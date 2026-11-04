import {
  CustomResource,
  CustomResourceOptions,
  Input,
  Output,
} from "@pulumi/pulumi";

export interface DnsRecordArgs {
  domain: Input<string>;
  type: Input<string>;
  name: Input<string>;
  value: Input<string>;
  mxPriority?: Input<number>;
}

export interface DnsRecord {
  recordId: Output<string>;
}

/**
 * A DNS record in a Vercel domain that may be there already, like the CAA
 * record an AWS certificate needs: one that exists is taken as it is, and the
 * record is kept when it's deleted. One of SST's own resources, which the
 * `sst` binary serves as a Pulumi provider. It calls Vercel's API with
 * VERCEL_API_TOKEN, which isn't in its inputs: those are saved to the state.
 */
export class DnsRecord extends CustomResource {
  constructor(name: string, args: DnsRecordArgs, opts?: CustomResourceOptions) {
    super(
      "sst:vercel:DnsRecord",
      name,
      { ...args, teamId: process.env.VERCEL_TEAM_ID, recordId: undefined },
      opts,
    );
  }
}
