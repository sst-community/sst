import type { Input } from "../../input";
import { type DnsAdapter, checkAdapter } from "../../dns-adapter";
import { plain } from "../../args";
import { VisibleError } from "../../error";
import { dns as awsDns } from "../dns";

/**
 * What a component built the 5.0 way takes for a custom domain. A component
 * adds what's its own, like a base path.
 */
export interface DomainArgs {
  /**
   * The custom domain you want to use. A plain value: the DNS records are named after it.
   *
   * @example
   * ```js
   * {
   *   domain: {
   *     name: "example.com"
   *   }
   * }
   * ```
   *
   * Can also include subdomains based on the current stage.
   *
   * ```js
   * {
   *   domain: {
   *     name: `${$app.stage}.example.com`
   *   }
   * }
   * ```
   */
  name: string;
  /**
   * The DNS provider to use for the domain: an adapter that creates the DNS records, like
   * `sst.aws.dns()`, `sst.cloudflare.dns()` or `sst.vercel.dns()`. A plain value.
   *
   * For other providers, set `dns` to `false` and pass in a `cert`.
   *
   * @default `sst.aws.dns`
   *
   * @example
   *
   * Specify the hosted zone ID for the Route 53 domain.
   *
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.aws.dns({
   *       zone: "Z2FDTNDATAQYW2"
   *     })
   *   }
   * }
   * ```
   *
   * Use a domain hosted on Cloudflare, needs the Cloudflare provider.
   *
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   *
   * Use a domain hosted on Vercel, needs the Vercel provider.
   *
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.vercel.dns()
   *   }
   * }
   * ```
   */
  dns?: false | DnsAdapter;
  /**
   * The ARN of an ACM (AWS Certificate Manager) certificate that proves ownership of the
   * domain. By default, a certificate is created and validated automatically.
   *
   * :::tip
   * You need to pass in a `cert` for domains that are not hosted on supported `dns` providers.
   * :::
   *
   * To manually set up a domain on an unsupported provider, you'll need to:
   *
   * 1. [Validate that you own the domain](https://docs.aws.amazon.com/acm/latest/userguide/domain-ownership-validation.html) by creating an ACM certificate. You can either validate it by setting a DNS record or by verifying an email sent to the domain owner.
   * 2. Once validated, set the certificate ARN as the `cert` and set `dns` to `false`.
   * 3. Add the DNS records in your provider to point to it.
   *
   * @example
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: false,
   *     cert: "arn:aws:acm:us-east-1:112233445566:certificate/3a958790-8878-4cdc-a396-06d95064cf63"
   *   }
   * }
   * ```
   */
  cert?: Input<string>;
}

/**
 * A component's custom domain, checked: its name and its DNS adapter are plain
 * values, since the DNS records are named after the name, and without a `cert`
 * there's always an adapter, to validate the certificate the component
 * creates.
 *
 * ```ts
 * const domain = domainOf(args.domain, `the "${name}" API`);
 * const certificateArn =
 *   domain.cert ??
 *   this.part("certificate", { domainName: domain.name, dns: domain.dns! }).arn;
 * // ... the service's own domain resource, then:
 * domain.dns?.alias(name, { name: domain.name, aliasName, aliasZone }, this.delegateOpts());
 * ```
 *
 * @param domain The `domain` arg: a domain name, or the domain's args.
 * @param owner What the domain belongs to, for error messages: `the "MyApi" API`.
 */
export function domainOf(
  domain: string | (Pick<DomainArgs, "dns" | "cert"> & { name?: string }),
  owner: string,
) {
  plain(domain, `The "domain" of ${owner}`);
  const given = typeof domain === "string" ? { name: domain } : domain;
  if (!given.name)
    throw new VisibleError(`Domain "name" is required for ${owner}.`);
  const name = plain(
    given.name,
    `The domain "name" of ${owner}`,
    "Its DNS records are named after it.",
  );

  plain(given.dns, `The domain's "dns" in ${owner}`);
  checkAdapter(given.dns, `The domain's "dns" in ${owner}`);
  const dns = given.dns === false ? undefined : given.dns ?? awsDns();
  if (!dns && !given.cert)
    throw new VisibleError(
      `Domain "cert" is required when "dns" is disabled for ${owner}.`,
    );

  return { name, dns, cert: given.cert };
}
