import { type ComponentResourceOptions, all } from "@pulumi/pulumi";
import { DnsRecord } from "@pulumiverse/vercel";
import {
  type DnsAdapter,
  type DnsAliasRecord,
  type DnsRecord as Record,
  recordName,
} from "../dns-adapter";
import { transform } from "../component";
import { plain } from "../args";
import { VisibleError } from "../error";
import { DEFAULT_TEAM_ID } from "./account-id";
import { DnsRecord as OverridableDnsRecord } from "./resources/dns-record";
import type { DnsArgs } from "./dns";

/**
 * The adapter for domains on Vercel, as SST 5's components use it.
 * `sst.vercel.dns()` gives it.
 *
 * It names records as `sst.vercel.dns()` always has, so a component that
 * switches to SST 5 keeps them.
 */
export function vercelDnsAdapter(args: DnsArgs): DnsAdapter {
  return {
    provider: "vercel",
    record,
    alias,
    caa,
  };

  function alias(
    namePrefix: string,
    target: DnsAliasRecord,
    opts: ComponentResourceOptions,
  ) {
    const name = plain(
      target.name,
      `The domain of "${namePrefix}"`,
      "Its DNS records are named after it.",
    );
    const domain = plain(
      args.domain,
      `The "domain" of sst.vercel.dns()`,
      "It decides the type of a record, which the record is named after.",
    ) as string;
    // A CNAME can't be at the domain's apex
    const type = name.startsWith(domain) ? "ALIAS" : "CNAME";
    return [record(namePrefix, { name, type, value: target.aliasName }, opts)];
  }

  function record(
    namePrefix: string,
    record: Record,
    opts: ComponentResourceOptions,
  ) {
    const type = plain(
      record.type,
      `The type of a DNS record of "${namePrefix}"`,
    );
    return new DnsRecord(
      ...transform(
        args.transform?.record,
        `${namePrefix}${type}Record${recordName(record, namePrefix)}`,
        {
          domain: args.domain,
          type,
          // Its name within the domain
          name: all([args.domain, record.name]).apply(([domain, name]) => {
            const full = name.replace(/\.$/, "");
            if (!full.endsWith(domain))
              throw new VisibleError(
                `Record name "${full}" is not a subdomain of "${domain}".`,
              );
            return full.slice(0, -(domain.length + 1));
          }),
          value: record.value,
          mxPriority: record.priority,
          teamId: DEFAULT_TEAM_ID,
          ttl: 60,
        },
        opts,
      ),
    );
  }

  function caa(
    namePrefix: string,
    _domain: string,
    opts: ComponentResourceOptions,
  ) {
    // A CAA record that's there already is kept: they aren't removed
    return [
      { name: `${namePrefix}CaaRecord`, tag: "issue" },
      { name: `${namePrefix}CaaWildcardRecord`, tag: "issuewild" },
    ].map(
      ({ name, tag }) =>
        new OverridableDnsRecord(
          name,
          {
            domain: args.domain,
            name: args.domain,
            type: "CAA",
            value: `0 ${tag} "amazonaws.com"`,
          },
          opts,
        ),
    );
  }
}
