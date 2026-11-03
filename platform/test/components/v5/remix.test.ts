import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { ssrSiteSuite } from "./ssr-site.suite";

// A Remix app as Remix's Vite plugin builds it, or Remix's own compiler.
// `buildCommand: "true"` stands in for the build, so what it would have made
// is made here.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-remix-")),
);
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.writeFileSync(path.join(app, file), content);
};
function writeSite(
  dir: string,
  options: {
    base?: string;
    buildDirectory?: string;
    vite?: string | false;
  } = {},
) {
  const build = options.buildDirectory ?? "build";
  write(`${dir}/package.json`, JSON.stringify({ name: "web" }));
  if (options.vite === false) {
    // Remix's own compiler
    write(`${dir}/build/index.js`, "export const routes = {};");
    write(`${dir}/public/favicon.ico`, "ico");
    write(`${dir}/public/build/entry-abc123.js`, "js");
    return;
  }
  write(
    `${dir}/${options.vite ?? "vite.config.ts"}`,
    options.base
      ? `export default { base: '${options.base}' };`
      : "export default {};",
  );
  write(`${dir}/${build}/server/index.js`, "export const routes = {};");
  write(`${dir}/${build}/client/favicon.ico`, "ico");
  write(`${dir}/${build}/client/assets/entry-abc123.js`, "js");
}
// The sites are given from the app's folder, which the tests run in
const site = "web";
const based = "docs";
writeSite(site);
writeSite(based, { base: "/docs/" });
writeSite("out", { buildDirectory: "out" });
writeSite("compiler", { vite: false });
writeSite("js", { base: "/docs/", vite: "vite.config.js" });
const cwd = process.cwd();
process.chdir(app);

// What 4.x kept in the state and the V5 site doesn't: the command that built
// it
const BUILDER = "command:local:Command::WebBuilder";

afterAll(() => {
  process.chdir(cwd);
  fs.rmSync(app, { recursive: true, force: true });
});

// What every site with a server passes, with Remix's build
ssrSiteSuite(
  {
    name: "Remix",
    site: "Web",
    load: async () => ({
      original: (await import("../../../src/components/aws/remix"))
        .Remix as any,
      v5: (await import("../../../src/components/aws/v5/remix")).Remix as any,
    }),
    paths: { site, based, app },
    alwaysServes: true,
    each: { unclaimed: [BUILDER], changed: [] },
    created: [],
  },
  {
    cases: ({ expected }) => ({
      "with its own build directory": {
        create: (Remix: any, opts) =>
          new Remix(
            "Web",
            { path: "out", buildCommand: "true", buildDirectory: "out" },
            opts,
          ),
        ...expected(),
      },
    }),
    tests: ({ pulumi, Site, names }) => {
      const server = () =>
        pulumi.graph().find((r) => r.name === "WebServerUseast1")!;

      it("wraps the server build in a Lambda handler, with the polyfills injected first", async () => {
        new (Site())("Web", { path: site, buildCommand: "true" });
        await pulumi.settle();
        expect(server().build).toMatchObject({
          handler: path.join(site, "build", "server.handler"),
        });
        expect(JSON.stringify(server().build)).toContain(
          JSON.stringify(path.join(app, site, "build", "polyfill.mjs")),
        );
        const wrapper = fs.readFileSync(
          path.join(app, site, "build", "server.mjs"),
          "utf8",
        );
        expect(wrapper).toContain(
          `import * as remixServerBuild from "./server/index.js";`,
        );
        expect(wrapper).toContain("createRequestHandler");
      });

      it("reads the build from its build directory", async () => {
        // `buildDirectory` is Remix's own, which the shared tests' type lacks
        new (Site() as any)("Web", {
          path: "out",
          buildCommand: "true",
          buildDirectory: "out",
        });
        await pulumi.settle();
        expect(server().build).toMatchObject({
          handler: path.join("out", "out", "server.handler"),
        });
        expect(fs.existsSync(path.join(app, "out", "out", "server.mjs"))).toBe(
          true,
        );
      });

      it("takes a build from Remix's own compiler", async () => {
        new (Site())("Web", { path: "compiler", buildCommand: "true" });
        await pulumi.settle();
        expect(server().build).toMatchObject({
          handler: path.join("compiler", "build", "server.handler"),
        });
        expect(
          fs.readFileSync(
            path.join(app, "compiler", "build", "server.mjs"),
            "utf8",
          ),
        ).toContain(`import * as remixServerBuild from "./index.js";`);
        expect(names()).toContain("WebAssetFiles");
      });

      it("reads the base path from a Vite config in another extension", async () => {
        const { Router } = await import(
          "../../../src/components/aws/v5/router"
        );
        new (Site())("Web", {
          path: "js",
          buildCommand: "true",
          router: { instance: new Router("Router"), path: "/docs" },
        });
        await pulumi.settle();
        expect(names()).toContain("WebServerUseast1");
      });

      it("refuses a build directory that isn't a plain value", () => {
        expect(
          () =>
            new (Site())("Web", {
              path: site,
              // @ts-expect-error
              buildDirectory: output("build"),
            }),
        ).toThrow(/"buildDirectory"/);
      });
    },
  },
);
