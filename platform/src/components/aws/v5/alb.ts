import {
  ComponentResourceOptions,
  interpolate,
  type Output,
  output,
} from "@pulumi/pulumi";
import { ec2, lb } from "@pulumi/aws";
import { V5Args, component, many, optional } from "../../parts-component";
import { plainDeep, withDefault } from "../../args";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import { DnsValidatedCertificate } from "../dns-validated-certificate";
import { listenerKey } from "../helpers/load-balancer";
import {
  domainOf,
  forbidden,
  pointDomainAt,
  securityGroupArgs,
} from "../helpers/load-balancer-args";
import { Vpc } from "../vpc";
import type { AlbArgs as OriginalAlbArgs } from "../alb";

const parts = () => ({
  /**
   * The AWS Security Group of the load balancer.
   */
  securityGroup: ec2.SecurityGroup,
  /**
   * The certificate of the custom domain. Only created when there's a `domain` without
   * a `cert` of its own.
   */
  certificate: optional(DnsValidatedCertificate),
  /**
   * The AWS Load Balancer.
   */
  loadBalancer: lb.LoadBalancer,
  /**
   * The AWS Load Balancer listeners, by protocol and port: `HTTPS443`. A listener that
   * `getListener` looks up is added when it's asked for.
   */
  listener: many(lb.Listener),
});

export interface AlbArgs extends V5Args<OriginalAlbArgs, typeof parts> {}

/**
 * The `Alb` component lets you create a standalone Application Load Balancer that can be
 * shared across multiple services.
 *
 * It takes the same args as [`sst.aws.Alb`](/docs/component/aws/alb) and creates the same
 * resources. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a shared ALB
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 *
 * const alb = new sst.aws.v5.Alb("SharedAlb", {
 *   vpc,
 *   domain: "app.example.com",
 *   listeners: [
 *     { port: 80, protocol: "http" },
 *     { port: 443, protocol: "https" },
 *   ],
 * });
 * ```
 *
 * #### Attach services to the ALB
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("Api", {
 *   cluster,
 *   image: "api:latest",
 *   loadBalancer: {
 *     instance: alb,
 *     rules: [
 *       { listen: "443/https", forward: "8080/http", conditions: { path: "/api/*" }, priority: 100 },
 *     ],
 *   },
 * });
 * ```
 *
 * #### Reference an existing ALB
 *
 * ```ts title="sst.config.ts"
 * const alb = sst.aws.v5.Alb.get("SharedAlb", "arn:aws:elasticloadbalancing:...");
 * ```
 *
 * #### Switch from `sst.aws.Alb`
 *
 * Change `sst.aws.Alb` to `sst.aws.v5.Alb` and keep the name. The load balancer, its
 * security group, listeners, certificate and DNS records are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const alb = new sst.aws.Alb("SharedAlb", { vpc, listeners });
 * const alb = new sst.aws.v5.Alb("SharedAlb", { vpc, listeners });
 * ```
 *
 * A few things work differently:
 *
 * - Switch the services on the load balancer first, or along with it. A
 *   `sst.aws.v5.Service` takes either one. A
 *   [`sst.aws.Service`](/docs/component/aws/service) only takes `sst.aws.Alb`.
 * - `nodes.listeners` is `nodes.listener`. `nodes` also has the certificate, which can
 *   be transformed.
 * - A transform function for `listener` is also given the listener's protocol and port:
 *   `HTTPS443`.
 * - A `domain` with `dns: false` and no `cert` is refused. There's nothing to validate
 *   a certificate with.
 */
export class Alb extends component("sst:aws:Alb", parts) {
  // What the services on the load balancer and what links to it read
  private balancer: { url: Output<string>; vpcId: Output<string> };

  constructor(name: string, args: AlbArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    // A load balancer that's already deployed, with the security group it has
    const existing = this.existingPart("loadBalancer");
    if (existing) {
      if (!this.existingPart("securityGroup"))
        this.lookupPart(
          "securityGroup",
          existing.securityGroups.apply((groups) => {
            if (!groups?.length)
              throw new VisibleError(
                `No security groups found on the referenced ALB "${name}".`,
              );
            return groups[0];
          }),
        );
      this.balancer = {
        url: interpolate`http://${existing.dnsName}`,
        vpcId: existing.vpcId,
      };
      this.registerOutputs({ _hint: this.balancer.url });
      return;
    }

    const of = `the "${name}" load balancer`;
    const listeners = plainDeep(args.listeners, `The "listeners" of ${of}`);
    const domain = domainOf(args.domain, of);

    // In the public subnets, or in the private ones when it's internal
    const isPublic = withDefault(args.public, true);
    const vpc =
      args.vpc instanceof Vpc
        ? {
            id: args.vpc.id,
            publicSubnets: output(args.vpc.publicSubnets),
            privateSubnets: output(args.vpc.privateSubnets),
          }
        : output(args.vpc);
    const vpcId = output(vpc.id);
    const subnets = isPublic.apply((isPublic) =>
      isPublic ? vpc.publicSubnets : vpc.privateSubnets,
    );

    const securityGroup = this.part("securityGroup", securityGroupArgs(vpcId));

    const certificateArn =
      domain &&
      (domain.cert ??
        this.part("certificate", {
          domainName: domain.name,
          alternativeNames: domain.aliases,
          dns: domain.dns!,
        }).arn);

    const loadBalancer = this.part("loadBalancer", {
      internal: isPublic.apply((v) => !v),
      loadBalancerType: "application",
      subnets,
      securityGroups: [securityGroup.id],
      enableCrossZoneLoadBalancing: true,
    });

    // Each listener refuses what none of its rules match. The services on the
    // load balancer add the rules.
    for (const listener of listeners) {
      const protocol = listener.protocol.toUpperCase();
      this.part("listener", listenerKey(protocol, listener.port), {
        loadBalancerArn: loadBalancer.arn,
        port: listener.port,
        protocol,
        certificateArn: protocol === "HTTPS" ? certificateArn : undefined,
        defaultActions: forbidden(),
      });
    }

    if (domain) pointDomainAt(name, domain, loadBalancer, this.delegateOpts());

    this.balancer = {
      url: domain
        ? interpolate`https://${domain.name}/`
        : interpolate`http://${loadBalancer.dnsName}`,
      vpcId,
    };
    this.registerOutputs({ _hint: this.balancer.url });
  }

  /**
   * The URL of the load balancer. If a custom domain is set, this will be the custom
   * domain URL (eg. `https://app.example.com/`). Otherwise, it's the ALB's DNS name.
   */
  public get url(): Output<string> {
    return this.balancer.url;
  }

  /**
   * The ARN of the load balancer.
   */
  public get arn(): Output<string> {
    return this.nodes.loadBalancer.arn;
  }

  /**
   * The DNS name of the load balancer.
   */
  public get dnsName(): Output<string> {
    return this.nodes.loadBalancer.dnsName;
  }

  /**
   * The zone ID of the load balancer.
   */
  public get zoneId(): Output<string> {
    return this.nodes.loadBalancer.zoneId;
  }

  /**
   * The security group ID of the load balancer.
   */
  public get securityGroupId(): Output<string> {
    return this.nodes.securityGroup.id;
  }

  /** @internal */
  public get _vpc(): Output<string> {
    return this.balancer.vpcId;
  }

  /**
   * Get a specific listener by protocol and port. A listener the component didn't
   * create is looked up on the load balancer.
   *
   * @example
   * ```ts
   * const listener = alb.getListener("https", 443);
   * ```
   */
  public getListener(protocol: string, port: number): lb.Listener {
    const key = listenerKey(protocol, port);
    if (key in this.nodes.listener) return this.nodes.listener[key];

    return this.lookupPart(
      "listener",
      key,
      lb.getListenerOutput(
        { loadBalancerArn: this.nodes.loadBalancer.arn, port },
        { parent: this },
      ).arn,
    );
  }

  /**
   * Linking a load balancer gives the linked resource its URL.
   */
  public link() {
    return {
      properties: {
        url: this.url,
      },
    };
  }

  /**
   * Reference an existing ALB by its ARN.
   *
   * @param name The name of the component.
   * @param loadBalancerArn The ARN of the existing ALB.
   * @param opts Component resource options.
   *
   * @example
   * ```ts
   * const alb = sst.aws.v5.Alb.get("SharedAlb", "arn:aws:elasticloadbalancing:...");
   * ```
   */
  public static get(
    name: string,
    loadBalancerArn: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Alb(
      name,
      { existing: { loadBalancer: loadBalancerArn } } as AlbArgs,
      opts,
    );
  }
}
