import {
  type Input,
  type InvokeOutputOptions,
  type Output,
  output,
  runtime,
} from "@pulumi/pulumi";

/**
 * The id of the Route 53 hosted zone a domain is in: the one whose name is the
 * longest the domain ends with. A function of SST's provider, so a preview
 * finds it too; SST 4 looked it up with a resource, `HostedZoneLookup`.
 */
export function hostedZoneId(
  domain: Input<string>,
  opts?: InvokeOutputOptions,
): Output<string> {
  return runtime
    .invokeOutput<{ zoneId: string }>(
      "sst:aws:getHostedZone",
      { domain: output(domain).apply((name) => name.replace(/\.$/, "")) },
      opts,
    )
    .apply((found) => found.zoneId);
}
