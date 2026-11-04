import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";
import { rejectionsOf } from "../../../helpers/rejections";

// A static site, and one that's built. SST 4 reads a site's folder from the
// folder the deploy runs in, so the tests run in the app's folder, and give
// each site from there.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-cloudflare-static-site-")),
);
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.writeFileSync(path.join(app, file), content);
};
write("web/index.html", "<html>Home</html>");
write("web/404.html", "<html>Not found</html>");
write("vite/package.json", JSON.stringify({ name: "vite" }));
write("vite/vite.config.ts", "export default {};");
write("vite/dist/index.html", "<html>Built</html>");
const cwd = process.cwd();
process.chdir(app);

// The CLI builds a Worker's code into one file: here, an empty one
const bundle = path.join(app, ".bundle");
fs.mkdirSync(bundle);
fs.writeFileSync(path.join(bundle, "bundle.mjs"), "export default {};\n");

const SCRIPT = "cloudflare:index/workersScript:WorkersScript";
const DOMAIN = "cloudflare:index/workersCustomDomain:WorkersCustomDomain";
// What SST 4 kept in the state and the V5 site doesn't: the command that built
// it, which has nothing in Cloudflare behind it
const BUILDER = "command:local:Command::WebBuilder";

const pulumi = mockPulumi({
  root: app,
  // A Worker's `workers.dev` URL, as Cloudflare gives it
  state: (args) =>
    (args.type === "pulumi-nodejs:dynamic:Resource" ||
      args.type === "sst:cloudflare:WorkerUrl") &&
    "scriptName" in args.inputs &&
    args.inputs.enabled === true
      ? { url: `${args.inputs.scriptName}.acme.workers.dev` }
      : {},
  cli: (method) =>
    method === "Runtime.Build"
      ? { handler: "bundle.mjs", out: bundle, errors: [] }
      : undefined,
});

type V5Class =
  typeof import("../../../../src/components/cloudflare/v5/static-site").StaticSite;
type OriginalClass =
  typeof import("../../../../src/components/cloudflare/static-site-v2").StaticSiteV2;
type AnyClass = V5Class | OriginalClass;

let Site: V5Class;
let OriginalSite: OriginalClass;

beforeAll(async () => {
  Site = (await import("../../../../src/components/cloudflare/v5/static-site"))
    .StaticSite;
  OriginalSite = (
    await import("../../../../src/components/cloudflare/static-site-v2")
  ).StaticSiteV2;
  await import("../../../../src/components/cloudflare/takeover/index");
});

afterAll(() => {
  process.chdir(cwd);
  fs.rmSync(app, { recursive: true, force: true });
});

beforeEach(() => {
  pulumi.reset();
  // @ts-ignore
  global.$dev = false;
  // @ts-ignore
  global.$cli.command = "deploy";
});

const resource = (name: string) =>
  pulumi.resources.find((r) => r.name === name)!;
const names = () => pulumi.resources.map((r) => r.name);
const ROUTER = (platform: string) =>
  path.join(platform, "functions", "cf-static-site-router-worker-experimental");

describe("takes over a deployed StaticSiteV2", () => {
  pulumi.takeoverCases<AnyClass, AnyClass>({
    original: () => OriginalSite,
    v5: () => Site,
    provider: "cloudflare",
    // SST 4 told the CLI how to run the site in `sst dev` from a deployed
    // site too. The V5 one says so only where it runs it.
    changed: [["Web", ["outputs"]]],
    check: () => expect(resource("WebRouterScript").type).toBe(SCRIPT),
    cases: {
      "a site": (Site, opts) => new Site("Web", { path: "web" }, opts),
      "a built site, with its environment": {
        create: (Site, opts) =>
          new Site(
            "Web",
            {
              path: "vite",
              build: { command: "true", output: "dist" },
              environment: { VITE_API_URL: "https://api.example.com" },
            },
            opts,
          ),
        unclaimed: [BUILDER],
      },
      "a site with trailing slashes and 404 pages": (Site, opts) =>
        new Site(
          "Web",
          { path: "web", trailingSlash: "force", notFound: "404" },
          opts,
        ),
      "a site with a domain, aliases and redirects": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            domain: {
              name: "app.example.com",
              aliases: ["app.example.net"],
              redirects: ["www.example.com"],
            },
          },
          opts,
        ),
      "a site whose Worker is transformed": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            transform: { server: { placement: { mode: "smart" } } },
          },
          opts,
        ),
    },
  });
});

it("serves its folder with SST's Worker", async () => {
  const site = new Site("Web", { path: "web" });
  await pulumi.settle();
  const script = resource("WebRouterScript");
  expect(script.inputs.assets).toMatchObject({
    directory: path.join(app, "web"),
    config: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "single-page-application",
    },
  });
  expect(pulumi.reportOf("WebRouter")).toMatchObject({
    function: { handler: ROUTER($cli.paths.platform) },
  });
  const url = `https://${script.inputs.scriptName}.acme.workers.dev`;
  // Only its URL: nothing for `sst dev`, where it isn't run
  expect(pulumi.reportOf("Web")).toEqual({ contract: 1, hint: url });
  expect(await new Promise((resolve) => output(site.url).apply(resolve))).toBe(
    url,
  );
  expect((site.link() as any).properties).toHaveProperty("url");
});

it("builds the site with its environment, and serves what it built", async () => {
  new Site("Web", {
    path: "vite",
    build: { command: "env > build-env.txt", output: "dist" },
    environment: { VITE_API_URL: "https://api.example.com" },
  });
  await pulumi.settle();
  const env = fs
    .readFileSync(path.join(app, "vite", "build-env.txt"), "utf8")
    .split("\n");
  expect(env).toContain("VITE_API_URL=https://api.example.com");
  expect(env).toContain("SST=1");
  expect(resource("WebRouterScript").inputs.assets.directory).toBe(
    path.join(app, "vite", "dist"),
  );
  // Vite's types for its environment
  expect(
    fs.readFileSync(path.join(app, "vite", "src", "sst-env.d.ts"), "utf8"),
  ).toContain("readonly VITE_API_URL: string");
  // The Worker has the environment too, as SST 4 gave it
  expect(
    resource("WebRouterScript").inputs.bindings.map((b: any) => b.name),
  ).toContain("VITE_API_URL");
});

it("takes how it serves pages as outputs", async () => {
  new Site("Web", {
    path: "web",
    trailingSlash: output("drop" as const),
    notFound: output("404" as const),
  });
  await pulumi.settle();
  expect(resource("WebRouterScript").inputs.assets.config).toMatchObject({
    htmlHandling: "drop-trailing-slash",
    notFoundHandling: "404-page",
  });
});

it("runs in sst dev", async () => {
  // @ts-ignore
  global.$dev = true;
  write("dev/vite.config.ts", "export default {};");
  const site = new Site("Web", {
    path: "dev",
    environment: { VITE_STAGE: "dev" },
  });
  await pulumi.settle();
  expect(names()).toEqual(["Web"]);
  expect(pulumi.reportOf("Web")).toEqual({
    contract: 1,
    dev: {
      command: "npm run dev",
      directory: "dev",
      autostart: true,
      environment: { VITE_STAGE: "dev" },
      links: [],
    },
  });
  expect(
    fs.readFileSync(path.join(app, "dev", "src", "sst-env.d.ts"), "utf8"),
  ).toContain("readonly VITE_STAGE: string");
  expect(() => site.nodes.server).toThrow(/runs locally there/);
});

it("is deployed in sst dev with dev: false, and isn't also run there", async () => {
  // @ts-ignore
  global.$dev = true;
  new Site("Web", { path: "web", dev: false });
  await pulumi.settle();
  expect(names()).toContain("WebRouterScript");
  expect(pulumi.reportOf("Web")?.dev).toBeUndefined();
});

it("isn't built for sst refresh, and leaves its Worker as it is", async () => {
  // @ts-ignore
  global.$cli.command = "refresh";
  new Site("Web", {
    path: "vite",
    build: { command: "touch refreshed.txt", output: "dist" },
  });
  await pulumi.settle();
  expect(names()).toEqual(["Web"]);
  expect(fs.existsSync(path.join(app, "vite", "refreshed.txt"))).toBe(false);
});

it("fails a deploy once, with the build's own message", async () => {
  const failures = await rejectionsOf(async () => {
    new Site("Web", {
      path: "vite",
      build: { command: "echo the reason >&2; exit 3", output: "dist" },
    });
    await pulumi.settle();
  });
  expect(new Set(failures).size).toBe(1);
  expect((failures[0] as Error).message).toBe(
    'Failed to build the "Web" site: `echo the reason >&2; exit 3` exited with 3.\nthe reason',
  );
});

it("fails a deploy once when the build has no output", async () => {
  const failures = await rejectionsOf(async () => {
    new Site("Web", {
      path: "vite",
      build: { command: "true", output: "missing" },
    });
    await pulumi.settle();
  });
  expect(new Set(failures).size).toBe(1);
  expect((failures[0] as Error).message).toBe(
    `The "Web" static site has no build output at "${path.join(
      app,
      "vite",
      "missing",
    )}". Set "build.output" to the folder its build writes.`,
  );
});

it("refuses SST 4's index and error pages", () => {
  for (const option of ["indexPage", "errorPage"])
    expect(
      () => new Site("Web", { path: "web", [option]: "404.html" } as any),
    ).toThrow(
      `"${option}" isn't an option for the "Web" static site. Cloudflare serves the site's files: set "notFound" to "404" to serve the nearest "404.html", or to "single-page-application" to serve "index.html".`,
    );
});

// As the Worker takes it: a domain given as a string is one custom domain,
// whatever it is
it("takes a domain that's an output as the domain's name", async () => {
  new Site("Web", { path: "web", domain: output("app.example.com") });
  await pulumi.settle();
  expect(
    pulumi.resources
      .filter((r) => r.type === DOMAIN)
      .map((r) => [r.name, r.inputs.hostname]),
  ).toEqual([["WebRouterDomain", "app.example.com"]]);
});

it("refuses a domain object that's an output, as the site's", async () => {
  const failures = await rejectionsOf(async () => {
    new Site("Web", {
      path: "web",
      domain: output({ name: "app.example.com" }) as any,
    });
    await pulumi.settle();
  });
  expect(failures.map((f) => (f as Error).message)).toContainEqual(
    expect.stringContaining(
      `The "domain" of the "Web" static site is an output that isn't a domain's name.`,
    ),
  );
  expect(
    () =>
      new Site("Other", {
        path: "web",
        domain: { name: "app.example.com", aliases: output([]) as any },
      }),
  ).toThrow(
    `The "domain.aliases" of the "Other" static site has to be a plain value`,
  );
});

it("refuses what decides what it creates or builds as an output", () => {
  expect(
    () =>
      new Site("Build", {
        path: "vite",
        build: { command: output("true") as any, output: "dist" },
      }),
  ).toThrow(`The "build" of the "Build" static site has to be a plain value`);
  expect(() => new Site("Path", { path: output("web") as any })).toThrow(
    `The "path" of the "Path" static site has to be a plain value`,
  );
  expect(() => new Site("Missing", { path: "missing" })).toThrow(
    `There's no folder at "${path.join(
      app,
      "missing",
    )}", the "path" of the "Missing" static site.`,
  );
});

it("refuses a Worker in existing", () => {
  expect(
    () => new Site("Web", { path: "web", existing: { server: "my-worker" } }),
  ).toThrow(
    `"existing.server" isn't an option for the "Web" static site. A site creates the Worker that serves it, from its build.`,
  );
});
