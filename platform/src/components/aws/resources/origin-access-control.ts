import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

export interface OriginAccessControlArgs {
  /**
   * What its name starts with. A random ending is added, so a new one can be
   * made before the old one is deleted. It's ignored once it's created.
   */
  name: Input<string>;
}

/**
 * A CloudFront origin access control that signs requests to an S3 bucket. One
 * of SST's own resources, which the `sst` binary serves as a Pulumi provider.
 * A move adopts SST 4's by its id.
 */
export class OriginAccessControl extends CustomResource {
  constructor(
    name: string,
    args: OriginAccessControlArgs,
    opts?: CustomResourceOptions,
  ) {
    super("sst:aws:OriginAccessControl", name, { ...args }, opts);
  }
}
