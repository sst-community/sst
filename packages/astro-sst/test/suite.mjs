// Packs this adapter and installs it into a fixture Astro app, as a user's app
// gets it from npm. Builds the app in buffer and stream response modes,
// bundles each server handler with the esbuild options SST uses, and calls it
// with fake Lambda events. No AWS account or network needed.
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const HOST = "example.test";

function run(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}

// Options mirror pkg/runtime/node/build.go in sst-community/sst.
// sst.aws.Astro installs sharp instead of bundling it.
async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    platform: "node",
    format: "esm",
    bundle: true,
    minify: true,
    keepNames: true,
    target: "node22",
    mainFields: ["module", "main"],
    external: ["sharp"],
    banner: {
      js: [
        `import { createRequire as topLevelCreateRequire } from 'module';`,
        `const require = topLevelCreateRequire(import.meta.url);`,
        `import { fileURLToPath as topLevelFileUrlToPath, URL as topLevelURL } from "url"`,
        `const __filename = topLevelFileUrlToPath(import.meta.url)`,
        `const __dirname = topLevelFileUrlToPath(new topLevelURL(".", import.meta.url))`,
      ].join("\n"),
    },
    logLevel: "warning",
  });
}

// Stands in for the `awslambda` global that Lambda's Node.js runtime provides
// to streaming handlers. As in aws-lambda-nodejs-runtime-interface-client's
// src/stream, the status and headers are sent just before the first write, so
// a response that never writes loses them.
globalThis.awslambda = {
  streamifyResponse: (handler) => handler,
  HttpResponseStream: {
    from(stream, metadata) {
      stream._onBeforeFirstWrite = () => {
        stream.metadata = metadata;
      };
      return stream;
    },
  },
};

async function callStreaming(handler, event) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  // Like Lambda's response stream: a chunk that isn't a string or bytes is
  // written as JSON, and the first write runs _onBeforeFirstWrite.
  const write = stream.write.bind(stream);
  let written = false;
  stream.write = (chunk, ...rest) => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      chunk = JSON.stringify(chunk);
    }
    if (!written) {
      written = true;
      stream._onBeforeFirstWrite?.();
    }
    return write(chunk, ...rest);
  };
  // In Lambda, an error on the response stream rejects a promise nothing
  // awaits, and Node exits. A failed response has to reject the handler.
  let streamError;
  stream.on("error", (error) => {
    streamError = error;
  });
  const finished = new Promise((resolve) => {
    stream.on("finish", resolve);
    stream.on("close", resolve);
  });
  await handler(event, stream);
  await finished;
  if (streamError) {
    throw new Error(
      `The response stream got an error, which crashes Lambda's runtime: ${streamError.message}`
    );
  }
  const raw = Buffer.concat(chunks);
  const headers = stream.metadata?.headers ?? {};
  return {
    statusCode: stream.metadata?.statusCode,
    headers,
    cookies: stream.metadata?.cookies,
    body:
      headers["content-encoding"] === "gzip" ? zlib.gunzipSync(raw) : raw,
  };
}

/** API Gateway v2 (HTTP API) event */
function v2(
  rawPath,
  { method = "GET", query = "", headers = {}, cookies, body, b64 = false } = {}
) {
  return {
    version: "2.0",
    rawPath,
    rawQueryString: query,
    cookies,
    headers: { host: HOST, ...headers },
    requestContext: { http: { method, sourceIp: "203.0.113.9" } },
    body,
    isBase64Encoded: b64,
  };
}

/**
 * @param {object} options
 * @param {string} options.name label for the report, e.g. "Astro 5"
 * @param {string} options.fixtureDir folder name under test/
 * @param {string} options.importName the name the fixture imports the adapter
 *   by: "astro-sst", the alias `sst init` writes, or "@sst-community/astro-sst"
 * @param {boolean} options.polyfills whether the handler installs Astro 5's
 *   Node polyfills
 * @param {string} [options.fetchFile] a custom fetch handler in the fixture's
 *   src/, built as a third variant
 */
export function defineSuite({ name, fixtureDir, importName, polyfills, fetchFile }) {
  const fixture = path.join(root, "test", fixtureDir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astro-sst-"));
  const handlers = {};

  describe(name, () => {
    before(async () => {
      assert.ok(
        fs.existsSync(path.join(root, "dist", "adapter.js")),
        "run `npm run build` first"
      );

      const p = run(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", tmp],
        root
      );
      assert.equal(p.status, 0, p.out);
      const tarball = path.join(tmp, p.stdout.trim().split("\n").pop());

      if (!fs.existsSync(path.join(fixture, "node_modules"))) {
        // `npm ci` installs exactly what the fixture's lockfile pins.
        const i = run("npm", ["ci", "--no-audit", "--no-fund"], fixture);
        assert.equal(i.status, 0, i.out);
      }
      // Remove the copy from an earlier run, so npm can't keep it.
      fs.rmSync(path.join(fixture, "node_modules", importName), {
        recursive: true,
        force: true,
      });
      const a = run(
        "npm",
        ["install", "--no-save", "--no-audit", "--no-fund", `${importName}@file:${tarball}`],
        fixture
      );
      assert.equal(a.status, 0, a.out);

      const variants = [
        { key: "buffer", env: { OUT_DIR: "dist", RESPONSE_MODE: "buffer" } },
        { key: "stream", env: { OUT_DIR: "dist-stream", RESPONSE_MODE: "stream" } },
      ];
      if (fetchFile) {
        variants.push({
          key: "fetch",
          env: { OUT_DIR: "dist-fetch", RESPONSE_MODE: "buffer", FETCH_FILE: fetchFile },
        });
      }
      for (const { key, env } of variants) {
        const b = run("npx", ["astro", "build"], fixture, env);
        assert.equal(b.status, 0, b.out);
        const bundled = path.join(tmp, key, "index.mjs");
        await bundle(path.join(fixture, env.OUT_DIR, "server", "entry.mjs"), bundled);
        handlers[key] = (await import(bundled)).handler;
      }

      // sst.aws.Astro copies 404.html next to the bundle, and runs from there.
      fs.copyFileSync(
        path.join(fixture, "dist", "server", "404.html"),
        path.join(tmp, "404.html")
      );
      process.chdir(tmp);
    });

    describe("build output (what sst.aws.Astro reads)", () => {
      const meta = (outDir) =>
        JSON.parse(
          fs.readFileSync(path.join(fixture, outDir, "sst.buildMeta.json"), "utf8")
        );

      it("writes entry.mjs, which exports the handler", () => {
        assert.ok(fs.existsSync(path.join(fixture, "dist/server/entry.mjs")));
        assert.equal(typeof handlers.buffer, "function");
        assert.equal(typeof handlers.stream, "function");
      });

      it("writes sst.buildMeta.json with the fields the component reads", () => {
        const m = meta("dist");
        assert.equal(m.pluginVersion, pkg.version);
        assert.equal(m.outputMode, "server");
        assert.equal(m.base, "/");
        assert.equal(m.responseMode, "buffer");
        assert.equal(m.clientBuildOutputDir, "dist/client");
        assert.equal(m.clientBuildVersionedSubDir, "_astro");
        assert.equal(meta("dist-stream").responseMode, "stream");
      });

      it("has a pluginVersion the component accepts (3.1.2 or later)", () => {
        const [major, minor, patch] = meta("dist").pluginVersion.split(".").map(Number);
        assert.ok(
          major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 2))),
          meta("dist").pluginVersion
        );
      });

      it("copies the prerendered 404.html into the server output", () => {
        assert.equal(
          fs.readFileSync(path.join(fixture, "dist/server/404.html"), "utf8"),
          fs.readFileSync(path.join(fixture, "dist/client/404.html"), "utf8")
        );
      });
    });

    describe("Node globals", () => {
      // Node 18 has no `crypto` or `File` global. Remove them, as on Node 18,
      // and check the bundled handler puts them back before Astro starts.
      it(
        "sets crypto and File when the runtime lacks them",
        { skip: !polyfills && "Astro 6 and later require Node 22.12+, which has both globals" },
        () => {
          const code = [
            "delete globalThis.File;",
            "delete globalThis.crypto;",
            `await import(${JSON.stringify(pathToFileURL(path.join(tmp, "buffer", "index.mjs")).href)});`,
            "console.log(JSON.stringify({ File: typeof globalThis.File, crypto: typeof globalThis.crypto?.getRandomValues }));",
          ].join("\n");
          const r = run(process.execPath, ["--input-type=module", "-e", code], tmp);
          assert.equal(r.status, 0, r.out);
          const last = r.stdout.trim().split("\n").pop();
          assert.deepEqual(JSON.parse(last), { File: "function", crypto: "function" });
        }
      );
    });

    describe("buffered responses", () => {
      const call = (event) => handlers.buffer(event);

      it("renders a server page with the query string and cookies", async () => {
        const r = await call(v2("/ssr", { query: "name=Ada", cookies: ["visits=4"] }));
        assert.equal(r.statusCode, 200);
        assert.match(r.headers["content-type"], /text\/html/);
        assert.match(r.body, /Hello Ada/);
        assert.match(r.body, /visits: 5/);
        assert.ok(r.cookies.some((c) => c.startsWith("visits=5")), JSON.stringify(r.cookies));
      });

      it("passes route params to a dynamic page", async () => {
        const r = await call(v2("/blog/first-post"));
        assert.equal(r.statusCode, 200);
        assert.match(r.body, /post: first-post/);
      });

      it("sends several cookies in `cookies`, not in headers", async () => {
        const r = await call(v2("/api/cookies"));
        assert.equal(r.statusCode, 200);
        assert.deepEqual(r.cookies.map((c) => c.split(";")[0]).sort(), ["a=1", "b=2"]);
        assert.equal(r.headers["set-cookie"], undefined);
      });

      it("keeps each cookie's attributes as the app set them", async () => {
        const r = await call(v2("/api/cookies"));
        const a = r.cookies.find((c) => c.startsWith("a="));
        assert.match(a, /Max-Age=3600/i);
        assert.match(a, /HttpOnly/i);
        assert.match(a, /SameSite=Lax/i);
      });

      it("passes a JSON POST body and the client address through", async () => {
        const r = await call(
          v2("/api/echo", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"a":1}',
          })
        );
        assert.equal(r.statusCode, 200);
        assert.deepEqual(JSON.parse(r.body), {
          method: "POST",
          contentType: "application/json",
          body: '{"a":1}',
          ip: "203.0.113.9",
        });
      });

      const echoIp = async (headers) => {
        const r = await call(
          v2("/api/echo", {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: "{}",
          })
        );
        return JSON.parse(r.body).ip;
      };

      it("takes the client address from CloudFront-Viewer-Address", async () => {
        // A client can send its own X-Forwarded-For, which CloudFront passes
        // on; CloudFront-Viewer-Address is set by CloudFront.
        assert.equal(
          await echoIp({
            "x-forwarded-for": "203.0.113.66",
            "cloudfront-viewer-address": "198.51.100.7:44321",
          }),
          "198.51.100.7"
        );
        assert.equal(await echoIp({ "cloudfront-viewer-address": "2001:db8::7:44321" }), "2001:db8::7");
        assert.equal(await echoIp({ "cloudfront-viewer-address": "[2001:db8::7]:44321" }), "2001:db8::7");
      });

      it("ignores X-Forwarded-For without CloudFront, and uses the source IP", async () => {
        assert.equal(await echoIp({ "x-forwarded-for": "203.0.113.66" }), "203.0.113.9");
      });

      it("decodes a base64 request body", async () => {
        const body = Buffer.from("héllo").toString("base64");
        const r = await call(
          v2("/api/echo", {
            method: "POST",
            headers: { "content-type": "text/plain", origin: `https://${HOST}` },
            body,
            b64: true,
          })
        );
        assert.equal(r.statusCode, 200);
        assert.equal(JSON.parse(r.body).body, "héllo");
      });

      it("rejects a cross-origin form POST with 403", async () => {
        const r = await call(
          v2("/api/echo", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: "https://evil.test",
            },
            body: "a=1",
          })
        );
        assert.equal(r.statusCode, 403);
      });

      it("builds the request URL from x-forwarded-host", async () => {
        const r = await call(
          v2("/api/echo", {
            method: "POST",
            headers: {
              host: "abc.lambda-url.us-east-1.on.aws",
              "x-forwarded-host": HOST,
              "content-type": "application/x-www-form-urlencoded",
              origin: `https://${HOST}`,
            },
            body: "a=1",
          })
        );
        assert.equal(r.statusCode, 200);
      });

      it("returns binary responses as base64 without corrupting the bytes", async () => {
        const r = await call(v2("/api/binary"));
        assert.equal(r.isBase64Encoded, true);
        assert.deepEqual(
          [...Buffer.from(r.body, "base64")],
          [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]
        );
      });

      it("returns any type that isn't text as base64, such as AVIF", async () => {
        const r = await call(v2("/api/avif"));
        assert.equal(r.isBase64Encoded, true);
        assert.deepEqual(
          [...Buffer.from(r.body, "base64")],
          [0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x80]
        );
      });

      it("returns a redirect with its Location header", async () => {
        const r = await call(v2("/go"));
        assert.equal(r.statusCode, 302);
        assert.equal(r.headers.location, "/ssr?name=redirected");
      });

      it("returns 500 when a route throws", async () => {
        const r = await call(v2("/boom"));
        assert.equal(r.statusCode, 500);
      });

      it("returns a response with no body", async () => {
        const r = await call(v2("/api/empty"));
        assert.equal(r.statusCode, 204);
        assert.equal(r.headers["x-empty"], "yes");
        assert.equal(r.body, "");
      });

      it("serves the prerendered 404.html for an unknown route", async () => {
        const r = await call(v2("/nope"));
        assert.equal(r.statusCode, 404);
        assert.match(r.headers["content-type"], /text\/html/);
        assert.match(r.body, /Custom not found/);
      });

      it("serves the prerendered 404.html when a page returns an empty 404", async () => {
        const r = await call(v2("/blog/missing"));
        assert.equal(r.statusCode, 404);
        assert.match(r.body, /Custom not found/);
      });

      it("redirects a trailing slash, as trailingSlash: never asks", async () => {
        const r = await call(v2("/ssr/", { query: "name=Ada" }));
        assert.equal(r.statusCode, 301);
        assert.equal(r.headers.location, "/ssr?name=Ada");
      });

      it("accepts API Gateway v1 (REST API) events", async () => {
        const r = await call({
          httpMethod: "GET",
          path: "/api/echo",
          queryStringParameters: { x: "1" },
          multiValueQueryStringParameters: null,
          headers: { host: HOST },
          multiValueHeaders: {},
          requestContext: { identity: { sourceIp: "203.0.113.9" } },
          body: null,
        });
        assert.equal(r.statusCode, 200);
        assert.deepEqual(JSON.parse(r.body), { query: { x: "1" } });
      });

      /** CloudFront (Lambda@Edge) origin request event */
      const cf = (uri, { querystring = "", cookie } = {}) => ({
        Records: [
          {
            cf: {
              request: {
                method: "GET",
                uri,
                querystring,
                headers: {
                  host: [{ key: "host", value: HOST }],
                  ...(cookie && { cookie: [{ key: "cookie", value: cookie }] }),
                },
                clientIp: "203.0.113.9",
              },
            },
          },
        ],
      });

      it("accepts CloudFront (Lambda@Edge) events, cookies included", async () => {
        const r = await call(cf("/ssr", { querystring: "name=Edge", cookie: "visits=4" }));
        assert.equal(r.status, "200");
        assert.match(r.body, /Hello Edge/);
        assert.match(r.body, /visits: 5/);
        assert.ok(
          r.headers["set-cookie"]?.some((h) => h.value.startsWith("visits=5")),
          JSON.stringify(r.headers)
        );
      });

      it("leaves a CloudFront response's status text to CloudFront", async () => {
        const r = await call(cf("/nope"));
        assert.equal(r.status, "404");
        assert.equal(r.statusDescription, undefined);
        assert.equal(r.headers["set-cookie"], undefined);
      });
    });

    describe("streamed responses", () => {
      const call = (event) => callStreaming(handlers.stream, event);

      it("streams a server page, gzipped, with its status, headers and cookies", async () => {
        const r = await call(
          v2("/ssr", {
            query: "name=Ada",
            cookies: ["visits=4"],
            headers: { "accept-encoding": "gzip, deflate, br" },
          })
        );
        assert.equal(r.statusCode, 200);
        assert.match(r.headers["content-type"], /text\/html/);
        assert.equal(r.headers["content-encoding"], "gzip");
        assert.match(r.body.toString(), /Hello Ada/);
        assert.ok(r.cookies?.some((c) => c.startsWith("visits=5")), JSON.stringify(r));
      });

      it("doesn't gzip for a client that doesn't accept it", async () => {
        for (const acceptEncoding of [undefined, "identity", "br", "gzip;q=0"]) {
          const headers = acceptEncoding ? { "accept-encoding": acceptEncoding } : {};
          const r = await call(v2("/ssr", { query: "name=Ada", headers }));
          assert.equal(r.headers["content-encoding"], undefined, acceptEncoding);
          assert.match(r.body.toString(), /Hello Ada/);
        }
      });

      it("sends each cookie on its own, attributes included", async () => {
        const r = await call(v2("/api/cookies"));
        assert.deepEqual(r.cookies?.map((c) => c.split(";")[0]).sort(), ["a=1", "b=2"]);
        assert.match(r.cookies.find((c) => c.startsWith("a=")), /Max-Age=3600/i);
        assert.equal(r.headers["set-cookie"], undefined);
      });

      it("streams binary responses without gzip or corruption", async () => {
        const r = await call(v2("/api/binary"));
        assert.equal(r.headers["content-encoding"], undefined);
        assert.deepEqual([...r.body], [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
        const avif = await call(v2("/api/avif"));
        assert.equal(avif.headers["content-encoding"], undefined);
        assert.deepEqual(
          [...avif.body],
          [0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x80]
        );
      });

      it("streams a large body whole and in order", async () => {
        const r = await call(v2("/api/large"));
        const lines = r.body.toString().trimEnd().split("\n");
        assert.equal(lines.length, 200);
        lines.forEach((line, i) => assert.ok(line.startsWith(String(i).padStart(4, "0")), `line ${i}`));
      });

      it("returns a body that fails partway as the handler's error", { timeout: 5000 }, async () => {
        // The handler rejecting is how Lambda's runtime learns the response
        // failed, without crashing.
        await assert.rejects(call(v2("/api/stream-error")), (error) => {
          assert.equal(error.message, "failed partway");
          return true;
        });
      });

      it("returns a redirect with its Location header", async () => {
        const r = await call(v2("/go"));
        assert.equal(r.statusCode, 302);
        assert.equal(r.headers.location, "/ssr?name=redirected");
        assert.equal(r.body.length, 0);
      });

      it("sends the status and headers of a response with no body", async () => {
        const r = await call(v2("/api/empty"));
        assert.equal(r.statusCode, 204);
        assert.equal(r.headers["x-empty"], "yes");
        assert.equal(r.headers["content-encoding"], undefined);
        assert.equal(r.body.length, 0);
      });

      it("serves the prerendered 404.html for an unknown route", async () => {
        const r = await call(v2("/nope"));
        assert.equal(r.statusCode, 404);
        assert.match(r.body.toString(), /Custom not found/);
      });

      it("serves the prerendered 404.html when a page returns an empty 404", async () => {
        const r = await call(v2("/blog/missing"));
        assert.equal(r.statusCode, 404);
        assert.match(r.body.toString(), /Custom not found/);
      });

      it("redirects a trailing slash, as trailingSlash: never asks", async () => {
        const r = await call(v2("/ssr/"));
        assert.equal(r.statusCode, 301);
        assert.equal(r.headers.location, "/ssr");
      });
    });

    describe("a custom fetch handler (src/fetch.ts)", () => {
      const skip = !fetchFile && "this fixture has no custom fetch handler";

      it("gets requests that match no route", { skip }, async () => {
        const r = await handlers.fetch(v2("/from-fetch"));
        assert.equal(r.statusCode, 200);
        assert.equal(r.body, "handled by src/custom-fetch.ts");
      });

      it("passes the rest to Astro, 404 page included", { skip }, async () => {
        const ok = await handlers.fetch(v2("/blog/first-post"));
        assert.match(ok.body, /post: first-post/);
        const missing = await handlers.fetch(v2("/nope"));
        assert.equal(missing.statusCode, 404);
        assert.match(missing.body, /Custom not found/);
      });
    });
  });
}
