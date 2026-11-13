import {
  CustomResource,
  CustomResourceOptions,
  Input,
  Output,
} from "@pulumi/pulumi";
import { DEFAULT_ACCOUNT_ID } from "../account-id";

/**
 * Where a Worker runs: one of Smart Placement (`mode`), or near a region, a
 * host or a hostname.
 */
export interface WorkerPlacementArgs {
  accountId?: Input<string>;
  scriptName: Input<string>;
  /**
   * The script's etag, the hash of its code, so it's set again when the code
   * changes.
   */
  etag?: Input<string>;
  /**
   * When the script was last uploaded, so it's set again after every upload,
   * the code's or not: Cloudflare resets a script's placement when it's
   * uploaded without one, as Pulumi's provider uploads it.
   */
  modifiedOn?: Input<string>;
  mode?: Input<string | undefined>;
  region?: Input<string | undefined>;
  host?: Input<string | undefined>;
  hostname?: Input<string | undefined>;
}

export interface WorkerPlacement {
  scriptName: Output<string>;
}

/**
 * Where a Worker runs, in its script's settings, and back to Cloudflare's
 * default when it's deleted. One of SST's own resources, which the `sst`
 * binary serves as a Pulumi provider. It calls Cloudflare's API with the
 * CLI's credentials, which aren't in its inputs: those are saved to the state.
 */
export class WorkerPlacement extends CustomResource {
  constructor(
    name: string,
    args: WorkerPlacementArgs,
    opts?: CustomResourceOptions,
  ) {
    super(
      "sst:cloudflare:WorkerPlacement",
      name,
      { ...args, accountId: args.accountId ?? DEFAULT_ACCOUNT_ID },
      opts,
    );
  }
}
