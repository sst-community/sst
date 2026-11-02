import {
  type ComponentResourceOptions,
  type Input,
  type Output,
  all,
  output,
} from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import {
  type DnsAdapter,
  type DnsAliasRecord,
  type DnsRecord,
  recordName,
} from "../dns-adapter";
import { transform } from "../component";
import { plain } from "../args";
import { VisibleError } from "../error";
import { DEFAULT_ACCOUNT_ID } from "./account-id";
import { DnsRecord as OverridableDnsRecord } from "./providers/dns-record";
import type { DnsArgs } from "./dns";

/**
 * The adapter for domains on Cloudflare, as SST 5's components use it.
 * `sst.cloudflare.dns()` gives it.
 *
 * It names records as `sst.cloudflare.dns()` always has, so a component that
 * switches to SST 5 keeps them. The zone is found with Cloudflare's provider,
 * not with a resource: the longest one the domain ends with.
 */
export function cloudflareDnsAdapter(args: DnsArgs): DnsAdapter {
  return {
    provider: "cloudflare",
    record: (namePrefix, record, opts) =>
      create(namePrefix, record, false, opts),
    alias,
    caa,
  };

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
    return [
      create(
        namePrefix,
        { name, type: "CNAME", value: record.aliasName },
        true,
        opts,
      ),
    ];
  }

  function caa(
    namePrefix: string,
    domain: string,
    opts: ComponentResourceOptions,
  ) {
    const zone = zoneOf(domain, opts);
    // A CAA record that's there already is kept, as Cloudflare's own record
    // only allows for one: Amazon needs `issue` and `issuewild`, and others,
    // like Let's Encrypt's, may be there too.
    return [
      { name: `${namePrefix}CAA${domain}Record`, tag: "issue" },
      { name: `${namePrefix}CAAWildcard${domain}Record`, tag: "issuewild" },
    ].map(
      ({ name, tag }) =>
        new OverridableDnsRecord(
          name,
          {
            zoneId: zone.id,
            type: "CAA",
            name: zone.name,
            accountId: args.accountId,
            data: { flags: "0", tag, value: "amazonaws.com" },
          },
          opts,
        ),
    );
  }

  function create(
    namePrefix: string,
    record: DnsRecord,
    isAlias: boolean,
    opts: ComponentResourceOptions,
  ) {
    const given = plain(
      record.type,
      `The type of a DNS record of "${namePrefix}"`,
    );
    const type = given.toUpperCase();
    const proxy = output(args.proxy).apply(
      (proxy) => (proxy && isAlias) ?? false,
    );
    return new cloudflare.DnsRecord(
      ...transform(
        args.transform?.record,
        `${namePrefix}${given}Record${recordName(record, namePrefix)}`,
        {
          zoneId: zoneOf(record.name, opts).id,
          proxied: proxy,
          type,
          name: record.name,
          content:
            type === "TXT"
              ? output(record.value).apply((value) =>
                  value.startsWith(`"`) ? value : `"${value}"`,
                )
              : record.value,
          ...(record.priority !== undefined
            ? { priority: record.priority }
            : {}),
          ttl: proxy.apply((proxy) => (proxy ? 1 : 60)),
        },
        opts,
      ),
    );
  }

  // The zone the given one is, or the longest one the domain ends with
  function zoneOf(
    domain: Input<string>,
    opts: ComponentResourceOptions,
  ): { id: Output<string>; name: Output<string> } {
    if (args.zone) {
      const zone = cloudflare.getZoneOutput(
        { zoneId: args.zone },
        { parent: opts.parent },
      );
      return { id: output(args.zone), name: zone.name };
    }
    const found = all([domain, args.accountId ?? DEFAULT_ACCOUNT_ID]).apply(
      async ([domain, accountId]) => {
        const name = domain.replace(/\.$/, "");
        const labels = name.split(".");
        for (let i = 0; i <= labels.length - 2; i++) {
          const candidate = labels.slice(i).join(".");
          const zones = await cloudflare.getZones(
            { name: candidate, account: { id: accountId } },
            { parent: opts.parent },
          );
          const zone = zones.results.find((z) => z.name === candidate);
          if (zone) return { id: zone.id, name: zone.name };
        }
        throw new VisibleError(`Could not find hosted zone for domain ${name}`);
      },
    );
    return { id: found.id, name: found.name };
  }
}
