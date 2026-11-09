import type { ComponentResourceOptions, Input, Resource } from "@pulumi/pulumi";
import { plain } from "./args";
import { VisibleError } from "./error";
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

// SST 4's adapter methods, which SST 5's components don't call
const sst4Methods = ["createRecord", "createAlias", "createCaa"] as const;

// The SST 4 methods each of SST's own adapters has, for an app that calls
// them, by the adapter's `record`, which a spread of it keeps. So one spread
// with its own in their place is told apart: SST 5's components wouldn't call
// it.
const ownSst4 = new WeakMap<object, Record<string, unknown>>();

/**
 * Mark one of SST's adapters, with the SST 4 methods it has.
 *
 * @internal
 */
export function sstAdapter<
  T extends DnsAdapter & Record<(typeof sst4Methods)[number], unknown>,
>(adapter: T): T {
  ownSst4.set(adapter.record, {
    createRecord: adapter.createRecord,
    createAlias: adapter.createAlias,
    createCaa: adapter.createCaa,
  });
  return adapter;
}

/**
 * Check what's given as `dns` is an adapter SST 5's components can use. One
 * written for SST 4's components, with `createRecord`, `createAlias` and
 * `createCaa`, is refused, as is one of SST's with one of those replaced,
 * which SST 5's components wouldn't call.
 *
 * @param what The arg, as the start of the error message.
 * @internal
 */
export function checkAdapter<T>(dns: T, what: string): T {
  if (dns === undefined || dns === false) return dns;
  const adapter = dns as Record<string | symbol, unknown>;
  const sst4 = sst4Methods.filter((m) => typeof adapter[m] === "function");
  const missing = (["record", "alias", "caa"] as const).filter(
    (m) => typeof adapter[m] !== "function",
  );
  const instead = `Use sst.aws.dns(), sst.cloudflare.dns() or sst.vercel.dns(), or an adapter of your own with "record", "alias" and "caa", which SST 5's components call (DnsAdapter).`;
  if (missing.length > 0)
    throw new VisibleError(
      sst4.length > 0
        ? `${what} is written the way SST 4's adapters were, with ${sst4.map((m) => `"${m}"`).join(", ")}. ${instead}`
        : `${what} isn't a DNS adapter: it has no ${missing.map((m) => `"${m}"`).join(", ")}. ${instead}`,
    );
  const own = ownSst4.get(adapter.record as object);
  const replaced = own ? sst4.filter((m) => adapter[m] !== own[m]) : [];
  if (replaced.length > 0)
    throw new VisibleError(
      `${what} is one of SST's adapters with ${replaced.map((m) => `"${m}"`).join(", ")} replaced, which SST 5's components don't call: they call "record", "alias" and "caa". Replace those instead.`,
    );
  return dns;
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
