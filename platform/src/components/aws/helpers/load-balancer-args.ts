import {
  type ComponentResourceOptions,
  type Output,
  output,
} from "@pulumi/pulumi";
import type { ec2, lb } from "@pulumi/aws";
import { plainDeep } from "../../args";
import type { Input } from "../../input";
import type {
  DnsValidatedCertificate,
  DnsValidatedCertificateArgs,
} from "../v5/dns-validated-certificate";
import { type DomainArgs, domainOf } from "./domain";

/**
 * A load balancer's custom domain, and the other names it answers to.
 */
export interface LoadBalancerDomainArgs extends DomainArgs {
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
   *
   * Wildcard domains are supported.
   *
   * ```js
   * {
   *   domain: {
   *     name: "*.example.com"
   *   }
   * }
   * ```
   *
   * A plain value: the DNS records are named after it.
   */
  name: string;
  /**
   * Alias domains that should also point to the load balancer. A plain list: each alias
   * gets DNS records of its own, and is on the certificate.
   *
   * @example
   * ```js {4}
   * {
   *   domain: {
   *     name: "app1.example.com",
   *     aliases: ["app2.example.com"]
   *   }
   * }
   * ```
   */
  aliases?: string[];
}

/**
 * The args of a security group that lets everything in and out, for what
 * decides for itself what it answers: a load balancer's listeners, or a
 * public task.
 */
export function securityGroupArgs(vpcId: Input<string>): ec2.SecurityGroupArgs {
  const anywhere = () => [
    {
      fromPort: 0,
      toPort: 0,
      protocol: "-1",
      cidrBlocks: ["0.0.0.0/0"],
    },
  ];
  return {
    description: "Managed by SST",
    vpcId,
    egress: anywhere(),
    ingress: anywhere(),
  };
}

/** What a listener answers when none of its rules match. */
export function forbidden() {
  return [
    {
      type: "fixed-response",
      fixedResponse: {
        statusCode: "403",
        contentType: "text/plain",
        messageBody: "Forbidden",
      },
    },
  ];
}

/**
 * A load balancer's custom domain, checked as `domainOf()` checks one, with
 * the other names it answers to. The aliases are plain: a DNS record is named
 * after each.
 *
 * @param owner What the domain belongs to, for error messages.
 */
export function loadBalancerDomain(
  domain: string | Partial<LoadBalancerDomainArgs> | undefined,
  owner: string,
) {
  if (!domain) return undefined;
  const checked = domainOf(domain, owner);
  const aliases =
    (typeof domain === "object"
      ? plainDeep(domain.aliases, `The domain's "aliases" in ${owner}`)
      : undefined) ?? [];
  return { ...checked, aliases };
}

/**
 * The certificate of a load balancer's domain: the domain's `cert`, or one
 * the component creates for the domain and its aliases, validated through the
 * domain's DNS adapter.
 *
 * @param create Creates the component's certificate part with the given args.
 */
export function certificateOf(
  domain: NonNullable<ReturnType<typeof loadBalancerDomain>>,
  create: (args: DnsValidatedCertificateArgs) => DnsValidatedCertificate,
): { arn: Output<string>; created?: DnsValidatedCertificate } {
  if (domain.cert) return { arn: output(domain.cert) };
  const created = create({
    domainName: domain.name,
    alternativeNames: domain.aliases,
    dns: domain.dns!,
  });
  return { arn: created.arn, created };
}

/**
 * Point a domain and each of its aliases at a load balancer.
 *
 * @param name The component's name.
 * @param opts The component's `delegateOpts()`.
 */
export function pointDomainAt(
  name: string,
  domain: NonNullable<ReturnType<typeof loadBalancerDomain>>,
  loadBalancer: lb.LoadBalancer,
  opts: ComponentResourceOptions,
) {
  const pointAt = (prefix: string, record: string) =>
    domain.dns?.alias(
      prefix,
      {
        name: record,
        aliasName: loadBalancer.dnsName,
        aliasZone: loadBalancer.zoneId,
      },
      opts,
    );
  pointAt(name, domain.name);
  for (const alias of domain.aliases) pointAt(`${name}${alias}`, alias);
}
