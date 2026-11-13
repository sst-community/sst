import {
  ComponentResourceOptions,
  Input,
  Output,
  all,
  interpolate,
  output,
  secret,
} from "@pulumi/pulumi";
import {
  ec2,
  getAvailabilityZonesOutput,
  getPartitionOutput,
  iam,
  route53,
  servicediscovery,
  ssm,
} from "@pulumi/aws";
import { PrivateKey } from "@pulumi/tls";
import {
  type ComponentArgs,
  component,
  many,
  named,
  optional,
} from "../parts-component";
import { notAnExistingPart, plain, usedAsItIs, getArgs } from "../args";
import { context } from "../contract";
import { VisibleError } from "../error";
import { firstVersion } from "../sst4";

const parts = {
  /**
   * The Amazon EC2 VPC.
   */
  vpc: ec2.Vpc,
  /**
   * The Internet Gateway. All the traffic from the public subnets is routed through it.
   */
  internetGateway: ec2.InternetGateway,
  /**
   * The VPC's default security group. It lets in traffic from inside the VPC only.
   */
  securityGroup: ec2.DefaultSecurityGroup,
  /**
   * A public subnet in each AZ, by the AZ's number: `"1"`, `"2"` and so on.
   */
  publicSubnet: many(ec2.Subnet),
  /**
   * The route table of each public subnet, by the AZ's number. It routes to the
   * Internet Gateway.
   */
  publicRouteTable: many(ec2.RouteTable),
  /**
   * What gives each public subnet its route table, by the AZ's number.
   */
  publicRouteTableAssociation: many(ec2.RouteTableAssociation),
  /**
   * A private subnet in each AZ, by the AZ's number.
   */
  privateSubnet: many(ec2.Subnet),
  /**
   * The route table of each private subnet, by the AZ's number. With `nat`, it routes
   * to the NAT in the same AZ.
   */
  privateRouteTable: many(ec2.RouteTable),
  /**
   * What gives each private subnet its route table, by the AZ's number.
   */
  privateRouteTableAssociation: many(ec2.RouteTableAssociation),
  /**
   * With `nat`, an Elastic IP for the NAT in each AZ, by the AZ's number. With
   * `nat.ip`, it's the one given, looked up.
   */
  elasticIp: many(ec2.Eip),
  /**
   * With `nat: "managed"`, a NAT Gateway in each AZ, by the AZ's number.
   */
  natGateway: many(ec2.NatGateway),
  /**
   * With `nat: "ec2"`, the security group of the NAT instances.
   */
  natSecurityGroup: named(
    optional(ec2.SecurityGroup),
    "NatInstanceSecurityGroup",
  ),
  /**
   * With `nat: "ec2"`, the IAM role the NAT instances run as. With `nat.ec2.role`,
   * it's the one given, looked up.
   */
  natInstanceRole: optional(iam.Role),
  /**
   * With `nat: "ec2"`, the instance profile of the NAT instances.
   */
  natInstanceProfile: optional(iam.InstanceProfile),
  /**
   * With `nat: "ec2"`, a NAT instance in each AZ, by the AZ's number.
   */
  natInstance: many(ec2.Instance),
  /**
   * With `nat: "ec2"`, what gives each NAT instance its Elastic IP, by the AZ's number.
   */
  natInstanceEipAssociation: many(ec2.EipAssociation),
  /**
   * With `bastion`, the bastion's security group. It lets in SSH. Not created with
   * `nat: "ec2"`, whose first instance is the bastion.
   */
  bastionSecurityGroup: optional(ec2.SecurityGroup),
  /**
   * With `bastion`, the IAM role the bastion runs as. Not created with
   * `bastion.instanceProfile` or `nat: "ec2"`.
   */
  bastionRole: optional(iam.Role),
  /**
   * With `bastion`, the bastion's instance profile. With `bastion.instanceProfile`,
   * it's the one given, looked up. Not created with `nat: "ec2"`.
   */
  bastionProfile: optional(iam.InstanceProfile),
  /**
   * With `bastion`, the bastion instance, in the first public subnet. Not created with
   * `nat: "ec2"`, whose first instance is the bastion.
   */
  bastionInstance: optional(ec2.Instance),
  /**
   * With `bastion`, the key `sst tunnel` connects to the bastion with.
   */
  tlsPrivateKey: optional(PrivateKey),
  /**
   * With `bastion`, the SSM parameter that keeps the bastion's private key, for the
   * stages that reference this VPC with `get`.
   */
  privateKeyValue: optional(ssm.Parameter),
  /**
   * With `bastion`, the EC2 key pair of the bastion's key.
   */
  keyPair: optional(ec2.KeyPair),
  /**
   * The AWS Cloud Map namespace, `sst`, for service discovery.
   */
  cloudmapNamespace: servicediscovery.PrivateDnsNamespace,
};

export interface VpcArgs extends ComponentArgs<typeof parts> {
  /**
   * Specify the Availability Zones or AZs for the VPC.
   *
   * You can specify a number of AZs or a list of AZs. If you specify a number, it will
   * look up the availability zones in the region and automatically select that number of
   * AZs. If you specify a list of AZs, it will use that list of AZs.
   *
   * By default, it creates a VPC with 2 availability zones since services like RDS and
   * Fargate need at least 2 AZs.
   *
   * It decides how many subnets are created, so it's a plain value: a number, or a list
   * whose length is known. The AZs in the list can be outputs.
   * @default `2`
   * @example
   * Create a VPC with 3 AZs
   * ```ts
   * {
   *   az: 3
   * }
   * ```
   *
   * Create a VPC with specific AZs
   * ```ts
   * {
   *   az: ["us-east-1a", "us-east-1b"]
   * }
   * ```
   */
  az?: number | Input<string>[];
  /**
   * Configures NAT. Enabling NAT allows resources in private subnets to connect to the internet.
   *
   * There are two NAT options:
   * 1. `"managed"` creates a [NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
   * 2. `"ec2"` creates an [EC2 instance](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
   *    with the [fck-nat](https://github.com/AndrewGuenther/fck-nat) AMI
   *
   * For `"managed"`, a NAT Gateway is created in each AZ. All the traffic from
   * the private subnets are routed to the NAT Gateway in the same AZ.
   *
   * NAT Gateways are billed per hour and per gigabyte of data processed. A NAT Gateway for
   * two AZs costs $65 per month. This is relatively expensive but it automatically scales
   * based on the traffic.
   *
   * For `"ec2"`, an EC2 instance of type `t4g.nano` will be launched in each AZ
   * with the [fck-nat](https://github.com/AndrewGuenther/fck-nat) AMI. All the traffic from
   * the private subnets are routed to the Elastic Network Interface (ENI) of the EC2 instance
   * in the same AZ.
   *
   * :::tip
   * The `"ec2"` option uses fck-nat and is 10x cheaper than the `"managed"` NAT Gateway.
   * :::
   *
   * NAT EC2 instances are much cheaper than NAT Gateways, the `t4g.nano` instance type is around
   * $3 per month. But you'll need to scale it up manually if you need more bandwidth.
   *
   * Which NAT it is, and how many Elastic IPs are given, decide what's created, so `nat`,
   * `nat.type`, `nat.ec2` and the list in `nat.ip` are plain values. The Elastic IP
   * allocation IDs, and the instance type, AMI and role in `nat.ec2`, can be outputs.
   *
   * @default NAT is disabled
   * @example
   * ```ts
   * {
   *   nat: "managed"
   * }
   * ```
   */
  nat?:
    | "ec2"
    | "managed"
    | {
        /**
         * Configures the type of NAT to create.
         *
         * - If `nat.ec2` is provided, `nat.type` defaults to `"ec2"`.
         * - Otherwise, `nat.type` must be explicitly specified.
         */
        type?: "ec2" | "managed";
        /**
         * A list of Elastic IP allocation IDs to use for the NAT Gateways or NAT
         * instances. The number of allocation IDs must match the number of AZs.
         *
         * By default, new Elastic IP addresses are created.
         *
         * @example
         * ```ts
         * {
         *   nat: {
         *     ip: ["eipalloc-0123456789abcdef0", "eipalloc-0123456789abcdef1"]
         *   }
         * }
         * ```
         */
        ip?: Input<string>[];
        /**
         * Configures the NAT EC2 instance.
         * @default `{instance: "t4g.nano"}`
         * @example
         * ```ts
         * {
         *   nat: {
         *     ec2: {
         *       instance: "t4g.large"
         *     }
         *   }
         * }
         * ```
         */
        ec2?: {
          /**
           * The type of instance to use for the NAT.
           *
           * @default `"t4g.nano"`
           */
          instance?: Input<string>;
          /**
           * The AMI to use for the NAT.
           *
           * By default, the latest public [`fck-nat`](https://github.com/AndrewGuenther/fck-nat)
           * AMI is used. However, if the AMI is not available in the region you are
           * deploying to or you want to use a custom AMI, you can specify a different AMI.
           *
           * @default The latest `fck-nat` AMI
           * @example
           * ```ts
           * {
           *   nat: {
           *     ec2: {
           *       ami: "ami-1234567890abcdef0"
           *     }
           *   }
           * }
           * ```
           */
          ami?: Input<string>;
          /**
           * The Name of an existing IAM role to use for the NAT instance.
           *
           * By default, a new IAM role with SSM managed instance core permissions is created.
           * Use this to provide a custom role with additional permissions or to comply with
           * organizational policies.
           *
           * @default A new IAM role is created
           * @example
           * ```ts
           * {
           *   nat: {
           *     ec2: {
           *       role: "my-nat-instance-role"
           *     }
           *   }
           * }
           * ```
           */
          role?: Input<string>;
        };
      };
  /**
   * Configures a bastion host that can be used to connect to resources in the VPC.
   *
   * When enabled, an EC2 instance of type `t4g.nano` with the bastion AMI will be launched
   * in a public subnet. The instance will have AWS SSM (AWS Session Manager) enabled for
   * secure access without the need for SSH key. You can optionally provide an existing
   * IAM instance profile by name for the bastion.
   *
   * It costs roughly $3 per month to run the `t4g.nano` instance.
   *
   * :::note
   * If `nat: "ec2"` is enabled, the bastion host will reuse the NAT EC2 instance.
   * :::
   *
   * However if `nat: "ec2"` is enabled, the EC2 instance that NAT creates will be used
   * as the bastion host. No additional EC2 instance will be created.
   *
   * The bastion runs the newest Amazon Linux 2023 image for Arm, with the kernel Amazon
   * makes the default. It's read from Amazon's public SSM parameter
   * `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`, so the deploy
   * needs `ssm:GetParameter` on it. A deploy after Amazon releases a new image replaces
   * the bastion.
   *
   * If you are running `sst dev`, a tunnel will be automatically created to the bastion host.
   * This uses a network interface to forward traffic from your local machine to the bastion host.
   *
   * You can learn more about [`sst tunnel`](/docs/reference/cli#tunnel).
   *
   * It decides what's created, so it's a plain value. The instance profile's name can be
   * an output: whether it's given is what decides.
   *
   * @default `false`
   * @example
   * ```ts
   * {
   *   bastion: true
   * }
   * ```
   *
   * Use an existing instance profile by name.
   * Bastion is automatically enabled when you provide an instance profile.
   * @example
   * ```ts
   * {
   *   bastion: {
   *     instanceProfile: "my-bastion-profile"
   *   }
   * }
   * ```
   */
  bastion?:
    | boolean
    | {
        /**
         * The name of an existing IAM instance profile to use for the bastion.
         */
        instanceProfile: Input<string>;
      };
}

// What the components that take a VPC read from it, the same whether it was
// created or referenced with `get`
interface Network {
  publicSubnets: Output<string[]>;
  privateSubnets: Output<string[]>;
  securityGroups: Output<string[]>;
  bastion: Output<string | undefined>;
  // Whether the private subnets reach the internet. Not known for a VPC
  // that's referenced.
  nat?: boolean;
  // The private subnets by the AZ's number, for a VPC that's created
  privateSubnetsByAz?: Record<string, Output<string>>;
}

/**
 * The `Vpc` component lets you add a VPC to your app. It uses [Amazon VPC](https://docs.aws.amazon.com/vpc/). This is useful for services like RDS and Fargate that need to be hosted inside
 * a VPC.
 *
 * This creates a VPC with 2 Availability Zones by default. It also creates the following
 * resources:
 *
 * 1. A default security group blocking all incoming internet traffic.
 * 2. A public subnet in each AZ.
 * 3. A private subnet in each AZ.
 * 4. An Internet Gateway. All the traffic from the public subnets are routed through it.
 * 5. If `nat` is enabled, a NAT Gateway or NAT instance in each AZ. All the traffic from
 *    the private subnets are routed to the NAT in the same AZ.
 *
 * :::note
 * By default, this does not create NAT Gateways or NAT instances.
 * :::
 *
 * @example
 *
 * #### Create a VPC
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Vpc("MyVPC");
 * ```
 *
 * #### Create it with 3 Availability Zones
 *
 * ```ts title="sst.config.ts" {2}
 * new sst.aws.Vpc("MyVPC", {
 *   az: 3
 * });
 * ```
 *
 * #### Enable NAT
 *
 * ```ts title="sst.config.ts" {2}
 * new sst.aws.Vpc("MyVPC", {
 *   nat: "managed"
 * });
 * ```
 *
 * #### Switch from SST 4's `sst.aws.Vpc`
 *
 * Keep the name, and `sst migrate` moves it. The VPC you've deployed is
 * kept, and so is everything in it.
 *
 * A few things work differently:
 *
 * - `az`, `nat` and `bastion` are plain values, since they decide what's created. Some
 *   values inside them can still be outputs, like an AZ's name, `nat.ec2.ami` or
 *   `bastion.instanceProfile`. Each arg says which.
 * - `nodes` has an entry for each part. A part there's one of in each AZ is an object
 *   keyed by the AZ's number, and named in the singular:
 *   `Object.values(vpc.nodes.privateSubnet)` in place of `vpc.nodes.privateSubnets`, and
 *   `vpc.nodes.natGateway["1"]` for the first NAT Gateway. `nodes.vpc`,
 *   `nodes.internetGateway`, `nodes.securityGroup` and `nodes.cloudmapNamespace` are as
 *   they were. The NAT's and the bastion's security groups are the resources, not
 *   outputs of them, and `undefined` when they aren't created. With `nat: "ec2"` and
 *   `bastion`, the first NAT instance is the bastion: `nodes.bastionInstance` and
 *   `nodes.bastionSecurityGroup` are `undefined`, where SST 4's `Vpc` gave the NAT's, and
 *   `bastion` is the instance's ID.
 * - `transform` takes the same keys, and one for each resource it didn't have, like
 *   `cloudmapNamespace`. A function there is given outputs where it was given plain
 *   values, like a subnet's `availabilityZone` when `az` is a number.
 * - The bastion runs the newest Amazon Linux 2023 image with Amazon's default kernel.
 *   SST 4's `Vpc` looked for the newest image of any kernel, and Amazon releases several
 *   at once, so which one it found could change from one deploy to the next. A switch
 *   replaces the bastion once if it doesn't run that image. Start `sst tunnel` again
 *   after that deploy. The image is read from Amazon's public SSM parameter, so a deploy
 *   role that's limited to what it needs also needs `ssm:GetParameter` on
 *   `arn:aws:ssm:*::parameter/aws/service/ami-amazon-linux-latest/*`.
 * - `get` looks up the VPC, its default security group, its Internet Gateway and its
 *   Cloud Map namespace, which are in `nodes`, and finds the subnets and the bastion with
 *   lookups that aren't resources, so `nodes` has no subnets, route tables or NATs. A
 *   switch drops the lookups SST 4's `Vpc.get` kept in the state, which changes nothing in
 *   AWS. Its `nodes.securityGroup` is looked up as a default security group, where
 *   SST 4's `Vpc.get` looked it up as a security group, and its `nodes.cloudmapNamespace`
 *   has no `vpc`, which AWS doesn't give.
 * - If you set `tags` with an object in `transform` on the VPC, the NAT instances or the
 *   bastion, or on the NAT's or the bastion's security group, it keeps the tags SST sets
 *   next to yours. They're added back when you switch. A stage that references this VPC
 *   with `get` finds its bastion by them.
 * - SST 4's `Vpc.v1` has no 5.0 form.
 *
 * ---
 *
 * ### Cost
 *
 * By default, this component costs **$0.50 per month** for the CloudMap hosted zone used for
 * service discovery. Following is the cost to enable the `nat` or `bastion` options.
 *
 * #### Managed NAT
 *
 * If you enable `nat` with the `managed` option, it uses a _NAT Gateway_ per `az` at $0.045 per
 * hour, and $0.045 per GB processed per month.
 *
 * That works out to a minimum of $0.045 x 2 x 24 x 30 or **$65 per month**. Adjust this for the
 * number of `az` and add $0.045 per GB processed per month.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [NAT Gateway pricing](https://aws.amazon.com/vpc/pricing/) for more details. Standard [data
 * transfer charges](https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer) apply.
 *
 * #### EC2 NAT
 *
 * If you enable `nat` with the `ec2` option, it uses `t4g.nano` EC2 _On Demand_ instances per
 * `az` at $0.0042 per hour, and $0.09 per GB processed per month for the first 10TB.
 *
 * That works out to a minimum of $0.0042 x 2 x 24 x 30 or **$6 per month**. Adjust this for the
 * `nat.ec2.instance` you are using and add $0.09 per GB processed per month.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [EC2 On-Demand pricing](https://aws.amazon.com/vpc/pricing/) and the
 * [EC2 Data Transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer)
 * for more details.
 *
 * #### Bastion
 *
 * If you enable `bastion`, it uses a single `t4g.nano` EC2 _On Demand_ instance at
 * $0.0042 per hour, and $0.09 per GB processed per month for the first 10TB.
 *
 * That works out to $0.0042 x 24 x 30 or **$3 per month**. Add $0.09 per GB processed per month.
 *
 * However if `nat: "ec2"` is enabled, one of the NAT EC2 instances will be reused; making this
 * **free**.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [EC2 On-Demand pricing](https://aws.amazon.com/vpc/pricing/) and the
 * [EC2 Data Transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer)
 * for more details.
 */
export class Vpc extends component("sst:aws:Vpc", parts) {
  /**
   * @internal
   * @deprecated SST 4's first version of the `Vpc`, which SST 5 doesn't have.
   */
  static get v1(): never {
    return firstVersion("sst.aws.Vpc");
  }

  private readonly network: Network;

  constructor(
    name: string,
    args: VpcArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const existing = this.existingPart("vpc");
    this.network = existing
      ? this.reference(name, existing, args)
      : this.create(name, args);
  }

  private create(name: string, args: VpcArgs): Network {
    const self = this;
    const of = `the "${name}" VPC`;
    const zones = zonesOf();
    const nat = natOf();
    const bastion = bastionOf();
    const ids = zones.map((_, i) => `${i + 1}`);
    const { app } = context();

    // A part the VPC doesn't create, for the args it's given, can't be in
    // `existing`: it wouldn't be used
    const notCreated = (keys: string[], instead: string) => {
      for (const key of keys)
        notAnExistingPart(args.existing, key, of, instead);
    };
    if (!nat) notCreated(["elasticIp"], `It's only created with "nat".`);
    if (nat?.type !== "managed")
      notCreated(["natGateway"], `It's only created when "nat" is "managed".`);
    if (nat?.type !== "ec2")
      notCreated(
        [
          "natSecurityGroup",
          "natInstanceRole",
          "natInstanceProfile",
          "natInstance",
          "natInstanceEipAssociation",
        ],
        `It's only created when "nat" is "ec2".`,
      );
    const bastionParts = [
      "bastionSecurityGroup",
      "bastionRole",
      "bastionProfile",
      "bastionInstance",
    ];
    if (!bastion)
      notCreated(
        [...bastionParts, "tlsPrivateKey", "privateKeyValue", "keyPair"],
        `It's only created with "bastion".`,
      );
    else if (nat?.type === "ec2")
      notCreated(
        bastionParts,
        `When "nat" is "ec2", the first NAT instance is the bastion.`,
      );
    else if (bastion.instanceProfile !== undefined)
      notCreated(
        ["bastionRole"],
        `The bastion runs with "bastion.instanceProfile".`,
      );

    const vpc = this.part("vpc", {
      cidrBlock: "10.0.0.0/16",
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: {
        Name: `${app.name}-${app.stage}-${name} VPC`,
        // What the 4.x `Vpc` writes. Its `get`, and this one's, read the second.
        "sst:component-version": "2",
        "sst:ref-version": "2",
      },
    });

    const key = bastion ? keyOf() : undefined;

    const internetGateway = this.part("internetGateway", { vpcId: vpc.id });

    this.part("securityGroup", {
      vpcId: vpc.id,
      egress: [
        { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
      ],
      ingress: [
        // Only from inside the VPC
        { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: [vpc.cidrBlock] },
      ],
    });

    const publicSubnets = zones.map((zone, i) => {
      const subnet = this.part("publicSubnet", ids[i], {
        vpcId: vpc.id,
        cidrBlock: `10.0.${8 * i}.0/22`,
        availabilityZone: zone,
        mapPublicIpOnLaunch: true,
      });
      const routeTable = this.part("publicRouteTable", ids[i], {
        vpcId: vpc.id,
        routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }],
      });
      this.part("publicRouteTableAssociation", ids[i], {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
      });
      return subnet;
    });

    const elasticIps = nat
      ? ids.map((id, i) =>
          nat.ip
            ? this.existingPart("elasticIp", id) ??
              this.lookupPart("elasticIp", id, nat.ip[i])
            : this.part("elasticIp", id, { domain: "vpc" }),
        )
      : [];

    const natGateways =
      nat?.type === "managed"
        ? ids.map((id, i) =>
            this.part("natGateway", id, {
              subnetId: publicSubnets[i].id,
              allocationId: elasticIps[i].id,
            }),
          )
        : [];

    const natInstances = nat?.type === "ec2" ? natInstancesOf(nat.ec2) : [];

    const privateSubnets = zones.map((zone, i) => {
      const subnet = this.part("privateSubnet", ids[i], {
        vpcId: vpc.id,
        cidrBlock: `10.0.${8 * i + 4}.0/22`,
        availabilityZone: zone,
      });
      const routeTable = this.part("privateRouteTable", ids[i], {
        vpcId: vpc.id,
        routes: [
          ...(natGateways[i]
            ? [{ cidrBlock: "0.0.0.0/0", natGatewayId: natGateways[i].id }]
            : []),
          ...(natInstances[i]
            ? [
                {
                  cidrBlock: "0.0.0.0/0",
                  networkInterfaceId: natInstances[i].primaryNetworkInterfaceId,
                },
              ]
            : []),
        ],
      });
      this.part("privateRouteTableAssociation", ids[i], {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
      });
      return subnet;
    });

    // With NAT instances, the first is the bastion
    const bastionInstance = !bastion
      ? undefined
      : natInstances.length
        ? natInstances[0]
        : bastionInstanceOf(bastion);

    this.part("cloudmapNamespace", { name: "sst", vpc: vpc.id });

    if (bastionInstance && key)
      this.report({
        tunnel: {
          // A NAT instance is reached at its Elastic IP
          ip: natInstances.length
            ? elasticIps[0].publicIp
            : bastionInstance.publicIp,
          username: "ec2-user",
          privateKey: key.privateKey,
          subnets: [...privateSubnets, ...publicSubnets].map(
            (subnet) => subnet.cidrBlock,
          ),
        },
      });

    return {
      publicSubnets: all(publicSubnets.map((subnet) => subnet.id)),
      privateSubnets: all(privateSubnets.map((subnet) => subnet.id)),
      securityGroups: output([this.nodes.securityGroup.id]),
      bastion: output(bastionInstance?.id),
      nat: nat !== undefined,
      privateSubnetsByAz: Object.fromEntries(
        privateSubnets.map((subnet, i) => [ids[i], subnet.id]),
      ),
    };

    // A zone for each AZ: as given, or the region's first ones
    function zonesOf(): Input<string>[] {
      const az = plain(args.az, `The "az" of the "${name}" VPC`) ?? 2;
      if (Array.isArray(az)) return az;
      if (!Number.isInteger(az) || az < 0)
        throw new VisibleError(
          `The "az" of the "${name}" VPC has to be a whole number of AZs or a list of them. It's ${az}.`,
        );
      const names = getAvailabilityZonesOutput(
        { state: "available" },
        { parent: self },
      ).names;
      return Array.from({ length: az }, (_, i) =>
        names.apply((names) => names[i]),
      );
    }

    function natOf() {
      const nat = plain(args.nat, `The "nat" of the "${name}" VPC`);
      if (!nat) return undefined;
      if (nat === "managed") return { type: "managed" as const };
      if (nat === "ec2")
        return { type: "ec2" as const, ec2: { instance: "t4g.nano" } };

      plain(nat.type, `The "nat.type" of the "${name}" VPC`);
      const ip = plain(nat.ip, `The "nat.ip" of the "${name}" VPC`);
      const ec2 = plain(nat.ec2, `The "nat.ec2" of the "${name}" VPC`);
      if (ec2 && nat.type === "managed")
        throw new VisibleError(
          `The "nat" of ${of} has "ec2" settings, so its "type" can't be "managed". Make it "ec2", or leave it out.`,
        );
      if (!nat.type && !ec2)
        throw new VisibleError(
          `The "nat" of ${of} has no "type". Set it to "managed" or "ec2".`,
        );
      if (ip && ip.length !== zones.length)
        throw new VisibleError(
          `The "nat.ip" of ${of} has ${ip.length} Elastic IPs, for ${zones.length} AZs. Give one for each AZ.`,
        );

      return ec2 || nat.type === "ec2"
        ? {
            type: "ec2" as const,
            ip,
            ec2: {
              instance: ec2?.instance ?? "t4g.nano",
              ami: ec2?.ami,
              role: ec2?.role,
            },
          }
        : { type: "managed" as const, ip };
    }

    function bastionOf() {
      const bastion = plain(args.bastion, `The "bastion" of the "${name}" VPC`);
      if (!bastion) return undefined;
      if (bastion === true) return { instanceProfile: undefined };
      return { instanceProfile: bastion.instanceProfile };
    }

    // The key `sst tunnel` connects with, kept in SSM for a stage that
    // references this VPC
    function keyOf() {
      const tlsPrivateKey = self.part("tlsPrivateKey", {
        algorithm: "RSA",
        rsaBits: 4096,
      });
      self.part("privateKeyValue", {
        name: interpolate`/sst/vpc/${vpc.id}/private-key-value`,
        description: "Bastion host private key",
        type: ssm.ParameterType.SecureString,
        value: tlsPrivateKey.privateKeyOpenssh,
      });
      const keyPair = self.part("keyPair", {
        publicKey: tlsPrivateKey.publicKeyOpenssh,
      });
      return { keyPair, privateKey: tlsPrivateKey.privateKeyOpenssh };
    }

    function natInstancesOf(settings: {
      instance: Input<string>;
      ami?: Input<string>;
      role?: Input<string>;
    }) {
      const securityGroup = self.part("natSecurityGroup", {
        vpcId: vpc.id,
        ingress: [
          { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
        ],
        egress: [
          { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
        ],
        tags: { "sst:is-nat-sg": "true" },
      });

      // Whether it's given decides, so it can be an output
      const role =
        settings.role !== undefined
          ? self.existingPart("natInstanceRole") ??
            self.lookupPart("natInstanceRole", settings.role)
          : self.part("natInstanceRole", ec2RoleArgs());
      const profile = self.part("natInstanceProfile", { role: role.name });

      const ami =
        settings.ami ??
        ec2.getAmiOutput(
          {
            // fck-nat's account
            owners: ["568608671756"],
            filters: [
              // The image has the SSM agent installed
              { name: "name", values: ["fck-nat-al2023-*"] },
              { name: "architecture", values: ["arm64"] },
            ],
            mostRecent: true,
          },
          { parent: self },
        ).id;

      return ids.map((id, i) => {
        const instance = self.part("natInstance", id, {
          instanceType: settings.instance,
          ami,
          subnetId: publicSubnets[i].id,
          vpcSecurityGroupIds: [securityGroup.id],
          iamInstanceProfile: profile.name,
          sourceDestCheck: false,
          keyName: key?.keyPair.keyName,
          tags: {
            Name: `${name} NAT Instance`,
            "sst:is-nat": "true",
            // What `get` finds the bastion by
            ...(bastion && i === 0 ? { "sst:is-bastion": "true" } : {}),
          },
        });
        self.part("natInstanceEipAssociation", id, {
          instanceId: instance.id,
          allocationId: elasticIps[i].id,
        });
        return instance;
      });
    }

    function bastionInstanceOf(bastion: { instanceProfile?: Input<string> }) {
      const securityGroup = self.part("bastionSecurityGroup", {
        vpcId: vpc.id,
        ingress: [
          {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        egress: [
          { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
        ],
        tags: { "sst:is-bastion-sg": "true" },
      });

      // Whether it's given decides, so it can be an output
      const profile =
        bastion.instanceProfile !== undefined
          ? self.existingPart("bastionProfile") ??
            self.lookupPart(
              "bastionProfile",
              output(bastion.instanceProfile).apply((profile) => {
                if (profile.startsWith("arn:"))
                  throw new VisibleError(
                    `The "bastion.instanceProfile" of ${of} is an ARN. Give the instance profile's name.`,
                  );
                return profile;
              }),
            )
          : self.part("bastionProfile", {
              role: self.part("bastionRole", ec2RoleArgs()).name,
            });

      // Amazon releases an image for each kernel at the same time, so the
      // newest image by name can be any of them. Its public parameter names
      // one: the newest, with the kernel it makes the default.
      const ami = ssm.getParameterOutput(
        {
          name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
        },
        { parent: self },
      ).insecureValue;

      return self.part("bastionInstance", {
        instanceType: "t4g.nano",
        ami,
        subnetId: publicSubnets[0].id,
        vpcSecurityGroupIds: [securityGroup.id],
        iamInstanceProfile: profile.name,
        keyName: key?.keyPair.keyName,
        tags: { "sst:is-bastion": "true" },
      });
    }

    // A role an EC2 instance runs as, which Session Manager can reach it through
    function ec2RoleArgs(): iam.RoleArgs {
      const partition = getPartitionOutput({}, { parent: self }).partition;
      return {
        assumeRolePolicy: iam.getPolicyDocumentOutput(
          {
            statements: [
              {
                actions: ["sts:AssumeRole"],
                principals: [
                  { type: "Service", identifiers: ["ec2.amazonaws.com"] },
                ],
              },
            ],
          },
          { parent: self },
        ).json,
        managedPolicyArns: [
          interpolate`arn:${partition}:iam::aws:policy/AmazonSSMManagedInstanceCore`,
        ],
      };
    }
  }

  // A VPC SST created, in another stage. Its subnets and bastion are found
  // with lookups that aren't resources: how many there are is only known once
  // they've been looked up.
  private reference(name: string, vpc: ec2.Vpc, args: VpcArgs): Network {
    const self = this;
    const of = `the "${name}" VPC`;

    // It's used the way it is, and what's in it is found with lookups
    usedAsItIs(args, ["az", "nat", "bastion"], "vpc", of);
    const found = [
      "vpc",
      "internetGateway",
      "securityGroup",
      "cloudmapNamespace",
    ];
    for (const key of Object.keys(args.existing ?? {}))
      if (!found.includes(key))
        notAnExistingPart(
          args.existing,
          key,
          of,
          `It creates nothing in the "vpc" it's given, and finds its subnets and its bastion with lookups.`,
        );

    const vpcId = all([vpc.id, vpc.tagsAll]).apply(([id, tags]) => {
      if (tags?.["sst:ref-version"] !== "2")
        throw new VisibleError(
          `The "vpc" ${of} is given was created by an older version of SST's "Vpc". Deploy the stage that created it again, then this one.`,
        );
      return id;
    });
    const byVpc = { name: "vpc-id", values: [vpcId] };

    if (!this.existingPart("internetGateway"))
      this.lookupPart(
        "internetGateway",
        ec2.getInternetGatewayOutput(
          { filters: [{ name: "attachment.vpc-id", values: [vpcId] }] },
          { parent: this },
        ).internetGatewayId,
      );

    const securityGroup =
      this.existingPart("securityGroup") ??
      this.lookupPart(
        "securityGroup",
        all([
          ec2.getSecurityGroupsOutput(
            { filters: [{ name: "group-name", values: ["default"] }, byVpc] },
            { parent: this },
          ).ids,
          vpcId,
        ]).apply(([ids, vpcId]) => {
          if (!ids.length)
            throw new VisibleError(
              `The VPC "${vpcId}" ${of} is given has no default security group.`,
            );
          return ids[0];
        }),
      );

    // The zone the namespace made. Cloud Map has no lookup of a namespace by
    // its VPC, and a lookup by name finds every VPC's `sst`.
    if (!this.existingPart("cloudmapNamespace")) {
      const namespaceId = all([
        route53.getZoneOutput(
          { name: "sst", privateZone: true, vpcId },
          { parent: this },
        ).linkedServiceDescription,
        vpcId,
      ]).apply(([description, vpcId]) => {
        const id = description.match(/:namespace\/(ns-[a-z0-9]+)/)?.[1];
        if (!id)
          throw new VisibleError(
            `The VPC "${vpcId}" ${of} is given has no "sst" Cloud Map namespace.`,
          );
        return id;
      });
      this.lookupPart("cloudmapNamespace", namespaceId);
    }

    const subnets = (kind: string) =>
      ec2.getSubnetsOutput(
        { filters: [byVpc, { name: "tag:Name", values: [`*${kind}*`] }] },
        { parent: this },
      ).ids;
    const publicSubnets = subnets("Public");
    const privateSubnets = subnets("Private");

    const bastions = ec2.getInstancesOutput(
      { filters: [{ name: "tag:sst:is-bastion", values: ["true"] }, byVpc] },
      { parent: this },
    );

    this.report({
      tunnel: all([bastions.ids, bastions.publicIps]).apply(([ids, ips]) =>
        ids.length
          ? {
              // A NAT instance's public IP is its Elastic IP
              ip: ips[0],
              username: "ec2-user",
              // Kept secret whatever the lookup marks
              privateKey: secret(
                ssm.getParameterOutput(
                  { name: interpolate`/sst/vpc/${vpcId}/private-key-value` },
                  { parent: self },
                ).value,
              ),
              subnets: all([privateSubnets, publicSubnets]).apply(
                ([privateIds, publicIds]) =>
                  all(
                    [...privateIds, ...publicIds].map(
                      (id) =>
                        ec2.getSubnetOutput({ id }, { parent: self }).cidrBlock,
                    ),
                  ),
              ),
            }
          : undefined,
      ) as Output<any>,
    });

    return {
      publicSubnets,
      privateSubnets,
      securityGroups: output([securityGroup.id]),
      bastion: bastions.ids.apply((ids) => ids[0] as string | undefined),
    };
  }

  /**
   * The VPC ID.
   */
  public get id() {
    return this.nodes.vpc.id;
  }

  /**
   * A list of public subnet IDs in the VPC.
   */
  public get publicSubnets() {
    return this.network.publicSubnets;
  }

  /**
   * A list of private subnet IDs in the VPC.
   */
  public get privateSubnets() {
    return this.network.privateSubnets;
  }

  /**
   * A list of VPC security group IDs.
   */
  public get securityGroups() {
    return this.network.securityGroups;
  }

  /**
   * The bastion instance ID.
   */
  public get bastion() {
    return this.network.bastion.apply((id) => {
      if (!id)
        throw new VisibleError(
          `The "${this.componentName}" VPC has no bastion. Set its "bastion".`,
        );
      return id;
    });
  }

  /**
   * Whether the private subnets reach the internet through a NAT. `undefined` for a VPC
   * that's referenced with `get`.
   * @internal
   */
  public get hasNat() {
    return this.network.nat;
  }

  /**
   * The private subnets by the AZ's number, as they're kept in `nodes`.
   * `undefined` for a VPC that's referenced with `get`.
   * @internal
   */
  public get privateSubnetsByAz() {
    return this.network.privateSubnetsByAz;
  }

  /**
   * Reference an existing VPC with the given ID. This is useful when you
   * create a VPC in one stage and want to share it in another stage. It avoids having to
   * create a new VPC in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share VPCs across stages.
   * :::
   *
   * @param name The name of the component.
   * @param vpcId The ID of the existing VPC.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a VPC in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new VPC, you want to share the VPC from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const vpc = $app.stage === "frank"
   *   ? sst.aws.Vpc.get("MyVPC", "vpc-0be8fa4de860618bb")
   *   : new sst.aws.Vpc("MyVPC");
   * ```
   *
   * Here `vpc-0be8fa4de860618bb` is the ID of the VPC created in the `dev` stage.
   * You can find this by outputting the VPC ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   vpc: vpc.id
   * };
   * ```
   */
  public static get(
    name: string,
    vpcId: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Vpc(name, getArgs({ existing: { vpc: vpcId } }), opts);
  }

  public link() {
    return {
      properties: {
        bastion: this.network.bastion,
      },
    };
  }
}
