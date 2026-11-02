import { describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

// The AZ a subnet is in, by the last letter of its id: `subnet-0a1b` is in
// us-east-1b. The mock's own ids end in `_id`.
const azOf = (id: string) => id.replace(/_id$/, "").slice(-1).toLowerCase();

// A new stage's preview: everything is about to be created, so of each
// resource only what it was given is known, and nothing AWS gives back. The
// lookups' inputs are known, so they're answered.
const pulumi = mockPulumi({
  preview: true,
  state: (args) => {
    // A V5 `Vpc` from `get` is one SST created, in another stage
    if (args.type === "aws:ec2/vpc:Vpc" && args.id)
      return {
        cidrBlock: "10.9.0.0/16",
        tagsAll: { "sst:ref-version": "2" },
      };
    return Object.fromEntries(
      ["arn", "cidrBlock"]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    );
  },
  call: (args) => {
    const filter = (name: string) =>
      args.inputs.filters?.find((f: any) => f.name === name)?.values[0];
    switch (args.token) {
      case "aws:index/getAvailabilityZones:getAvailabilityZones":
        return { names: ["us-east-1a", "us-east-1b"] };
      case "aws:ec2/getVpc:getVpc":
        return { id: args.inputs.id, cidrBlock: "10.9.0.0/16" };
      case "aws:ec2/getSubnets:getSubnets":
        return {
          ids:
            filter("tag:Name") === "*Public*"
              ? ["subnet-pub-a", "subnet-pub-b"]
              : ["subnet-priv-b", "subnet-priv-a"],
        };
      case "aws:ec2/getSubnet:getSubnet":
        return {
          id: args.inputs.id,
          availabilityZone: `us-east-1${azOf(args.inputs.id)}`,
        };
      case "aws:ec2/getInternetGateway:getInternetGateway":
        return { internetGatewayId: "igw-shared" };
      case "aws:ec2/getSecurityGroups:getSecurityGroups":
        return { ids: ["sg-default"] };
      case "aws:ec2/getRouteTable:getRouteTable":
        return { routeTableId: `rtb-${args.inputs.subnetId}` };
      case "aws:ec2/getNatGateways:getNatGateways":
        return { ids: [] };
      case "aws:ec2/getInstances:getInstances":
        return { ids: [], publicIps: [] };
      case "aws:route53/getZone:getZone":
        return {
          linkedServiceDescription:
            "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-shared",
        };
    }
    return undefined;
  },
});

describe("a file system in a new stage's preview", () => {
  it("plans a mount target in each AZ, whatever VPC it's in", async () => {
    const aws = await import("@pulumi/aws");
    const { Efs } = await import("../../../src/components/aws/v5/efs");
    const { Vpc } = await import("../../../src/components/aws/v5/vpc");

    // In a VPC the app creates. That they're made without waiting for the
    // subnets' ids, which a real preview doesn't know, is in efs.test.ts:
    // the mock gives every resource an id.
    new Efs("InVpc", { vpc: new Vpc("MyVpc") });
    // In subnets the app creates, given by their ids
    const subnet = (name: string) =>
      new aws.ec2.Subnet(name, { vpcId: "vpc-1", cidrBlock: "10.9.0.0/24" });
    new Efs("InIds", {
      vpc: { id: "vpc-1", subnets: [subnet("A").id, subnet("B").id] },
    });
    // In a VPC from another stage, whose subnets are looked up, and created
    // once the lookups are answered, which a preview does
    new Efs("InShared", { vpc: Vpc.get("Shared", "vpc-shared") });
    await pulumi.settle();

    const mountTargets = (efs: string) =>
      pulumi.resources
        .filter(
          (r) =>
            r.type === "aws:efs/mountTarget:MountTarget" &&
            r.parent.endsWith(`::sst:aws:Efs::${efs}`),
        )
        .map((r) => r.name)
        .sort();
    expect(mountTargets("InVpc")).toEqual([
      "InVpcMountTarget1",
      "InVpcMountTarget2",
    ]);
    expect(mountTargets("InIds")).toHaveLength(2);
    expect(mountTargets("InShared")).toHaveLength(2);
  });
});
