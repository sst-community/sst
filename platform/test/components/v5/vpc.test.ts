import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output, type Output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { SECRET, SIG } from "../../../src/testing/state";

const INSTANCE = "aws:ec2/instance:Instance";
const NAT_GATEWAY = "aws:ec2/natGateway:NatGateway";
const SUBNET = "aws:ec2/subnet:Subnet";
const PARAMETER = "aws:ssm/parameter:Parameter";
const VPC = "aws:ec2/vpc:Vpc";

// The images the lookups find. Amazon's public parameter can name another
// image than 4.x found.
const FCK_NAT = "ami-0fcknat";
const AL2023 = "ami-0al2023";
let amazonDefault = AL2023;

// What the providers keep secret
const secret = (value: string) => ({ [SIG]: SECRET, value });

// VPCs SST created in another stage: with a NAT Gateway and a bastion in each
// of two AZs, and with neither
const SHARED = "vpc-shared";
const PLAIN = "vpc-plain";
const CIDRS: Record<string, string> = {
  "private-1": "10.0.4.0/22",
  "private-2": "10.0.12.0/22",
  "public-1": "10.0.0.0/22",
  "public-2": "10.0.8.0/22",
};
// A subnet's id says which VPC it's in: `subnet-public-1`, `subnet-plain-public-1`
const cidrOf = (subnet: string) =>
  CIDRS[subnet.replace(/^subnet-(plain-)?/, "")];
// 4.x read a namespace's id up to its first 0, so the one both find has none
let namespace = "ns-abc123def456789";
type Transforms = Record<string, (args: any, opts: any) => undefined>;
const filter = (args: any, name: string) =>
  args.inputs.filters?.find((f: any) => f.name === name)?.values?.[0];

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === INSTANCE) return { publicIp: "203.0.113.10" };
    if (args.type === "tls:index/privateKey:PrivateKey")
      return {
        privateKeyOpenssh: secret("the-private-key"),
        publicKeyOpenssh: "the-public-key",
      };
    if (!args.id) return {};
    if (args.type === VPC)
      return {
        cidrBlock: "10.0.0.0/16",
        tagsAll: [SHARED, PLAIN].includes(args.id)
          ? { "sst:ref-version": "2" }
          : {},
      };
    if (args.type === SUBNET) return { cidrBlock: cidrOf(args.id) };
    if (args.type === NAT_GATEWAY)
      return { allocationId: `eipalloc-${args.id}` };
    if (args.type === PARAMETER) return { value: secret("the-private-key") };
    return {};
  },
  call: (args) => {
    switch (args.token) {
      case "aws:index/getAvailabilityZones:getAvailabilityZones":
        return {
          names: ["us-east-1a", "us-east-1b", "us-east-1c", "us-east-1d"],
        };
      case "aws:ec2/getAmi:getAmi":
        return {
          id: args.inputs.owners.includes("amazon") ? AL2023 : FCK_NAT,
        };
      case "aws:ssm/getParameter:getParameter":
        return args.inputs.name.startsWith("/aws/service/")
          ? { value: amazonDefault, insecureValue: amazonDefault }
          : // In plain text, as a provider that didn't mark it would give it
            { value: "the-private-key", insecureValue: "the-private-key" };
      // What `get` looks up
      case "aws:ec2/getInternetGateway:getInternetGateway":
        return { internetGatewayId: "igw-shared" };
      case "aws:ec2/getSecurityGroups:getSecurityGroups":
        return {
          ids: filter(args, "group-name") === "default" ? ["sg-default"] : [],
        };
      case "aws:ec2/getSubnets:getSubnets": {
        const kind =
          filter(args, "tag:Name") === "*Public*" ? "public" : "private";
        const vpc = filter(args, "vpc-id") === PLAIN ? "plain-" : "";
        return { ids: [1, 2].map((i) => `subnet-${vpc}${kind}-${i}`) };
      }
      case "aws:ec2/getSubnet:getSubnet":
        return { cidrBlock: cidrOf(args.inputs.id) };
      case "aws:ec2/getRouteTable:getRouteTable":
        return { routeTableId: `rtb-${args.inputs.subnetId}` };
      case "aws:ec2/getNatGateways:getNatGateways":
        return {
          ids: filter(args, "subnet-id").startsWith("subnet-plain-")
            ? []
            : [`nat-${filter(args, "subnet-id")}`],
        };
      case "aws:ec2/getInstances:getInstances":
        return filter(args, "tag:sst:is-bastion") &&
          filter(args, "vpc-id") === SHARED
          ? { ids: ["i-bastion"], publicIps: ["203.0.113.10"] }
          : { ids: [], publicIps: [] };
      case "aws:route53/getZone:getZone":
        return {
          linkedServiceDescription: `arn:aws:servicediscovery:us-east-1:123456789012:namespace/${namespace}`,
        };
    }
    return undefined;
  },
});

describe("Vpc", () => {
  let OriginalVpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Vpc: typeof import("../../../src/components/aws/v5/vpc").Vpc;

  beforeAll(async () => {
    OriginalVpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Vpc = (await import("../../../src/components/aws/v5/vpc")).Vpc;
    await import("../../../src/components/aws/takeover/vpc");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  const read = <T>(value: Output<T>) =>
    new Promise<T>((resolve) => value.apply(resolve));

  describe("takes over a deployed Vpc", () => {
    pulumi.takeoverCases({
      original: () => OriginalVpc,
      v5: () => Vpc,
      // 4.x's version marker, with nothing in AWS behind it
      unclaimed: ["sst:sst:Version::MyVpcVersion"],
      cases: {
        "two AZs": (Vpc, opts) => {
          new Vpc("MyVpc", {}, opts);
        },
        "three AZs": (Vpc, opts) => {
          new Vpc("MyVpc", { az: 3 }, opts);
        },
        "the AZs given": (Vpc, opts) => {
          new Vpc("MyVpc", { az: ["us-east-1a", "us-east-1c"] }, opts);
        },
        "managed NAT": (Vpc, opts) => {
          new Vpc("MyVpc", { nat: "managed" }, opts);
        },
        "managed NAT with the Elastic IPs given": (Vpc, opts) => {
          new Vpc(
            "MyVpc",
            { nat: { type: "managed", ip: ["eipalloc-1", "eipalloc-2"] } },
            opts,
          );
        },
        "EC2 NAT": (Vpc, opts) => {
          new Vpc("MyVpc", { nat: "ec2" }, opts);
        },
        "EC2 NAT with its settings": (Vpc, opts) => {
          new Vpc(
            "MyVpc",
            {
              az: 3,
              nat: {
                ip: ["eipalloc-1", "eipalloc-2", "eipalloc-3"],
                ec2: {
                  instance: "t4g.small",
                  ami: "ami-custom",
                  role: "my-role",
                },
              },
            },
            opts,
          );
        },
        "EC2 NAT that's the bastion": (Vpc, opts) => {
          new Vpc("MyVpc", { nat: "ec2", bastion: true }, opts);
        },
        "EC2 NAT that's the bastion, with its Elastic IPs given": (
          Vpc,
          opts,
        ) => {
          new Vpc(
            "MyVpc",
            {
              nat: { type: "ec2", ip: ["eipalloc-1", "eipalloc-2"] },
              bastion: true,
            },
            opts,
          );
        },
        "a bastion": (Vpc, opts) => {
          new Vpc("MyVpc", { bastion: true }, opts);
        },
        "managed NAT and a bastion with its own instance profile": (
          Vpc,
          opts,
        ) => {
          new Vpc(
            "MyVpc",
            { nat: "managed", bastion: { instanceProfile: "my-profile" } },
            opts,
          );
        },
        // Each written once for both. Their types differ in what a function
        // is given: V5 also gives a subnet's the AZ's number.
        transforms: (Vpc, opts) => {
          const transform: Transforms = {
            vpc: (args) => {
              args.cidrBlock = "10.0.0.0/16";
              args.instanceTenancy = "default";
            },
            internetGateway: (args) => {
              args.tags = { team: "net" };
            },
            securityGroup: (args) => {
              args.revokeRulesOnDelete = true;
            },
            publicSubnet: (args) => {
              args.assignIpv6AddressOnCreation = false;
            },
            privateSubnet: (args) => {
              args.enableDns64 = false;
            },
            publicRouteTable: (args) => {
              args.tags = { kind: "public" };
            },
            privateRouteTable: (args) => {
              args.tags = { kind: "private" };
            },
            elasticIp: (args) => {
              args.tags = { kind: "nat" };
            },
            natSecurityGroup: (args) => {
              args.description = "NAT";
            },
            natInstance: (args, opts) => {
              args.monitoring = true;
              opts.ignoreChanges = ["ami"];
            },
          };
          new Vpc(
            "MyVpc",
            { nat: "ec2", bastion: true, transform } as {},
            opts,
          );
        },
        "a bastion, transformed": (Vpc, opts) => {
          const transform: Transforms = {
            natGateway: (args) => {
              args.tags = { kind: "nat" };
            },
            bastionSecurityGroup: (args) => {
              args.description = "SSH";
            },
            bastionInstance: (args) => {
              args.instanceType = "t4g.micro";
            },
          };
          new Vpc(
            "MyVpc",
            { nat: "managed", bastion: true, transform } as {},
            opts,
          );
        },
        // V5 merges an object transform into the defaults. 4.x replaced a
        // nested object whole, so the tags SST sets come back on a switch.
        "an object transform that sets tags": {
          create: (Vpc, opts) => {
            const tags = { team: "net" };
            new Vpc(
              "MyVpc",
              {
                nat: "ec2",
                bastion: true,
                transform: {
                  vpc: { tags },
                  natSecurityGroup: { tags },
                  natInstance: { tags },
                },
              } as {},
              opts,
            );
          },
          changed: [
            ["MyVpcNatInstance1", ["tags"]],
            ["MyVpcNatInstance2", ["tags"]],
            ["MyVpcNatInstanceSecurityGroup", ["tags"]],
            ["MyVpcVpc", ["tags"]],
          ],
        },
        "an object transform that sets the bastion's tags": {
          create: (Vpc, opts) => {
            const tags = { team: "net" };
            new Vpc(
              "MyVpc",
              {
                bastion: true,
                transform: {
                  bastionSecurityGroup: { tags },
                  bastionInstance: { tags },
                },
              } as {},
              opts,
            );
          },
          changed: [
            ["MyVpcBastionInstance", ["tags"]],
            ["MyVpcBastionSecurityGroup", ["tags"]],
          ],
        },
        "a VPC from another stage, with no NAT or bastion": {
          create: (Vpc, opts) => {
            Vpc.get("MyVpc", PLAIN, opts);
          },
          unclaimed: [
            "aws:ec2/internetGateway:InternetGateway::MyVpcInstanceGateway",
            "aws:ec2/routeTable:RouteTable::MyVpcPrivateRouteTable1",
            "aws:ec2/routeTable:RouteTable::MyVpcPrivateRouteTable2",
            "aws:ec2/routeTable:RouteTable::MyVpcPublicRouteTable1",
            "aws:ec2/routeTable:RouteTable::MyVpcPublicRouteTable2",
            "aws:ec2/securityGroup:SecurityGroup::MyVpcSecurityGroup",
            "aws:ec2/subnet:Subnet::MyVpcPrivateSubnet1",
            "aws:ec2/subnet:Subnet::MyVpcPrivateSubnet2",
            "aws:ec2/subnet:Subnet::MyVpcPublicSubnet1",
            "aws:ec2/subnet:Subnet::MyVpcPublicSubnet2",
            "sst:sst:Version::MyVpcVersion",
          ],
          // Nothing for `sst tunnel`, as 4.x
          check: () => expect(pulumi.reportOf("MyVpc")?.tunnel).toBeUndefined(),
        },
        "a VPC from another stage": {
          create: (Vpc, opts) => {
            Vpc.get("MyVpc", SHARED, opts);
          },
          // What 4.x looked up and kept in the state. Looking something up
          // changes nothing in AWS. The V5 one looks the subnets, their route
          // tables, the NATs and the bastion up with lookups that aren't
          // resources.
          unclaimed: [
            "aws:ec2/eip:Eip::MyVpcElasticIp1",
            "aws:ec2/eip:Eip::MyVpcElasticIp2",
            "aws:ec2/instance:Instance::MyVpcBastionInstance",
            "aws:ec2/internetGateway:InternetGateway::MyVpcInstanceGateway",
            "aws:ec2/natGateway:NatGateway::MyVpcNatGateway1",
            "aws:ec2/natGateway:NatGateway::MyVpcNatGateway2",
            "aws:ec2/routeTable:RouteTable::MyVpcPrivateRouteTable1",
            "aws:ec2/routeTable:RouteTable::MyVpcPrivateRouteTable2",
            "aws:ec2/routeTable:RouteTable::MyVpcPublicRouteTable1",
            "aws:ec2/routeTable:RouteTable::MyVpcPublicRouteTable2",
            "aws:ec2/securityGroup:SecurityGroup::MyVpcSecurityGroup",
            "aws:ec2/subnet:Subnet::MyVpcPrivateSubnet1",
            "aws:ec2/subnet:Subnet::MyVpcPrivateSubnet2",
            "aws:ec2/subnet:Subnet::MyVpcPublicSubnet1",
            "aws:ec2/subnet:Subnet::MyVpcPublicSubnet2",
            "aws:ssm/parameter:Parameter::MyVpcPrivateKeyValue",
            "sst:sst:Version::MyVpcVersion",
          ],
          check: () => {
            // The same VPC and namespace are looked up
            const vpc = resource("MyVpcVpc");
            expect(vpc.kind).toBe("read");
            expect(vpc.options.id).toBe(SHARED);
            expect(resource("MyVpcCloudmapNamespace").options.id).toBe(
              namespace,
            );
          },
        },
      },
    });
  });

  describe("creates", () => {
    it("a subnet, route table and NAT in each AZ, named by the AZ's number", async () => {
      const vpc = new Vpc("MyVpc", { az: 3, nat: "managed" });
      await pulumi.settle();
      for (const key of [
        "publicSubnet",
        "privateSubnet",
        "publicRouteTable",
        "privateRouteTable",
        "elasticIp",
        "natGateway",
      ] as const)
        expect(Object.keys(vpc.nodes[key]), key).toEqual(["1", "2", "3"]);
      expect(Object.keys(vpc.nodes.natInstance)).toEqual([]);
      expect(resource("MyVpcPrivateSubnet3").inputs).toMatchObject({
        availabilityZone: "us-east-1c",
        cidrBlock: "10.0.20.0/22",
      });
      expect(await read(vpc.privateSubnets)).toEqual(
        ["1", "2", "3"]
          .map((i) => vpc.nodes.privateSubnet[i])
          .map(() => expect.any(String)),
      );
    });

    it("no NAT and no bastion by default", async () => {
      const vpc = new Vpc("MyVpc");
      await pulumi.settle();
      expect(names().filter((n) => /Nat|Elastic|Bastion|Key/.test(n))).toEqual(
        [],
      );
      expect(vpc.hasNat).toBe(false);
      expect(pulumi.reportOf("MyVpc")).toBeUndefined();
    });

    it("a bastion from Amazon's default image, which `sst tunnel` reaches", async () => {
      const vpc = new Vpc("MyVpc", { bastion: true });
      await pulumi.settle();
      expect(resource("MyVpcBastionInstance").inputs.ami).toBe(AL2023);
      const report = pulumi.reportOf("MyVpc") as any;
      expect(report.tunnel).toEqual({
        ip: expect.any(String),
        username: "ec2-user",
        // As secret as the key is
        privateKey: secret("the-private-key"),
        subnets: ["10.0.4.0/22", "10.0.12.0/22", "10.0.0.0/22", "10.0.8.0/22"],
      });
      expect(await read(vpc.bastion)).toBe(
        await read(vpc.nodes.bastionInstance!.id),
      );
    });

    it("no bastion of its own when the first NAT instance is the bastion", async () => {
      const vpc = new Vpc("MyVpc", { nat: "ec2", bastion: true });
      await pulumi.settle();
      expect(vpc.nodes.bastionInstance).toBeUndefined();
      expect(resource("MyVpcNatInstance1").inputs.tags).toMatchObject({
        "sst:is-bastion": "true",
      });
      expect(resource("MyVpcNatInstance2").inputs.tags).not.toHaveProperty(
        "sst:is-bastion",
      );
      expect(await read(vpc.bastion)).toBe(
        await read(vpc.nodes.natInstance["1"].id),
      );
      const report = pulumi.reportOf("MyVpc") as any;
      expect(report.tunnel.ip).toBe(
        await read(vpc.nodes.elasticIp["1"].publicIp),
      );
    });
  });

  describe("takes plain values for what decides what's created", () => {
    it.each([
      ["az", { az: output(2) }],
      ["nat", { nat: output("managed") }],
      ["nat.ip", { nat: { type: "managed", ip: output(["a", "b"]) } }],
      ["bastion", { bastion: output(true) }],
    ])("%s", (what, args) => {
      expect(() => new Vpc("MyVpc", args as any)).toThrow(
        `The "${what}" of the "MyVpc" VPC has to be a plain value`,
      );
    });

    it("and the AZs inside a list can be outputs", async () => {
      new Vpc("MyVpc", { az: [output("us-east-1b")] });
      await pulumi.settle();
      expect(resource("MyVpcPublicSubnet1").inputs.availabilityZone).toBe(
        "us-east-1b",
      );
    });

    it("and so can the role and the instance profile it's given", async () => {
      new Vpc("MyVpc", {
        nat: { ec2: { role: output("nat-role") } },
        bastion: { instanceProfile: output("bastion-profile") },
      });
      await pulumi.settle();
      // Looked up, as when they're strings
      expect(resource("MyVpcNatInstanceRole")).toMatchObject({
        kind: "read",
        options: expect.objectContaining({ id: "nat-role" }),
      });
      // The first NAT instance is the bastion, so no profile of its own
      expect(names()).not.toContain("MyVpcBastionProfile");

      pulumi.reset();
      new Vpc("MyVpc", {
        bastion: { instanceProfile: output("bastion-profile") },
      });
      await pulumi.settle();
      expect(resource("MyVpcBastionProfile")).toMatchObject({
        kind: "read",
        options: expect.objectContaining({ id: "bastion-profile" }),
      });
    });
  });

  it("refuses NAT settings that don't go together", () => {
    expect(
      () => new Vpc("MyVpc", { nat: { type: "managed", ec2: {} } }),
    ).toThrow(
      `The "nat.type" cannot be "managed" when "nat.ec2" is specified.`,
    );
    expect(() => new Vpc("MyVpc", { nat: {} })).toThrow(
      `Missing "nat.type" for the "MyVpc" VPC.`,
    );
    expect(
      () => new Vpc("MyVpc", { nat: { type: "managed", ip: ["one"] } }),
    ).toThrow(
      "The number of Elastic IP allocation IDs must match the number of AZs.",
    );
  });

  it("links the bastion", async () => {
    const vpc = new Vpc("MyVpc", { bastion: true });
    await pulumi.settle();
    expect(await read(output(vpc.link().properties.bastion))).toBe(
      await read(vpc.nodes.bastionInstance!.id),
    );
  });

  describe("from another stage", () => {
    it("finds its subnets, security group and bastion", async () => {
      const vpc = Vpc.get("MyVpc", SHARED);
      await pulumi.settle();
      expect(await read(vpc.publicSubnets)).toEqual([
        "subnet-public-1",
        "subnet-public-2",
      ]);
      expect(await read(vpc.privateSubnets)).toEqual([
        "subnet-private-1",
        "subnet-private-2",
      ]);
      expect(await read(vpc.securityGroups)).toEqual(["sg-default"]);
      expect(await read(vpc.bastion)).toBe("i-bastion");
      expect(vpc.hasNat).toBeUndefined();
      expect(Object.keys(vpc.nodes.publicSubnet)).toEqual([]);
      // `sst tunnel` reaches the bastion it finds, and every subnet
      expect(pulumi.reportOf("MyVpc")?.tunnel).toMatchObject({
        ip: "203.0.113.10",
        username: "ec2-user",
        // Secret, though the lookup gave it in plain text
        privateKey: secret("the-private-key"),
        subnets: ["10.0.4.0/22", "10.0.12.0/22", "10.0.0.0/22", "10.0.8.0/22"],
      });
      // Only what's looked up
      expect(
        pulumi.resources
          .filter((r) => r.type.startsWith("aws:"))
          .map((r) => [r.kind, r.name]),
      ).toEqual(
        expect.arrayContaining([
          ["read", "MyVpcVpc"],
          ["read", "MyVpcInternetGateway"],
          ["read", "MyVpcSecurityGroup"],
          ["read", "MyVpcCloudmapNamespace"],
        ]),
      );
      expect(
        pulumi.resources.filter(
          (r) => r.type.startsWith("aws:") && r.kind !== "read",
        ),
      ).toEqual([]);
    });
  });

  it("replaces the bastion on a switch when Amazon's default image isn't the one it runs", async () => {
    amazonDefault = "ami-0newer";
    try {
      const result = await pulumi.takesOver(
        () => new OriginalVpc("MyVpc", { bastion: true }),
        () => new Vpc("MyVpc", { bastion: true }),
      );
      // Only the bastion, as the state map lists it
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["MyVpcBastionInstance", ["ami"]],
      ]);
    } finally {
      amazonDefault = AL2023;
    }
  });

  it("reads a namespace id with a 0 in it", async () => {
    namespace = "ns-0abc123def456780";
    try {
      Vpc.get("MyVpc", SHARED);
      await pulumi.settle();
      expect(resource("MyVpcCloudmapNamespace").options.id).toBe(namespace);
    } finally {
      namespace = "ns-abc123def456789";
    }
  });

  describe("is taken by the V5 components that take a VPC", () => {
    it("as the 4.x one is", async () => {
      const { Cluster } = await import(
        "../../../src/components/aws/v5/cluster"
      );
      const { Service } = await import(
        "../../../src/components/aws/v5/service"
      );
      const { Efs } = await import("../../../src/components/aws/v5/efs");
      const { Function } = await import(
        "../../../src/components/aws/v5/function"
      );
      const vpc = new Vpc("MyVpc", { nat: "managed" });
      const cluster = new Cluster("MyCluster", { vpc });
      new Service("MyService", { cluster, image: "nginx" });
      new Efs("MyEfs", { vpc });
      new Function("MyFunction", { handler: "src/index.handler", vpc });
      await pulumi.settle();

      const privateSubnets = await read(vpc.privateSubnets);
      expect(resource("MyFunctionFunction").inputs.vpcConfig).toMatchObject({
        subnetIds: privateSubnets,
      });
      expect(
        Object.values(
          pulumi.resources
            .filter((r) => r.name.startsWith("MyEfsMountTarget"))
            .map((r) => r.inputs.subnetId),
        ),
      ).toEqual(privateSubnets);
      expect(
        resource("MyServiceService").inputs.networkConfiguration,
      ).toMatchObject({ subnets: await read(vpc.publicSubnets) });
    });

    it("and an API's VPC link is in the public subnets", async () => {
      const { ApiGatewayV2 } = await import(
        "../../../src/components/aws/v5/apigatewayv2"
      );
      const vpc = new Vpc("MyVpc");
      new ApiGatewayV2("MyApi", { vpc });
      await pulumi.settle();
      expect(resource("MyApiVpcLink").inputs).toMatchObject({
        subnetIds: await read(vpc.publicSubnets),
        securityGroupIds: await read(vpc.securityGroups),
      });
    });

    it("from another stage, with what it looked up", async () => {
      const { Function } = await import(
        "../../../src/components/aws/v5/function"
      );
      const vpc = Vpc.get("MyVpc", SHARED);
      new Function("MyFunction", { handler: "src/index.handler", vpc });
      await pulumi.settle();
      expect(resource("MyFunctionFunction").inputs.vpcConfig).toEqual({
        subnetIds: ["subnet-private-1", "subnet-private-2"],
        securityGroupIds: ["sg-default"],
      });
    });
  });
});
