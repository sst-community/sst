import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

export interface KvKeysArgs {
  /** The ARN of the CloudFront key-value store. */
  store: Input<string>;
  /** What each key starts with, so several sets of entries share a store. */
  namespace: Input<string>;
  entries: Input<Record<string, Input<string>>>;
  /** Whether keys in the namespace that aren't in `entries` are deleted. */
  purge: Input<boolean>;
}

/**
 * Entries in a CloudFront key-value store, under a namespace: written again
 * when they change, and deleted when they're gone. One of SST's own
 * resources, which the `sst` binary serves as a Pulumi provider.
 */
export class KvKeys extends CustomResource {
  constructor(name: string, args: KvKeysArgs, opts?: CustomResourceOptions) {
    super("sst:aws:KvKeys", name, { ...args }, opts);
  }
}
