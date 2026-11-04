import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

export interface DistributionInvalidationArgs {
  distributionId: Input<string>;
  /** The paths to invalidate. A path that ends in `*` is a wildcard. */
  paths: Input<string[]>;
  /** Whether a deploy waits for the invalidation to finish. */
  wait: Input<boolean>;
  /** A new one invalidates again: what's served changed. */
  version: Input<string>;
}

/**
 * A CloudFront invalidation, made when it's created and each time its
 * `version` changes. One of SST's own resources, which the `sst` binary serves
 * as a Pulumi provider.
 */
export class DistributionInvalidation extends CustomResource {
  constructor(
    name: string,
    args: DistributionInvalidationArgs,
    opts?: CustomResourceOptions,
  ) {
    super("sst:aws:DistributionInvalidation", name, { ...args }, opts);
  }
}
