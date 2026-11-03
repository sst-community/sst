import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { ssrSiteSuite } from "./ssr-site.suite";

// A SvelteKit app as the "svelte-kit-sst" adapter builds it.
// `buildCommand: "true"` stands in for the build, so what it would have made
// is made here.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-svelte-kit-")),
);
function writeSite(
  dir: string,
  options: { base?: string; streaming?: boolean; snakeCase?: boolean } = {},
) {
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(app, dir, file)), { recursive: true });
    fs.writeFileSync(path.join(app, dir, file), content);
  };
  const adapter = ".svelte-kit/svelte-kit-sst";
  const handler = "export const handler = async () => ({});";
  write("package.json", JSON.stringify({ name: "web" }));
  // SvelteKit 3 spells the manifest's fields in snake_case
  const [dirKey, pathKey] = options.snakeCase
    ? ["app_dir", "app_path"]
    : ["appDir", "appPath"];
  write(
    `${adapter}/server/manifest.js`,
    `export const manifest = { ${dirKey}: "_app", ${pathKey}: "${
      options.base ? `${options.base.slice(1)}/` : ""
    }_app" };`,
  );

  write(`${adapter}/server/lambda-handler/index.mjs`, handler);
  write(`${adapter}/server/lambda-handler/stream.mjs`, handler);
  if (options.streaming)
    write(`${adapter}/adapter.json`, JSON.stringify({ streaming: true }));
  write(`${adapter}/client/favicon.png`, "png");
  write(`${adapter}/client/_app/version.json`, '{"version":"1"}');
  write(`${adapter}/client/_app/immutable/entry/start.abc123.js`, "js");
  write(`${adapter}/prerendered/about.html`, "<html>About</html>");
}
// SST 4 copies the prerendered pages into the server from the app's folder
// joined with the site's path, so the sites are given from the app's folder,
// which the tests run in
const site = "web";
const based = "docs";
const streaming = "streaming";
writeSite(site);
writeSite(based, { base: "/docs", snakeCase: true });
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

// What every site with a server passes, with SvelteKit's build
ssrSiteSuite(
  {
    name: "SvelteKit",
    site: "Web",
    load: async () => ({
      original: (await import("../../../src/components/aws/svelte-kit"))
        .SvelteKit as any,
      v5: (await import("../../../src/components/aws/v5/svelte-kit"))
        .SvelteKit as any,
    }),
    paths: { site, based, app },
    alwaysServes: true,
    each: { unclaimed: [BUILDER], changed: [] },
    created: [],
  },
  {
    cases: ({ expected }) => ({
      "with a streaming server": {
        create: (SvelteKit, opts) =>
          new SvelteKit("Web", { path: streaming, buildCommand: "true" }, opts),
        ...expected(),
      },
    }),
    tests: ({ pulumi, Site }) => {
      const build = (name: string) =>
        JSON.stringify(pulumi.graph().find((r) => r.name === name)!.build);

      it("builds its server from the adapter's handler, with the prerendered pages", async () => {
        new (Site())("Web", { path: streaming, buildCommand: "true" });
        await pulumi.settle();
        const server = build("WebServerUseast1");
        expect(server).toContain(
          JSON.stringify(
            "streaming/.svelte-kit/svelte-kit-sst/server/lambda-handler/stream.handler",
          ),
        );
        expect(server).toContain(
          "/streaming/.svelte-kit/svelte-kit-sst/prerendered",
        );
      });
    },
  },
);
