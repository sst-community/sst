import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

// A Vite site that's built, and one that isn't. The build writes its
// environment to a file, to see what it was given.
const app = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-static-site-preview-")),
);
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.writeFileSync(path.join(app, file), content);
};
write("vite/vite.config.ts", "export default {};");
write("vite/dist/index.html", "<html>Built</html>");
write("plain/index.html", "<html>Home</html>");
write("plain/404.html", "<html>Not found</html>");

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
        "domainName",
        "bucketRegionalDomainName",
        "id",
      ]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    ),
});

afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

describe("a StaticSite in a new stage's preview", () => {
  it("is built without what isn't known, and plans everything a deploy creates", async () => {
    const { StaticSite } = await import(
      "../../../src/components/aws/v5/static-site"
    );
    const { Queue } = await import("../../../src/components/aws/v5/queue");
    const { Router } = await import("../../../src/components/aws/v5/router");
    const jobs = new Queue("Jobs");
    const router = new Router("Router");
    new StaticSite("Built", {
      path: "vite",
      build: { command: "env > build-env.txt", output: "dist" },
      environment: { VITE_QUEUE_URL: jobs.url, VITE_STAGE: "test" },
      router: { instance: router, path: "/app" },
    });
    new StaticSite("Plain", { path: "plain", errorPage: "404.html" });
    await pulumi.settle();

    // The queue's URL isn't known, so the build doesn't have it
    const env = fs
      .readFileSync(path.join(app, "vite/build-env.txt"), "utf8")
      .split("\n");
    expect(env).toContain("VITE_STAGE=test");
    expect(env.some((line) => line.startsWith("VITE_QUEUE_URL="))).toBe(false);
    // Vite's types have every key: those are known
    const types = fs.readFileSync(
      path.join(app, "vite/src/sst-env.d.ts"),
      "utf8",
    );
    expect(types).toContain("readonly VITE_QUEUE_URL: string");
    expect(types).toContain("readonly VITE_STAGE: string");

    const inSite = (name: string) =>
      pulumi.resources
        .filter((r) => r.parent.endsWith(`::sst:aws:StaticSite::${name}`))
        .map((r) => r.name)
        .sort();
    expect(inSite("Built")).toEqual([
      "BuiltAssetFiles",
      "BuiltAssets",
      "BuiltInvalidation.sst.aws.DistributionInvalidation",
      "BuiltKvKeys",
      "BuiltRoutesUpdate.sst.aws.KvRoutesUpdate",
    ]);
    expect(inSite("Plain")).toEqual([
      "PlainAssetFiles",
      "PlainAssets",
      "PlainCdn",
      "PlainCloudfrontFunctionRequest",
      "PlainInvalidation.sst.aws.DistributionInvalidation",
      "PlainKvKeys",
      "PlainKvStore",
      "PlainS3AccessControl.sst.aws.OriginAccessControl",
    ]);
  });
});
