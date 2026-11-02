import type { ComponentResourceOptions, Input, Resource } from "@pulumi/pulumi";
import { plain } from "./args";
import { logicalName } from "./naming";

/**
 * A DNS record an adapter creates.
 */
export interface DnsRecord {
  /** The record's type, like `CNAME`. A plain value: it's in the record's name. */
  type: string;
  /** The record's name in DNS, like `_dmarc.example.com`. */
  name: Input<string>;
  /**
   * What the record is named after in the app, when its name in DNS isn't a
   * plain value, as a certificate's validation record's isn't. It defaults to
   * the name in DNS, which then has to be a plain value.
   */
  key?: string;
  /** The record's value. */
  value: Input<string>;
  /** The record's priority. Only for `MX` records. */
  priority?: Input<number>;
}

/**
 * A domain pointed at an AWS service that has a hosted zone of its own, like
 * a CloudFront distribution.
 */
export interface DnsAliasRecord {
  /** The domain. A plain value: the records are named after it. */
  name: string;
  /** The service's own domain name. */
  aliasName: Input<string>;
  /** The id of the service's hosted zone. */
  aliasZone: Input<string>;
}

/**
 * What creates the DNS records for a domain, on the provider that hosts it.
 * `sst.aws.dns()`, `sst.cloudflare.dns()` and `sst.vercel.dns()` give one.
 *
 * An adapter creates what it creates directly, never inside an `apply`, and
 * names it only from plain values, so a preview shows all of it. Each method
 * names what it creates starting with `namePrefix`.
 */
export interface DnsAdapter {
  /** The provider that hosts the domain, like `"aws"`. */
  provider: string;
  /** Create a record. */
  record(
    namePrefix: string,
    record: DnsRecord,
    opts: ComponentResourceOptions,
  ): Resource;
  /** Point a domain at an AWS service, like a CloudFront distribution. */
  alias(
    namePrefix: string,
    record: DnsAliasRecord,
    opts: ComponentResourceOptions,
  ): Resource[];
  /**
   * Let Amazon issue certificates for a domain, where the provider needs a CAA
   * record for that. Route 53 doesn't.
   */
  caa(
    namePrefix: string,
    domain: string,
    opts: ComponentResourceOptions,
  ): Resource[];
}

/**
 * What an adapter names a record after, as a name: its `key`, or its name in
 * DNS, which then has to be a plain value. SST's adapters name a record
 * `<prefix><type>Record<this>`, as they did in SST 4.
 *
 * @internal
 */
export function recordName(record: DnsRecord, namePrefix: string) {
  const named =
    record.key ??
    plain(
      record.name,
      `The name of a DNS record of "${namePrefix}"`,
      'The record is named after it. Give it a "key" to be named after when its name is only known once something is deployed.',
    );
  return logicalName(named as string);
}
