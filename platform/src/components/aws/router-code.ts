// The code of the CloudFront functions a router, and a site served through it
// or on its own, run at the edge, and what they keep in the key-value store. The
// SST 4's components and SST 5's deploy the same code, so it lives here, in one place.
import crypto from "crypto";
import type { DurationSeconds } from "../duration";
import type { Size } from "../size";
import { minify, minifyBody } from "../../util/minify";

// CloudFront Functions have a 10KB limit on the forwarded request size.
// We reserve 512 bytes for origin-request overhead CloudFront can still add after
// this viewer-request function runs, so borderline requests fail with a clear 431.
const CLOUDFRONT_FUNCTION_SAFE_HEADER_LIMIT = 10240 - 512;

// NOTE: CF_BLOCK_CLOUDFRONT_URL_INJECTION is size-sensitive — CloudFront Functions
// have a 10KB limit. Its 403 body is plain text on purpose: it keeps the block
// small, and it is the body upstream chose. Don't put the HTML page back to look
// like a web server's.
export const CF_BLOCK_CLOUDFRONT_URL_INJECTION = minifyBody`
if (event.request.headers.host.value.includes('cloudfront.net')) {
  return {
    statusCode: 403,
    statusDescription: 'Forbidden',
    body: {
      encoding: "text",
      data: "403 Forbidden"
    }
  };
}`;

// The route lookup that ends the router's viewer-request function: finds the
// route for the request in the key-value store and sends the request on to it.
// Minified when the function is built, because the router's key-value
// namespace is part of it.
// NOTE: This string is size-sensitive — CloudFront Functions have a 10KB limit.
// The minifier keeps local names as written, so keep them short.
export const routerLookupCode = (kvNamespace: string) => minifyBody`
  async function getRoutes() {
    const routerNS = "${kvNamespace}";
    let routes = [];
    try {
      const v = await cf.kvs().get(routerNS + ":routes");
      routes = JSON.parse(v);

      // handle chunked routes
      if (routes.parts) {
        const reads = [];
        for (let i = 0; i < routes.parts; i++) {
          reads.push(cf.kvs().get(routerNS + ":routes:" + i));
        }
        const chunks = await Promise.all(reads);
        routes = JSON.parse(chunks.join(""));
      }
    } catch (e) {}
    return Array.isArray(routes) ? routes : [];
  }

  async function matchRoute(routes) {
    const requestHost = event.request.headers.host.value;
    const escapedHost = requestHost.replace(/\\./g, "\\\\.");
    const hostPattern = "^" + requestHost + "$";
    let match;
    routes.forEach(r => {
      ${
        /*
        Route format: [type, routeNamespace, hostRegex, pathPrefix]
        - First sort by host pattern (longest first)
        - Then sort by path prefix (longest first)
      */ ""
      }
      var parts = r.split(",");
      const type = parts[0];
      const routeNs = parts[1];
      const host = parts[2];
      const hostLength = host.length;
      const path = parts[3];
      const pathLength = path.length;

      // Do not consider if the current match is a better winner
      if (match && (
          hostLength < match.hostLength
          || (hostLength === match.hostLength && pathLength < match.pathLength)
      )) return;

      const hostMatches = host === ""
        || host === escapedHost
        || (host.includes("*") && new RegExp(host).test(hostPattern));
      if (!hostMatches) return;

      const pathMatches = event.request.uri.startsWith(path) && (event.request.uri === path || path.endsWith('/') || event.request.uri[path.length] === '/' || path === '/');
      if (!pathMatches) return;

      match = {
        type,
        routeNs,
        host,
        hostLength,
        path,
        pathLength,
      };
    });

    // Load metadata
    if (match) {
      try {
        const type = match.type;
        const routeNs = match.routeNs;
        const v = await cf.kvs().get(routeNs + ":metadata");
        return { type, routeNs, metadata: JSON.parse(v) };
      } catch (e) {
        return { unreadable: true };
      }
    }
  }

  // Look up the route
  const routes = await getRoutes();
  const route = await matchRoute(routes);
  if (!route || route.unreadable) {
    // Routes are registered and none matches this request: a 404, as the docs
    // say. When no routes are registered yet, or a matched route's metadata
    // couldn't be read, the request is passed on as it was. The body is plain
    // text, like CF_BLOCK_CLOUDFRONT_URL_INJECTION's 403, because this function
    // shares 10KB with the user's injection.
    if (!route && routes.length > 0) {
      return {
        statusCode: 404,
        statusDescription: "Not Found",
        body: { encoding: "text", data: "404 Not Found" },
      };
    }
    return event.request;
  }
  if (route.metadata.rewrite) {
    const rw = route.metadata.rewrite;
    event.request.uri = event.request.uri.replace(new RegExp(rw.regex), rw.to);
  }
  if (route.type === "url") setUrlOrigin(route.metadata.host, route.metadata.origin);
  if (route.type === "bucket") setS3Origin(route.metadata.domain, route.metadata.origin);
  if (route.type === "site") {
    const response = await routeSite(route.routeNs, route.metadata);
    return response || event.request;
  }
  return event.request;
`;

// CloudFront Function handler code injected into site and router CF functions.
// NOTE: This string is size-sensitive — CloudFront Functions have a 10KB limit.
// NOTE: `s3Key` is the S3 key of a file: the folder, the path prefix the files were
// uploaded under (`s3.prefix`), then the uri without the site's base path. Without
// `s3.prefix` (metadata from an older version) it is the folder and the whole uri.
// The base is only taken off the start of the uri, and only at a segment boundary
// (`/admin` is not taken off `/administrator`), so don't go back to `replace`. The base
// never has a trailing slash (the route's path prefix is normalized in this file, and an
// SSR site's base in `ssr-site.ts`), so `base + "/"` is safe.
// `s3Key` takes everything as arguments: reading `baselessUri` from `routeSite` fails with
// "cannot access variable before initialization" in the CloudFront function runtime.
// The custom 404 and the "unmatched" branches below still use the old key.
export const CF_ROUTER_INJECTION = minify`
async function routeSite(kvNamespace, metadata) {
  const baselessUri = metadata.base && (event.request.uri === metadata.base || event.request.uri.startsWith(metadata.base + "/"))
    ? event.request.uri.slice(metadata.base.length)
    : event.request.uri;

  function s3Key(metadata, uri, baselessUri) {
    return metadata.s3.dir + (metadata.s3.prefix === undefined ? uri : metadata.s3.prefix + baselessUri);
  }

  // Route to S3 files
  try {
    // check using baselessUri b/c files are stored in the root
    const u = decodeURIComponent(baselessUri);
    const postfixes = u.endsWith("/")
      ? ["index.html"]
      : ["", ".html", "/index.html"];
    const v = await Promise.any(postfixes.map(p => cf.kvs().get(kvNamespace + ":" + u + p).then(v => p)));
    // files are stored in a subdirectory, add it to the request uri
    event.request.uri = s3Key(metadata, event.request.uri, baselessUri) + v;
    setS3Origin(metadata.s3.domain);
    return;
  } catch (e) {}

  // Route to S3 routes
  if (metadata.s3 && metadata.s3.routes) {
    for (var i=0, l=metadata.s3.routes.length; i<l; i++) {
      const route = metadata.s3.routes[i];
      if (baselessUri.startsWith(route)) {
        event.request.uri = s3Key(metadata, event.request.uri, baselessUri);
        // uri ends with /, ie. /usage/ -> /usage/index.html
        if (event.request.uri.endsWith("/")) {
          event.request.uri += "index.html";
        }
        // uri ends with non-file, ie. /usage -> /usage/index.html
        else if (!event.request.uri.split("/").pop().includes(".")) {
          event.request.uri += "/index.html";
        }
        setS3Origin(metadata.s3.domain);
        return;
      }
    }
  }

  // Route to S3 custom 404 (SPA fallback, no servers)
  if (metadata.custom404 && !metadata.errorResponseCode) {
    event.request.uri = metadata.s3.dir + (metadata.base ? metadata.base : "") + metadata.custom404;
    setS3Origin(metadata.s3.domain);
    return;
  }

  // Route unmatched to S3 (triggers customErrorResponses)
  if (metadata.s3 && !metadata.servers) {
    event.request.uri = metadata.s3.dir + event.request.uri;
    setS3Origin(metadata.s3.domain);
    return;
  }

  // Route to image optimizer
  if (metadata.image && baselessUri.startsWith(metadata.image.route)) {
    setForwardedHost();
    setNextjsCacheKey();
    if (isRequestHeaderTooLarge()) return buildOversizedHeadersResponse();
    setUrlOrigin(metadata.image.host, metadata.image.originAccessControlConfig ? { originAccessControlConfig: metadata.image.originAccessControlConfig } : undefined);
    return;
  }

  // Route to servers
  if (metadata.servers){
    setForwardedHost();
    // In SvelteKit, form action requests contain "/" in request query string
    // ie. POST request with query string "?/action"
    // CloudFront does not allow query string with "/". It needs to be encoded.
    for (var key in event.request.querystring) {
      if (key.includes("/")) {
        event.request.querystring[encodeURIComponent(key)] = event.request.querystring[key];
        delete event.request.querystring[key];
      }
    }
    setNextjsGeoHeaders();
    setNextjsCacheKey();
    if (isRequestHeaderTooLarge()) return buildOversizedHeadersResponse();
    setUrlOrigin(findNearestServer(metadata.servers), metadata.origin);
  }

  // Inject the CloudFront viewer country, region, latitude, and longitude headers into
  // the request headers for OpenNext to use them
  function setNextjsGeoHeaders() {
    var keys = ["city","country","region","latitude","longitude"];
    for (var i=0; i<keys.length; i++) {
      if (event.request.headers["cloudfront-viewer-" + keys[i]])
        event.request.headers["x-open-next-" + keys[i]] = event.request.headers["cloudfront-viewer-" + keys[i]];
    }
  }

  // This function is used to improve cache hit ratio by setting the cache key
  // based on the request headers and the path. next/image only needs the
  // accept header, and this header is not useful for the rest of the query
  function setNextjsCacheKey() {
    var cacheKey = "";
    if (event.request.uri.startsWith("/_next/image")) {
      cacheKey = getHeader("accept");
    } else {
      var headers = ["rsc","next-router-prefetch","next-router-segment-prefetch","next-router-state-tree","next-url","x-prerender-revalidate"];
      for (var i=0; i<headers.length; i++) cacheKey += getHeader(headers[i]);
    }
    if (event.request.cookies["__prerender_bypass"]) {
      cacheKey += event.request.cookies["__prerender_bypass"]
        ? event.request.cookies["__prerender_bypass"].value
        : "";
    }
    var crypto = require("crypto");
    var hashedKey = crypto.createHash("md5").update(cacheKey).digest("hex");
    event.request.headers["x-open-next-cache-key"] = { value: hashedKey };
  }

  function getHeader(key) {
    var header = event.request.headers[key];
    if (header) {
      if (header.multiValue) {
        return header.multiValue.map((header) => header.value).join(",");
      }
      if (header.value) {
        return header.value;
      }
    }
    return "";
  }

  function isRequestHeaderTooLarge() {
    return getRequestHeaderSize() > ${CLOUDFRONT_FUNCTION_SAFE_HEADER_LIMIT};
  }

  function buildOversizedHeadersResponse() {
    return {
      statusCode: 431,
      statusDescription: "Request Header Fields Too Large",
      headers: {
        "cache-control": { value: "no-store" },
        "content-type": { value: "text/plain; charset=utf-8" },
      },
      body: {
        encoding: "text",
        data: "Request headers are too large. Reduce cookie size and try again.",
      },
    };
  }

  function getRequestHeaderSize() {
    var size = 0;

    for (var key in event.request.headers) {
      var header = event.request.headers[key];
      if (header.multiValue) {
        for (var i=0; i<header.multiValue.length; i++) {
          size += key.length + header.multiValue[i].value.length + 4;
        }
      } else if (header.value) {
        size += key.length + header.value.length + 4;
      }
    }

    var cookies = [];
    for (var key in event.request.cookies) {
      var cookie = event.request.cookies[key];
      if (cookie.multiValue) {
        for (var i=0; i<cookie.multiValue.length; i++) {
          cookies.push(key + "=" + cookie.multiValue[i].value);
        }
      } else {
        cookies.push(key + "=" + cookie.value);
      }
    }

    if (cookies.length) {
      size += 10 + cookies.join("; ").length;
    }

    return size;
  }

  function findNearestServer(servers) {
    if (servers.length === 1) return servers[0][0];

    const h = event.request.headers;
    const lat = h["cloudfront-viewer-latitude"] && h["cloudfront-viewer-latitude"].value;
    const lon = h["cloudfront-viewer-longitude"] && h["cloudfront-viewer-longitude"].value;
    if (!lat || !lon) return servers[0][0];

    return servers
      .map((s) => ({
        distance: haversineDistance(lat, lon, s[1], s[2]),
        host: s[0],
      }))
      .sort((a, b) => a.distance - b.distance)[0]
      .host;
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = angle => angle * Math.PI / 180;
    const radLat1 = toRad(lat1);
    const radLat2 = toRad(lat2);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

function setForwardedHost() {
  // Lambda URLs expect the original viewer host in x-forwarded-host.
  event.request.headers["x-forwarded-host"] = event.request.headers.host;
}

function setUrlOrigin(urlHost, override) {
  setForwardedHost();
  const origin = {
    domainName: urlHost,
    customOriginConfig: {
      port: 443,
      protocol: "https",
      sslProtocols: ["TLSv1.2"],
    },
    originAccessControlConfig: {
      enabled: false,
    }
  };
  override = override ?? {};
  if (override.protocol === "http") {
    delete origin.customOriginConfig;
  }
  if (override.connectionAttempts) {
    origin.connectionAttempts = override.connectionAttempts;
  }
  if (override.timeouts) {
    origin.timeouts = override.timeouts;
  }
  if (override.originAccessControlConfig) {
    origin.originAccessControlConfig = override.originAccessControlConfig;
  }
  cf.updateRequestOrigin(origin);
}

function setS3Origin(s3Domain, override) {
  delete event.request.headers["Cookies"];
  delete event.request.headers["cookies"];
  delete event.request.cookies;

  const origin = {
    domainName: s3Domain,
    originAccessControlConfig: {
      enabled: true,
      signingBehavior: "always",
      signingProtocol: "sigv4",
      originType: "s3",
    }
  };
  override = override ?? {};
  if (override.connectionAttempts) {
    origin.connectionAttempts = override.connectionAttempts;
  }
  if (override.timeouts) {
    origin.timeouts = override.timeouts;
  }
  cf.updateRequestOrigin(origin);
}`;

export type KV_SITE_METADATA = {
  base?: string; // Undefined or "" if no base path. Otherwise starts with "/" and never ends with one (so never "/"): the router strips it with `base + "/"`.
  custom404?: string;
  errorResponseCode?: number;
  s3: {
    domain: string;
    dir: string; // Should be "" if no dir
    prefix?: string; // The path prefix the files are stored under, "" if none. Missing in metadata from older versions.
    routes: string[];
  };
  image?: {
    host: string;
    route: string;
    originAccessControlConfig?: {
      enabled: boolean;
      signingBehavior: string;
      signingProtocol: string;
      originType: string;
    };
  };
  servers?: [string, number, number][];
  origin?: {
    timeouts: {
      readTimeout: number;
    };
    originAccessControlConfig?: {
      enabled: boolean;
      signingBehavior: string;
      signingProtocol: string;
      originType: string;
    };
  };
};

export type ProtectionConfig = {
  mode: "none" | "oac" | "oac-with-edge-signing";
  edgeFunction?: {
    arn?: string;
    memory?: Size;
    timeout?: DurationSeconds;
  };
};

/**
 * The prefix of what something served through a router keeps in its key-value
 * store, made from its name: a store can serve several routers and sites.
 */
export function kvNamespace(name: string) {
  return crypto
    .createHash("md5")
    .update(`${$app.name}-${$app.stage}-${name}`)
    .digest("hex")
    .substring(0, 4);
}

/**
 * A route's pattern, like `api.example.com/v1`, as the router's function
 * matches it: the host as a regular expression, and the path.
 */
export function parsePattern(pattern: string) {
  const [host, ...path] = pattern.split("/");
  return {
    host: host
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special regex chars
      .replace(/\*/g, ".*"), // Replace * with .*
    path: "/" + path.join("/"),
  };
}

/** Whether a router with this protection signs its requests to what it routes to. */
export function isSigning(mode: ProtectionConfig["mode"]) {
  return mode === "oac" || mode === "oac-with-edge-signing";
}
