import { describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

// A new stage's preview: everything is about to be created, so of each
// resource only what it was given is known, and nothing AWS gives back. The
// lookups' inputs are known, so they're answered.
const pulumi = mockPulumi({
  preview: true,
  state: (args) =>
    Object.fromEntries(
      [
        "arn",
        "cidrBlock",
        "keyName",
        "name",
        "primaryNetworkInterfaceId",
        "privateKeyOpenssh",
        "publicIp",
        "publicKeyOpenssh",
      ]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    ),
  call: (args) => {
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b", "us-east-1c"] };
    if (args.token === "aws:ec2/getAmi:getAmi") return { id: "ami-fcknat" };
    if (args.token === "aws:ssm/getParameter:getParameter")
      return { insecureValue: "ami-al2023" };
    return undefined;
  },
});

describe("a VPC in a new stage's preview", () => {
  it("plans everything a deploy creates", async () => {
    const { Vpc } = await import("../../../src/components/aws/vpc");
    new Vpc("Net", { az: 3, nat: "ec2", bastion: true });
    new Vpc("Gateways", { nat: "managed", bastion: true });
    await pulumi.settle();

    const count = (component: string) =>
      Object.entries(
        pulumi.resources
          .filter((r) => r.parent.endsWith(`::sst:aws:Vpc::${component}`))
          .reduce<Record<string, number>>((counts, r) => {
            const type = r.type.split(":").at(-1)!;
            counts[type] = (counts[type] ?? 0) + 1;
            return counts;
          }, {}),
      ).sort();
    expect(count("Net")).toEqual([
      ["DefaultSecurityGroup", 1],
      ["Eip", 3],
      ["EipAssociation", 3],
      ["Instance", 3],
      ["InstanceProfile", 1],
      ["InternetGateway", 1],
      ["KeyPair", 1],
      ["Parameter", 1],
      ["PrivateDnsNamespace", 1],
      ["PrivateKey", 1],
      ["Role", 1],
      ["RouteTable", 6],
      ["RouteTableAssociation", 6],
      ["SecurityGroup", 1],
      ["Subnet", 6],
      ["Vpc", 1],
    ]);
    expect(count("Gateways")).toEqual([
      ["DefaultSecurityGroup", 1],
      ["Eip", 2],
      ["Instance", 1],
      ["InstanceProfile", 1],
      ["InternetGateway", 1],
      ["KeyPair", 1],
      ["NatGateway", 2],
      ["Parameter", 1],
      ["PrivateDnsNamespace", 1],
      ["PrivateKey", 1],
      ["Role", 1],
      ["RouteTable", 4],
      ["RouteTableAssociation", 4],
      ["SecurityGroup", 1],
      ["Subnet", 4],
      ["Vpc", 1],
    ]);
    // An AZ from the lookup, not an output that's waiting for one
    const subnet = pulumi.resources.find((r) => r.name === "NetPublicSubnet3")!;
    expect(subnet.inputs.availabilityZone).toBe("us-east-1c");
  });
});
