import type { ComponentResourceOptions } from "@pulumi/pulumi";
import type { ec2, lb } from "@pulumi/aws";
import { plainDeep } from "../../args";
import type { Input } from "../../input";
import { type DomainArgs, domainOf } from "./domain";

/**
 * The args of a load balancer's security group. It lets everything in and
 * out: the listeners decide what's answered.
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
  domain: string | (Partial<DomainArgs> & { aliases?: string[] }) | undefined,
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
