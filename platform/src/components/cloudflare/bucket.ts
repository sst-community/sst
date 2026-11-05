import type { ComponentResourceOptions, Output } from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import { type ComponentArgs, component } from "../parts-component";
import type { Input } from "../input";
import { binding } from "./binding";
import { DEFAULT_ACCOUNT_ID } from "./account-id";
import { useExisting } from "./helpers/lookup";

const parts = {
  /**
   * The Cloudflare R2 Bucket. Pass one you have in `existing`, or its name.
   */
  bucket: cf.R2Bucket,
};

export interface BucketArgs extends ComponentArgs<typeof parts> {
  /**
   * The Cloudflare account ID to use for this R2 Bucket.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * The `Bucket` component lets you add a [Cloudflare R2 Bucket](https://developers.cloudflare.com/r2/) to
 * your app.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const bucket = new sst.cloudflare.Bucket("MyBucket");
 * ```
 *
 * #### Link to a worker
 *
 * You can link the bucket to a worker.
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.cloudflare.Worker("MyWorker", {
 *   handler: "./index.ts",
 *   link: [bucket],
 *   url: true
 * });
 * ```
 *
 * Once linked, you can use the SDK to interact with the bucket.
 *
 * ```ts title="index.ts" {3}
 * import { Resource } from "sst";
 *
 * await Resource.MyBucket.list();
 * ```
 *
 * #### Use an existing bucket
 *
 * Pass the name of a bucket you already have in `existing`. It's used the way
 * it is.
 *
 * ```ts title="sst.config.ts"
 * const bucket = new sst.cloudflare.Bucket("MyBucket", {
 *   existing: { bucket: "my-bucket" }
 * });
 * ```
 *
 * It's looked up in the app's account. For a bucket in another account, give
 * the account ID in front of the name, as `"<account_id>/my-bucket"`. For a
 * bucket in a [jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/#jurisdictional-restrictions),
 * give the account ID, the name and the jurisdiction, as
 * `"<account_id>/my-bucket/eu"`.
 *
 * #### Switch from SST 4's `sst.cloudflare.Bucket`
 *
 * Keep the name, and `sst migrate` moves it. The bucket and what's in it are kept.
 *
 * A few things are different:
 *
 * - A Worker it's linked to is given the bucket's jurisdiction, for a bucket
 *   that has one, like `eu`. `sst.cloudflare.Bucket` left it out of the
 *   binding, and a Worker can't reach such a bucket without it. If you set
 *   `jurisdiction` in `transform`, the Worker is updated on the switch. A
 *   site it's linked to has it in the Wrangler config its build and
 *   `sst dev` read too.
 * - You can pass a bucket you already have in `existing`, or its name. The
 *   name can have the account ID in front, `"<account_id>/my-bucket"`, and
 *   the jurisdiction after it, `"<account_id>/my-bucket/eu"`.
 */
export class Bucket extends component("sst:cloudflare:Bucket", parts) {
  constructor(
    name: string,
    args: BucketArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const accountId = args.accountId ?? DEFAULT_ACCOUNT_ID;

    // A bucket that's already deployed is used as it is. Cloudflare's
    // provider looks it up by its account, name and jurisdiction, which is
    // "default" for a bucket outside one.
    const existing = args.existing?.bucket;
    if (existing !== undefined) {
      useExisting(
        existing,
        accountId,
        (id) => this.lookupPart("bucket", id),
        "default",
      );
      return;
    }

    this.part("bucket", {
      // Named by SST, as the 4.x `Bucket` names it
      name: "",
      accountId,
    });
  }

  /**
   * The generated name of the R2 Bucket.
   */
  public get name() {
    return this.nodes.bucket.name;
  }

  /**
   * When you link a bucket to a worker, you can interact with it using these
   * [Bucket methods](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions).
   *
   * @example
   * ```ts title="index.ts" {3}
   * import { Resource } from "sst";
   *
   * await Resource.MyBucket.list();
   * ```
   *
   * @internal
   */
  public link() {
    return {
      properties: { name: this.name },
      include: [
        binding({
          type: "r2BucketBindings",
          properties: {
            bucketName: this.name,
            // Cloudflare gives a bucket outside any jurisdiction "default",
            // which a binding doesn't take. Left out, it isn't in the binding.
            jurisdiction: this.nodes.bucket.jurisdiction.apply(
              (jurisdiction) =>
                jurisdiction && jurisdiction !== "default"
                  ? jurisdiction
                  : undefined,
            ) as Output<string>,
          },
        }),
      ],
    };
  }
}
