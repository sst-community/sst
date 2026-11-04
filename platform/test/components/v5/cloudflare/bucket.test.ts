import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";

const BUCKET = "cloudflare:index/r2Bucket:R2Bucket";
// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

// Cloudflare gives a bucket outside any jurisdiction "default"
const pulumi = mockPulumi({
  state: (args) =>
    args.type === BUCKET
      ? { jurisdiction: args.inputs.jurisdiction ?? "default" }
      : {},
});

type BucketClass =
  | typeof import("../../../../src/components/cloudflare/bucket").Bucket
  | typeof import("../../../../src/components/cloudflare/v5/bucket").Bucket;

describe("Bucket", () => {
  let Original: typeof import("../../../../src/components/cloudflare/bucket").Bucket;
  let Bucket: typeof import("../../../../src/components/cloudflare/v5/bucket").Bucket;
  let OriginalWorker: typeof import("../../../../src/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/v5/worker").Worker;

  beforeAll(async () => {
    Original = (await import("../../../../src/components/cloudflare/bucket"))
      .Bucket;
    Bucket = (await import("../../../../src/components/cloudflare/v5/bucket"))
      .Bucket;
    OriginalWorker = (
      await import("../../../../src/components/cloudflare/worker")
    ).Worker;
    Worker = (await import("../../../../src/components/cloudflare/v5/worker"))
      .Worker;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const bindingsOf = (name = "MyWorkerScript") =>
    resource(name).inputs.bindings as Record<string, any>[];
  const value = (v: any) => new Promise((resolve) => output(v).apply(resolve));

  describe("takes over a deployed Bucket", () => {
    pulumi.takeoverCases<BucketClass, BucketClass>({
      original: () => Original,
      v5: () => Bucket,
      provider: "cloudflare",
      cases: {
        "a bucket": {
          create: (Bucket, opts) => new Bucket("MyBucket", {}, opts),
          check: () =>
            expect(resource("MyBucketBucket")).toMatchObject({
              kind: "register",
              type: BUCKET,
            }),
        },
        "a bucket in another account": (Bucket, opts) =>
          new Bucket("MyBucket", { accountId: "other-account" }, opts),
        "a bucket transformed": (Bucket, opts) =>
          new Bucket(
            "MyBucket",
            {
              transform: {
                bucket: { location: "weur", storageClass: "InfrequentAccess" },
              },
            },
            opts,
          ),
        "a bucket in a jurisdiction": (Bucket, opts) =>
          new Bucket(
            "MyBucket",
            { transform: { bucket: { jurisdiction: "eu" } } },
            opts,
          ),
        // The worker is the 5.0 one both times: what it's given is the
        // bucket's binding
        "a bucket a worker is linked to": {
          create: (Bucket, opts) => {
            const bucket = new Bucket("MyBucket", {}, opts);
            new Worker("MyWorker", { handler, link: [bucket] });
          },
          check: () =>
            expect(bindingsOf()).toContainEqual({
              type: "r2_bucket",
              name: "MyBucket",
              bucketName: resource("MyBucketBucket").inputs.name,
            }),
        },
        // SST 4 left the jurisdiction out of the binding, and a Worker can't
        // reach such a bucket without it. It's added: an update in place.
        "a bucket in a jurisdiction a worker is linked to": {
          create: (Bucket, opts) => {
            const bucket = new Bucket(
              "MyBucket",
              { transform: { bucket: { jurisdiction: "eu" } } },
              opts,
            );
            new Worker("MyWorker", { handler, link: [bucket] });
          },
          changed: [["MyWorkerScript", ["bindings"]]],
          check: () =>
            expect(
              bindingsOf().find((b) => b.type === "r2_bucket"),
            ).toMatchObject({ name: "MyBucket", jurisdiction: "eu" }),
        },
      },
    });
  });

  // An app switches the Worker and what it's linked to: the Worker is bound
  // to the bucket as SST 4's was
  it("binds a worker the way SST 4's did", async () => {
    const result = await pulumi.takesOver(
      () => {
        const bucket = new Original("MyBucket");
        new OriginalWorker("MyWorker", { handler, link: [bucket] });
      },
      () => {
        const bucket = new Bucket("MyBucket");
        new Worker("MyWorker", { handler, link: [bucket] });
      },
    );
    expect(result).toMatchObject({ unclaimed: [], changed: [], revealed: [] });
    expect(bindingsOf().find((b) => b.type === "r2_bucket")).toEqual({
      type: "r2_bucket",
      name: "MyBucket",
      bucketName: resource("MyBucketBucket").inputs.name,
    });
  });

  it("creates a bucket named for the app, in the account", async () => {
    const bucket = new Bucket("MyBucket", { accountId: "my-account" });
    await pulumi.settle();
    expect(resource("MyBucketBucket").inputs).toMatchObject({
      accountId: "my-account",
      name: expect.stringMatching(/^app-test-mybucketbucket-/),
    });
    expect(await value(bucket.name)).toBe(
      resource("MyBucketBucket").inputs.name,
    );
  });

  describe("its link", () => {
    it("gives its name", async () => {
      const bucket = new Bucket("MyBucket");
      const link = bucket.link();
      await pulumi.settle();
      expect(await value(link.properties)).toEqual({
        name: resource("MyBucketBucket").inputs.name,
      });
      expect(link.include![0]).toMatchObject({
        type: "cloudflare.binding",
        binding: "r2BucketBindings",
      });
    });

    it("binds no jurisdiction for a bucket outside one", async () => {
      new Worker("MyWorker", { handler, link: [new Bucket("MyBucket")] });
      await pulumi.settle();
      expect(resource("MyBucketBucket").inputs).not.toHaveProperty(
        "jurisdiction",
      );
      expect(
        bindingsOf().find((b) => b.type === "r2_bucket"),
      ).not.toHaveProperty("jurisdiction");
    });
  });

  describe("an existing bucket", () => {
    // R2's import id is `<account>/<name>/<jurisdiction>`
    it("is looked up by its name, its account and name, or the whole id", async () => {
      new Bucket("MyBucket", {
        accountId: "acct",
        existing: { bucket: "my-bucket" },
      });
      new Bucket("Other", { existing: { bucket: "acct/eu-bucket/eu" } });
      new Bucket("Third", { existing: { bucket: "other-acct/its-bucket" } });
      await pulumi.settle();
      expect(resource("MyBucketBucket")).toMatchObject({
        kind: "read",
        type: BUCKET,
        options: { id: "acct/my-bucket/default" },
      });
      expect(resource("OtherBucket").options.id).toBe("acct/eu-bucket/eu");
      expect(resource("ThirdBucket").options.id).toBe(
        "other-acct/its-bucket/default",
      );
    });

    it("is used as it is when it's the resource", async () => {
      const { R2Bucket } = await import("@pulumi/cloudflare");
      const shared = new R2Bucket("Shared", { accountId: "acct", name: "x" });
      const bucket = new Bucket("MyBucket", { existing: { bucket: shared } });
      await pulumi.settle();
      expect(bucket.nodes.bucket).toBe(shared);
      expect(pulumi.resources.map((r) => r.name)).not.toContain(
        "MyBucketBucket",
      );
    });
  });
});
