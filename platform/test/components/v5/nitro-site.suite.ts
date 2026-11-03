import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { rejectionsOf } from "../../helpers/rejections";
import { ssrSiteSuite } from "./ssr-site.suite";

// The tests of a Nuxt, SolidStart or Analog site, run by each one's test
// file: an app as Nitro's "aws-lambda" preset builds it, with
// `buildCommand: "true"` standing in for the build, so what it would have made
// is made here. TanStack Start, also built by Nitro, has its own tests.

/** A framework whose apps Nitro builds. */
export interface NitroFramework {
  /** The component: `Nuxt`. */
  name: string;
  /** The component's file, in `aws/` and `aws/v5/`: `nuxt`. */
  file: string;
  /** Where Nitro builds to, in the site's folder: `.output`. */
  output: string;
  /** The config file the base path is read from. */
  config: string;
  /** That config file, setting the base path. */
  base: (base: string) => string;
}

// What 4.x kept in the state and the V5 site doesn't: the command that built
// it
const BUILDER = "command:local:Command::WebBuilder";

export function nitroSiteTests(f: NitroFramework) {
  const app = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `sst-${f.file}-`)),
  );
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    fs.writeFileSync(path.join(app, file), content);
  };
  const writeSite = (
    dir: string,
    options: {
      base?: string;
      streaming?: boolean;
      preset?: string;
      config?: string;
    } = {},
  ) => {
    write(`${dir}/package.json`, JSON.stringify({ name: "web" }));
    write(
      `${dir}/${options.config ?? f.config}`,
      options.base ? f.base(options.base) : "export default {};",
    );
    write(
      `${dir}/${f.output}/nitro.json`,
      JSON.stringify({
        preset: options.preset ?? "aws-lambda",
        config: options.streaming ? { awsLambda: { streaming: true } } : {},
      }),
    );
    write(
      `${dir}/${f.output}/server/index.mjs`,
      "export const handler = async () => ({});",
    );
    write(`${dir}/${f.output}/public/favicon.ico`, "ico");
    write(`${dir}/${f.output}/public/_build/main-abc123.js`, "js");
    write(`${dir}/${f.output}/public/about/index.html`, "<html>About</html>");
    write(
      `${dir}/${f.output}/public/_server/index.html`,
      "<html>Server</html>",
    );
  };
  // The sites are given from the app's folder, which the tests run in
  writeSite("web");
  writeSite("docs", { base: "/docs" });
  writeSite("streaming", { streaming: true });
  const cwd = process.cwd();
  process.chdir(app);

  afterAll(() => {
    process.chdir(cwd);
    fs.rmSync(app, { recursive: true, force: true });
  });

  const streamingCase = (Site: any, opts: any) =>
    new Site("Web", { path: "streaming", buildCommand: "true" }, opts);

  // What every site with a server passes, with the framework's build
  ssrSiteSuite(
    {
      name: f.name,
      site: "Web",
      load: async () => ({
        original: (await import(`../../../src/components/aws/${f.file}.ts`))[
          f.name
        ],
        v5: (await import(`../../../src/components/aws/v5/${f.file}.ts`))[
          f.name
        ],
      }),
      paths: { site: "web", based: "docs", app },
      alwaysServes: true,
      each: { unclaimed: [BUILDER], changed: [] },
      created: [],
    },
    {
      cases: ({ expected }) => ({
        "with a streaming server": {
          create: streamingCase,
          // SST 4 didn't read Nitro's streaming for Analog
          ...(f.name === "Analog"
            ? expected({ changed: [["WebServerUseast1Url", ["invokeMode"]]] })
            : expected()),
        },
      }),
      tests: ({ pulumi, Site, resource, names }) => {
        const server = () =>
          pulumi.graph().find((r) => r.name === "WebServerUseast1")!;

        it("builds its server from Nitro's output, streaming when Nitro says so", async () => {
          new (Site())("Web", { path: "streaming", buildCommand: "true" });
          await pulumi.settle();
          expect(server().build).toMatchObject({
            handler: "index.handler",
            bundle: path.join("streaming", f.output, "server"),
          });
          expect(resource("WebServerUseast1Url").inputs.invokeMode).toBe(
            "RESPONSE_STREAM",
          );
        });

        it("has no invalidation of versioned files, which Nitro's build doesn't have", async () => {
          new (Site())("Web", {
            path: "web",
            buildCommand: "true",
            invalidation: { paths: "versioned" },
          });
          await pulumi.settle();
          expect(
            names().filter((n) => n.startsWith("WebInvalidation")),
          ).toEqual([]);
        });

        it("refuses a build without Nitro's aws-lambda preset, saying where to set it", async () => {
          writeSite("node", { preset: "node-server" });
          const failures = await rejectionsOf(async () => {
            new (Site())("Web", { path: "node", buildCommand: "true" });
            await pulumi.settle();
          });
          expect(new Set(failures).size).toBe(1);
          const message = (failures[0] as Error).message;
          expect(message).toMatch(
            new RegExp(`No AWS-Lambda preset detected for ${f.name}`),
          );
          expect(message).toMatch(/preset: "aws-lambda"/);
          expect(message).toMatch(/Detected preset: "node-server"/);
          expect(names()).not.toContain("WebServerUseast1");
        });

        it("takes the preset's name in Nitro's other spelling", async () => {
          writeSite("snake", { preset: "aws_lambda" });
          new (Site())("Web", { path: "snake", buildCommand: "true" });
          await pulumi.settle();
          expect(names()).toContain("WebServerUseast1");
        });

        it("reads the base path from a config in another extension", async () => {
          writeSite("mjs", {
            base: "/docs",
            config: f.config.replace(/\.ts$/, ".mjs"),
          });
          const { Router } = await import(
            "../../../src/components/aws/v5/router"
          );
          const failures = await rejectionsOf(async () => {
            new (Site())("Web", {
              path: "mjs",
              buildCommand: "true",
              router: { instance: new Router("Router"), path: "/docs" },
            });
            await pulumi.settle();
          });
          expect(failures).toEqual([]);
          expect(names()).toContain("WebServerUseast1");
        });

        if (f.name === "SolidStart")
          it("sends what's under _server to the server", async () => {
            // A site no other test has built, so its folder is still there
            writeSite("fresh");
            new (Site())("Web", { path: "fresh", buildCommand: "true" });
            await pulumi.settle();
            expect(
              fs.existsSync(
                path.join(app, "fresh", f.output, "public/_server"),
              ),
            ).toBe(false);
          });
      },
    },
  );
}
