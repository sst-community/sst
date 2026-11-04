import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

export interface KvRoutesUpdateArgs {
  /** The ARN of the CloudFront key-value store. */
  store: Input<string>;
  /** The key of the router's list of routes. */
  key: Input<string>;
  /** The route this adds to the list. */
  entry: Input<string>;
  /** What the router's keys start with. */
  namespace: Input<string>;
}

/**
 * A route in a router's list of routes, in a CloudFront key-value store,
 * shared with the router's other routes: added when it's created, and taken
 * out of the list when it's deleted. One of SST's own resources, which the
 * `sst` binary serves as a Pulumi provider.
 */
export class KvRoutesUpdate extends CustomResource {
  constructor(
    name: string,
    args: KvRoutesUpdateArgs,
    opts?: CustomResourceOptions,
  ) {
    super("sst:aws:KvRoutesUpdate", name, { ...args }, opts);
  }
}
