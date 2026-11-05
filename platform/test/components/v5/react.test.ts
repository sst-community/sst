import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { rejectionsOf } from "../../helpers/rejections";
import { ssrSiteSuite } from "./ssr-site.suite";

// A React Router app as React Router builds it, with a server or in SPA mode.
// `buildCommand: "true"` stands in for the build, so what it would have made
// is made here.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-react-")),
);
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.writeFileSync(path.join(app, file), content);
};
function writeSite(
  dir: string,
  options: {
    base?: string;
    basename?: string;
    spa?: boolean;
    ext?: string;
  } = {},
) {
  const ext = options.ext ?? "ts";
  write(`${dir}/package.json`, JSON.stringify({ name: "web" }));
  write(
    `${dir}/vite.config.${ext}`,
    options.base
      ? `export default { base: "${options.base}" };`
      : "export default {};",
  );
  write(
    `${dir}/react-router.config.${ext}`,
    options.basename
      ? `export default { basename: "${options.basename}" };`
      : "export default {};",
  );
  if (!options.spa)
    write(`${dir}/build/server/index.js`, "export const routes = {};");
  write(`${dir}/build/client/index.html`, "<html>App</html>");
  write(`${dir}/build/client/favicon.ico`, "ico");
  write(`${dir}/build/client/assets/entry-abc123.js`, "js");
}
// The sites are given from the app's folder, which the tests run in
const site = "web";
const based = "docs";
writeSite(site);
writeSite(based, { base: "/docs/", basename: "/docs" });
writeSite("spa", { spa: true });
writeSite("js", { base: "/docs/", basename: "/docs", ext: "js" });
writeSite("no-slash", { base: "/docs", basename: "/docs" });
writeSite("no-basename", { base: "/docs/" });
writeSite("slashed-basename", { base: "/docs/", basename: "/docs/" });
writeSite("no-base", { basename: "/docs" });
const cwd = process.cwd();
process.chdir(app);

// What 4.x kept in the state and the V5 site doesn't: the command that built
// it
const BUILDER = "command:local:Command::WebBuilder";

afterAll(() => {
  process.chdir(cwd);
  fs.rmSync(app, { recursive: true, force: true });
});

// What every site with a server passes, with React Router's build
ssrSiteSuite(
  {
    name: "React",
    site: "Web",
    load: async () => ({
      original: (await import("../../fixtures/v4/components/aws/react"))
        .React as any,
      v5: (await import("../../../src/components/aws/react")).React as any,
    }),
    paths: { site, based, app },
    // In SPA mode there's no server
    alwaysServes: false,
    each: { unclaimed: [BUILDER], changed: [] },
    created: [],
  },
  {
    cases: ({ expected }) => ({
      "in SPA mode": {
        create: (React, opts) =>
          new React("Web", { path: "spa", buildCommand: "true" }, opts),
        ...expected(),
      },
    }),
    tests: ({ pulumi, Site, names }) => {
      const server = () =>
        pulumi.graph().find((r) => r.name === "WebServerUseast1")!;

      it("wraps the server build in a Lambda handler", async () => {
        new (Site())("Web", { path: site, buildCommand: "true" });
        await pulumi.settle();
        expect(server().build).toMatchObject({
          handler: path.join(site, "build", "server.handler"),
        });
        expect(
          fs.readFileSync(path.join(app, site, "build", "server.mjs"), "utf8"),
        ).toContain(`import * as serverBuild from "./server/index.js";`);
      });

      it("has no server in SPA mode, and serves the app for every path", async () => {
        const web = new (Site())("Web", {
          path: "spa",
          buildCommand: "true",
          warm: 1,
        });
        await pulumi.settle();
        expect(Object.keys(web.nodes.server)).toEqual([]);
        expect(names()).not.toContain("WebServerUseast1");
        const { entries } = pulumi.resources.find(
          (r) => r.name === "WebKvKeys",
        )!.inputs;
        const metadata = Object.entries(entries).find(([key]) =>
          key.endsWith("metadata"),
        )![1] as string;
        expect(JSON.parse(metadata).custom404).toBe("/index.html");
      });

      it("reads the base path from configs in another extension", async () => {
        const { Router } = await import("../../../src/components/aws/router");
        new (Site())("Web", {
          path: "js",
          buildCommand: "true",
          router: { instance: new Router("Router"), path: "/docs" },
        });
        await pulumi.settle();
        expect(names()).toContain("WebServerUseast1");
      });

      it("refuses a base path set in one config and not the other, or with the wrong slash", async () => {
        for (const [dir, message] of [
          [
            "no-slash",
            /The "base" in the Vite config of the "Web" React site is "\/docs"\. End it with a "\/": "\/docs\/"\./,
          ],
          [
            "no-basename",
            /The "Web" React site sets "base" in its Vite config and no "basename" in its react-router\.config\. Set "basename" to "\/docs" too\./,
          ],
          [
            "slashed-basename",
            /The "basename" in the react-router\.config of the "Web" React site is "\/docs\/"\. Leave out the "\/" at its end: "\/docs"\./,
          ],
          [
            "no-base",
            /The "Web" React site sets "basename" in its react-router\.config and no "base" in its Vite config\. Set "base" to "\/docs\/" too\./,
          ],
        ] as const) {
          const failures = await rejectionsOf(async () => {
            new (Site())("Web", { path: dir, buildCommand: "true" });
            await pulumi.settle();
          });
          expect(new Set(failures).size).toBe(1);
          expect((failures[0] as Error).message).toMatch(message);
          expect((failures[0] as Error).constructor.name).toBe("VisibleError");
          pulumi.reset();
        }
      });
    },
  },
);
