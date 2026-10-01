import type { Dns } from "../../dns";
import type { Input } from "../../input";
import { plain } from "../../args";
import { VisibleError } from "../../error";
import { dns as awsDns } from "../dns";

/**
 * What every V5 component takes for a custom domain. A component adds what's
 * its own, like a base path.
 */
export interface CustomDomainArgs {
  /**
   * The custom domain you want to use.
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
  name: Input<string>;
  /**
   * The DNS provider to use for the domain: an adapter that creates the DNS
   * records, like `sst.aws.dns()`, `sst.cloudflare.dns()` or
   * `sst.vercel.dns()`.
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
   */
  dns?: false | Dns;
  /**
   * The ARN of an ACM (AWS Certificate Manager) certificate that proves ownership of the
   * domain. By default, a certificate is created and validated automatically.
   *
   * :::tip
   * You need to pass in a `cert` for domains that are not hosted on supported `dns` providers.
   * :::
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
 * Work out how a component's custom domain is set up: its name, the DNS
 * adapter that creates its records, and its certificate when the user brings
 * one. Without a `cert` there is always a `dns`, to validate the certificate
 * the component creates.
 *
 * ```ts
 * const domain = customDomain(args.domain, `the "${name}" API`);
 * const certificateArn =
 *   domain.cert ??
 *   this.part("certificate", { domainName: domain.name, dns: domain.dns! }).arn;
 * // ... the service's own domain resource, then:
 * domain.dns?.createAlias(name, { ... }, this.delegateOpts());
 * ```
 *
 * @param domain The `domain` arg: a domain name, or the domain's args.
 * @param owner What the domain belongs to, for error messages: `the "MyApi" API`.
 */
export function customDomain(
  domain: string | Partial<CustomDomainArgs>,
  owner: string,
) {
  plain(domain, `The "domain" of ${owner}`);
  const { name, dns, cert } =
    typeof domain === "string" ? ({ name: domain } as CustomDomainArgs) : domain;
  if (!name) throw new VisibleError(`Domain "name" is required for ${owner}.`);

  plain(dns, `The domain's "dns" in ${owner}`);
  const adapter = dns === false ? undefined : dns ?? awsDns();
  if (!adapter && !cert)
    throw new VisibleError(
      `Domain "cert" is required when "dns" is disabled for ${owner}.`,
    );

  return { name, dns: adapter, cert };
}
