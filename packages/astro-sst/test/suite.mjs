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
import { fileURLToPath } from "node:url";
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
// to streaming handlers.
globalThis.awslambda = {
  streamifyResponse: (handler) => handler,
  HttpResponseStream: {
    from(stream, metadata) {
      stream.metadata = metadata;
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
  const finished = new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  await handler(event, stream);
  await finished;
  const raw = Buffer.concat(chunks);
  const headers = stream.metadata?.headers ?? {};
  return {
    statusCode: stream.metadata?.statusCode,
    headers,
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
 */
export function defineSuite({ name, fixtureDir, importName }) {
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

      for (const mode of ["buffer", "stream"]) {
        const outDir = mode === "buffer" ? "dist" : "dist-stream";
        const b = run("npx", ["astro", "build"], fixture, {
          OUT_DIR: outDir,
          RESPONSE_MODE: mode,
        });
        assert.equal(b.status, 0, b.out);
        const bundled = path.join(tmp, mode, "index.mjs");
        await bundle(path.join(fixture, outDir, "server", "entry.mjs"), bundled);
        handlers[mode] = (await import(bundled)).handler;
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

      it("takes the client address from x-forwarded-for when CloudFront sets it", async () => {
        const r = await call(
          v2("/api/echo", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
            body: "{}",
          })
        );
        assert.equal(JSON.parse(r.body).ip, "198.51.100.7");
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

      it("returns a redirect with its Location header", async () => {
        const r = await call(v2("/go"));
        assert.equal(r.statusCode, 302);
        assert.equal(r.headers.location, "/ssr?name=redirected");
      });

      it("returns 500 when a route throws", async () => {
        const r = await call(v2("/boom"));
        assert.equal(r.statusCode, 500);
      });

      it("serves the prerendered 404.html for an unknown route", async () => {
        const r = await call(v2("/nope"));
        assert.equal(r.statusCode, 404);
        assert.match(r.headers["content-type"], /text\/html/);
        assert.match(r.body, /Custom not found/);
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

      it("accepts CloudFront (Lambda@Edge) events", async () => {
        const r = await call({
          Records: [
            {
              cf: {
                request: {
                  method: "GET",
                  uri: "/ssr",
                  querystring: "name=Edge",
                  headers: { host: [{ key: "host", value: HOST }] },
                  clientIp: "203.0.113.9",
                },
              },
            },
          ],
        });
        assert.equal(r.status, "200");
        assert.match(r.body, /Hello Edge/);
      });
    });

    describe("streamed responses", () => {
      const call = (event) => callStreaming(handlers.stream, event);

      it("streams a server page, gzipped, with its status, headers and cookies", async () => {
        const r = await call(v2("/ssr", { query: "name=Ada", cookies: ["visits=4"] }));
        assert.equal(r.statusCode, 200);
        assert.match(r.headers["content-type"], /text\/html/);
        assert.equal(r.headers["content-encoding"], "gzip");
        assert.match(r.body.toString(), /Hello Ada/);
        assert.match(r.headers["set-cookie"], /visits=5/);
      });

      it("streams binary responses without gzip or corruption", async () => {
        const r = await call(v2("/api/binary"));
        assert.equal(r.headers["content-encoding"], undefined);
        assert.deepEqual([...r.body], [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
      });

      it(
        "returns a redirect with its Location header",
        { todo: "3.1.4 writes the number 0 for an empty body, which Node streams reject" },
        async () => {
          const r = await call(v2("/go"));
          assert.equal(r.statusCode, 302);
          assert.equal(r.headers.location, "/ssr?name=redirected");
        }
      );

      it("serves the prerendered 404.html for an unknown route", async () => {
        const r = await call(v2("/nope"));
        assert.equal(r.statusCode, 404);
        assert.match(r.body.toString(), /Custom not found/);
      });
    });
  });
}
