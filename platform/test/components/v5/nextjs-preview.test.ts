import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

// A Next.js app as OpenNext builds it, as in nextjs.test.ts. The build writes
// its environment to a file, to see what it was given.
const app = fs.mkdtempSync(path.join(os.tmpdir(), "sst-nextjs-preview-"));
const site = path.join(app, "web");
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(site, file)), { recursive: true });
  fs.writeFileSync(path.join(site, file), content);
};
const handler = "export const handler = async () => ({});";
write(".next/BUILD_ID", "build-1");
write(".next/routes-manifest.json", JSON.stringify({ basePath: "" }));
write(".next/prerender-manifest.json", JSON.stringify({ routes: {} }));
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
      },
      imageOptimizer: {
        type: "function",
        handler: "index.handler",
        bundle: ".open-next/image-optimization-function",
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
    },
  }),
);
write(".open-next/server-functions/default/index.mjs", handler);
write(".open-next/image-optimization-function/index.mjs", handler);
write(".open-next/revalidation-function/index.mjs", handler);
write(".open-next/dynamodb-provider/index.mjs", handler);
write(".open-next/assets/favicon.ico", "icon");
write(".open-next/cache/build-1/index.cache", "{}");

// A new stage's preview: everything is about to be created, so of each
// resource only what it was given is known, and nothing AWS gives back
const pulumi = mockPulumi({
  root: app,
  preview: true,
  state: (args) =>
    Object.fromEntries(
      [
        "arn",
        "bucket",
        "name",
        "url",
        "qualifiedArn",
        "functionUrl",
        "domainName",
        "id",
      ]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    ),
});

afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

describe("a Nextjs site in a new stage's preview", () => {
  it("is built without what isn't known, and plans everything a deploy creates", async () => {
    const { Nextjs } = await import("../../../src/components/aws/v5/nextjs");
    const { Queue } = await import("../../../src/components/aws/v5/queue");
    const { Linkable } = await import("../../../src/components/linkable");
    const jobs = new Queue("Jobs");
    // A link none of whose properties are known: they come from an output
    const settings = new Linkable("Settings", {
      properties: jobs.url.apply((url) => ({ url })),
    });
    new Nextjs("Next", {
      path: site,
      buildCommand: "env > build-env.txt",
      link: [jobs, settings],
      environment: { QUEUE_URL: jobs.url, STATIC: "1" },
    });
    await pulumi.settle();

    // The queue's URL isn't known, so the build doesn't have it
    const env = fs
      .readFileSync(path.join(site, "build-env.txt"), "utf8")
      .split("\n");
    expect(env).toContain("STATIC=1");
    expect(env.some((line) => line.startsWith("QUEUE_URL="))).toBe(false);
    const link = env.find((line) => line.startsWith("SST_RESOURCE_Jobs="));
    expect(JSON.parse(link!.split("=").slice(1).join("="))).toEqual({
      type: "sst.aws.Queue",
    });
    // Still linked, with its type
    const linked = env.find((line) =>
      line.startsWith("SST_RESOURCE_Settings="),
    );
    expect(JSON.parse(linked!.split("=").slice(1).join("="))).toEqual({
      type: "sst.sst.Linkable",
    });

    const inSite = pulumi.resources
      .filter((r) => r.parent.endsWith("::sst:aws:Nextjs::Next"))
      .map((r) => r.name)
      .sort();
    expect(inSite).toEqual([
      "NextAssetFiles.sst.aws.BucketFiles",
      "NextAssets",
      "NextCdn",
      "NextCloudfrontFunctionRequest",
      "NextImageOptimizer",
      "NextImageOptimizerPublicFunctionUrlAccess",
      "NextInvalidation.sst.aws.DistributionInvalidation",
      "NextKvKeys.sst.aws.KvKeys",
      "NextKvStore",
      "NextPublicFunctionUrlAccessUseast1",
      "NextRevalidationEvents",
      "NextRevalidationSeed",
      "NextRevalidationSeeder",
      "NextRevalidationTable",
      "NextServerCachePolicy",
      "NextServerUseast1",
    ]);
  });
});
