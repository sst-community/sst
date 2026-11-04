import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

export interface MicrovmImagePruneArgs {
  /** The ARN of the MicroVM image. */
  imageArn: Input<string>;
  /** The version that was just built. A new one prunes again. */
  imageVersion: Input<string>;
  /** The image's region. */
  region: Input<string>;
  /** How many of the newest versions that built to keep, the current one included. */
  keep: Input<number>;
}

/**
 * Deletes the old versions of a Lambda MicroVM image after each build, as an
 * image can have 50. It keeps the current version, the newest ones that
 * built, and every version a MicroVM still runs from, and never fails a
 * deploy. One of SST's own resources, which the `sst` binary serves as a
 * Pulumi provider.
 */
export class MicrovmImagePrune extends CustomResource {
  constructor(
    name: string,
    args: MicrovmImagePruneArgs,
    opts?: CustomResourceOptions,
  ) {
    super("sst:aws:MicrovmImagePrune", name, { ...args }, opts);
  }
}
