import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, type TakeoverCase } from "../../../helpers/graph";
import { rejectionsOf } from "../../../helpers/rejections";

// The tests every Cloudflare site with a server passes, the `Astro`, the
// `ReactRouter` and the `TanStackStart` (`cloudflare/helpers/ssr-site.ts`),
// run by each framework's test file with what's its own. Inside, the V5
// component is called `Site` and its 4.x form `OriginalSite` whatever the
// framework: the two have the same shape.

type V5Class =
  typeof import("../../../../src/components/cloudflare/v5/astro").Astro;
type OriginalClass =
  typeof import("../../../../src/components/cloudflare/astro").Astro;
type AnyClass = V5Class | OriginalClass;

const SCRIPT = "cloudflare:index/workersScript:WorkersScript";
// What 4.x kept in the state and the V5 site doesn't: the command that built
// it, which has nothing in Cloudflare behind it
const BUILDER = "command:local:Command::WebBuilder";

/** One framework, as the shared tests see it: what differs from the others. */
export interface SsrSiteCase {
  /** The framework, as the site's messages name it: `Astro`. */
  label: string;
  /** The 4.x and V5 components. */
  load(): Promise<{ original: OriginalClass; v5: V5Class }>;
  /**
   * Writes a site as its framework builds it with Cloudflare's adapter, into
   * the folder given, for `buildCommand: "true"`: its `package.json`, its
   * config and its build.
   */
  write(dir: string): void;
  /** Where the build put the Worker and its files, from the site's folder. */
  built: { server: string; assets: string };
  /** The config file the site's adapter reads SST's Wrangler config in. */
  config: string;
}

/** What a framework's own tests are given. */
export interface SsrSiteContext {
  pulumi: ReturnType<typeof mockPulumi>;
  Site: () => V5Class;
  /** The app's folder, where the tests run, and how to add a site to it. */
  app: string;
  write: (file: string, content: string) => void;
  resource: (name: string) => any;
  /** The Wrangler config the site's build and `sst dev` read. */
  wrangler: (name?: string) => Record<string, any>;
}

/**
 * The tests every Cloudflare site with a server passes.
 *
 * @param own The framework's own takeover cases and tests.
 */
export function ssrSiteSuite(
  c: SsrSiteCase,
  own: {
    cases?: (ctx: SsrSiteContext) => Record<string, TakeoverCase<AnyClass>>;
    tests?: (ctx: SsrSiteContext) => void;
  } = {},
) {
  // SST 4 reads a site's folder from the folder the deploy runs in, so the
  // tests run in the app's folder, and give each site from there
  const app = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `sst-cloudflare-${c.label}-`)),
  );
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    fs.writeFileSync(path.join(app, file), content);
  };
  c.write(path.join(app, "web"));
  const cwd = process.cwd();
  process.chdir(app);

  // The CLI builds a Worker's code into one file: here, an empty one
  const bundle = path.join(app, ".bundle");
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, "bundle.mjs"), "export default {};\n");

  const pulumi = mockPulumi({
    root: app,
    // A Worker's `workers.dev` URL, as Cloudflare gives it
    state: (args) =>
      args.type === "pulumi-nodejs:dynamic:Resource" &&
      "scriptName" in args.inputs &&
      args.inputs.enabled === true
        ? { url: `${args.inputs.scriptName}.acme.workers.dev` }
        : {},
    cli: (method) =>
      method === "Runtime.Build"
        ? { handler: "bundle.mjs", out: bundle, errors: [] }
        : undefined,
  });

  // Cloudflare's API, which a Worker with Durable Object migrations reads
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) =>
      String(url).startsWith("https://api.cloudflare.com/")
        ? new Response(JSON.stringify({ success: true, result: [] }))
        : realFetch(url, init)) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    process.chdir(cwd);
    fs.rmSync(app, { recursive: true, force: true });
  });

  describe(c.label, () => {
    let Site: V5Class;
    let OriginalSite: OriginalClass;
    let Kv: typeof import("../../../../src/components/cloudflare/kv").Kv;
    let Secret: typeof import("../../../../src/components/secret").Secret;
    let Bucket: typeof import("../../../../src/components/aws/v5/bucket").Bucket;

    beforeAll(async () => {
      ({ original: OriginalSite, v5: Site } = await c.load());
      Kv = (await import("../../../../src/components/cloudflare/kv")).Kv;
      Secret = (await import("../../../../src/components/secret")).Secret;
      Bucket = (await import("../../../../src/components/aws/v5/bucket"))
        .Bucket;
      await import("../../../../src/components/cloudflare/takeover/index");
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
    const wrangler = (name = "Web") =>
      JSON.parse(
        fs.readFileSync(
          path.join($cli.paths.work, "wrangler", "test", `${name}.jsonc`),
          "utf8",
        ),
      );
    const ctx: SsrSiteContext = {
      pulumi,
      Site: () => Site,
      app,
      write,
      resource,
      wrangler,
    };

    // Each case deploys the 4.x site, then the same thing as the V5 one.
    // Everything the 4.x one created has to be kept by the V5 one, with the
    // same inputs, but the command that built it.
    describe("takes over a deployed site", () => {
      pulumi.takeoverCases<AnyClass, AnyClass>({
        original: () => OriginalSite,
        v5: () => Site,
        provider: "cloudflare",
        unclaimed: [BUILDER],
        // SST 4's Worker waited on everything in what it's linked to, from
        // reading its name. Its bindings wait on what they name, which is
        // all Cloudflare needs.
        needlessOrder:
          /^WebWorkerScript before (MyKv|MySecret|MyBucket)\w*(\.sst\.\w+\.\w+)?$/,
        check: () => expect(resource("WebWorkerScript").type).toBe(SCRIPT),
        cases: {
          "a site": (Site, opts) =>
            new Site("Web", { path: "web", buildCommand: "true" }, opts),
          "a site with its environment, linked to a KV namespace": (
            Site,
            opts,
          ) => {
            const kv = new Kv("MyKv");
            new Site(
              "Web",
              {
                path: "web",
                buildCommand: "true",
                environment: { API_URL: "https://api.example.com" },
                link: [kv],
              },
              opts,
            );
          },
          "a site linked to an AWS bucket": (Site, opts) => {
            const bucket = new Bucket("MyBucket");
            new Site(
              "Web",
              { path: "web", buildCommand: "true", link: [bucket] },
              opts,
            );
          },
          "a site with a domain, aliases and redirects": (Site, opts) =>
            new Site(
              "Web",
              {
                path: "web",
                buildCommand: "true",
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
                buildCommand: "true",
                transform: {
                  server: {
                    compatibility: {
                      date: "2025-09-01",
                      flags: ["nodejs_compat", "nodejs_als"],
                    },
                    placement: { mode: "smart" },
                  },
                },
              },
              opts,
            ),
          ...own.cases?.(ctx),
        },
      });
    });

    // SST 4's build waited on SST's Wrangler config, which has a secret's
    // value, so where it put the Worker's code and files was kept secret: in
    // the script, and in what the Worker reported. The V5 build is a step of
    // the program, so a path and a hash of the code are plain. The secret's
    // own binding stays secret.
    it("keeps what it's linked to secret, and not where its build is", async () => {
      const site = (Site: AnyClass) => () => {
        const secret = new Secret("MySecret", "shh");
        new Site("Web", { path: "web", buildCommand: "true", link: [secret] });
      };
      const result = await pulumi.takesOver(site(OriginalSite), site(Site));
      expect(result.unclaimed).toEqual([BUILDER]);
      expect(result.revealed.sort()).toEqual([
        "WebWorkerScript.assets.directory",
        "WebWorkerScript.contentFile",
        "WebWorkerScript.contentSha256",
      ]);
      // The CLI reads the Worker's handler decrypted, so it's the same
      // function to it. The mock reads it as it's kept.
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["WebWorker", ["outputs"]],
      ]);
      // Recorded as a secret, with Pulumi's mark
      expect(resource("WebWorkerScript").inputs.bindings).toHaveProperty(
        "4dabf18193072939515e22adb298388d",
      );
    });

    it("builds the site with SST's Wrangler config, and serves what it built", async () => {
      const kv = new Kv("MyKv");
      new Site("Web", {
        path: "web",
        buildCommand: `printf '%s' "$SST_WRANGLER_PATH" > wrangler-path.txt`,
        environment: { API_URL: "https://api.example.com" },
        link: [kv],
      });
      await pulumi.settle();

      const wranglerPath = path.join(
        $cli.paths.work,
        "wrangler",
        "test",
        "Web.jsonc",
      );
      expect(
        fs.readFileSync(path.join(app, "web", "wrangler-path.txt"), "utf8"),
      ).toBe(wranglerPath);
      expect(wrangler()).toMatchObject({
        name: "sst-test-web",
        compatibility_date: "2025-05-05",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          API_URL: "https://api.example.com",
          SST_RESOURCE_App: JSON.stringify({ name: "app", stage: "test" }),
        },
        kv_namespaces: [{ binding: "MyKv", id: "MyKvNamespace_id" }],
      });

      const script = resource("WebWorkerScript");
      expect(script.inputs.assets.directory).toBe(
        path.join(app, "web", c.built.assets),
      );
      // The Worker is told where its code is, from the app's folder
      expect(pulumi.reportOf("WebWorker")).toMatchObject({
        function: { handler: path.join("web", c.built.server) },
      });
      expect(pulumi.reportOf("Web")).toMatchObject({
        hint: `https://${script.inputs.scriptName}.acme.workers.dev`,
      });
    });

    // A Worker can't reach a bucket in a jurisdiction without it
    it("binds a bucket it's linked to in the Wrangler config, with its jurisdiction", async () => {
      const { Bucket: R2Bucket } = await import(
        "../../../../src/components/cloudflare/v5/bucket"
      );
      const files = new R2Bucket("Files");
      const records = new R2Bucket("Records", {
        transform: { bucket: { jurisdiction: "eu" } },
      });
      new Site("Web", {
        path: "web",
        buildCommand: "true",
        link: [files, records],
      });
      await pulumi.settle();
      expect(wrangler().r2_buckets).toEqual([
        {
          binding: "Files",
          bucket_name: resource("FilesBucket").inputs.name,
          remote: true,
        },
        {
          binding: "Records",
          bucket_name: resource("RecordsBucket").inputs.name,
          jurisdiction: "eu",
          remote: true,
        },
      ]);
    });

    it("sets its compatibility on its Worker and in the Wrangler config", async () => {
      new Site("Web", {
        path: "web",
        buildCommand: "true",
        compatibility: { date: "2025-09-01", flags: ["nodejs_als"] },
      });
      await pulumi.settle();
      expect(resource("WebWorkerScript").inputs).toMatchObject({
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_als"],
      });
      expect(wrangler()).toMatchObject({
        compatibility_date: "2025-09-01",
        compatibility_flags: ["nodejs_als"],
      });
    });

    it("reads the compatibility its transform gives its Worker, in either form", async () => {
      new Site("Web", {
        path: "web",
        buildCommand: "true",
        transform: {
          server: (args) => {
            args.compatibility = { date: "2025-10-01" };
          },
        },
      });
      new Site("Other", {
        path: "web",
        buildCommand: "true",
        compatibility: { date: "2025-09-01" },
        transform: {
          server: { transform: { worker: { compatibilityFlags: ["a"] } } },
        },
      });
      await pulumi.settle();
      expect(resource("WebWorkerScript").inputs.compatibilityDate).toBe(
        "2025-10-01",
      );
      expect(wrangler().compatibility_date).toBe("2025-10-01");
      expect(resource("OtherWorkerScript").inputs).toMatchObject({
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["a"],
      });
      expect(wrangler("Other")).toMatchObject({
        compatibility_date: "2025-09-01",
        compatibility_flags: ["a"],
      });
    });

    it("has its Worker's URL, or its domain's", async () => {
      const site = new Site("Web", { path: "web", buildCommand: "true" });
      const custom = new Site("Custom", {
        path: "web",
        buildCommand: "true",
        domain: "app.example.com",
      });
      await pulumi.settle();
      const url = (site: { url: any }) =>
        new Promise((resolve) => output(site.url).apply(resolve));
      expect(await url(site)).toBe(
        `https://${
          resource("WebWorkerScript").inputs.scriptName
        }.acme.workers.dev`,
      );
      expect(await url(custom)).toBe("https://app.example.com");
      expect((site.link() as any).properties).toHaveProperty("url");
      expect(site.nodes.server.urn).toBeDefined();
    });

    it("runs in sst dev, with SST's Wrangler config", async () => {
      // @ts-ignore
      global.$dev = true;
      const kv = new Kv("MyKv");
      const site = new Site("Web", {
        path: "web",
        environment: { API_URL: "https://api.example.com" },
        link: [kv],
        dev: { command: "npm run start" },
      });
      await pulumi.settle();

      expect(names().filter((n) => n.startsWith("Web"))).toEqual(["Web"]);
      const wranglerPath = path.join(
        $cli.paths.work,
        "wrangler",
        "test",
        "Web.jsonc",
      );
      expect(pulumi.reportOf("Web")).toEqual({
        contract: 1,
        dev: {
          command: "npm run start",
          directory: "web",
          autostart: true,
          environment: { API_URL: "https://api.example.com" },
          links: ["MyKv"],
          cloudflare: { path: wranglerPath },
        },
      });
      expect(wrangler()).toMatchObject({
        vars: { API_URL: "https://api.example.com" },
        kv_namespaces: [{ binding: "MyKv" }],
      });
      expect(() => site.nodes.server).toThrow(/runs locally there/);
      const url = await new Promise((resolve) =>
        output(site.url).apply(resolve),
      );
      expect(url).toBe("http://url-unavailable-in-dev.mode");
    });

    it("is deployed in sst dev with dev: false", async () => {
      // @ts-ignore
      global.$dev = true;
      new Site("Web", { path: "web", buildCommand: "true", dev: false });
      await pulumi.settle();
      expect(names()).toContain("WebWorkerScript");
      expect(pulumi.reportOf("Web")?.dev).toBeUndefined();
    });

    it("isn't built for sst refresh, and leaves its Worker as it is", async () => {
      // @ts-ignore
      global.$cli.command = "refresh";
      new Site("Web", {
        path: "web",
        buildCommand: "touch refreshed.txt",
      });
      await pulumi.settle();
      expect(names()).toEqual(["Web"]);
      expect(fs.existsSync(path.join(app, "web", "refreshed.txt"))).toBe(false);
    });

    it("fails a deploy once, with the build's own message", async () => {
      const failures = await rejectionsOf(async () => {
        new Site("Web", {
          path: "web",
          buildCommand: "echo the reason >&2; exit 3",
        });
        await pulumi.settle();
      });
      expect(new Set(failures).size).toBe(1);
      expect((failures[0] as Error).message).toBe(
        'Failed to build the "Web" site: `echo the reason >&2; exit 3` exited with 3.\nthe reason',
      );
    });

    it("fails a deploy once when the build has no Worker", async () => {
      write("empty/package.json", "{}");
      write(
        `empty/${c.config}`,
        "export default { configPath: process.env.SST_WRANGLER_PATH };",
      );
      const failures = await rejectionsOf(async () => {
        new Site("Web", { path: "empty", buildCommand: "true" });
        await pulumi.settle();
      });
      expect(new Set(failures).size).toBe(1);
      expect((failures[0] as Error).message).toContain(
        `The build of the "Web" ${c.label} site has no Worker`,
      );
    });

    it("refuses a site without SST's Wrangler config, or with a Wrangler file", () => {
      write("unset/package.json", "{}");
      write(`unset/${c.config}`, "export default {};");
      expect(() => new Site("Web", { path: "unset" })).toThrow(
        `Missing required configuration for the "Web" ${c.label} site.`,
      );
      write("own/package.json", "{}");
      write(
        `own/${c.config}`,
        "export default { configPath: process.env.SST_WRANGLER_PATH };",
      );
      write("own/wrangler.toml", "");
      expect(() => new Site("Other", { path: "own" })).toThrow(
        `Found wrangler.toml in "${path.join(app, "own")}" for the "Other" ${
          c.label
        } site.`,
      );
      expect(() => new Site("Missing", { path: "missing" })).toThrow(
        `There's no folder at "${path.join(
          app,
          "missing",
        )}", the "path" of the "Missing" ${c.label} site.`,
      );
    });

    it("refuses what decides what it creates or builds as an output", () => {
      expect(
        () =>
          new Site("Web", {
            path: "web",
            domain: output("app.example.com") as any,
          }),
      ).toThrow(
        `The "domain" of the "Web" ${c.label} site has to be a plain value`,
      );
      expect(
        () => new Site("Link", { path: "web", link: output([]) as any }),
      ).toThrow(
        `The "link" of the "Link" ${c.label} site has to be a plain value`,
      );
      expect(
        () =>
          new Site("Command", {
            path: "web",
            buildCommand: output("true") as any,
          }),
      ).toThrow(
        `The "buildCommand" of the "Command" ${c.label} site has to be a plain value`,
      );
    });

    it("refuses a Worker in existing", () => {
      expect(
        () =>
          new Site("Web", {
            path: "web",
            existing: { server: "my-worker" },
          }),
      ).toThrow(
        `"existing.server" isn't an option for the "Web" ${c.label} site. A site creates the Worker that serves it, from its build.`,
      );
    });

    own.tests?.(ctx);
  });
}
