import type { Vpc } from "./vpc";
import {
  ComponentResourceOptions,
  interpolate,
  type Output,
  output,
} from "@pulumi/pulumi";
import { ec2, lb } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  many,
  optional,
} from "../parts-component";
import type { Prettify } from "../component";
import {
  notAnExistingPart,
  plainDeep,
  usedAsItIs,
  withDefault,
  mapArg,
  getArgs,
} from "../args";
import { VisibleError } from "../error";
import type { Input } from "../input";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { listenerKey } from "./helpers/load-balancer";
import {
  certificateOf,
  forbidden,
  type LoadBalancerDomainArgs,
  loadBalancerDomain,
  pointDomainAt,
  securityGroupArgs,
} from "./helpers/load-balancer-args";
import { assertVpcIds, isVpc, subnetsOf } from "./helpers/vpc";

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

export interface AlbListenerArgs {
  /**
   * The port to listen on.
   *
   * @example
   * ```js
   * {
   *   port: 443
   * }
   * ```
   */
  port: number;
  /**
   * The protocol to listen on. Only `http` and `https` are supported (ALB-only).
   *
   * @example
   * ```js
   * {
   *   protocol: "https"
   * }
   * ```
   */
  protocol: "http" | "https";
}

export interface AlbDomainArgs extends LoadBalancerDomainArgs {}

export interface AlbArgs extends ComponentArgs<typeof parts> {
  /**
   * The VPC to deploy the ALB in: a `Vpc` component, or the ids of a VPC.
   *
   * @example
   *
   * Using a `Vpc` component:
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   *
   * Using the ids of a VPC:
   * ```js
   * {
   *   vpc: {
   *     id: "vpc-0123456789abcdef0",
   *     publicSubnets: ["subnet-abc", "subnet-def"],
   *     privateSubnets: ["subnet-ghi", "subnet-jkl"]
   *   }
   * }
   * ```
   */
  vpc:
    | Vpc
    | Input<{
        /**
         * The VPC ID.
         */
        id: Input<string>;
        /**
         * The public subnet IDs.
         */
        publicSubnets: Input<Input<string>[]>;
        /**
         * The private subnet IDs.
         */
        privateSubnets: Input<Input<string>[]>;
      }>;
  /**
   * Configure if the load balancer should be public (internet-facing) or private (internal).
   *
   * When set to `false`, the load balancer endpoint will only be accessible within the VPC.
   *
   * @default `true`
   */
  public?: Input<boolean>;
  /**
   * Set a custom domain for the load balancer.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and Vercel. For other
   * providers, you'll need to pass in a `cert` that validates domain ownership and add the
   * DNS records.
   *
   * The domain has to be a plain value, and so do its `name`, `aliases` and `dns`: they
   * decide the certificate and the DNS records.
   *
   * When SST creates the certificate, the load balancer is created after the certificate
   * is validated, and removed before the certificate.
   *
   * @example
   *
   * ```js
   * {
   *   domain: "example.com"
   * }
   * ```
   *
   * For domains on Cloudflare:
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   */
  domain?: string | Prettify<AlbDomainArgs>;
  /**
   * The listeners for the load balancer. Each entry creates a listener on the specified
   * port and protocol. A plain list: each listener is named after its protocol and port.
   *
   * @example
   * ```js
   * {
   *   listeners: [
   *     { port: 80, protocol: "http" },
   *     { port: 443, protocol: "https" }
   *   ]
   * }
   * ```
   */
  listeners: AlbListenerArgs[];
}

/**
 * The `Alb` component lets you create a standalone Application Load Balancer that can be
 * shared across multiple services.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a shared ALB
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 *
 * const alb = new sst.aws.Alb("SharedAlb", {
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
 * new sst.aws.Service("Api", {
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
 * const alb = sst.aws.Alb.get("SharedAlb", "arn:aws:elasticloadbalancing:...");
 * ```
 *
 * #### Switch from SST 4's `sst.aws.Alb`
 *
 * Keep the name, and `sst migrate` moves it. The load balancer, its
 * security group, listeners, certificate and DNS records are kept.
 *
 * A few things work differently:
 *
 * - `nodes.listeners` is `nodes.listener`. `nodes` also has the certificate, which can
 *   be transformed.
 * - A transform function for `listener` is also given the listener's protocol and port:
 *   `HTTPS443`.
 * - A `domain` with `dns: false` and no `cert` is refused. There's nothing to validate
 *   a certificate with.
 * - `domain`, with its `name`, `aliases` and `dns`, has to be a plain value, not an
 *   output. `domain.dns` is an adapter SST 5's components use, like SST 4's `dns()`,
 *   SST 4's `dns()` or `sst.vercel.dns()`. An object written by hand for SST 4's
 *   doesn't work.
 * - The DNS records that validate the certificate are named after the domains they
 *   validate, and a domain's hosted zone is found without a resource: SST 4's
 *   `HostedZoneLookup`, and Cloudflare's `ZoneLookup`, leave the state.
 * - A `vpc` that's another resource, not a `Vpc` or the ids of a VPC, is refused.
 * - An https listener without a `domain` is refused as the config is read, where AWS
 *   refused it on deploy.
 */
export class Alb extends component("sst:aws:Alb", parts) {
  // What the services on the load balancer and what links to it read
  private balancer: { url: Output<string>; vpcId: Output<string> };

  constructor(name: string, args: AlbArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const of = `the "${name}" load balancer`;

    // A load balancer that's already deployed, with the security group it has
    const existing = this.existingPart("loadBalancer");
    if (existing) {
      usedAsItIs(
        args,
        ["vpc", "public", "domain", "listeners"],
        "loadBalancer",
        of,
      );
      notAnExistingPart(
        args.existing,
        "certificate",
        of,
        `The "loadBalancer" it's given has its certificates on its listeners already.`,
      );
      if (!this.existingPart("securityGroup"))
        this.lookupPart(
          "securityGroup",
          existing.securityGroups.apply((groups) => {
            if (!groups?.length)
              throw new VisibleError(
                `The "loadBalancer" the "${name}" load balancer is given has no security group. Pass the one it should have in "existing.securityGroup".`,
              );
            return groups[0];
          }),
        );
      this.balancer = {
        url: interpolate`http://${existing.dnsName}`,
        vpcId: existing.vpcId,
      };
      this.report({ hint: this.balancer.url });
      return;
    }

    const listeners = plainDeep(args.listeners, `The "listeners" of ${of}`);
    const domain = loadBalancerDomain(args.domain, of);
    // An https listener needs the domain's certificate
    if (!domain && listeners.some((l) => l.protocol === "https"))
      throw new VisibleError(
        `An https listener of ${of} needs a certificate. Set the "domain" of the load balancer.`,
      );

    // In the public subnets, or in the private ones when it's internal
    const isPublic = withDefault(args.public, true);
    const vpc = isVpc(args.vpc)
      ? {
          id: args.vpc.id,
          publicSubnets: subnetsOf(args.vpc, "public"),
          privateSubnets: subnetsOf(args.vpc, "private"),
        }
      : (assertVpcIds(args.vpc, of), output(args.vpc));
    const vpcId = output(vpc.id);
    const subnets = mapArg(isPublic, (isPublic) =>
      isPublic ? vpc.publicSubnets : vpc.privateSubnets,
    );

    const securityGroup = this.part("securityGroup", securityGroupArgs(vpcId));

    if (!domain || domain.cert)
      notAnExistingPart(
        args.existing,
        "certificate",
        of,
        domain
          ? `It uses the "cert" of its "domain".`
          : `It's only created for a "domain".`,
      );
    const certificate =
      domain && certificateOf(domain, (args) => this.part("certificate", args));

    const loadBalancer = this.part(
      "loadBalancer",
      {
        internal: mapArg(isPublic, (v) => !v),
        loadBalancerType: "application",
        subnets,
        securityGroups: [securityGroup.id],
        enableCrossZoneLoadBalancing: true,
      },
      // The load balancer is what holds on to the certificate, so it's
      // removed first. Its listeners are given the certificate, but it isn't.
      { dependsOn: certificate?.created },
    );

    // Each listener refuses what none of its rules match. The services on the
    // load balancer add the rules.
    for (const listener of listeners) {
      const protocol = listener.protocol.toUpperCase();
      this.part("listener", listenerKey(protocol, listener.port), {
        loadBalancerArn: loadBalancer.arn,
        port: listener.port,
        protocol,
        certificateArn: protocol === "HTTPS" ? certificate?.arn : undefined,
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
    this.report({ hint: this.balancer.url });
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

    return (
      this.existingPart("listener", key) ??
      this.lookupPart(
        "listener",
        key,
        lb.getListenerOutput(
          { loadBalancerArn: this.nodes.loadBalancer.arn, port },
          { parent: this },
        ).arn,
      )
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
   * const alb = sst.aws.Alb.get("SharedAlb", "arn:aws:elasticloadbalancing:...");
   * ```
   */
  public static get(
    name: string,
    loadBalancerArn: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Alb(
      name,
      getArgs({ existing: { loadBalancer: loadBalancerArn } }) as AlbArgs,
      opts,
    );
  }
}
