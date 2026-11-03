import fs from "fs";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, type TakeoverCase } from "../../helpers/graph";
import { rejectionsOf } from "../../helpers/rejections";

// The tests every site with a server passes, the `Nextjs`, the `Astro` and
// the `SvelteKit` (`helpers/ssr-site.ts`), run by each framework's test file
// with what's its own. Inside, the V5 component is called `Site` and its 4.x
// form `OriginalSite` whatever the framework: the two have the same shape.

type V5Class = typeof import("../../../src/components/aws/v5/astro").Astro;
type OriginalClass = typeof import("../../../src/components/aws/astro").Astro;
type AnyClass = V5Class | OriginalClass;
type Changed = [name: string, fields: string[]][];

const DISTRIBUTION = "aws:cloudfront/distribution:Distribution";
const DYNAMIC = "pulumi-nodejs:dynamic:Resource";
const FUNCTION_URL =
  "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";
const EDGE_ARN = "arn:aws:lambda:us-east-1:123456789012:function:signer:3";
const STORE_ARN =
  "arn:aws:cloudfront::123456789012:key-value-store/their-store";

/** One framework, as the shared tests see it: what differs from the others. */
export interface SsrSiteCase {
  /** The component's name, as in its type, `sst:aws:Astro`. */
  name: string;
  /** What the sites in the tests are called: `Web`. */
  site: string;
  /** The 4.x and V5 components, with the V5 one's takeover map loaded. */
  load(): Promise<{ original: OriginalClass; v5: V5Class }>;
  /**
   * Built sites, as the framework builds them, for `buildCommand: "true"`:
   * one with a server, one with the base path `/docs`, and the app's folder
   * they're in.
   */
  paths: { site: string; based: string; app: string };
  /**
   * Whether every build has a server, so it's in `nodes` from the start.
   */
  alwaysServes: boolean;
  /** What every takeover case leaves out and updates, beyond the shared. */
  each: { unclaimed: string[]; changed: Changed; wrappers?: number };
  /** What 4.x created that a plain deploy creates, beyond the shared. */
  created: string[];
  /** What the mock calls the components 4.x wraps things in. */
  wrappers?: RegExp;
}

/** What a framework's own tests are given. */
export interface SsrSiteContext {
  pulumi: ReturnType<typeof mockPulumi>;
  Site: () => V5Class;
  OriginalSite: () => OriginalClass;
  Router: () => typeof import("../../../src/components/aws/v5/router").Router;
  Bucket: () => typeof import("../../../src/components/aws/v5/bucket").Bucket;
  resource: (name: string) => any;
  names: () => string[];
  /** What every takeover case expects, with what's its own added. */
  expected: (more?: { unclaimed?: string[]; changed?: Changed }) => {
    unclaimed: string[];
    changed: Changed;
    wrappers?: number;
  };
}

/**
 * The tests every site with a server passes.
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
  const { site, based, app } = c.paths;
  const S = c.site;

  const pulumi = mockPulumi({
    root: app,
    wrappers: c.wrappers,
    state: (args) => {
      if (args.type === DISTRIBUTION)
        return {
          domainName: `${args.name.toLowerCase()}.cloudfront.net`,
          hostedZoneId: "Z2FDTNDATAQYW2",
          etag: "E1",
        };
      if (args.type === DYNAMIC && "etag" in args.inputs)
        return { isDone: true };
      if (args.type === "aws:lambda/function:Function")
        return {
          qualifiedArn: `${args.name}:1`,
          codeSha256: `${args.name}-code`,
        };
      if (args.type === "aws:lambda/functionUrl:FunctionUrl")
        return { functionUrl: FUNCTION_URL };
      return {};
    },
  });

  describe(c.name, () => {
    let Site: V5Class;
    let OriginalSite: OriginalClass;
    let OriginalRouter: typeof import("../../../src/components/aws/router").Router;
    let Router: typeof import("../../../src/components/aws/v5/router").Router;
    let Bucket: typeof import("../../../src/components/aws/v5/bucket").Bucket;

    beforeAll(async () => {
      ({ original: OriginalSite, v5: Site } = await c.load());
      OriginalRouter = (await import("../../../src/components/aws/router"))
        .Router;
      Router = (await import("../../../src/components/aws/v5/router")).Router;
      Bucket = (await import("../../../src/components/aws/v5/bucket")).Bucket;
      await import("../../../src/components/aws/takeover/index");
    });

    beforeEach(() => {
      pulumi.reset();
      // @ts-ignore
      global.$dev = false;
    });

    const resource = (name: string) =>
      pulumi.resources.find((r) => r.name === name)!;
    const names = () => pulumi.resources.map((r) => r.name);
    const byName = (list: Changed) =>
      [...list].sort(([a], [b]) => a.localeCompare(b));
    const expected = (
      more: { unclaimed?: string[]; changed?: Changed } = {},
    ) => ({
      unclaimed: [...c.each.unclaimed, ...(more.unclaimed ?? [])],
      changed: byName([...c.each.changed, ...(more.changed ?? [])]),
      ...(c.each.wrappers !== undefined && { wrappers: c.each.wrappers }),
    });
    const ctx: SsrSiteContext = {
      pulumi,
      Site: () => Site,
      OriginalSite: () => OriginalSite,
      Router: () => Router,
      Bucket: () => Bucket,
      resource,
      names,
      expected,
    };
    // A warmed site's 4.x `Cron`s go, and its prewarm in each region is made
    // again once
    const warmed = (...regions: string[]) =>
      expected({
        unclaimed: regions.map((r) => `sst:aws:Cron::${S}Warmer${r}`),
        changed: regions.map((r) => [`${S}Prewarm${r}`, ["triggers"]]),
      });

    describe(`takes over a deployed ${c.name}`, () => {
      pulumi.takeoverCases<AnyClass, AnyClass>({
        original: () => OriginalSite,
        v5: () => Site,
        // 4.x created what it made from the build inside an `apply` that
        // waited for everything the build read: the router's outputs, a
        // linked bucket's name, which waits for its CORS rules, and for the
        // warmer, the server it links, URL and all. Nothing in AWS needs any of
        // it removed first.
        needlessOrder: new RegExp(
          `^(${S}Server\\w+Function before Router(KvStore|CdnDistribution)|${S}KvKeys\\S* before RouterCdnDistribution|${S}\\S+ before UploadsCors|${S}(WarmerTarget|WarmerPermission|Prewarm)\\w+ before ${S}Server\\w+Url(Access|Invoke)?)$`,
        ),
        cases: {
          "on a distribution of its own": {
            create: (Site, opts) =>
              new Site(S, { path: site, buildCommand: "true" }, opts),
            ...expected(),
          },
          "behind a 4.x Router": {
            create: (Site, opts) => {
              const router = new OriginalRouter("Router");
              return new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  router: { instance: router },
                },
                opts,
              );
            },
            ...expected(),
          },
          "behind a V5 Router that signs, under a path": {
            create: (Site, opts) => {
              const router = new Router("Router", { protection: "oac" });
              return new Site(
                S,
                {
                  path: based,
                  buildCommand: "true",
                  router: {
                    instance: router as any,
                    path: "/docs",
                    domain: "docs.example.com",
                  },
                },
                opts,
              );
            },
            ...expected(),
          },
          "with OAC": {
            create: (Site, opts) =>
              new Site(
                S,
                { path: site, buildCommand: "true", protection: "oac" },
                opts,
              ),
            ...expected(),
          },
          "with edge signing": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  protection: {
                    mode: "oac-with-edge-signing",
                    edgeFunction: { memory: "256 MB", timeout: "10 seconds" },
                  },
                },
                opts,
              ),
            ...expected(),
          },
          "with the user's edge signer": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  protection: {
                    mode: "oac-with-edge-signing",
                    edgeFunction: { arn: EDGE_ARN },
                  },
                },
                opts,
              ),
            ...expected(),
          },
          "kept warm": {
            create: (Site, opts) =>
              new Site(S, { path: site, buildCommand: "true", warm: 3 }, opts),
            ...warmed("Useast1"),
          },
          "in two regions, kept warm": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  regions: ["us-east-1", "eu-west-1"],
                  warm: 1,
                },
                opts,
              ),
            ...warmed("Useast1", "Euwest1"),
          },
          "with links and environment": {
            create: (Site, opts) => {
              const bucket = new Bucket("Uploads");
              return new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  link: [bucket],
                  environment: { API_URL: bucket.name, STATIC: "1" },
                  permissions: [
                    { actions: ["s3:ListAllMyBuckets"], resources: ["*"] },
                  ],
                },
                opts,
              );
            },
            ...expected(),
          },
          "with edge code, a cache policy and versioned invalidation": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  cachePolicy: "658327ea-f89d-4fab-a63d-7e88639e58f6",
                  edge: {
                    viewerRequest: {
                      injection: "event.request.headers.a = {value: '1'};",
                    },
                    viewerResponse: {
                      injection: "event.response.headers.b = {value: '2'};",
                    },
                  },
                  invalidation: { paths: "versioned", wait: true },
                },
                opts,
              ),
            ...expected(),
          },
          "without invalidation, with server options": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  invalidation: false,
                  server: {
                    memory: "2048 MB",
                    timeout: "30 seconds",
                    architecture: "arm64",
                    install: ["sharp"],
                    layers: [
                      "arn:aws:lambda:us-east-1:123456789012:layer:one:1",
                    ],
                  },
                  assets: {
                    purge: true,
                    nonVersionedFilesCacheHeader: "no-cache",
                  },
                },
                opts,
              ),
            ...expected(),
          },
          "with a domain that redirects": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  domain: {
                    name: "example.com",
                    aliases: ["app.example.com"],
                    redirects: ["www.example.com"],
                  },
                },
                opts,
              ),
            ...expected(),
            // The redirect's function, as the Cdn's tests say
            changed: (way) =>
              expected({
                changed:
                  way === "with another provider"
                    ? [
                        [
                          `${S}CdnRedirectCloudfrontFunctionRequest`,
                          ["options.provider"],
                        ],
                      ]
                    : [],
              }).changed,
          },
          "in a VPC": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  vpc: {
                    privateSubnets: ["subnet-0a1", "subnet-0b2"],
                    securityGroups: ["sg-0c3"],
                  },
                },
                opts,
              ),
            ...expected(),
          },
          "with edge code on a store of the user's": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  edge: {
                    viewerRequest: {
                      injection: "event.request.headers.a = {value: '1'};",
                      kvStore: STORE_ARN,
                    },
                  },
                },
                opts,
              ),
            ...expected(),
            check: () => expect(names()).not.toContain(`${S}KvStore`),
          },
          "with the server transformed": {
            create: (Site, opts) =>
              new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  transform: {
                    server: (args: any): undefined => {
                      args.memory = "3008 MB";
                      args.description = "The site's server";
                    },
                  },
                },
                opts,
              ),
            ...expected(),
            check: () =>
              expect(
                resource(`${S}ServerUseast1Function`).inputs,
              ).toMatchObject({
                memorySize: 3008,
                description: "The site's server",
              }),
          },
          "in two regions behind a Router that signs": {
            create: (Site, opts) => {
              const router = new Router("Router", { protection: "oac" });
              return new Site(
                S,
                {
                  path: site,
                  buildCommand: "true",
                  regions: ["us-east-1", "eu-west-1"],
                  router: { instance: router as any },
                },
                opts,
              );
            },
            ...expected(),
          },
          "deployed in sst dev": {
            create: (Site, opts) => {
              // @ts-ignore
              global.$dev = true;
              return new Site(
                S,
                {
                  path: site,
                  buildCommand: "exit 1",
                  dev: { command: "npm run dev" },
                },
                opts,
              );
            },
            check: () => expect(names()).toContain(`${S}DevServer`),
          },
          ...own.cases?.(ctx),
        },
      });
    });

    it("builds once, with the values of its links and its environment", async () => {
      const env = path.join(site, "build-env.txt");
      const bucket = new Bucket("Uploads");
      new Site(S, {
        path: site,
        buildCommand: "env > build-env.txt",
        link: [bucket],
        environment: { API_URL: bucket.name, STATIC: "1" },
      });
      await pulumi.settle();
      const lines = fs.readFileSync(env, "utf8").split("\n");
      fs.rmSync(env);
      expect(lines).toContain("SST=1");
      expect(lines).toContain("STATIC=1");
      expect(lines.find((l) => l.startsWith("API_URL="))).toMatch(
        /^API_URL=.+/,
      );
      const uploads = lines.find((l) => l.startsWith("SST_RESOURCE_Uploads="));
      expect(JSON.parse(uploads!.split("=").slice(1).join("="))).toMatchObject({
        type: "sst.aws.Bucket",
      });
      expect(lines.some((l) => l.startsWith("SST_RESOURCE_App="))).toBe(true);
    });

    it("fails a deploy once, with the build's own message", async () => {
      const failures = await rejectionsOf(async () => {
        const web = new Site(S, {
          path: site,
          buildCommand: "echo the reason >&2; exit 3",
          warm: 1,
        });
        // What's made from the server waits for it, and fails with the build
        if (c.alwaysServes) {
          const server = (web.nodes.server["us-east-1"] as any).promise();
          await expect(server).rejects.toThrow(
            new RegExp(`Failed to build the "${S}" site`),
          );
        }
        await pulumi.settle();
      });
      // Pulumi reports an error once, by identity
      expect(failures.length).toBeGreaterThan(0);
      expect(new Set(failures).size).toBe(1);
      expect((failures[0] as Error).message).toBe(
        `Failed to build the "${S}" site: \`echo the reason >&2; exit 3\` exited with 3.\nthe reason`,
      );
      expect(names()).not.toContain(`${S}ServerUseast1`);
    });

    if (c.alwaysServes)
      it("has its server in nodes from the start, without regions", async () => {
        const web = new Site(S, { path: site, buildCommand: "true", warm: 1 });
        expect(Object.keys(web.nodes.server)).toEqual(["us-east-1"]);
        expect(Object.keys(web.nodes.warmer)).toEqual(["us-east-1"]);
        expect(Object.keys(web.nodes.prewarm)).toEqual(["us-east-1"]);
        expect(Object.keys(web.nodes.urlAccess)).toEqual(["us-east-1"]);
        expect(Object.keys(web.nodes.cloudFrontUrlAccess)).toEqual([]);
        const server = await pulumi.resolve(web.nodes.server["us-east-1"]);
        expect(server.constructor.name).toBe("Function");
        await pulumi.settle();
      });
    else
      it("has its server in nodes once the build says it has one", async () => {
        const web = new Site(S, { path: site, buildCommand: "true", warm: 1 });
        expect(Object.keys(web.nodes.server)).toEqual([]);
        await pulumi.settle();
        expect(Object.keys(web.nodes.server)).toEqual(["us-east-1"]);
        expect(Object.keys(web.nodes.warmer)).toEqual(["us-east-1"]);
        expect(Object.keys(web.nodes.urlAccess)).toEqual(["us-east-1"]);
      });

    it("has its server in nodes once it's created, given a provider of its own", async () => {
      const { Provider } = await import("@pulumi/aws");
      const web = new Site(
        S,
        { path: site, buildCommand: "true" },
        { provider: new Provider("West", { region: "us-west-2" }) },
      );
      // The provider's region is read in the deploy
      expect(Object.keys(web.nodes.server)).toEqual([]);
      await pulumi.settle();
      // The mock's lookups give us-east-1, whatever the provider
      expect(Object.keys(web.nodes.server)).toEqual(["us-east-1"]);
    });

    it("gives each server by region, as an output", async () => {
      const web = new Site(S, {
        path: site,
        buildCommand: "true",
        regions: ["us-east-1", "eu-west-1"],
      });
      if (c.alwaysServes)
        expect(Object.keys(web.nodes.server)).toEqual([
          "us-east-1",
          "eu-west-1",
        ]);
      await pulumi.settle();
      expect(Object.keys(web.nodes.server)).toEqual(["us-east-1", "eu-west-1"]);
      const server = await pulumi.resolve(web.nodes.server["eu-west-1"]);
      expect(server.constructor.name).toBe("Function");
      expect(web.nodes.cdn).toBeDefined();
    });

    it("can be linked by a function", async () => {
      const { Function } = await import(
        "../../../src/components/aws/v5/function"
      );
      const web = new Site(S, { path: site, buildCommand: "true" });
      new Function("Api", { handler: "src/api.handler", link: [web] });
      await pulumi.settle();
      expect(names()).toContain("ApiFunction");
      expect(names()).toContain(`${S}ServerUseast1Function`);
    });

    it("runs on your machine in sst dev", async () => {
      // @ts-ignore
      global.$dev = true;
      const web = new Site(S, {
        path: site,
        buildCommand: "exit 1",
        dev: { command: "npm run dev -- --port 4000", title: "Web" },
      });
      await pulumi.settle();
      expect(
        names()
          .filter((n) => n.startsWith(S))
          .sort(),
      ).toEqual(
        expect.arrayContaining([S, `${S}DevServer`, `${S}DevServerFunction`]),
      );
      expect(names()).not.toContain(`${S}ServerUseast1`);
      expect(pulumi.reportOf(S)?.dev).toMatchObject({
        command: "npm run dev -- --port 4000",
        title: "Web",
        directory: site,
        autostart: true,
      });
      expect(() => web.nodes.server).toThrow(/runs locally/);
    });

    it("isn't built for sst refresh, which creates nothing", async () => {
      const cli = (globalThis as any).$cli;
      const was = cli.command;
      cli.command = "refresh";
      try {
        const web = new Site(S, { path: site, buildCommand: "exit 1" });
        await pulumi.settle();
        expect(names()).toContain(`${S}Assets`);
        expect(names()).not.toContain(`${S}ServerUseast1`);
        expect(names()).not.toContain(`${S}AssetFiles`);
        expect(await pulumi.resolve(web.url)).toMatch(/^https:\/\//);
      } finally {
        cli.command = was;
      }
    });

    it(`turns down what sst.aws.${c.name} took and the V5 one doesn't`, () => {
      expect(
        () =>
          new Site(S, {
            path: site,
            // @ts-expect-error
            route: { router: {} },
          }),
      ).toThrow(/"route" isn't an option/);
      expect(
        () =>
          // @ts-expect-error
          new Site(S, { path: site, cdn: false }),
      ).toThrow(/"cdn" isn't an option/);
      expect(
        () =>
          new Site(S, {
            path: site,
            // @ts-expect-error
            server: { edge: {} },
          }),
      ).toThrow(/"edge" isn't an option/);
      expect(
        () =>
          new Site(S, {
            path: site,
            // @ts-expect-error
            regions: output(["us-east-1"]),
          }),
      ).toThrow(/"regions"/);
      expect(() => new Site(S, { path: path.join(app, "missing") })).toThrow(
        /Site directory not found/,
      );
    });

    it("creates what 4.x created", async () => {
      new Site(S, { path: site, buildCommand: "true" });
      await pulumi.settle();
      expect(names()).toEqual(
        expect.arrayContaining([
          `${S}Assets`,
          `${S}AssetFiles`,
          `${S}ServerUseast1`,
          `${S}KvKeys`,
          `${S}Invalidation.sst.aws.DistributionInvalidation`,
          `${S}Cdn`,
          `${S}KvStore`,
          `${S}ServerCachePolicy`,
          `${S}CloudfrontFunctionRequest`,
          `${S}PublicFunctionUrlAccessUseast1`,
          ...c.created,
        ]),
      );
    });

    own.tests?.(ctx);
  });
}
