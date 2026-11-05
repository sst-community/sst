import { CustomResourceOptions, Input, dynamic } from "@pulumi/pulumi";
import { rpc } from "../../../../../../src/components/rpc/rpc";

export interface MicrovmImagePruneInputs {
  /**
   * The ARN of the MicroVM image.
   */
  imageArn: Input<string>;
  /**
   * The version that was just built. A new one runs the prune again.
   */
  imageVersion: Input<string>;
  /**
   * The region of the image.
   */
  region: Input<string>;
  /**
   * How many of the newest versions that built to keep, the current one included.
   */
  keep: Input<number>;
}

/**
 * The `MicrovmImagePrune` component is internally used by the `MicroVm` component to
 * delete the old versions of its image after each build. Lambda allows 50 versions per
 * image.
 *
 * It keeps the current version, the newest ones that built, and every version MicroVMs
 * still run from. It never fails a deploy.
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 */
export class MicrovmImagePrune extends dynamic.Resource {
  constructor(
    name: string,
    args: MicrovmImagePruneInputs,
    opts?: CustomResourceOptions,
  ) {
    super(
      new rpc.Provider("Aws.MicrovmImagePrune"),
      `${name}.sst.aws.MicrovmImagePrune`,
      args,
      opts,
    );
  }
}
