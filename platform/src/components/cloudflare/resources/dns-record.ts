import {
  CustomResource,
  CustomResourceOptions,
  Input,
  Output,
} from "@pulumi/pulumi";
import { DEFAULT_ACCOUNT_ID } from "../account-id";

export interface DnsRecordArgs {
  zoneId: Input<string>;
  type: Input<string>;
  name: Input<string>;
  value?: Input<string>;
  /** What a CAA record holds. */
  data?: Input<{
    flags: Input<string>;
    tag: Input<string>;
    value: Input<string>;
  }>;
  proxied?: Input<boolean>;
  accountId?: Input<string>;
}

export interface DnsRecord {
  recordId: Output<string>;
}

/**
 * A DNS record in a Cloudflare zone that may be there already, like the CAA
 * record an AWS certificate needs: one that exists is taken as it is, and the
 * record is kept when it's deleted. One of SST's own resources, which the
 * `sst` binary serves as a Pulumi provider. It calls Cloudflare's API with the
 * CLI's credentials, which aren't in its inputs: those are saved to the state.
 */
export class DnsRecord extends CustomResource {
  constructor(name: string, args: DnsRecordArgs, opts?: CustomResourceOptions) {
    super(
      "sst:cloudflare:DnsRecord",
      name,
      {
        ...args,
        accountId: args.accountId ?? DEFAULT_ACCOUNT_ID,
        recordId: undefined,
      },
      opts,
    );
  }
}
