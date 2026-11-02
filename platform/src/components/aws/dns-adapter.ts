import {
  type ComponentResourceOptions,
  type Input,
  type Output,
  all,
} from "@pulumi/pulumi";
import { route53 } from "@pulumi/aws";
import {
  type DnsAdapter,
  type DnsAliasRecord,
  type DnsRecord,
  recordName,
} from "../dns-adapter";
import { transform } from "../component";
import { logicalName } from "../naming";
import { plain } from "../args";
import { VisibleError } from "../error";
import { hostedZoneId } from "./resources/hosted-zone";
import type { DnsArgs } from "./dns";

/**
 * The adapter for domains on Route 53, as SST 5's components use it.
 * `sst.aws.dns()` gives it.
 *
 * It names records as `sst.aws.dns()` always has, so a component that
 * switches to SST 5 keeps them: `<prefix><type>Record<name>`, with the name in
 * DNS, or the record's `key`, made into a name. The hosted zone is found with
 * SST's provider, not with a resource.
 */
export function awsDnsAdapter(args: DnsArgs): DnsAdapter {
  return {
    provider: "aws",
    record,
    alias,
    caa: () => [],
  };

  function record(
    namePrefix: string,
    record: DnsRecord,
    opts: ComponentResourceOptions,
  ) {
    const type = plain(
      record.type,
      `The type of a DNS record of "${namePrefix}"`,
    );
    return create(
      `${namePrefix}${type}Record${recordName(record, namePrefix)}`,
      {
        type,
        name: record.name,
        ttl: 60,
        records: [
          all([record.value, record.priority]).apply(([value, priority]) =>
            priority !== undefined ? `${priority} ${value}` : value,
          ),
        ],
      },
      opts,
    );
  }

  function alias(
    namePrefix: string,
    record: DnsAliasRecord,
    opts: ComponentResourceOptions,
  ) {
    const name = plain(
      record.name,
      `The domain of "${namePrefix}"`,
      "Its DNS records are named after it.",
    );
    return ["A", "AAAA"].map((type) =>
      create(
        `${namePrefix}${type}Record${logicalName(name)}`,
        {
          type,
          name,
          aliases: [
            {
              name: record.aliasName,
              zoneId: record.aliasZone,
              evaluateTargetHealth: true,
            },
          ],
        },
        opts,
      ),
    );
  }

  function create(
    name: string,
    partial: Omit<route53.RecordArgs, "zoneId">,
    opts: ComponentResourceOptions,
  ) {
    return new route53.Record(
      ...transform(
        args.transform?.record,
        name,
        {
          zoneId: zoneOf(partial.name, opts),
          allowOverwrite: args.override,
          ...partial,
        },
        opts,
      ),
    );
  }

  // The hosted zone the record goes in: the one given, which has to be the
  // record's, or the one SST's provider finds for it
  function zoneOf(
    name: Input<string>,
    opts: ComponentResourceOptions,
  ): Output<string> {
    if (!args.zone) return hostedZoneId(name, { parent: opts.parent });
    return all([args.zone, name]).apply(async ([zoneId, name]) => {
      const zone = await route53.getZone({ zoneId }, { parent: opts.parent });
      if (!name.replace(/\.$/, "").endsWith(zone.name))
        throw new VisibleError(
          `The DNS record "${name}" cannot be created because the domain name does not match the hosted zone "${zone.name}" (${zoneId}).`,
        );
      return zoneId;
    });
  }
}
