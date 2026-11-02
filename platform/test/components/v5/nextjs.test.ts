import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { rejectionsOf } from "../../helpers/rejections";

const DISTRIBUTION = "aws:cloudfront/distribution:Distribution";
const DYNAMIC = "pulumi-nodejs:dynamic:Resource";
const FUNCTION_URL =
  "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";
const EDGE_ARN = "arn:aws:lambda:us-east-1:123456789012:function:signer:3";
const STORE_ARN =
  "arn:aws:cloudfront::123456789012:key-value-store/their-store";

// A Next.js app as OpenNext builds it. `buildCommand: "true"` stands in for
// the build, so what it would have made is made here.
const app = fs.mkdtempSync(path.join(os.tmpdir(), "sst-nextjs-"));
function writeSite(dir: string, props: Record<string, unknown> = {}) {
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const handler = "export const handler = async () => ({});";
  write(
    "package.json",
    JSON.stringify({ name: "web", dependencies: { next: "15.0.0" } }),
  );
  write(".next/BUILD_ID", "build-1");
  write(".next/routes-manifest.json", JSON.stringify({ basePath: "" }));
  write(
    ".next/prerender-manifest.json",
    JSON.stringify({ version: 4, routes: { "/": {}, "/about": {} } }),
  );
  write(
    ".open-next/open-next.output.json",
    JSON.stringify({
      edgeFunctions: {},
      origins: {
        s3: { type: "s3", originPath: "_assets", copy: [] },
        default: {
          type: "function",
          handler: "index.handler",
          bundle: ".open-next/server-functions/default",
          streaming: false,
          wrapper: "aws-lambda",
          converter: "aws-apigw-v2",
          queue: "sqs",
          incrementalCache: "s3",
          tagCache: "dynamodb",
        },
        imageOptimizer: {
          type: "function",
          handler: "index.handler",
          bundle: ".open-next/image-optimization-function",
          wrapper: "aws-lambda",
          converter: "aws-apigw-v2",
          imageLoader: "s3",
        },
      },
      behaviors: [],
      additionalProps: {
        initializationFunction: {
          handler: "index.handler",
          bundle: ".open-next/initialization-function",
        },
        revalidationFunction: {
          handler: "index.handler",
          bundle: ".open-next/revalidation-function",
        },
        ...props,
      },
    }),
  );
  write(".open-next/server-functions/default/index.mjs", handler);
  write(".open-next/image-optimization-function/index.mjs", handler);
  write(".open-next/revalidation-function/index.mjs", handler);
  write(".open-next/dynamodb-provider/index.mjs", handler);
  write(".open-next/dynamodb-provider/dynamodb-cache.json", "[]");
  write(".open-next/assets/favicon.ico", "icon");
  write(".open-next/assets/BUILD_ID", "build-1");
  write(".open-next/assets/_next/static/chunks/main-abc.js", "js");
  write(".open-next/assets/blog/post.html", "<html></html>");
  write(".open-next/cache/build-1/index.cache", "{}");
}
const site = path.join(app, "web");
const noIsr = path.join(app, "no-isr");
const based = path.join(app, "docs");
writeSite(site);
writeSite(noIsr, { disableIncrementalCache: true, disableTagCache: true });
writeSite(based);
fs.writeFileSync(
  path.join(based, ".next/routes-manifest.json"),
  JSON.stringify({ basePath: "/docs" }),
);

const pulumi = mockPulumi({
  root: app,
  // The 4.x subscriber of the revalidation queue, named after the queue's ARN
  wrappers: /^sst:aws:QueueLambdaSubscriber::/,
  state: (args) => {
    if (args.type === DISTRIBUTION)
      return {
        domainName: `${args.name.toLowerCase()}.cloudfront.net`,
        hostedZoneId: "Z2FDTNDATAQYW2",
        etag: "E1",
      };
    if (args.type === DYNAMIC && "etag" in args.inputs) return { isDone: true };
    if (args.type === "aws:lambda/function:Function")
      return { qualifiedArn: `${args.name}:1` };
    if (args.type === "aws:lambda/functionUrl:FunctionUrl")
      return { functionUrl: FUNCTION_URL };
    if (args.type === "aws:acm/certificate:Certificate")
      return {
        domainValidationOptions: [
          {
            resourceRecordType: "CNAME",
            resourceRecordName: "_abc.example.com.",
            resourceRecordValue: "_def.acm-validations.aws.",
          },
        ],
      };
    return {};
  },
});

describe("Nextjs", () => {
  let OriginalNextjs: typeof import("../../../src/components/aws/nextjs").Nextjs;
  let Nextjs: typeof import("../../../src/components/aws/v5/nextjs").Nextjs;
  let OriginalRouter: typeof import("../../../src/components/aws/router").Router;
  let Router: typeof import("../../../src/components/aws/v5/router").Router;
  let Bucket: typeof import("../../../src/components/aws/v5/bucket").Bucket;

  beforeAll(async () => {
    OriginalNextjs = (await import("../../../src/components/aws/nextjs"))
      .Nextjs;
    Nextjs = (await import("../../../src/components/aws/v5/nextjs")).Nextjs;
    OriginalRouter = (await import("../../../src/components/aws/router"))
      .Router;
    Router = (await import("../../../src/components/aws/v5/router")).Router;
    Bucket = (await import("../../../src/components/aws/v5/bucket")).Bucket;
    await import("../../../src/components/aws/takeover/index");
  });

  afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);

  // What 4.x kept in the state and the V5 site doesn't: the command that
  // built it, and the wrapper of the revalidation queue's subscriber
  const BUILDER = "command:local:Command::NextBuilder";
  // A site with ISR: the seed is made again once
  const isr = {
    unclaimed: [BUILDER],
    changed: [["NextRevalidationSeed", ["triggers"]]] as [string, string[]][],
    wrappers: 1,
  };

  describe("takes over a deployed Nextjs", () => {
    pulumi.takeoverCases({
      original: () => OriginalNextjs,
      v5: () => Nextjs,
      // 4.x created what it made from the build inside an `apply` that
      // waited for everything the build read: the router's outputs, a
      // linked bucket's name, which waits for its CORS rules, and for the
      // warmer, the server it links, URL and all. Nothing in AWS needs any of
      // it removed first.
      needlessOrder:
        /^(NextServer\w+Function before Router(KvStore|CdnDistribution)|NextKvKeys\S* before RouterCdnDistribution|Next\S+ before UploadsCors|Next(WarmerTarget|WarmerPermission|Prewarm)\w+ before NextServer\w+Url(Access|Invoke)?)$/,
      cases: {
        "on a distribution of its own": {
          create: (Nextjs, opts) =>
            new Nextjs("Next", { path: site, buildCommand: "true" }, opts),
          ...isr,
        },
        "behind a 4.x Router": {
          create: (Nextjs, opts) => {
            const router = new OriginalRouter("Router");
            return new Nextjs(
              "Next",
              {
                path: site,
                buildCommand: "true",
                router: { instance: router },
              },
              opts,
            );
          },
          ...isr,
        },
        "behind a V5 Router that signs, under a path": {
          create: (Nextjs, opts) => {
            const router = new Router("Router", { protection: "oac" });
            return new Nextjs(
              "Next",
              {
                path: based,
                buildCommand: "true",
                router: {
                  instance: router,
                  path: "/docs",
                  domain: "docs.example.com",
                },
              },
              opts,
            );
          },
          ...isr,
        },
        "with OAC": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
              { path: site, buildCommand: "true", protection: "oac" },
              opts,
            ),
          ...isr,
        },
        "with edge signing": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
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
          ...isr,
        },
        "with the user's edge signer": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
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
          ...isr,
        },
        "kept warm": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
              { path: site, buildCommand: "true", warm: 3 },
              opts,
            ),
          unclaimed: [BUILDER, "sst:aws:Cron::NextWarmerUseast1"],
          changed: [
            ["NextPrewarmUseast1", ["triggers"]],
            ["NextRevalidationSeed", ["triggers"]],
          ],
          wrappers: 1,
        },
        "in two regions, kept warm": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
              {
                path: site,
                buildCommand: "true",
                regions: ["us-east-1", "eu-west-1"],
                warm: 1,
              },
              opts,
            ),
          unclaimed: [
            BUILDER,
            "sst:aws:Cron::NextWarmerUseast1",
            "sst:aws:Cron::NextWarmerEuwest1",
          ],
          changed: [
            ["NextPrewarmEuwest1", ["triggers"]],
            ["NextPrewarmUseast1", ["triggers"]],
            ["NextRevalidationSeed", ["triggers"]],
          ],
          wrappers: 1,
        },
        "with ISR turned off": {
          create: (Nextjs, opts) =>
            new Nextjs("Next", { path: noIsr, buildCommand: "true" }, opts),
          unclaimed: [BUILDER],
        },
        "with links and environment": {
          create: (Nextjs, opts) => {
            const bucket = new Bucket("Uploads");
            return new Nextjs(
              "Next",
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
          ...isr,
        },
        "with edge code, a cache policy and versioned invalidation": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
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
          ...isr,
        },
        "without invalidation, with server options": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
              {
                path: site,
                buildCommand: "true",
                invalidation: false,
                server: {
                  memory: "2048 MB",
                  timeout: "30 seconds",
                  architecture: "arm64",
                  install: ["sharp"],
                  layers: ["arn:aws:lambda:us-east-1:123456789012:layer:one:1"],
                },
                imageOptimization: { memory: "512 MB", staticEtag: true },
                assets: {
                  purge: true,
                  nonVersionedFilesCacheHeader: "no-cache",
                },
              },
              opts,
            ),
          ...isr,
        },
        "with a domain that redirects": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
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
          ...isr,
        },
        "in a VPC": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
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
          ...isr,
        },
        "with edge code on a store of the user's": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
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
          ...isr,
          check: () => expect(names()).not.toContain("NextKvStore"),
        },
        "with the server transformed": {
          create: (Nextjs, opts) =>
            new Nextjs(
              "Next",
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
          ...isr,
          check: () =>
            expect(resource("NextServerUseast1Function").inputs).toMatchObject({
              memorySize: 3008,
              description: "The site's server",
            }),
        },
        "in two regions behind a Router that signs": {
          create: (Nextjs, opts) => {
            const router = new Router("Router", { protection: "oac" });
            return new Nextjs(
              "Next",
              {
                path: site,
                buildCommand: "true",
                regions: ["us-east-1", "eu-west-1"],
                router: { instance: router },
              },
              opts,
            );
          },
          ...isr,
        },
        "deployed in sst dev": {
          create: (Nextjs, opts) => {
            // @ts-ignore
            global.$dev = true;
            return new Nextjs(
              "Next",
              {
                path: site,
                buildCommand: "exit 1",
                dev: { command: "next dev" },
              },
              opts,
            );
          },
          check: () => expect(names()).toContain("NextDevServer"),
        },
      },
    });
  });

  it("builds once, with the values of its links and its environment", async () => {
    const env = path.join(site, "build-env.txt");
    const bucket = new Bucket("Uploads");
    new Nextjs("Next", {
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
    expect(lines.find((l) => l.startsWith("API_URL="))).toMatch(/^API_URL=.+/);
    const uploads = lines.find((l) => l.startsWith("SST_RESOURCE_Uploads="));
    expect(JSON.parse(uploads!.split("=").slice(1).join("="))).toMatchObject({
      type: "sst.aws.Bucket",
    });
    expect(lines.some((l) => l.startsWith("SST_RESOURCE_App="))).toBe(true);
  });

  it("fails with the end of a build's output", async () => {
    const { buildSite } = await import(
      "../../../src/components/aws/helpers/site-build"
    );
    await expect(
      buildSite({
        name: "Next",
        sitePath: site,
        command: "echo first; echo the reason >&2; exit 3",
      }),
    ).rejects.toThrow(
      /`echo first; echo the reason >&2; exit 3` exited with 3\.\n[\s\S]*the reason/,
    );
  });

  it("fails a deploy once, with the build's own message", async () => {
    const failures = await rejectionsOf(async () => {
      const next = new Nextjs("Next", {
        path: site,
        buildCommand: "echo the reason >&2; exit 3",
        warm: 1,
      });
      // What's made from the server waits for it, and fails with the build
      const server = (next.nodes.server["us-east-1"] as any).promise();
      await expect(server).rejects.toThrow(/Failed to build the "Next" site/);
      await pulumi.settle();
    });
    // Pulumi reports an error once, by identity
    expect(failures.length).toBeGreaterThan(0);
    expect(new Set(failures).size).toBe(1);
    expect((failures[0] as Error).message).toBe(
      'Failed to build the "Next" site: `echo the reason >&2; exit 3` exited with 3.\nthe reason',
    );
    expect(names()).not.toContain("NextServerUseast1");
  });

  it("has its server in nodes from the start, without regions", async () => {
    const next = new Nextjs("Next", {
      path: site,
      buildCommand: "true",
      warm: 1,
    });
    expect(Object.keys(next.nodes.server)).toEqual(["us-east-1"]);
    expect(Object.keys(next.nodes.warmer)).toEqual(["us-east-1"]);
    expect(Object.keys(next.nodes.prewarm)).toEqual(["us-east-1"]);
    expect(Object.keys(next.nodes.urlAccess)).toEqual(["us-east-1"]);
    expect(Object.keys(next.nodes.cloudFrontUrlAccess)).toEqual([]);
    const server = await pulumi.resolve(next.nodes.server["us-east-1"]);
    expect(server.constructor.name).toBe("Function");
    await pulumi.settle();
  });

  it("has its server in nodes once it's created, given a provider of its own", async () => {
    const { Provider } = await import("@pulumi/aws");
    const next = new Nextjs(
      "Next",
      { path: site, buildCommand: "true" },
      { provider: new Provider("West", { region: "us-west-2" }) },
    );
    // The provider's region is read in the deploy
    expect(Object.keys(next.nodes.server)).toEqual([]);
    await pulumi.settle();
    // The mock's lookups give us-east-1, whatever the provider
    expect(Object.keys(next.nodes.server)).toEqual(["us-east-1"]);
  });

  it("gives each server by region, and ISR's parts, as outputs", async () => {
    const next = new Nextjs("Next", {
      path: noIsr,
      buildCommand: "true",
      regions: ["us-east-1", "eu-west-1"],
    });
    expect(Object.keys(next.nodes.server)).toEqual(["us-east-1", "eu-west-1"]);
    const server = await pulumi.resolve(next.nodes.server["eu-west-1"]);
    expect(server.constructor.name).toBe("Function");
    expect(await pulumi.resolve(next.nodes.revalidationQueue)).toBeUndefined();
    expect(await pulumi.resolve(next.nodes.revalidationTable)).toBeUndefined();
    expect(next.nodes.cdn).toBeDefined();
    await pulumi.settle();
  });

  it("can be linked by a function", async () => {
    const { Function } = await import(
      "../../../src/components/aws/v5/function"
    );
    const next = new Nextjs("Next", { path: site, buildCommand: "true" });
    new Function("Api", { handler: "src/api.handler", link: [next] });
    await pulumi.settle();
    expect(names()).toContain("ApiFunction");
    expect(names()).toContain("NextServerUseast1Function");
  });

  it("runs on your machine in sst dev", async () => {
    // @ts-ignore
    global.$dev = true;
    const next = new Nextjs("Next", {
      path: site,
      buildCommand: "exit 1",
      dev: { command: "next dev", title: "Web" },
    });
    await pulumi.settle();
    expect(
      names()
        .filter((n) => n.startsWith("Next"))
        .sort(),
    ).toEqual(
      expect.arrayContaining([
        "Next",
        "NextDevServer",
        "NextDevServerFunction",
      ]),
    );
    expect(names()).not.toContain("NextServerUseast1");
    expect(pulumi.reportOf("Next")?.dev).toMatchObject({
      command: "next dev",
      title: "Web",
      directory: site,
      autostart: true,
    });
    expect(() => next.nodes.server).toThrow(/runs locally/);
  });

  it("turns down what sst.aws.Nextjs took and the V5 one doesn't", () => {
    expect(
      () =>
        new Nextjs("Next", {
          path: site,
          // @ts-expect-error
          route: { router: {} },
        }),
    ).toThrow(/"route" isn't an option/);
    expect(
      () =>
        // @ts-expect-error
        new Nextjs("Next", { path: site, cdn: false }),
    ).toThrow(/"cdn" isn't an option/);
    expect(
      () =>
        new Nextjs("Next", {
          path: site,
          // @ts-expect-error
          server: { edge: {} },
        }),
    ).toThrow(/"edge" isn't an option/);
    expect(
      () =>
        new Nextjs("Next", {
          path: site,
          // @ts-expect-error
          regions: output(["us-east-1"]),
        }),
    ).toThrow(/"regions"/);
    expect(
      () => new Nextjs("Next", { path: path.join(app, "missing") }),
    ).toThrow(/Site directory not found/);
  });

  it("creates what 4.x created", async () => {
    new Nextjs("Next", { path: site, buildCommand: "true" });
    await pulumi.settle();
    expect(names()).toEqual(
      expect.arrayContaining([
        "NextAssets",
        "NextAssetFiles.sst.aws.BucketFiles",
        "NextServerUseast1",
        "NextImageOptimizer",
        "NextRevalidationEvents",
        "NextRevalidationTable",
        "NextRevalidationSeeder",
        "NextRevalidationSeed",
        "NextKvKeys.sst.aws.KvKeys",
        "NextInvalidation.sst.aws.DistributionInvalidation",
        "NextCdn",
        "NextKvStore",
        "NextServerCachePolicy",
        "NextCloudfrontFunctionRequest",
        "NextPublicFunctionUrlAccessUseast1",
        "NextImageOptimizerPublicFunctionUrlAccess",
      ]),
    );
  });
});
