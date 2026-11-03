import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { ssrSiteSuite } from "./ssr-site.suite";

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

// What 4.x kept in the state and the V5 site doesn't: the command that built
// it, and the wrapper of the revalidation queue's subscriber
const BUILDER = "command:local:Command::NextBuilder";

afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

// What every site with a server passes, with Next.js's build
ssrSiteSuite(
  {
    name: "Nextjs",
    site: "Next",
    load: async () => ({
      original: (await import("../../../src/components/aws/nextjs"))
        .Nextjs as any,
      v5: (await import("../../../src/components/aws/v5/nextjs")).Nextjs as any,
    }),
    paths: { site, based, app },
    alwaysServes: true,
    // A site with ISR: the seed is made again once
    each: {
      unclaimed: [BUILDER],
      changed: [["NextRevalidationSeed", ["triggers"]]],
      wrappers: 1,
    },
    created: [
      "NextImageOptimizer",
      "NextRevalidationEvents",
      "NextRevalidationTable",
      "NextRevalidationSeeder",
      "NextRevalidationSeed",
      "NextImageOptimizerPublicFunctionUrlAccess",
    ],
    // The 4.x subscriber of the revalidation queue, named after the queue's ARN
    wrappers: /^sst:aws:QueueLambdaSubscriber::/,
  },
  {
    cases: ({ expected }) => ({
      "with ISR turned off": {
        create: (Nextjs: any, opts) =>
          new Nextjs("Next", { path: noIsr, buildCommand: "true" }, opts),
        unclaimed: [BUILDER],
      },
      "with the image optimizer's options": {
        create: (Nextjs: any, opts) =>
          new Nextjs(
            "Next",
            {
              path: site,
              buildCommand: "true",
              imageOptimization: { memory: "512 MB", staticEtag: true },
            },
            opts,
          ),
        ...expected(),
      },
    }),
    tests: ({ pulumi, Site }) => {
      it("gives ISR's parts as outputs, undefined when the build turns ISR off", async () => {
        const Nextjs = Site() as any;
        const next = new Nextjs("Next", { path: noIsr, buildCommand: "true" });
        expect(
          await pulumi.resolve(next.nodes.revalidationQueue),
        ).toBeUndefined();
        expect(
          await pulumi.resolve(next.nodes.revalidationTable),
        ).toBeUndefined();
        await pulumi.settle();
      });
    },
  },
);
