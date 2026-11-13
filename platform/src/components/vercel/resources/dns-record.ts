import {
  Config,
  CustomResource,
  CustomResourceOptions,
  Input,
  Output,
  type Resource,
} from "@pulumi/pulumi";
import { underCore } from "../../context";
import { withVercelPlugin } from "../../plugin";

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
 * VERCEL_API_TOKEN, or in a program Pulumi runs on its own, the token of its
 * component's Vercel provider (`withVercelPlugin`). It isn't in its inputs,
 * which are saved to the state.
 */
export class DnsRecord extends CustomResource {
  constructor(name: string, args: DnsRecordArgs, opts?: CustomResourceOptions) {
    super(
      "sst:vercel:DnsRecord",
      name,
      { ...args, teamId: teamOf(opts?.parent), recordId: undefined },
      withVercelPlugin(opts),
    );
  }
}

// The team the record's domain is in: VERCEL_TEAM_ID, as SST's CLI has it,
// or in a program Pulumi runs on its own, the team of the component's Vercel
// provider, as Pulumi's resources take it
function teamOf(parent: Resource | undefined): Input<string | undefined> {
  const given = process.env.VERCEL_TEAM_ID;
  if (given || underCore()) return given;
  const provider = parent?.getProvider("vercel::");
  if (provider) return (provider as { team?: Output<string | undefined> }).team;
  return new Config("vercel").get("team");
}
