import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { rejectionsOf } from "../../helpers/rejections";
import { ssrSiteSuite } from "./ssr-site.suite";

// An Astro site as the "astro-sst" adapter builds it. `buildCommand: "true"`
// stands in for the build, so what it would have made is made here.
const app = fs.mkdtempSync(path.join(os.tmpdir(), "sst-astro-"));
// The server's 404 page is left out unless asked for: 4.x copies it into the
// server from the app's folder joined with its path, which is absolute here.
function writeSite(
  dir: string,
  meta: Record<string, unknown> = {},
  pkg: Record<string, unknown> = {},
  server404 = false,
) {
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  write("package.json", JSON.stringify({ name: "web", ...pkg }));
  write(
    "dist/sst.buildMeta.json",
    JSON.stringify({
      base: "/",
      pluginVersion: "4.0.0",
      outputMode: "server",
      responseMode: "buffer",
      clientBuildOutputDir: "dist/client",
      clientBuildVersionedSubDir: "_astro",
      routes: [
        { route: "/about", prerender: true },
        { route: "/api/[id]", prerender: false },
      ],
      ...meta,
    }),
  );
  write("dist/server/entry.mjs", "export const handler = async () => ({});");
  if (server404) write("dist/server/404.html", "<html>Not found</html>");
  write("dist/client/favicon.svg", "<svg></svg>");
  write("dist/client/_astro/index.abc123.css", "body{}");
  write("dist/client/about/index.html", "<html>About</html>");
  write("dist/client/404.html", "<html>Not found</html>");
}
const site = path.join(app, "web");
const based = path.join(app, "docs");
const statik = path.join(app, "static");
const staticDocs = path.join(app, "static-docs");
const streaming = path.join(app, "streaming");
writeSite(site);
writeSite(based, { base: "/docs" });
writeSite(statik, { outputMode: "static", routes: [] });
writeSite(staticDocs, { outputMode: "static", routes: [], base: "/docs" });
writeSite(streaming, { responseMode: "stream" });

// What 4.x kept in the state and the V5 site doesn't: the command that built
// it
const BUILDER = "command:local:Command::WebBuilder";

afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

// What every site with a server passes, with Astro's build
ssrSiteSuite(
  {
    name: "Astro",
    site: "Web",
    load: async () => ({
      original: (await import("../../fixtures/v4/components/aws/astro")).Astro,
      v5: (await import("../../../src/components/aws/astro")).Astro,
    }),
    paths: { site, based, app },
    alwaysServes: false,
    each: { unclaimed: [BUILDER], changed: [] },
    created: [],
  },
  {
    cases: ({ expected, Router }) => ({
      "a static site": {
        create: (Astro, opts) =>
          new Astro("Web", { path: statik, buildCommand: "true" }, opts),
        ...expected(),
      },
      "a static site, kept warm": {
        create: (Astro, opts) =>
          new Astro(
            "Web",
            { path: statik, buildCommand: "true", warm: 2 },
            opts,
          ),
        ...expected(),
      },
      "a static site under a path, behind a V5 Router": {
        create: (Astro, opts) => {
          const router = new (Router())("Router");
          return new Astro(
            "Web",
            {
              path: staticDocs,
              buildCommand: "true",
              router: { instance: router as any, path: "/docs" },
            },
            opts,
          );
        },
        ...expected(),
      },
      "with a streaming server": {
        create: (Astro, opts) =>
          new Astro("Web", { path: streaming, buildCommand: "true" }, opts),
        ...expected(),
      },
    }),
    tests: ({ pulumi, Site, names }) => {
      const server = () =>
        pulumi.graph().find((r) => r.name === "WebServerUseast1")!;

      it("builds its server from the adapter's entry, with sharp and the 404 page", async () => {
        const with404 = path.join(app, "with-404");
        writeSite(with404, {}, {}, true);
        new (Site())("Web", { path: with404, buildCommand: "true" });
        await pulumi.settle();
        const build = JSON.stringify(server().build);
        expect(build).toContain(
          JSON.stringify(path.join(with404, "dist/server/entry.handler")),
        );
        expect(build).toContain("sharp");
        expect(build).toContain("404.html");
      });

      it("has no server when the site is static, even kept warm", async () => {
        const web = new (Site())("Web", {
          path: statik,
          buildCommand: "true",
          warm: 2,
        });
        // Its region, as `undefined`, as SST 4's `nodes.server` was
        expect(Object.keys(web.nodes.server)).toEqual(["us-east-1"]);
        expect(await pulumi.resolve(web.nodes.server["us-east-1"])).toBeUndefined();
        await pulumi.settle();
        expect(Object.keys(web.nodes.server)).toEqual(["us-east-1"]);
        expect(Object.keys(web.nodes.warmer)).toEqual([]);
        expect(names()).not.toContain("WebServerUseast1");
        expect(names()).toEqual(
          expect.arrayContaining(["WebAssetFiles", "WebKvKeys", "WebCdn"]),
        );
      });

      it("builds with the site's own build script by default", async () => {
        const own = path.join(app, "own");
        writeSite(own, {}, { scripts: { build: "touch built-by-script" } });
        new (Site())("Web", { path: own });
        await pulumi.settle();
        expect(fs.existsSync(path.join(own, "built-by-script"))).toBe(true);
      });

      it("refuses SST's adapter 3.x with Astro 6 before it builds, given a command or not", () => {
        const old = path.join(app, "old-adapter");
        writeSite(old, {}, { dependencies: { "astro-sst": "^3.0.0" } });
        const dep = (name: string, version: string) => {
          const dir = path.join(old, "node_modules", name);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, "package.json"),
            JSON.stringify({ name, version }),
          );
        };
        dep("astro-sst", "3.1.0");
        dep("astro", "6.0.0");
        for (const buildCommand of ["touch built", undefined])
          expect(
            () => new (Site())("Web", { path: old, buildCommand }),
          ).toThrow(/doesn't support Astro 6 or later/);
        expect(fs.existsSync(path.join(old, "built"))).toBe(false);
      });

      it("refuses an adapter older than 3.1.2", async () => {
        const older = path.join(app, "older");
        writeSite(older, { pluginVersion: "3.0.0" });
        const failures = await rejectionsOf(async () => {
          new (Site())("Web", { path: older, buildCommand: "true" });
          await pulumi.settle();
        });
        expect(new Set(failures).size).toBe(1);
        expect((failures[0] as Error).message).toMatch(
          /requires "astro-sst" adapter version 3\.1\.2 or later/,
        );
      });
    },
  },
);
