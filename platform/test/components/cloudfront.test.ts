import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import {
  CF_BLOCK_CLOUDFRONT_URL_INJECTION,
  CF_ROUTER_INJECTION,
  routerLookupCode,
} from "../../src/components/aws/router";

const require = createRequire(import.meta.url);
const routerSource = readFileSync(
  new URL("../../src/components/aws/router.ts", import.meta.url),
  "utf8",
);

type CloudFrontField = {
  value?: string;
  multiValue?: { value: string }[];
};

type CloudFrontRequest = {
  uri: string;
  headers: Record<string, CloudFrontField>;
  cookies: Record<string, CloudFrontField>;
  querystring: Record<string, unknown>;
  origin?: unknown;
};

type CloudFrontEvent = {
  request: CloudFrontRequest;
};

type TestContext = vm.Context & {
  Promise: PromiseConstructor;
  Math: Math;
  JSON: JSON;
  RegExp: RegExpConstructor;
  decodeURIComponent: typeof decodeURIComponent;
  encodeURIComponent: typeof encodeURIComponent;
  event: CloudFrontEvent;
  cf: {
    kvs: () => {
      get: (key: string) => Promise<string>;
    };
    updateRequestOrigin: (origin: unknown) => void;
  };
  require: NodeRequire;
  __routeSite?: (
    kvNamespace: string,
    metadata: Record<string, any>,
  ) => Promise<any>;
  __getRequestHeaderSize?: () => number;
  __matchRoute?: (routes: string[]) => Promise<any>;
  __handler?: (event: CloudFrontEvent) => Promise<any>;
};

type CreateContextInput = {
  uri: string;
  headers: Record<string, CloudFrontField>;
  cookies?: Record<string, CloudFrontField>;
  querystring?: Record<string, unknown>;
  kvGet?: (key: string) => Promise<string>;
  updateRequestOrigin?: (origin: unknown, event: CloudFrontEvent) => void;
};

function extractTemplateCode(
  start: string,
  end: string,
  context: Record<string, unknown> = {},
) {
  const startIndex = routerSource.indexOf(start);
  const endIndex = routerSource.indexOf(end, startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Failed to extract code between ${start} and ${end}`);
  }

  return vm.runInNewContext(`\`${routerSource.slice(startIndex, endIndex)}\``, context);
}

const MATCH_ROUTE_CODE = extractTemplateCode(
  "async function matchRoute(routes) {",
  "\n\n  // Look up the route",
);

const REQUEST_HANDLER_CODE = extractTemplateCode(
  "async function handler(event) {\n  ${userInjection}\n  ${blockCloudfrontUrlInjection}\n  ${CF_ROUTER_INJECTION}\n",
  "\n}`,\n            },\n            { parent: self },\n          );",
  {
    userInjection: "",
    blockCloudfrontUrlInjection: "",
    CF_ROUTER_INJECTION,
    routerLookupCode,
    kvNamespace: "router",
  },
);

function createContext(input: CreateContextInput) {
  const event: CloudFrontEvent = {
    request: {
      uri: input.uri,
      headers: input.headers,
      cookies: input.cookies ?? {},
      querystring: input.querystring ?? {},
    },
  };

  const context: TestContext = {
    Promise,
    Math,
    JSON,
    RegExp,
    decodeURIComponent,
    encodeURIComponent,
    event,
    cf: {
      kvs: () => ({
        get: input.kvGet ?? (async () => {
          throw new Error("missing");
        }),
      }),
      updateRequestOrigin(origin: any) {
        input.updateRequestOrigin?.(origin, event);
      },
    },
    require,
  };

  vm.createContext(context);
  return { context, event };
}

function loadRouteSite(input: CreateContextInput) {
  const { context, event } = createContext(input);

  new vm.Script(
    `${CF_ROUTER_INJECTION.replace(
      /async function routeSite\(([^)]*)\)\{/,
      "async function routeSite($1){globalThis.__getRequestHeaderSize=getRequestHeaderSize;",
    )};globalThis.__routeSite = routeSite;`,
  ).runInContext(context);

  return {
    event,
    routeSite: context.__routeSite!,
    getRequestHeaderSize: () => context.__getRequestHeaderSize!(),
  };
}

function loadRouteMatcher(input: {
  uri: string;
  headers: Record<string, CloudFrontField>;
  metadata: Record<string, any>;
}) {
  const { context } = createContext({
    ...input,
    kvGet: async (key: string) => {
      if (!key.endsWith(":metadata")) throw new Error("missing");
      const routeNs = key.slice(0, -":metadata".length);
      const metadata = input.metadata[routeNs];
      if (!metadata) throw new Error("missing");
      return JSON.stringify(metadata);
    },
  });

  new vm.Script(`${MATCH_ROUTE_CODE};globalThis.__matchRoute = matchRoute;`).runInContext(
    context,
  );

  return context.__matchRoute!;
}

function loadHandler(input: {
  uri: string;
  headers: Record<string, CloudFrontField>;
  routes: string[];
  metadata: Record<string, any>;
  cookies?: Record<string, CloudFrontField>;
  querystring?: Record<string, unknown>;
  // replaces the key-value store, for a test that needs a read to fail
  kvGet?: (key: string) => Promise<string>;
}) {
  const { context, event } = createContext({
    ...input,
    kvGet: input.kvGet ?? (async (key: string) => {
      if (key === "router:routes") return JSON.stringify(input.routes);
      if (!key.endsWith(":metadata")) throw new Error("missing");

      const routeNs = key.slice(0, -":metadata".length);
      const metadata = input.metadata[routeNs];
      if (!metadata) throw new Error("missing");
      return JSON.stringify(metadata);
    }),
    updateRequestOrigin(origin, currentEvent) {
      currentEvent.request.origin = origin;
    },
  });

  new vm.Script(`${REQUEST_HANDLER_CODE}
}
globalThis.__handler = handler;`).runInContext(
    context,
  );

  return {
    event,
    handler: context.__handler!,
  };
}

async function selectRoute(requestUri: string, routePaths: string[]) {
  const metadata = Object.fromEntries(
    routePaths.map((path, index) => [`route${index}`, { path }]),
  );

  const matchRoute = loadRouteMatcher({
    uri: requestUri,
    headers: {
      host: { value: "example.com" },
    },
    metadata,
  });

  const match = await matchRoute(
    routePaths.map((path, index) => `url,route${index},,${path}`),
  );

  return match?.metadata.path;
}

async function pathMatches(requestUri: string, routePath: string) {
  return (await selectRoute(requestUri, [routePath])) === routePath;
}

describe("CloudFront router", () => {
  describe("path matching", () => {
    it("matches exact paths", async () => {
      expect(await pathMatches("/api", "/api")).toBe(true);
      expect(await pathMatches("/travel-plan", "/travel-plan")).toBe(true);
      expect(await pathMatches("/", "/")).toBe(true);
    });

    it("matches paths followed by slashes", async () => {
      expect(await pathMatches("/api/", "/api")).toBe(true);
      expect(await pathMatches("/api/users", "/api")).toBe(true);
      expect(await pathMatches("/api/users/123", "/api")).toBe(true);
    });

    it("matches nested paths", async () => {
      expect(await pathMatches("/travel-plan/abc", "/travel-plan")).toBe(
        true,
      );
      expect(await pathMatches("/travel-plan/abc/def", "/travel-plan")).toBe(
        true,
      );
      expect(await pathMatches("/uploads/file.txt", "/uploads")).toBe(true);
    });

    it("treats root as catch-all", async () => {
      expect(await pathMatches("/", "/")).toBe(true);
      expect(await pathMatches("/anything", "/")).toBe(true);
      expect(await pathMatches("/foo/bar", "/")).toBe(true);
      expect(await pathMatches("/api", "/")).toBe(true);
    });

    it("does not match non-segment continuations", async () => {
      expect(await pathMatches("/api-docs", "/api")).toBe(false);
      expect(await pathMatches("/apiv2", "/api")).toBe(false);
      expect(await pathMatches("/travel-plans", "/travel-plan")).toBe(false);
      expect(await pathMatches("/travel-planning", "/travel-plan")).toBe(
        false,
      );
    });

    it("does not match different paths", async () => {
      expect(await pathMatches("/users", "/api")).toBe(false);
      expect(await pathMatches("/v2/api", "/api")).toBe(false);
      expect(await pathMatches("/files", "/uploads")).toBe(false);
    });

    it("does not match shorter paths", async () => {
      expect(await pathMatches("/ap", "/api")).toBe(false);
      expect(await pathMatches("/a", "/api")).toBe(false);
    });

    it("handles trailing slash routes", async () => {
      expect(await pathMatches("/api/", "/api")).toBe(true);
      expect(await pathMatches("/api/users", "/api/")).toBe(true);
      expect(await pathMatches("/public/2025-11/image.jpg", "/public/")).toBe(
        true,
      );
      expect(await pathMatches("/public/", "/public/")).toBe(true);
      expect(await pathMatches("/publicfile", "/public/")).toBe(false);
    });

    it("handles special characters", async () => {
      expect(await pathMatches("/api/users-list", "/api")).toBe(true);
      expect(await pathMatches("/api_v2", "/api")).toBe(false);
      expect(await pathMatches("/api.json", "/api")).toBe(false);
    });

    it("handles deeply nested paths", async () => {
      expect(await pathMatches("/a/b/c/d/e/f", "/a")).toBe(true);
      expect(await pathMatches("/a/b/c/d/e/f", "/a/b")).toBe(true);
      expect(await pathMatches("/a/b/c/d/e/f", "/a/b/c")).toBe(true);
    });

    it("handles real-world boundary cases", async () => {
      expect(await pathMatches("/travel-plan/abc123", "/travel-plan")).toBe(
        true,
      );
      expect(await pathMatches("/travel-plans", "/travel-plan")).toBe(false);
      expect(await pathMatches("/travel-plans/123", "/travel-plan")).toBe(
        false,
      );
      expect(await pathMatches("/v1/users", "/v1")).toBe(true);
      expect(await pathMatches("/v1-beta", "/v1")).toBe(false);
      expect(await pathMatches("/v1-beta/users", "/v1")).toBe(false);
      expect(await pathMatches("/uploads/file.pdf", "/uploads")).toBe(true);
      expect(await pathMatches("/uploads-backup", "/uploads")).toBe(false);
      expect(await pathMatches("/uploads-backup/file.pdf", "/uploads")).toBe(
        false,
      );
    });

    it("picks the longest matching path", async () => {
      expect(await selectRoute("/api/users", ["/api", "/api-docs"])).toBe(
        "/api",
      );
      expect(await selectRoute("/api-docs/intro", ["/api", "/api-docs"])).toBe(
        "/api-docs",
      );
      expect(
        await selectRoute("/api/v2/users", ["/api", "/api/v2", "/api/v2/users", "/api/v3"]),
      ).toBe("/api/v2/users");
    });
  });

  describe("origin overrides", () => {
    it("sets URL route origin timeouts dynamically", async () => {
      const { event, handler } = loadHandler({
        uri: "/",
        headers: {
          host: { value: "example.com" },
        },
        routes: ["url,route0,,/"],
        metadata: {
          route0: {
            host: "gateway-origin.example.com",
            origin: {
              connectionAttempts: 2,
              timeouts: {
                connectionTimeout: 3,
                readTimeout: 60,
                keepAliveTimeout: 60,
              },
            },
          },
        },
      });

      await handler(event);

      expect(event.request.origin).toMatchObject({
        domainName: "gateway-origin.example.com",
        customOriginConfig: {
          port: 443,
          protocol: "https",
          sslProtocols: ["TLSv1.2"],
        },
        originAccessControlConfig: {
          enabled: false,
        },
        connectionAttempts: 2,
        timeouts: {
          connectionTimeout: 3,
          readTimeout: 60,
          keepAliveTimeout: 60,
        },
      });
    });

    it("leaves the origin timeouts alone when the route sets none", async () => {
      const { event, handler } = loadHandler({
        uri: "/",
        headers: {
          host: { value: "example.com" },
        },
        routes: ["url,route0,,/"],
        metadata: {
          route0: {
            host: "gateway-origin.example.com",
          },
        },
      });

      await handler(event);

      const origin = event.request.origin as Record<string, unknown>;
      expect(origin.domainName).toBe("gateway-origin.example.com");
      expect(origin.timeouts).toBeUndefined();
      expect(origin.connectionAttempts).toBeUndefined();
    });
  });

  describe("Next.js cache key", () => {
    it("varies for segment prefetch requests", async () => {
      async function getCacheKey(headers: Record<string, CloudFrontField>) {
        const { event, routeSite } = loadRouteSite({ uri: "/page", headers });

        await routeSite("test", {
          servers: [["server.example.com", 0, 0]],
          origin: {},
        });

        return event.request.headers["x-open-next-cache-key"].value;
      }

      const headers = { host: { value: "example.com" } };
      const baselineKey = await getCacheKey(headers);
      const repeatedBaselineKey = await getCacheKey(headers);
      const segmentPrefetchKey = await getCacheKey({
        ...headers,
        "next-router-segment-prefetch": { value: "/_tree" },
      });

      expect(repeatedBaselineKey).toBe(baselineKey);
      expect(segmentPrefetchKey).not.toBe(baselineKey);
    });

    it("varies only by accept for image requests", async () => {
      async function getCacheKey(headers: Record<string, CloudFrontField>) {
        const { event, routeSite } = loadRouteSite({
          uri: "/_next/image",
          headers,
        });

        await routeSite("test", {
          image: { route: "/_next/image", host: "image.example.com" },
        });

        return event.request.headers["x-open-next-cache-key"].value;
      }

      const headers = {
        host: { value: "example.com" },
        accept: { value: "image/webp" },
      };
      const baselineKey = await getCacheKey(headers);
      const segmentPrefetchKey = await getCacheKey({
        ...headers,
        "next-router-segment-prefetch": { value: "/_tree" },
      });
      const differentAcceptKey = await getCacheKey({
        ...headers,
        accept: { value: "image/avif" },
      });

      expect(segmentPrefetchKey).toBe(baselineKey);
      expect(differentAcceptKey).not.toBe(baselineKey);
    });
  });

  describe("header sizing", () => {
    it("counts request headers and cookies", async () => {
      const { getRequestHeaderSize, routeSite } = loadRouteSite({
        uri: "/",
        headers: {
          host: { value: "example.com" },
          accept: { value: "text/html" },
        },
        cookies: {
          session: { value: "abc" },
          theme: { value: "dark" },
        },
      });

      await routeSite("test", {});
      expect(getRequestHeaderSize()).toBe(71);
    });

    it("counts multi-value headers and cookies", async () => {
      const { getRequestHeaderSize, routeSite } = loadRouteSite({
        uri: "/",
        headers: {
          accept: {
            multiValue: [{ value: "text/html" }, { value: "application/json" }],
          },
        },
        cookies: {
          session: {
            multiValue: [{ value: "abc" }, { value: "def" }],
          },
        },
      });

      await routeSite("test", {});
      expect(getRequestHeaderSize()).toBe(79);
    });

    it("returns 431 for oversized image requests", async () => {
      const { routeSite } = loadRouteSite({
        uri: "/_next/image",
        headers: {
          host: { value: "example.com" },
          accept: { value: "image/webp" },
        },
        cookies: {
          session: { value: "x".repeat(10000) },
        },
      });

      const response = await routeSite("test", {
        image: { route: "/_next/image", host: "image.example.com" },
      });

      expect(response.statusCode).toBe(431);
      expect(response.statusDescription).toBe("Request Header Fields Too Large");
      expect(response.body.data).toContain("Reduce cookie size");
    });

    it("returns 431 for oversized server requests", async () => {
      const { routeSite } = loadRouteSite({
        uri: "/",
        headers: {
          host: { value: "example.com" },
        },
        cookies: {
          session: { value: "x".repeat(10000) },
        },
      });

      const response = await routeSite("test", {
        servers: [["server.example.com", 0, 0]],
        origin: {},
      });

      expect(response.statusCode).toBe(431);
      expect(response.statusDescription).toBe("Request Header Fields Too Large");
      expect(response.body.data).toContain("Reduce cookie size");
    });

    it("returns 431 for oversized image requests through handler", async () => {
      const { event, handler } = loadHandler({
        uri: "/_next/image",
        headers: {
          host: { value: "example.com" },
          accept: { value: "image/webp" },
        },
        cookies: {
          session: { value: "x".repeat(10000) },
        },
        routes: ["site,route0,,/"],
        metadata: {
          route0: {
            image: { route: "/_next/image", host: "image.example.com" },
          },
        },
      });

      const response = await handler(event);

      expect(response.statusCode).toBe(431);
      expect(response.statusDescription).toBe("Request Header Fields Too Large");
      expect(response.body.data).toContain("Reduce cookie size");
    });

    it("returns 431 for oversized server requests through handler", async () => {
      const { event, handler } = loadHandler({
        uri: "/",
        headers: {
          host: { value: "example.com" },
        },
        cookies: {
          session: { value: "x".repeat(10000) },
        },
        routes: ["site,route0,,/"],
        metadata: {
          route0: {
            servers: [["server.example.com", 0, 0]],
            origin: {},
          },
        },
      });

      const response = await handler(event);

      expect(response.statusCode).toBe(431);
      expect(response.statusDescription).toBe("Request Header Fields Too Large");
      expect(response.body.data).toContain("Reduce cookie size");
    });
  });

  describe("base path", () => {
    const S3_DOMAIN = "assets.s3.us-east-1.amazonaws.com";

    function siteMetadata(overrides: Record<string, any> = {}) {
      return {
        base: "/admin/board",
        s3: { domain: S3_DOMAIN, dir: "/_assets", prefix: "", routes: ["/_next/static"] },
        servers: [["server.lambda-url.us-east-1.on.aws", 0, 0]],
        ...overrides,
      };
    }

    it("keys an S3 route without the base", async () => {
      // The regression. The route is matched against the baseless uri, so the
      // key has to be built from it too. Building it from the full uri asks S3
      // for /_assets/admin/board/_next/... while the deploy uploaded
      // /_assets/_next/..., so every asset 404s. S3 reports that as 403 when
      // the caller cannot list, which sends people hunting for a permissions
      // problem that is not there.
      const { event, routeSite } = loadRouteSite({
        uri: "/admin/board/_next/static/css/abc123.css",
        headers: { host: { value: "example.com" } },
      });

      await routeSite("test", siteMetadata());

      expect(event.request.uri).toBe("/_assets/_next/static/css/abc123.css");
    });

    it("does not leave the base anywhere in the key", async () => {
      const { event, routeSite } = loadRouteSite({
        uri: "/admin/board/_next/static/chunk.js",
        headers: { host: { value: "example.com" } },
      });

      await routeSite("test", siteMetadata());

      expect(event.request.uri).not.toContain("/admin/board");
    });

    it("sends it to the S3 origin", async () => {
      let origin: any;
      const { routeSite } = loadRouteSite({
        uri: "/admin/board/_next/static/chunk.js",
        headers: { host: { value: "example.com" } },
        updateRequestOrigin: (o) => (origin = o),
      });

      await routeSite("test", siteMetadata());

      expect(origin.domainName).toBe(S3_DOMAIN);
    });

    it("is unchanged for a site with no base", async () => {
      const { event, routeSite } = loadRouteSite({
        uri: "/_next/static/css/abc123.css",
        headers: { host: { value: "example.com" } },
      });

      await routeSite("test", siteMetadata({ base: undefined }));

      expect(event.request.uri).toBe("/_assets/_next/static/css/abc123.css");
    });

    it("keys a file found in the KV store without the base", async () => {
      // The other branch that matches baseless and then keyed with the full
      // uri. Its own comment says files are stored in the root.
      const { event, routeSite } = loadRouteSite({
        uri: "/admin/board/about",
        headers: { host: { value: "example.com" } },
        kvGet: async (key: string) => {
          if (key === "test:/about.html") return "";
          throw new Error("missing");
        },
      });

      await routeSite("test", siteMetadata());

      expect(event.request.uri).toBe("/_assets/about.html");
    });

    it("still appends index.html under a base", async () => {
      const { event, routeSite } = loadRouteSite({
        uri: "/admin/board/docs/guide",
        headers: { host: { value: "example.com" } },
      });

      await routeSite(
        "test",
        siteMetadata({
          s3: { domain: S3_DOMAIN, dir: "/_assets", prefix: "", routes: ["/docs"] },
        }),
      );

      expect(event.request.uri).toBe("/_assets/docs/guide/index.html");
    });

    it("keeps the route's path prefix in the key", async () => {
      // A site on a Router path (/admin) with its own base path (/admin/board):
      // the files are uploaded under the route's prefix, so the key has the
      // prefix and the uri without the base.
      const { event, routeSite } = loadRouteSite({
        uri: "/admin/board/_next/static/chunk.js",
        headers: { host: { value: "example.com" } },
      });

      await routeSite(
        "test",
        siteMetadata({
          s3: { domain: S3_DOMAIN, dir: "/_assets", prefix: "/admin", routes: ["/_next/static"] },
        }),
      );

      expect(event.request.uri).toBe("/_assets/admin/_next/static/chunk.js");
    });

    it("keeps the whole uri for a StaticSite on a Router path", async () => {
      // A StaticSite's base is the Router path, and it uploads under it, so the
      // key is the uri itself. Taking the base off breaks every file.
      const { event, routeSite } = loadRouteSite({
        uri: "/admin/app.js",
        headers: { host: { value: "example.com" } },
      });

      await routeSite(
        "test",
        siteMetadata({
          base: "/admin",
          servers: undefined,
          s3: { domain: S3_DOMAIN, dir: "", prefix: "/admin", routes: ["/app.js"] },
        }),
      );

      expect(event.request.uri).toBe("/admin/app.js");
    });

    it("uses the whole uri for metadata from before the prefix was stored", async () => {
      // A Router can serve a site deployed with an older SST, whose metadata has
      // no prefix. It keeps the old key.
      const { event, routeSite } = loadRouteSite({
        uri: "/admin/app.js",
        headers: { host: { value: "example.com" } },
      });

      await routeSite(
        "test",
        siteMetadata({
          base: "/admin",
          servers: undefined,
          s3: { domain: S3_DOMAIN, dir: "", routes: ["/app.js"] },
        }),
      );

      expect(event.request.uri).toBe("/admin/app.js");
    });

    it("takes the base off the start of the uri only", async () => {
      // String.replace takes out the first match anywhere, so a uri outside
      // the base that has the base in the middle lost it, and got another key.
      const { event, routeSite } = loadRouteSite({
        uri: "/other/admin/board/chunk.js",
        headers: { host: { value: "example.com" } },
      });

      await routeSite(
        "test",
        siteMetadata({
          s3: { domain: S3_DOMAIN, dir: "/_assets", prefix: "", routes: ["/other"] },
        }),
      );

      expect(event.request.uri).toBe("/_assets/other/admin/board/chunk.js");
    });

    it("takes the base off at a segment boundary only", async () => {
      const { event, routeSite } = loadRouteSite({
        uri: "/administrator/chunk.js",
        headers: { host: { value: "example.com" } },
      });

      await routeSite(
        "test",
        siteMetadata({
          base: "/admin",
          s3: { domain: S3_DOMAIN, dir: "/_assets", prefix: "/admin", routes: ["/administrator"] },
        }),
      );

      expect(event.request.uri).toBe("/_assets/admin/administrator/chunk.js");
    });

    it("sends the base path itself to the server", async () => {
      // The uri is the base, with no trailing slash: it is taken off whole,
      // matches no S3 route, and goes to the server.
      let origin: any;
      const { routeSite } = loadRouteSite({
        uri: "/admin/board",
        headers: { host: { value: "example.com" } },
        updateRequestOrigin: (o) => (origin = o),
      });

      await routeSite("test", siteMetadata());

      expect(origin.domainName).toBe("server.lambda-url.us-east-1.on.aws");
    });

    it("leaves a path the S3 routes do not match to the server", async () => {
      let origin: any;
      const { routeSite } = loadRouteSite({
        uri: "/admin/board/b/123",
        headers: { host: { value: "example.com" } },
        updateRequestOrigin: (o) => (origin = o),
      });

      await routeSite("test", siteMetadata());

      expect(origin.domainName).toBe("server.lambda-url.us-east-1.on.aws");
    });
  });
});

describe("a request that matches no route", () => {
  const request = (uri: string) => ({
    uri,
    headers: { host: { value: "example.com" } },
  });

  it("answers 404 when routes are registered and none matches", async () => {
    const { event, handler } = loadHandler({
      ...request("/robots.txt"),
      routes: ["bucket,route0,,/files", "url,route1,,/api"],
      metadata: {
        route0: { domain: "bucket.s3.us-east-1.amazonaws.com", origin: {} },
        route1: { host: "api.example.com", origin: {} },
      },
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(404);
    expect(response.statusDescription).toBe("Not Found");
    expect(response.body.data).toBe("404 Not Found");
  });

  it("answers 404 when the only routes are for another host", async () => {
    const { event, handler } = loadHandler({
      ...request("/files/hello.txt"),
      routes: ["bucket,route0,other\\.example\\.com,/files"],
      metadata: {
        route0: { domain: "bucket.s3.us-east-1.amazonaws.com", origin: {} },
      },
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(404);
  });

  it("still routes a request that matches", async () => {
    const { event, handler } = loadHandler({
      ...request("/files/hello.txt"),
      routes: ["bucket,route0,,/files"],
      metadata: {
        route0: { domain: "bucket.s3.us-east-1.amazonaws.com", origin: {} },
      },
    });

    const response = await handler(event);

    expect(response.statusCode).toBeUndefined();
    expect(event.request.origin).toMatchObject({
      domainName: "bucket.s3.us-east-1.amazonaws.com",
    });
  });

  it("passes the request on when no routes are registered yet", async () => {
    const { event, handler } = loadHandler({
      ...request("/anything"),
      routes: [],
      metadata: {},
    });

    const response = await handler(event);

    expect(response.statusCode).toBeUndefined();
    expect(response.uri).toBe("/anything");
  });

  it("passes the request on when the routes can't be read", async () => {
    const { event, handler } = loadHandler({
      ...request("/anything"),
      routes: [],
      metadata: {},
      kvGet: async () => {
        throw new Error("key-value store unavailable");
      },
    });

    const response = await handler(event);

    expect(response.statusCode).toBeUndefined();
    expect(response.uri).toBe("/anything");
  });

  it("reads a list of routes that is stored in chunks", async () => {
    // The list is stored in parts when it is too long for one key.
    const all = JSON.stringify(["bucket,route0,,/files"]);
    const half = Math.floor(all.length / 2);
    const { event, handler } = loadHandler({
      ...request("/files/hello.txt"),
      routes: [],
      metadata: {},
      kvGet: async (key: string) => {
        if (key === "router:routes") return JSON.stringify({ parts: 2 });
        if (key === "router:routes:0") return all.slice(0, half);
        if (key === "router:routes:1") return all.slice(half);
        if (key === "route0:metadata")
          return JSON.stringify({ domain: "bucket.s3.us-east-1.amazonaws.com", origin: {} });
        throw new Error("missing");
      },
    });

    const response = await handler(event);

    expect(response.statusCode).toBeUndefined();
    expect(event.request.origin).toMatchObject({
      domainName: "bucket.s3.us-east-1.amazonaws.com",
    });
  });

  it("passes the request on when a chunk of the routes can't be read", async () => {
    // A part that fails to read leaves nothing to match against. It is not a
    // path nobody handles, and it must not fail the function either.
    const { event, handler } = loadHandler({
      ...request("/anything"),
      routes: [],
      metadata: {},
      kvGet: async (key: string) => {
        if (key === "router:routes") return JSON.stringify({ parts: 2 });
        throw new Error("chunk unavailable");
      },
    });

    const response = await handler(event);

    expect(response.statusCode).toBeUndefined();
    expect(response.uri).toBe("/anything");
  });

  it("passes the request on when a matched route's metadata can't be read", async () => {
    // The route matches, so this is not a path nobody handles: the read failed,
    // and a retry may work, so it is not answered with a 404.
    const { event, handler } = loadHandler({
      ...request("/files/hello.txt"),
      routes: ["bucket,route0,,/files"],
      metadata: {},
    });

    const response = await handler(event);

    expect(response.statusCode).toBeUndefined();
    expect(response.uri).toBe("/files/hello.txt");
  });
});

describe("minified function code", () => {
  const pieces = {
    CF_BLOCK_CLOUDFRONT_URL_INJECTION,
    CF_ROUTER_INJECTION,
    routerLookupCode: routerLookupCode("router"),
  };

  it.each(Object.entries(pieces))("%s carries no comments or indentation", (_, code) => {
    expect(code).not.toMatch(/\n\s/);
    expect(code).not.toMatch(/\/\*|\/\/[A-Za-z]/);
  });

  // CloudFront rejects the whole function on this ("SyntaxError: await in
  // arguments not supported"), and every request on the distribution fails.
  // Node accepts it, so only a check on the minified code catches it.
  it.each(Object.entries(pieces))("%s never awaits inside a call's arguments", (_, code) => {
    expect(code).not.toMatch(/[(,]\s*await\b/);
  });

  // The lookup's functions (`getRoutes`, `matchRoute`) are hoisted, and CloudFront
  // throws "ReferenceError: cannot access variable before initialization" when
  // one of them reads a `let` or `const` declared beside it in the handler, even
  // when the call comes after the declaration. Every request on the distribution
  // then fails with a 503. Node does not throw, so only a check on the code
  // catches it. Share state through a return value, as `matchRoute` does with
  // `{ unreadable: true }`, and declare variables inside a function. The
  // statement that starts the lookup, `const routes = ..., route = ...`, is set
  // before anything reads it and no function uses it. The check lists the plain
  // names a top-level `let`, `const` or `var` introduces, however the minifier
  // groups them. It cannot read a destructuring declaration or a class, so it
  // fails on those instead. Add a name here only if it is still true that no
  // function reads it.
  it("routerLookupCode declares only the variables it is known to be safe with", () => {
    const code = routerLookupCode("router");
    const declared: string[] = [];
    let depth = 0; // braces, parentheses and brackets
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if ("{([".includes(c)) depth++;
      else if ("})]".includes(c)) depth--;
      else if (depth === 0 && !/[\w$]/.test(code[i - 1] ?? " ") && /^(let|const|var)\s/.test(code.slice(i, i + 6))) {
        // the names of this statement: the identifier after the keyword, and the one
        // after every comma at this depth, up to the end of the statement
        let j = i + code.slice(i).search(/\s/) + 1;
        let d = 0;
        let start = j;
        const take = (from: number) => {
          const m = /^[\w$]+/.exec(code.slice(from).trimStart());
          if (m) declared.push(m[0]);
        };
        take(start);
        for (; j < code.length; j++) {
          const k = code[j];
          if ("{([".includes(k)) d++;
          else if ("})]".includes(k)) d--;
          else if (d === 0 && k === ";") break;
          else if (d === 0 && k === ",") take(j + 1);
        }
        i = j;
      }
    }
    expect(declared).toEqual(["routes", "route"]);
    // forms the scanner above cannot read
    expect(code).not.toMatch(/\b(let|const|var)\s*[{[]/);
    expect(code).not.toMatch(/\bclass\b/);
  });

  // The function is limited to 10,240 bytes and the user's injection goes in the
  // same space. REQUEST_HANDLER_CODE is the handler as the router builds it, with
  // the lookup and without an injection or the block; the import and the closing
  // brace are what `createRequestFunction` adds around it. If a change takes more
  // of the space, it's a choice to make on purpose.
  it("leaves room for the user's injection", () => {
    const used = [
      'import cf from "cloudfront";\n',
      REQUEST_HANDLER_CODE,
      "\n}",
      CF_BLOCK_CLOUDFRONT_URL_INJECTION,
    ].reduce((sum, code) => sum + Buffer.byteLength(code), 0);
    expect(10240 - used).toBeGreaterThanOrEqual(2000);
  });

  it("keeps the router's namespace in the lookup", () => {
    expect(routerLookupCode("ab12")).toContain('"ab12"');
  });

  it("answers the cloudfront.net URL with a 403", async () => {
    const run = new Function(
      "event",
      `return (async () => {${CF_BLOCK_CLOUDFRONT_URL_INJECTION}; return "routed"})();`,
    );
    const blocked = await run({ request: { headers: { host: { value: "d1.cloudfront.net" } } } });
    expect(blocked.statusCode).toBe(403);
    expect(await run({ request: { headers: { host: { value: "example.com" } } } })).toBe("routed");
  });
});
