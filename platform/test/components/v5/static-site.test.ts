import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, sidedClass } from "../../helpers/graph";
import { rejectionsOf } from "../../helpers/rejections";

// A static site, and one that's built. SST 4 builds a site in its folder
// joined to the app's, and reads what it built from the folder the deploy runs
// in, so the sites are given from the app's folder, which the tests run in.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-static-site-")),
);
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.writeFileSync(path.join(app, file), content);
};
write("web/index.html", "<html>Home</html>");
write("web/about.html", "<html>About</html>");
write("web/404.html", "<html>Not found</html>");
write("web/css/style.css", "body {}");
write("web/.well-known/apple-app-site-association", "{}");
// What SST leaves in a site's folder isn't uploaded
write("web/.sst/log.txt", "log");
write("vite/package.json", JSON.stringify({ name: "vite" }));
write("vite/vite.config.ts", "export default {};");
write("vite/dist/index.html", "<html>Built</html>");
write("vite/dist/assets/index-abc123.js", "console.log(1);");
const cwd = process.cwd();
process.chdir(app);

afterAll(() => {
  process.chdir(cwd);
  fs.rmSync(app, { recursive: true, force: true });
});

const DISTRIBUTION = "aws:cloudfront/distribution:Distribution";
const STORE_ARN =
  "arn:aws:cloudfront::123456789012:key-value-store/their-store";
const BUCKET_DOMAIN = (bucket: string) =>
  `${bucket}.s3.us-east-1.amazonaws.com`;
// What SST 4 kept in the state and the V5 site doesn't: the command that built
// it
const BUILDER = "command:local:Command::WebBuilder";

const pulumi = mockPulumi({
  root: app,
  state: (args) => {
    if (args.type === DISTRIBUTION)
      return {
        domainName: `${args.name.toLowerCase()}.cloudfront.net`,
        hostedZoneId: "Z2FDTNDATAQYW2",
        etag: "E1",
      };
    // A bucket SST 4 looked up by its name
    if (args.type === "aws:s3/bucket:Bucket" && args.id)
      return {
        bucket: args.id,
        bucketRegionalDomainName: BUCKET_DOMAIN(args.id),
      };
    return {};
  },
  call: (args) =>
    args.token === "aws:s3/getBucket:getBucket"
      ? {
          bucket: args.inputs.bucket,
          bucketRegionalDomainName: BUCKET_DOMAIN(args.inputs.bucket),
        }
      : undefined,
});

type V5Class =
  typeof import("../../../src/components/aws/static-site").StaticSite;
type OriginalClass =
  typeof import("../../fixtures/v4/components/aws/static-site").StaticSite;
type AnyClass = V5Class | OriginalClass;

let Site: V5Class;
let OriginalSite: OriginalClass;
let OriginalRouter: typeof import("../../fixtures/v4/components/aws/router").Router;
let Router: typeof import("../../../src/components/aws/router").Router;
let SidedRouter: any;

beforeAll(async () => {
  Site = (await import("../../../src/components/aws/static-site")).StaticSite;
  OriginalSite = (await import("../../fixtures/v4/components/aws/static-site"))
    .StaticSite;
  OriginalRouter = (await import("../../fixtures/v4/components/aws/router"))
    .Router;
  Router = (await import("../../../src/components/aws/router")).Router;
  // SST 4's for SST 4's site, SST 5's for SST 5's
  SidedRouter = await sidedClass(
    "Router",
    import("../../fixtures/v4/components/aws/router"),
    import("../../../src/components/aws/router"),
    import("../../../src/components/aws/takeover/router"),
  );
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

describe("takes over a deployed StaticSite", () => {
  pulumi.takeoverCases<AnyClass, AnyClass>({
    original: () => OriginalSite,
    v5: () => Site,
    // The 4.x site's entries waited for the router's outputs, as in the sites'
    // suite. Nothing about them needs the router's distribution removed after
    // them: they're in the router's store, which they still wait for.
    needlessOrder: /^WebKvKeys before RouterCdnDistribution$/,
    cases: {
      "on a distribution of its own": (Site, opts) =>
        new Site("Web", { path: "web" }, opts),
      "built, with its environment": {
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
      "with an error page": (Site, opts) =>
        new Site("Web", { path: "web", errorPage: "404.html" }, opts),
      "with an error page, under a path in the bucket": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            errorPage: "/404.html",
            assets: { path: "/sites/web/" },
          },
          opts,
        ),
      "without edge routing": (Site, opts) =>
        new Site("Web", { path: "web", edgeRouting: false }, opts),
      "without edge routing, with an error page and edge code": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            edgeRouting: false,
            errorPage: "404.html",
            indexPage: "/about.html",
            assets: { path: "sites/web" },
            edge: {
              viewerRequest: {
                injection: "event.request.headers.a = {value: '1'};",
                kvStore: STORE_ARN,
              },
            },
          },
          opts,
        ),
      "with a domain that redirects": {
        create: (Site, opts) =>
          new Site(
            "Web",
            {
              path: "web",
              domain: {
                name: "example.com",
                aliases: ["app.example.com"],
                redirects: ["www.example.com"],
              },
            },
            opts,
          ),
        // The redirect's function, as the Cdn's tests say
        changed: (way) =>
          way === "with another provider"
            ? [
                [
                  "WebCdnRedirectCloudfrontFunctionRequest",
                  ["options.provider"],
                ],
              ]
            : [],
      },
      "without edge routing, with a domain": (Site, opts) =>
        new Site(
          "Web",
          { path: "web", edgeRouting: false, domain: "example.com" },
          opts,
        ),
      "with edge code on a store of the user's": {
        create: (Site, opts) =>
          new Site(
            "Web",
            {
              path: "web",
              edge: {
                viewerRequest: {
                  injection: "event.request.headers.a = {value: '1'};",
                  kvStore: STORE_ARN,
                },
                viewerResponse: {
                  injection: "event.response.headers.b = {value: '2'};",
                  kvStore: STORE_ARN,
                },
              },
            },
            opts,
          ),
        check: () => expect(names()).not.toContain("WebKvStore"),
      },
      "in a bucket it's given": {
        create: (Site, opts) =>
          new Site(
            "Web",
            { path: "web", assets: { bucket: "their-bucket", path: "web" } },
            opts,
          ),
        // SST 4 looked the bucket up with a resource; the V5 site, with a
        // function
        unclaimed: ["aws:s3/bucket:Bucket::WebAssets"],
      },
      "with file options, routes and no purge": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            assets: {
              fileOptions: [
                { files: "**", cacheControl: "max-age=60" },
                {
                  files: ["**/*.css"],
                  ignore: "css/skip.css",
                  contentType: "text/css",
                  cacheControl: "no-cache",
                },
              ],
              routes: ["/uploads/", "media"],
              purge: false,
            },
          },
          opts,
        ),
      "with a text encoding": {
        create: (Site, opts) =>
          new Site(
            "Web",
            { path: "web", assets: { textEncoding: "iso-8859-1" } },
            opts,
          ),
        // SST 4 ignored it, and wrote UTF-8
        changed: [["WebAssetFiles.sst.aws.BucketFiles", ["files"]]],
      },
      "without invalidation": (Site, opts) =>
        new Site("Web", { path: "web", invalidation: false }, opts),
      "invalidating some paths, and waiting": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            invalidation: { paths: ["/index.html", "/css/*"], wait: true },
          },
          opts,
        ),
      "behind a Router": (Site, opts) => {
        const router = new SidedRouter("Router");
        return new Site(
          "Web",
          { path: "web", router: { instance: router } },
          opts,
        );
      },
      "behind a Router, under a path and a domain": (Site, opts) => {
        const router = new SidedRouter("Router");
        return new Site(
          "Web",
          {
            path: "web",
            errorPage: "404.html",
            router: {
              instance: router as any,
              path: "/docs",
              domain: "docs.example.com",
            },
          },
          opts,
        );
      },
      "in a bucket it's given, without edge routing, with an error page": {
        create: (Site, opts) =>
          new Site(
            "Web",
            {
              path: "web",
              edgeRouting: false,
              errorPage: "404.html",
              assets: { bucket: "their-bucket" },
            },
            opts,
          ),
        unclaimed: ["aws:s3/bucket:Bucket::WebAssets"],
      },
      "in a bucket it's given, behind a router": {
        create: (Site, opts) => {
          const router = new SidedRouter("Router");
          return new Site(
            "Web",
            {
              path: "web",
              assets: { bucket: "their-bucket", path: "web" },
              router: { instance: router as any, path: "/docs" },
            },
            opts,
          );
        },
        unclaimed: ["aws:s3/bucket:Bucket::WebAssets"],
      },
      "without edge routing, with only a viewer response function": (
        Site,
        opts,
      ) =>
        new Site(
          "Web",
          {
            path: "web",
            edgeRouting: false,
            edge: {
              viewerResponse: {
                injection: "event.response.headers.b = {value: '2'};",
              },
            },
          },
          opts,
        ),
      "with a domain, edge code and its own index page": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            indexPage: "about.html",
            domain: "example.com",
            edge: {
              viewerRequest: {
                injection: "event.request.headers.a = {value: '1'};",
              },
            },
          },
          opts,
        ),
      "with a domain of its own DNS, and an error page": (Site, opts) =>
        new Site(
          "Web",
          {
            path: "web",
            errorPage: "404.html",
            domain: {
              name: "example.com",
              dns: false,
              cert: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
            },
          },
          opts,
        ),
      "invalidating no paths": (Site, opts) =>
        new Site("Web", { path: "web", invalidation: { paths: [] } }, opts),
      "built, behind a Router, under a path in the bucket": {
        create: (Site, opts) => {
          const router = new SidedRouter("Router");
          return new Site(
            "Web",
            {
              path: "vite",
              build: { command: "true", output: "dist" },
              assets: { path: "sites/web" },
              router: { instance: router, path: "/web" },
            },
            opts,
          );
        },
        unclaimed: [BUILDER],
      },
      "with its parts transformed": {
        create: (Site, opts) =>
          new Site(
            "Web",
            {
              path: "web",
              transform: {
                assets: (args: any): undefined => {
                  args.versioning = true;
                },
                cdn: (args: any): undefined => {
                  args.comment = "The web site";
                },
              },
            },
            opts,
          ),
        check: () =>
          expect(resource("WebCdnDistribution").inputs.comment).toBe(
            "The web site",
          ),
      },
    },
  });
});

describe("StaticSite", () => {
  it("creates what 4.x created", async () => {
    new Site("Web", { path: "web" });
    await pulumi.settle();
    expect(names()).toEqual(
      expect.arrayContaining([
        "Web",
        "WebAssets",
        "WebAssetFiles",
        "WebKvKeys",
        "WebKvStore",
        "WebCloudfrontFunctionRequest",
        "WebCdn",
        "WebInvalidation",
      ]),
    );
    expect(names()).not.toContain("WebS3AccessControl");
  });

  it("uploads the site's files, but SST's own", async () => {
    new Site("Web", { path: "web" });
    await pulumi.settle();
    const files = resource("WebAssetFiles").inputs.files as {
      key: string;
      cacheControl: string;
      contentType: string;
    }[];
    expect(files.map((f) => f.key).sort()).toEqual([
      ".well-known/apple-app-site-association",
      "404.html",
      "about.html",
      "css/style.css",
      "index.html",
    ]);
    expect(files.find((f) => f.key === "index.html")).toMatchObject({
      cacheControl: "max-age=0,no-cache,no-store,must-revalidate",
      contentType: "text/html;charset=UTF-8",
    });
  });

  it("lists its top-level files and folders for the router", async () => {
    new Site("Web", { path: "web", assets: { routes: ["uploads"] } });
    await pulumi.settle();
    const entries = resource("WebKvKeys").inputs.entries as Record<
      string,
      string
    >;
    expect(Object.keys(entries).sort()).toEqual([
      "/.well-known/apple-app-site-association",
      "/404.html",
      "/about.html",
      "/index.html",
      "metadata",
    ]);
    expect(JSON.parse(entries.metadata)).toEqual({
      custom404: "/index.html",
      s3: {
        dir: "",
        prefix: "",
        // Every folder but `.well-known`, SST's own too, as SST 4 lists them
        routes: ["/uploads", "/.sst", "/css"],
      },
    });
  });

  it("serves from the bucket itself without edge routing", async () => {
    new Site("Web", {
      path: "web",
      edgeRouting: false,
      assets: { path: "web" },
    });
    await pulumi.settle();
    expect(names()).not.toContain("WebKvStore");
    expect(names()).not.toContain("WebKvKeys");
    expect(names()).not.toContain("WebCloudfrontFunctionRequest");
    expect(names()).toContain("WebS3AccessControl");
    const distribution = resource("WebCdnDistribution").inputs;
    expect(distribution.defaultRootObject).toBe("index.html");
    expect(distribution.origins[0].originPath).toBe("/web");
    expect(distribution.customErrorResponses).toEqual([
      expect.objectContaining({
        errorCode: 403,
        responseCode: 200,
        responsePagePath: "/index.html",
      }),
      expect.objectContaining({
        errorCode: 404,
        responseCode: 200,
        responsePagePath: "/index.html",
      }),
    ]);
  });

  // SST 4's, which a create would make a second of, is taken by its id: the
  // core gives the ids of SST 4's that a move adopts, until the move finishes
  it("adopts SST 4's origin access control by its id", async () => {
    const cli = (globalThis as any).$cli;
    const state = cli.state;
    const create = () => new Site("Web", { path: "web", edgeRouting: false });
    try {
      cli.state = {
        ...state,
        adopt: { "WebS3AccessControl.sst.aws.OriginAccessControl": "E2OAC" },
      };
      create();
      await pulumi.settle();
      expect(resource("WebS3AccessControl").options.importId).toBe("E2OAC");
      expect(resource("WebCdnDistribution").inputs.origins[0]).toMatchObject({
        originAccessControlId: "E2OAC",
      });

      // Another site's is left alone, and so is this one with none to adopt
      pulumi.reset();
      cli.state = {
        ...state,
        adopt: { "DocsS3AccessControl.sst.aws.OriginAccessControl": "E3OAC" },
      };
      create();
      await pulumi.settle();
      expect(resource("WebS3AccessControl").options).not.toHaveProperty(
        "importId",
      );
    } finally {
      cli.state = state;
    }
  });

  it("builds the site, with Vite's types for its environment", async () => {
    const web = new Site("Web", {
      path: "vite",
      build: { command: "echo built > built.txt", output: "dist" },
      environment: {
        VITE_API_URL: output("https://api.example.com"),
        STAGE: "test",
      },
    });
    await pulumi.settle();
    expect(fs.readFileSync(path.join(app, "vite/built.txt"), "utf8")).toBe(
      "built\n",
    );
    const types = fs.readFileSync(
      path.join(app, "vite/src/sst-env.d.ts"),
      "utf8",
    );
    expect(types).toContain("readonly VITE_API_URL: string");
    expect(types).toContain("readonly STAGE: string");
    const files = resource("WebAssetFiles").inputs.files as { key: string }[];
    expect(files.map((f) => f.key).sort()).toEqual([
      "assets/index-abc123.js",
      "index.html",
    ]);
    expect(await pulumi.resolve(web.url)).toMatch(/^https:\/\//);
  });

  it("fails a deploy once, with the build's own message", async () => {
    const failures = await rejectionsOf(async () => {
      new Site("Web", {
        path: "vite",
        build: { command: "echo the reason >&2; exit 3", output: "dist" },
      });
      await pulumi.settle();
    });
    // Pulumi reports an error once, by identity
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
    expect((failures[0] as Error).message).toMatch(
      /^The "Web" static site has no build output at ".*\/vite\/missing"\. Set "build.output"/,
    );
  });

  it("serves through a router under a path", async () => {
    const router = new Router("Router", { domain: "example.com" });
    const web = new Site("Web", {
      path: "web",
      router: { instance: router, path: "/docs" },
    });
    await pulumi.settle();
    expect(names()).not.toContain("WebCdn");
    expect(names()).not.toContain("WebKvStore");
    expect(names()).toContain("WebRoutesUpdate");
    const files = resource("WebAssetFiles").inputs.files as { key: string }[];
    expect(files.map((f) => f.key)).toContain("docs/index.html");
    const metadata = JSON.parse(
      (resource("WebKvKeys").inputs.entries as Record<string, string>).metadata,
    );
    expect(metadata).toMatchObject({ base: "/docs", s3: { prefix: "/docs" } });
    expect(await pulumi.resolve(web.url)).toBe("https://example.com/docs");
  });

  it("runs on your machine in sst dev", async () => {
    // @ts-ignore
    global.$dev = true;
    const web = new Site("Web", {
      path: "vite",
      build: { command: "exit 1", output: "dist" },
      environment: { VITE_STAGE: "dev" },
      dev: { command: "npm run dev -- --port 4000", title: "Web" },
    });
    await pulumi.settle();
    expect(names()).toEqual(["Web"]);
    expect(pulumi.reportOf("Web")?.dev).toMatchObject({
      command: "npm run dev -- --port 4000",
      title: "Web",
      directory: "vite",
      autostart: true,
      environment: { VITE_STAGE: "dev" },
    });
    expect(
      fs.readFileSync(path.join(app, "vite/src/sst-env.d.ts"), "utf8"),
    ).toContain("readonly VITE_STAGE: string");
    expect(await pulumi.resolve(web.url)).toBe(
      "http://url-unavailable-in-dev.mode",
    );
    expect(() => web.nodes.cdn).toThrow(/runs locally/);
  });

  it("isn't built for sst refresh, which creates nothing", async () => {
    const cli = (globalThis as any).$cli;
    const was = cli.command;
    cli.command = "refresh";
    try {
      const web = new Site("Web", {
        path: "vite",
        build: { command: "exit 1", output: "dist" },
      });
      await pulumi.settle();
      expect(names()).toContain("WebAssets");
      expect(names()).toContain("WebCdn");
      expect(names()).not.toContain("WebAssetFiles");
      expect(await pulumi.resolve(web.url)).toMatch(/^https:\/\//);
    } finally {
      cli.command = was;
    }
  });

  it("turns down what sst.aws.StaticSite took and the V5 one doesn't", () => {
    // @ts-expect-error
    expect(() => new Site("Web", { path: "web", route: {} })).toThrow(
      /"route" isn't an option for the "Web" static site\./,
    );
    // @ts-expect-error
    expect(() => new Site("Web", { path: "web", base: "/docs" })).toThrow(
      /"base" isn't an option for the "Web" static site\./,
    );
    // @ts-expect-error
    expect(() => new Site("Web", { path: "web", cdn: false })).toThrow(
      /"cdn" isn't an option for the "Web" static site\./,
    );
    expect(
      () =>
        new Site("Web", {
          path: "web",
          // @ts-expect-error
          dev: output(false),
        }),
    ).toThrow(/"dev" of the "Web" static site has to be a plain value/);
    expect(
      () =>
        // @ts-expect-error
        new Site("Web", { path: "web", errorPage: output("404.html") }),
    ).toThrow(/"errorPage"/);
    expect(
      () =>
        new Site("Web", {
          path: "web",
          // @ts-expect-error
          build: output({ command: "true", output: "." }),
        }),
    ).toThrow(/"build"/);
    expect(
      () =>
        // @ts-expect-error
        new Site("Web", { path: "web", assets: { bucket: output("b") } }),
    ).toThrow(/"assets.bucket"/);
    expect(() => new Site("Web", { path: "missing" })).toThrow(
      /There's no folder at ".*\/missing", the "path" of the "Web" static site\./,
    );
  });

  it("needs edge routing, and no domain or edge code of its own, behind a router", () => {
    const router = new Router("Router");
    expect(
      () =>
        new Site("A", {
          path: "web",
          edgeRouting: false,
          router: { instance: router },
        }),
    ).toThrow(
      /The "A" static site can't have both "edgeRouting: false" and "router"/,
    );
    expect(
      () =>
        new Site("B", {
          path: "web",
          domain: "example.com",
          router: { instance: router },
        }),
    ).toThrow(
      /The "B" static site can't have both "domain" and "router"\. Set "domain" on the Router/,
    );
    expect(
      () =>
        new Site("C", {
          path: "web",
          edge: { viewerRequest: { injection: "" } },
          router: { instance: router },
        }),
    ).toThrow(/The "C" static site can't have both "edge" and "router"/);
  });

  it("takes only a router, a path and a domain in its route", () => {
    const router = new Router("Router");
    for (const [key, value] of Object.entries({
      rewrite: { regex: "^/a", to: "/" },
      readTimeout: "30 seconds",
      keepAliveTimeout: "10 seconds",
      connectionTimeout: "3 seconds",
      connectionAttempts: 1,
    }))
      expect(
        () =>
          new Site("Web", {
            path: "web",
            router: { instance: router, [key]: value } as any,
          }),
      ).toThrow(
        new RegExp(
          `"router\\.${key}" isn't an option for the "Web" static site\\. A route to a site takes "instance", "path" and "domain"`,
        ),
      );
    expect(
      () =>
        new Site("Web", {
          path: "web",
          router: { instance: output(router) as any },
        }),
    ).toThrow(
      /"router\.instance" of the "Web" static site has to be a plain value/,
    );
  });

  it("refuses an existing distribution, or one of its parts behind a router", () => {
    expect(
      () =>
        new Site("Web", {
          path: "web",
          existing: { cdn: "E2IDLMESRN6V62" },
        }),
    ).toThrow(
      /"existing\.cdn" isn't an option for the "Web" static site\. A site creates its own distribution/,
    );
    expect(
      () =>
        new Site("Web", {
          path: "web",
          router: { instance: new Router("Router") },
          existing: { kvStore: STORE_ARN },
        }),
    ).toThrow(
      /"existing\.kvStore" isn't an option for the "Web" static site\. It's served through "router"/,
    );
  });

  it("refuses a store in existing next to the one edge names", () => {
    expect(
      () =>
        new Site("Web", {
          path: "web",
          edge: { viewerRequest: { injection: "", kvStore: STORE_ARN } },
          existing: { kvStore: STORE_ARN },
        }),
    ).toThrow(
      /"existing\.kvStore" isn't an option for the "Web" static site\. It routes with the store "edge\.viewerRequest\.kvStore" names/,
    );
  });

  it("refuses kvStores, which a CloudFront function takes one of", () => {
    for (const viewer of ["viewerRequest", "viewerResponse"])
      expect(
        () =>
          new Site("Web", {
            path: "web",
            edge: {
              [viewer]: { injection: "", kvStores: [STORE_ARN] },
            } as any,
          }),
      ).toThrow(
        new RegExp(
          `"edge\\.${viewer}\\.kvStores" isn't an option for the "Web" static site\\. Use "kvStore"`,
        ),
      );
  });

  it("keeps its functions when transform.cdn sets defaultCacheBehavior with an object", async () => {
    new Site("Web", {
      path: "web",
      transform: {
        cdn: {
          defaultCacheBehavior: {
            targetOriginId: "default",
            viewerProtocolPolicy: "allow-all",
            allowedMethods: ["GET", "HEAD"],
            cachedMethods: ["GET", "HEAD"],
          },
        },
      },
    });
    await pulumi.settle();
    const behavior = resource("WebCdnDistribution").inputs.defaultCacheBehavior;
    expect(behavior.viewerProtocolPolicy).toBe("allow-all");
    expect(behavior.allowedMethods).toEqual(["GET", "HEAD"]);
    // Merged into the site's: the function that routes it is still there
    expect(behavior.functionAssociations).toEqual([
      expect.objectContaining({ eventType: "viewer-request" }),
    ]);
  });

  it("is deployed in sst dev with dev: false", async () => {
    // @ts-ignore
    global.$dev = true;
    new Site("Web", { path: "web", dev: false });
    await pulumi.settle();
    expect(names()).toEqual(
      expect.arrayContaining(["WebAssetFiles", "WebCdn", "WebKvKeys"]),
    );
  });

  it("can be linked by a function", async () => {
    const { Function } = await import("../../../src/components/aws/function");
    const web = new Site("Web", { path: "web" });
    new Function("Api", { handler: "src/api.handler", link: [web] });
    await pulumi.settle();
    expect(names()).toContain("ApiFunction");
  });
});
