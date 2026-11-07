import { beforeAll, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;

// The resource options each resource is registered with, by name.
const options = new Map<string, pulumi.CustomResourceOptions>();
const resources = new Map<string, pulumi.runtime.MockResourceArgs>();

function resolveOutput<T>(value: pulumi.Output<T>) {
  return new Promise<T>((resolve) => {
    value.apply((resolved) => {
      resolve(resolved);
      return resolved;
    });
  });
}

// The name a resource was registered with.
function nameOf(resource: pulumi.Resource | undefined) {
  return (resource as any)?.__name as string | undefined;
}

describe("Bucket public access block lifecycle", () => {
  let Bucket: typeof import("../../src/components/aws/bucket").Bucket;

  beforeAll(async () => {
    await pulumi.runtime.setMocks(
      {
        newResource(args) {
          resources.set(args.name, args);
          return { id: `${args.name}_id`, state: args.inputs };
        },
        call(args) {
          return args.inputs;
        },
      },
      "project",
      "stack",
      false,
    );
    await pulumi.runtime.runInPulumiStack(async () => {
      pulumi.runtime.registerStackTransformation((args) => {
        options.set(args.name, args.opts as pulumi.CustomResourceOptions);
        return undefined;
      });
      Bucket = (await import("../../src/components/aws/bucket")).Bucket;
      return {};
    });
  });

  // Deleting the bucket doesn't delete its block first, so a bucket being
  // removed is never left without it.
  it("is deleted with its bucket", async () => {
    const bucket = new Bucket("DefaultBucket");
    await resolveOutput(bucket.name);

    expect(
      nameOf(options.get("DefaultBucketPublicAccessBlock")?.deletedWith),
    ).toBe("DefaultBucketBucket");
  });

  // `deletedWith` only applies when the bucket is deleted too. Removing the
  // block alone still deletes it, so nothing that works today changes.
  it("is not retained on its own", async () => {
    const bucket = new Bucket("PlainBucket");
    await resolveOutput(bucket.name);

    expect(
      options.get("PlainBucketPublicAccessBlock")?.retainOnDelete,
    ).toBeFalsy();
  });

  // `removal: "retain"` sets `retainOnDelete` on the S3 bucket alone
  // (auto/run.ts), so the block has none of its own and stays because it is
  // deleted with the bucket.
  it("stays with a bucket that is retained", async () => {
    const bucket = new Bucket("RetainedBucket", {
      transform: {
        bucket: (_args, opts) => {
          opts.retainOnDelete = true;
        },
      },
    });
    await resolveOutput(bucket.name);

    expect(options.get("RetainedBucketBucket")?.retainOnDelete).toBe(true);
    expect(
      options.get("RetainedBucketPublicAccessBlock")?.retainOnDelete,
    ).toBeFalsy();
    expect(
      nameOf(options.get("RetainedBucketPublicAccessBlock")?.deletedWith),
    ).toBe("RetainedBucketBucket");
  });

  it("lets a transform delete the block on its own again", async () => {
    let before: pulumi.Resource | undefined;
    const bucket = new Bucket("OverrideBucket", {
      transform: {
        publicAccessBlock: (_args, opts) => {
          before = opts.deletedWith;
          opts.deletedWith = undefined;
        },
      },
    });
    await resolveOutput(bucket.name);

    expect(nameOf(before)).toBe("OverrideBucketBucket");
    expect(
      options.get("OverrideBucketPublicAccessBlock")?.deletedWith,
    ).toBeUndefined();
  });

  it.each(["cloudfront", "public"] as const)(
    "keeps the public access block settings for %s access",
    async (access) => {
      const name = access === "public" ? "PublicBucket" : "CloudfrontBucket";
      const bucket = new Bucket(name, { access });
      await resolveOutput(bucket.name);
      await vi.waitFor(() => {
        expect(resources.has(`${name}PublicAccessBlock`)).toBe(true);
      });

      expect(resources.get(`${name}PublicAccessBlock`)?.inputs).toMatchObject({
        blockPublicAcls: true,
        blockPublicPolicy: access !== "public",
        ignorePublicAcls: true,
        restrictPublicBuckets: access !== "public",
      });
      expect(nameOf(options.get(`${name}PublicAccessBlock`)?.deletedWith)).toBe(
        `${name}Bucket`,
      );
    },
  );

  it("creates no block when the transform is false", async () => {
    const bucket = new Bucket("NoBlockBucket", {
      transform: { publicAccessBlock: false },
    });
    await resolveOutput(bucket.name);

    expect(options.has("NoBlockBucketPublicAccessBlock")).toBe(false);
  });
});
