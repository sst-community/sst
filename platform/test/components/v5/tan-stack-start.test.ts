import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { rejectionsOf } from "../../helpers/rejections";
import { ssrSiteSuite } from "./ssr-site.suite";

// A TanStack Start app as Nitro's "aws-lambda" preset builds it.
// `buildCommand: "true"` stands in for the build, so what it would have made
// is made here.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-tan-stack-start-")),
);
function writeSite(
  dir: string,
  options: {
    base?: string;
    streaming?: boolean;
    preset?: string;
    nitro3?: boolean;
  } = {},
) {
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(app, dir, file)), { recursive: true });
    fs.writeFileSync(path.join(app, dir, file), content);
  };
  write("package.json", JSON.stringify({ name: "web" }));
  write("vite.config.ts", "export default {};");
  write(
    ".output/nitro.json",
    JSON.stringify({
      preset: options.preset ?? "aws-lambda",
      config: options.streaming ? { awsLambda: { streaming: true } } : {},
    }),
  );
  write(".output/server/index.mjs", "export const handler = async () => ({});");
  // Where Nitro 3 puts the server's code, or before it
  write(
    options.nitro3
      ? ".output/server/_ssr/ssr.mjs"
      : ".output/server/chunks/_/server.mjs",
    `const ROUTER_BASEPATH = "${options.base ?? "/"}";`,
  );
  write(".output/public/favicon.ico", "ico");
  write(".output/public/assets/main-abc123.js", "js");
  // What the server answers, which the build also leaves in the client's
  // files
  write(".output/public/_server/index.html", "<html>Server</html>");
  write(".output/public/api/index.html", "<html>Api</html>");
}
// The sites are given from the app's folder, which the tests run in
const site = "web";
const based = "docs";
const streaming = "streaming";
const vinxi = "vinxi";
writeSite(site);
writeSite(based, { base: "/docs" });
writeSite(streaming, { streaming: true });
const cwd = process.cwd();
process.chdir(app);

// What 4.x kept in the state and the V5 site doesn't: the command that built
// it
const BUILDER = "command:local:Command::WebBuilder";

afterAll(() => {
  process.chdir(cwd);
  fs.rmSync(app, { recursive: true, force: true });
});

// What every site with a server passes, with TanStack Start's build
ssrSiteSuite(
  {
    name: "TanStackStart",
    site: "Web",
    load: async () => ({
      original: (await import("../../../src/components/aws/tan-stack-start"))
        .TanStackStart as any,
      v5: (await import("../../../src/components/aws/v5/tan-stack-start"))
        .TanStackStart as any,
    }),
    paths: { site, based, app },
    alwaysServes: true,
    each: { unclaimed: [BUILDER], changed: [] },
    created: [],
  },
  {
    cases: ({ expected }) => ({
      "with a streaming server": {
        create: (TanStackStart, opts) =>
          new TanStackStart(
            "Web",
            { path: streaming, buildCommand: "true" },
            opts,
          ),
        ...expected(),
      },
    }),
    tests: ({ pulumi, Site, resource, names }) => {
      const server = () =>
        pulumi.graph().find((r) => r.name === "WebServerUseast1")!;

      it("builds its server from Nitro's output, streaming when Nitro says so", async () => {
        new (Site())("Web", { path: streaming, buildCommand: "true" });
        await pulumi.settle();
        expect(server().build).toMatchObject({
          handler: "index.handler",
          bundle: path.join(app, streaming, ".output", "server"),
        });
        expect(resource("WebServerUseast1Function").inputs.description).toBe(
          "Server handler for TanStack",
        );
        expect(resource("WebServerUseast1Url").inputs.invokeMode).toBe(
          "RESPONSE_STREAM",
        );
      });

      it("sends what's under _server and api to the server", async () => {
        // A site no other test has built, so its folders are still there
        writeSite("fresh");
        new (Site())("Web", { path: "fresh", buildCommand: "true" });
        await pulumi.settle();
        for (const dir of ["_server", "api"])
          expect(
            fs.existsSync(path.join(app, "fresh", ".output/public", dir)),
          ).toBe(false);
        const files = JSON.stringify(
          pulumi.resources.find((r) => r.name === "WebAssetFiles")!.inputs,
        );
        expect(files).toContain("favicon.ico");
        expect(files).not.toContain("_server");
      });

      it("reads the base path where Nitro 3 puts the server's code", async () => {
        writeSite("nitro3", { base: "/docs", nitro3: true });
        const { Router } = await import(
          "../../../src/components/aws/v5/router"
        );
        const failures = await rejectionsOf(async () => {
          new (Site())("Web", {
            path: "nitro3",
            buildCommand: "true",
            router: { instance: new Router("Router"), path: "/docs" },
          });
          await pulumi.settle();
        });
        expect(failures).toEqual([]);
        expect(names()).toContain("WebServerUseast1");
      });

      it("refuses a site Nitro didn't build", async () => {
        writeSite("unbuilt");
        fs.rmSync(path.join(app, "unbuilt", ".output"), { recursive: true });
        const failures = await rejectionsOf(async () => {
          new (Site())("Web", { path: "unbuilt", buildCommand: "true" });
          await pulumi.settle();
        });
        expect(new Set(failures).size).toBe(1);
        expect((failures[0] as Error).message).toMatch(
          /No Nitro build found at ".*unbuilt\/\.output\/nitro\.json"/,
        );
      });

      it("refuses a build without Nitro's aws-lambda preset, saying where to set it", async () => {
        writeSite("node-server", { preset: "node-server" });
        writeSite(vinxi, { preset: "node-server" });
        fs.rmSync(path.join(app, vinxi, "vite.config.ts"));
        for (const [dir, where] of [
          ["node-server", /vite\.config\.ts/],
          [vinxi, /app\.config\.ts/],
        ] as const) {
          const failures = await rejectionsOf(async () => {
            new (Site())("Web", { path: dir, buildCommand: "true" });
            await pulumi.settle();
          });
          expect(new Set(failures).size).toBe(1);
          const message = (failures[0] as Error).message;
          expect(message).toMatch(/No AWS-Lambda preset detected/);
          expect(message).toMatch(where);
          expect(message).toMatch(/Detected preset: "node-server"/);
          pulumi.reset();
        }
      });
    },
  },
);
