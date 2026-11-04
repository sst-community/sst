import {
  CustomResource,
  CustomResourceOptions,
  Input,
  Output,
} from "@pulumi/pulumi";

export interface WorkerUrlArgs {
  accountId: Input<string>;
  scriptName: Input<string>;
  /** Whether the Worker answers at its workers.dev URL. */
  enabled: Input<boolean>;
  /** The script's etag, so it's set again each time the script is uploaded. */
  etag?: Input<string>;
}

export interface WorkerUrl {
  /** The URL, without its scheme, while it's turned on. */
  url: Output<string | undefined>;
}

/**
 * A Worker's workers.dev URL, turned on or off. One of SST's own resources,
 * which the `sst` binary serves as a Pulumi provider. It calls Cloudflare's
 * API with the CLI's credentials, which aren't in its inputs: those are saved
 * to the state.
 */
export class WorkerUrl extends CustomResource {
  constructor(name: string, args: WorkerUrlArgs, opts?: CustomResourceOptions) {
    super("sst:cloudflare:WorkerUrl", name, { ...args, url: undefined }, opts);
  }
}
