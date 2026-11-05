import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

// An Astro site and a static site that's built. Each build writes its
// environment to a file, to see what it was given.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-cloudflare-site-preview-")),
);
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.writeFileSync(path.join(app, file), content);
};
write(
  "astro/package.json",
  JSON.stringify({ name: "astro", dependencies: { astro: "^6.1.0" } }),
);
write(
  "astro/astro.config.mjs",
  "export default { adapter: cloudflare({ configPath: process.env.SST_WRANGLER_PATH }) };",
);
write("astro/dist/server/wrangler.json", JSON.stringify({ main: "entry.mjs" }));
write("astro/dist/server/entry.mjs", "export default {};");
write("astro/dist/client/index.html", "<html>Home</html>");
write("vite/vite.config.ts", "export default {};");
write("vite/dist/index.html", "<html>Built</html>");

const bundle = path.join(app, ".bundle");
fs.mkdirSync(bundle);
fs.writeFileSync(path.join(bundle, "bundle.mjs"), "export default {};\n");

// A new stage's preview: everything is about to be created, so of each
// resource only what it was given is known, and nothing Cloudflare gives back,
// its id included
const pulumi = mockPulumi({
  root: app,
  preview: true,
  unknownId: () => true,
  state: (args) =>
    Object.fromEntries(
      ["id", "url", "etag", "scriptName"]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    ),
  cli: (method) =>
    method === "Runtime.Build"
      ? { handler: "bundle.mjs", out: bundle, errors: [] }
      : undefined,
});

afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

describe("Cloudflare sites in a new stage's preview", () => {
  it("are built without what isn't known, and plan the Worker a deploy creates", async () => {
    const { Astro } = await import(
      "../../../../src/components/cloudflare/astro"
    );
    const { StaticSite } = await import(
      "../../../../src/components/cloudflare/static-site"
    );
    const { Worker } = await import(
      "../../../../src/components/cloudflare/worker"
    );
    const { Linkable } = await import("../../../../src/components/linkable");
    const { Kv } = await import("../../../../src/components/cloudflare/kv");
    // What Cloudflare gives back, like a Worker's URL, isn't known
    const api = new Worker("Api", { handler: "src/api.mjs", url: true });
    const thing = new Linkable("Thing", {
      properties: { url: api.url, region: "weur" },
    });
    const kv = new Kv("MyKv");
    new Astro("Web", {
      path: "astro",
      buildCommand: "env > build-env.txt",
      environment: { API_URL: api.url as any, STAGE: "test" },
      link: [kv, thing],
    });
    new StaticSite("Docs", {
      path: "vite",
      build: { command: "env > build-env.txt", output: "dist" },
      environment: { VITE_API_URL: api.url as any, VITE_STAGE: "test" },
    });
    await pulumi.settle();

    // The Worker's URL isn't known, so the builds don't have it
    const envOf = (site: string) =>
      fs
        .readFileSync(path.join(app, site, "build-env.txt"), "utf8")
        .split("\n");
    expect(envOf("astro")).toContain("STAGE=test");
    expect(envOf("astro").some((line) => line.startsWith("API_URL="))).toBe(
      false,
    );
    expect(envOf("astro")).toContain(
      `SST_RESOURCE_Thing=${JSON.stringify({
        region: "weur",
        type: "sst.sst.Linkable",
      })}`,
    );
    expect(envOf("astro")).toContain(
      `SST_WRANGLER_PATH=${path.join(
        $cli.paths.work,
        "wrangler",
        "test",
        "Web.jsonc",
      )}`,
    );
    expect(envOf("vite")).toContain("VITE_STAGE=test");
    expect(envOf("vite").some((line) => line.startsWith("VITE_API_URL="))).toBe(
      false,
    );

    // Nor does the Wrangler config, which has the rest. The namespace isn't
    // created yet, so it has no id to bind, and its binding is left out.
    const wrangler = JSON.parse(
      fs.readFileSync(
        path.join($cli.paths.work, "wrangler", "test", "Web.jsonc"),
        "utf8",
      ),
    );
    expect(wrangler.vars).toEqual({
      STAGE: "test",
      SST_RESOURCE_App: JSON.stringify({ name: "app", stage: "test" }),
      SST_RESOURCE_Thing: JSON.stringify({ region: "weur" }),
    });
    expect(wrangler).not.toHaveProperty("kv_namespaces");

    // Each Worker is planned, with what its build made
    const script = (name: string) =>
      pulumi.resources.find((r) => r.name === name)!;
    expect(script("WebWorkerScript").inputs.assets.directory).toBe(
      path.join(app, "astro", "dist", "client"),
    );
    expect(script("DocsRouterScript").inputs.assets.directory).toBe(
      path.join(app, "vite", "dist"),
    );
  });
});
