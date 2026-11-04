import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

export interface RdsRoleLookupArgs {
  /** The name of the IAM role. */
  name: Input<string>;
}

/**
 * Waits, up to five minutes, for the service-linked role RDS creates the first
 * time it's used in an account, so a proxy isn't created before it exists. It
 * waits when it's created: in a new account the role doesn't exist until the
 * database is created, so a preview can't look for it. One of SST's own
 * resources, which the `sst` binary serves as a Pulumi provider.
 */
export class RdsRoleLookup extends CustomResource {
  constructor(
    name: string,
    args: RdsRoleLookupArgs,
    opts?: CustomResourceOptions,
  ) {
    super("sst:aws:RdsRoleLookup", name, { ...args }, opts);
  }
}
