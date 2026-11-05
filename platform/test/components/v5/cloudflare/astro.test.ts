import fs from "fs";
import path from "path";
import { expect, it } from "vitest";
import { ssrSiteSuite } from "./ssr-site.suite";

const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

// An Astro site, as Astro 6 builds it with Cloudflare's adapter: a Worker
// and a Wrangler config that says where its files are
ssrSiteSuite(
  {
    label: "Astro",
    load: async () => ({
      original: (
        await import("../../../fixtures/v4/components/cloudflare/astro")
      ).Astro,
      v5: (await import("../../../../src/components/cloudflare/astro")).Astro,
    }),
    write: (dir) => {
      write(
        dir,
        "package.json",
        JSON.stringify({ name: "web", dependencies: { astro: "^6.1.0" } }),
      );
      write(
        dir,
        "astro.config.mjs",
        "export default { adapter: cloudflare({ configPath: process.env.SST_WRANGLER_PATH }) };",
      );
      write(
        dir,
        "dist/server/wrangler.json",
        JSON.stringify({
          main: "entry.mjs",
          assets: { directory: "../client" },
        }),
      );
      write(dir, "dist/server/entry.mjs", "export default {};");
      write(dir, "dist/client/index.html", "<html>Home</html>");
    },
    built: { server: "dist/server/entry.mjs", assets: "dist/client" },
    config: "astro.config.mjs",
  },
  {
    // Astro 5 writes the Worker into the folder of files it serves
    cases: ({ app }) => {
      writeAstro5(path.join(app, "legacy"));
      return {
        "an Astro 5 site": {
          create: (Site, opts) =>
            new Site("Web", { path: "legacy", buildCommand: "true" }, opts),
          check: () =>
            expect(
              fs.readFileSync(
                path.join(app, "legacy", "dist", ".assetsignore"),
                "utf8",
              ),
            ).toContain("_worker.js"),
        },
      };
    },
    tests: ({ pulumi, Site, app, resource }) => {
      it("serves Astro 5's build, without the Worker's own code", async () => {
        writeAstro5(path.join(app, "five"));
        new (Site())("Web", { path: "five", buildCommand: "true" });
        await pulumi.settle();
        expect(resource("WebWorkerScript").inputs.assets.directory).toBe(
          path.join(app, "five", "dist"),
        );
        expect(pulumi.reportOf("WebWorker")).toMatchObject({
          function: { handler: "five/dist/_worker.js/index.js" },
        });
        const ignored = fs
          .readFileSync(path.join(app, "five", "dist", ".assetsignore"), "utf8")
          .split("\n");
        expect(ignored).toEqual(
          expect.arrayContaining(["_worker.js", "_routes.json"]),
        );
        // Written once
        new (Site())("Again", { path: "five", buildCommand: "true" });
        await pulumi.settle();
        expect(
          fs
            .readFileSync(
              path.join(app, "five", "dist", ".assetsignore"),
              "utf8",
            )
            .split("\n")
            .filter((line) => line === "_worker.js"),
        ).toHaveLength(1);
      });
    },
  },
);

// An Astro 5 site doesn't read SST's Wrangler config, so it isn't checked for
// one
function writeAstro5(dir: string) {
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "web", dependencies: { astro: "^5.2.0" } }),
  );
  write(dir, "astro.config.mjs", "export default {};");
  write(dir, "dist/_worker.js/index.js", "export default {};");
  write(dir, "dist/index.html", "<html>Home</html>");
}
