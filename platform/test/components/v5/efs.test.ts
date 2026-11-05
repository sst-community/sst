import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, sidedClass } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

const FILE_SYSTEM = "aws:efs/fileSystem:FileSystem";
const ACCESS_POINT = "aws:efs/accessPoint:AccessPoint";
const MOUNT_TARGET = "aws:efs/mountTarget:MountTarget";
const VPC = "aws:ec2/vpc:Vpc";
const LAMBDA = "aws:lambda/function:Function";
const mockArn = (name: string) => `arn:aws:mock:us-east-1:123456789012:${name}`;

const lookups: string[] = [];
// The AZ a subnet is in, by the last letter of its id: `subnet-0a1b` is in
// us-east-1b. The mock's own ids end in `_id`.
const azOf = (id: string) => id.replace(/_id$/, "").slice(-1).toLowerCase();

const pulumi = mockPulumi({
  state: (args) => {
    // A VPC that's looked up has the CIDR block it has
    if (args.type === VPC && args.id)
      return {
        cidrBlock: "10.9.0.0/16",
        // A V5 `Vpc` from `get` is one SST created
        tagsAll: { "sst:ref-version": "2" },
      };
    if (args.type === ACCESS_POINT && args.id)
      return {
        arn: `arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/${args.id}`,
      };
    if (args.type === LAMBDA)
      return {
        arn: `arn:aws:lambda:us-east-1:123456789012:function:${args.name}`,
      };
    return {};
  },
  call: (args) => {
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b"] };
    // A VPC given by its ids is looked up for its CIDR block
    if (args.token === "aws:ec2/getVpc:getVpc")
      return { id: args.inputs.id, cidrBlock: "10.9.0.0/16" };
    // What a V5 `Vpc` from `get` looks up: the subnets it finds, in no
    // order, and the AZ each is in, by the last letter of its id. The VPC
    // `vpc-twice` has two private subnets in one AZ.
    const filter = (name: string) =>
      args.inputs.filters?.find((f: any) => f.name === name)?.values[0];
    if (args.token === "aws:ec2/getSubnets:getSubnets")
      return {
        ids:
          filter("tag:Name") === "*Public*"
            ? ["subnet-pub-a", "subnet-pub-b"]
            : filter("vpc-id") === "vpc-twice"
              ? ["subnet-one-a", "subnet-two-a"]
              : ["subnet-priv-b", "subnet-priv-a"],
      };
    if (args.token === "aws:ec2/getSubnet:getSubnet")
      return {
        id: args.inputs.id,
        availabilityZone: `us-east-1${azOf(args.inputs.id)}`,
        cidrBlock: "10.9.0.0/24",
      };
    if (args.token === "aws:ec2/getInternetGateway:getInternetGateway")
      return { internetGatewayId: "igw-shared" };
    if (args.token === "aws:ec2/getSecurityGroups:getSecurityGroups")
      return { ids: ["sg-default"] };
    if (args.token === "aws:ec2/getRouteTable:getRouteTable")
      return { routeTableId: `rtb-${args.inputs.subnetId}` };
    if (args.token === "aws:ec2/getNatGateways:getNatGateways")
      return { ids: [] };
    if (args.token === "aws:ec2/getInstances:getInstances")
      return { ids: [], publicIps: [] };
    if (args.token === "aws:route53/getZone:getZone")
      return {
        linkedServiceDescription:
          "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-shared",
      };
    if (args.token === "aws:efs/getAccessPoints:getAccessPoints") {
      lookups.push(args.inputs.fileSystemId);
      return { ids: ["fsap-first", "fsap-second"] };
    }
    return undefined;
  },
});

describe("Efs", () => {
  let OriginalEfs: typeof import("../../fixtures/v4/components/aws/efs").Efs;
  let Efs: typeof import("../../../src/components/aws/efs").Efs;
  // SST 4's for SST 4's side, SST 5's for SST 5's
  let Vpc: any;
  let V5Vpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Cluster: typeof import("../../../src/components/aws/cluster").Cluster;
  let Function: typeof import("../../../src/components/aws/function").Function;
  let Service: typeof import("../../../src/components/aws/service").Service;
  let Task: typeof import("../../../src/components/aws/task").Task;
  let SidedCluster: any;
  let SidedFunction: any;
  let SidedService: any;
  let SidedTask: any;
  let aws: typeof import("@pulumi/aws");

  beforeAll(async () => {
    OriginalEfs = (await import("../../fixtures/v4/components/aws/efs")).Efs;
    Efs = (await import("../../../src/components/aws/efs")).Efs;
    Vpc = await sidedClass(
      "Vpc",
      import("../../fixtures/v4/components/aws/vpc"),
      import("../../../src/components/aws/vpc"),
      import("../../../src/components/aws/takeover/vpc"),
    );
    V5Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Cluster = (await import("../../../src/components/aws/cluster")).Cluster;
    Function = (await import("../../../src/components/aws/function")).Function;
    Service = (await import("../../../src/components/aws/service")).Service;
    Task = (await import("../../../src/components/aws/task")).Task;
    aws = await import("@pulumi/aws");
    await import("../../../src/components/aws/takeover/efs");
    await import("../../../src/components/aws/takeover/vpc");
    await import("../../../src/components/aws/takeover/function");
    await import("../../../src/components/aws/takeover/service");
    await import("../../../src/components/aws/takeover/task");
    // SST 4's for the file system SST 4's, SST 5's for SST 5's
    SidedCluster = await sidedClass(
      "Cluster",
      import("../../fixtures/v4/components/aws/cluster"),
      import("../../../src/components/aws/cluster"),
      import("../../../src/components/aws/takeover/cluster"),
    );
    SidedFunction = await sidedClass(
      "Function",
      import("../../fixtures/v4/components/aws/function"),
      import("../../../src/components/aws/function"),
    );
    SidedService = await sidedClass(
      "Service",
      import("../../fixtures/v4/components/aws/service"),
      import("../../../src/components/aws/service"),
    );
    SidedTask = await sidedClass(
      "Task",
      import("../../fixtures/v4/components/aws/task"),
      import("../../../src/components/aws/task"),
    );
  });

  beforeEach(() => {
    pulumi.reset();
    lookups.length = 0;
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  // What's in AWS under the component
  const created = () =>
    pulumi.resources
      .filter((r) => r.type.startsWith("aws:") && r.name.startsWith("MyEfs"))
      .map((r) => r.name);
  const customVpc = { id: "vpc-1", subnets: ["subnet-0a1b", "subnet-2c3d"] };
  // What a switch changes: a mount target is now removed before it's made
  // again, since EFS allows one in each AZ. Nothing in AWS changes.
  const removedFirst = (...subnets: string[]) =>
    subnets.map((subnet): [string, string[]] => [
      `MyEfsMountTarget${subnet}`,
      ["options.deleteBeforeReplace"],
    ]);
  const inVpc = removedFirst(
    "MyVpcPrivateSubnet1_id",
    "MyVpcPrivateSubnet2_id",
  );
  const inIds = removedFirst("subnet-0a1b", "subnet-2c3d");
  const takesOver = async (original: () => void, v5: () => void) => {
    const result = await pulumi.takesOver(original, v5);
    return {
      unclaimed: result.unclaimed,
      changed: result.changed.map((c) => [c.name, c.fields]),
    };
  };

  // Each case deploys the 4.x Efs, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs.
  describe("takes over a deployed Efs", () => {
    pulumi.takeoverCases({
      original: () => OriginalEfs,
      v5: () => Efs,
      check: () => expect(resource("MyEfsFileSystem").type).toBe(FILE_SYSTEM),
      // The 4.x Efs made its security group from the VPC's id together with
      // its subnets, so the group waited on them, which it doesn't need. The
      // mount targets, which do, still go before the subnets.
      needlessOrder: /^MyEfsSecurityGroup before MyVpcPrivateSubnet\d$/,
      cases: {
        "in a Vpc": {
          create: (Efs, opts) => {
            new Efs("MyEfs", { vpc: new Vpc("MyVpc") }, opts);
          },
          changed: inVpc,
          check: () =>
            expect(
              pulumi.resources.filter((r) => r.type === MOUNT_TARGET),
            ).toHaveLength(2),
        },
        "in subnets given by their ids": {
          create: (Efs, opts) => {
            new Efs("MyEfs", { vpc: customVpc }, opts);
          },
          // The VPC is looked up with a function, not read into the state
          unclaimed: [`${VPC}::MyEfsVpc`],
          changed: inIds,
          check: () => {
            expect(names()).not.toContain("MyEfsVpc");
            expect(
              pulumi.resources.filter((r) => r.type === MOUNT_TARGET),
            ).toHaveLength(2);
          },
        },
        // The V5 one takes the ids as a plain object, with outputs inside
        "the ids as an output, with its own throughput and performance": {
          original: (opts) => {
            new OriginalEfs(
              "MyEfs",
              {
                vpc: output({
                  id: "vpc-1",
                  subnets: [output("subnet-0a1b")],
                }),
                throughput: "bursting",
                performance: output("max-io" as const),
              },
              opts,
            );
          },
          v5: (opts) => {
            new Efs(
              "MyEfs",
              {
                vpc: { id: output("vpc-1"), subnets: [output("subnet-0a1b")] },
                throughput: "bursting",
                performance: output("max-io" as const),
              },
              opts,
            );
          },
          unclaimed: [`${VPC}::MyEfsVpc`],
          changed: removedFirst("subnet-0a1b"),
        },
        "transform functions": {
          unclaimed: [`${VPC}::MyEfsVpc`],
          changed: inIds,
          create: (Efs, opts) => {
            new Efs(
              "MyEfs",
              {
                vpc: customVpc,
                transform: {
                  fileSystem: (args: any) => {
                    args.throughputMode = "provisioned";
                    args.provisionedThroughputInMibps = 8;
                    return undefined;
                  },
                  securityGroup: (args: any) => {
                    args.description = "Files";
                    return undefined;
                  },
                  accessPoint: (args: any) => {
                    args.posixUser = { uid: 1000, gid: 1000 };
                    return undefined;
                  },
                },
              },
              opts,
            );
          },
        },
        "mounted by a function, a service and a task": {
          changed: inVpc,
          // SST 4's Service's dev command, which SST 5's reports itself
          unclaimed: ["sst:sst:DevCommand::MyServiceDev"],
          create: (Efs, opts) => {
            const vpc = new Vpc("MyVpc");
            const efs = new Efs("MyEfs", { vpc }, opts);
            const cluster = new SidedCluster("MyCluster", { vpc });
            new SidedFunction("MyFunction", {
              handler: "src/index.handler",
              vpc,
              volume: { efs },
            });
            new SidedService("MyService", {
              cluster,
              image: "nginx:latest",
              volumes: [{ efs, path: "/mnt/efs" }],
            });
            new SidedTask("MyTask", {
              cluster,
              containers: [
                {
                  name: "app",
                  image: "nginx:latest",
                  volumes: [{ efs, path: "/data" }],
                },
              ],
            });
          },
          check: () => {
            expect(
              resource("MyFunctionFunction").inputs.fileSystemConfig,
            ).toEqual({
              arn: mockArn("MyEfsAccessPoint"),
              localMountPath: "/mnt/efs",
            });
            expect(
              resource("MyServiceTaskDefinition").inputs.volumes,
            ).toMatchObject([
              {
                efsVolumeConfiguration: {
                  fileSystemId: "MyEfsFileSystem_id",
                  authorizationConfig: {
                    accessPointId: "MyEfsAccessPoint_id",
                  },
                },
              },
            ]);
          },
        },
      },
    });
  });

  // The 4.x Efs looks the file system and its access point up outside the
  // component, and creates the component at the top of the app whatever
  // options it's given. A lookup can't be carried over, so both are dropped
  // from the state and read again, which changes nothing in AWS.
  describe("takes over a file system from get", () => {
    pulumi.takeoverCases({
      original: () => OriginalEfs,
      v5: () => Efs,
      unclaimed: (way) => [
        `${FILE_SYSTEM}::MyEfsFileSystem`,
        `${ACCESS_POINT}::MyEfsAccessPoint`,
        // The component moves under what it's created in
        ...(way === "inside another component" ? ["sst:aws:Efs::MyEfs"] : []),
      ],
      check: () => {
        expect(resource("MyEfsFileSystem")).toMatchObject({
          kind: "read",
          options: { id: "fs-123" },
        });
        expect(resource("MyEfsAccessPoint")).toMatchObject({
          kind: "read",
          options: { id: "fsap-first" },
        });
      },
      cases: {
        "on its own": (Efs, opts) => {
          Efs.get("MyEfs", "fs-123", opts);
        },
        "mounted by a function and a task": (Efs, opts) => {
          const vpc = new Vpc("MyVpc");
          const efs = Efs.get("MyEfs", "fs-123", opts);
          new SidedFunction("MyFunction", {
            handler: "src/index.handler",
            vpc,
            volume: { efs, path: "/mnt/files" },
          });
          new SidedTask("MyTask", {
            cluster: new SidedCluster("MyCluster", { vpc }),
            image: "nginx:latest",
            volumes: [{ efs, path: "/data" }],
          });
        },
      },
    });
  });

  describe("what it creates", () => {
    it("creates the file system, a mount target in each subnet, and an access point", async () => {
      const efs = new Efs("MyEfs", { vpc: customVpc });
      await pulumi.settle();

      // By the AZ each subnet is in, which is looked up. The VPC is looked up
      // with a function, so it isn't in the state.
      expect(created().sort()).toEqual([
        "MyEfsAccessPoint",
        "MyEfsFileSystem",
        "MyEfsMountTargetUseast1b",
        "MyEfsMountTargetUseast1d",
        "MyEfsSecurityGroup",
      ]);
      expect(resource("MyEfsFileSystem").inputs).toMatchObject({
        performanceMode: "generalPurpose",
        throughputMode: "elastic",
        encrypted: true,
      });
      expect(resource("MyEfsSecurityGroup").inputs).toMatchObject({
        vpcId: "vpc-1",
        ingress: [
          {
            fromPort: 0,
            toPort: 0,
            protocol: "-1",
            cidrBlocks: ["10.9.0.0/16"],
          },
        ],
      });
      expect(resource("MyEfsMountTargetUseast1d").inputs).toEqual({
        fileSystemId: "MyEfsFileSystem_id",
        subnetId: "subnet-2c3d",
        securityGroups: ["MyEfsSecurityGroup_id"],
      });
      // EFS allows one in each AZ, so a new one can't be made beside it
      expect(
        resource("MyEfsMountTargetUseast1d").options.deleteBeforeReplace,
      ).toBe(true);
      expect(resource("MyEfsAccessPoint").inputs).toMatchObject({
        fileSystemId: "MyEfsFileSystem_id",
        posixUser: { uid: 0, gid: 0 },
        rootDirectory: { path: "/" },
      });
      expect(await pulumi.resolve(efs.id)).toBe("MyEfsFileSystem_id");
      expect(await pulumi.resolve(efs.accessPoint)).toBe("MyEfsAccessPoint_id");
    });

    it("uses the private subnets and the CIDR block of a Vpc", async () => {
      const vpc = new Vpc("MyVpc");
      new Efs("MyEfs", { vpc });
      await pulumi.settle();

      const subnets = await pulumi.resolve(vpc.privateSubnets);
      expect(
        pulumi.resources
          .filter((r) => r.type === MOUNT_TARGET)
          .map((r) => r.inputs.subnetId),
      ).toEqual(subnets);
      expect(
        resource("MyEfsSecurityGroup").inputs.ingress[0].cidrBlocks,
      ).toEqual([resource("MyVpcVpc").inputs.cidrBlock]);
      // Nothing to look up
      expect(names()).not.toContain("MyEfsVpc");
    });

    // A subnet can't be deleted while a mount target is in it. The mount
    // target is given its subnet as an output of the VPC's, so it depends on
    // it, though it's created once a preview knows the subnets.
    it("removes a mount target before the subnet it's in", async () => {
      const vpc = new Vpc("MyVpc");
      new Efs("MyEfs", { vpc });
      await pulumi.settle();

      const target = pulumi.resources.find((r) => r.type === MOUNT_TARGET)!;
      expect(pulumi.dependsOn(target.name, /^MyVpcPrivateSubnet/)).toBe(true);
    });

    // What mounts the file system reads the access point, and has to find
    // the mount targets there
    it("makes the access point wait for the mount targets", async () => {
      new Efs("MyEfs", { vpc: customVpc });
      await pulumi.settle();

      const dependencies = resource("MyEfsAccessPoint").options.dependencies;
      for (const target of [
        "MyEfsMountTargetUseast1b",
        "MyEfsMountTargetUseast1d",
      ])
        expect(dependencies.some((urn: string) => urn.endsWith(target))).toBe(
          true,
        );
    });

    it("has every part in nodes, the mount targets by their AZ", async () => {
      const efs = new Efs("MyEfs", { vpc: customVpc });
      await pulumi.settle();

      expect(efs.nodes.fileSystem).toBeInstanceOf(aws.efs.FileSystem);
      expect(efs.nodes.accessPoint).toBeInstanceOf(aws.efs.AccessPoint);
      expect(efs.nodes.securityGroup).toBeInstanceOf(aws.ec2.SecurityGroup);
      expect(Object.keys(efs.nodes.mountTarget)).toEqual([
        "us-east-1b",
        "us-east-1d",
      ]);
      expect(
        await pulumi.resolve(efs.nodes.mountTarget["us-east-1b"].subnetId),
      ).toBe("subnet-0a1b");
    });

    it("transforms the mount targets, each with its key", async () => {
      new Efs("MyEfs", {
        vpc: customVpc,
        transform: {
          mountTarget: (args, _opts, _name, key) => {
            if (key === "us-east-1b") args.ipAddress = "10.9.0.10";
          },
        },
      });
      await pulumi.settle();

      expect(resource("MyEfsMountTargetUseast1b").inputs.ipAddress).toBe(
        "10.9.0.10",
      );
      expect(
        resource("MyEfsMountTargetUseast1d").inputs.ipAddress,
      ).toBeUndefined();
    });

    // 4.x replaced the root directory with the one in the transform. V5
    // merges it, so the path SST sets is there next to what's added.
    it("keeps the rest of the root directory an object transform sets part of", async () => {
      const create = (Efs: any) => () =>
        new Efs("MyEfs", {
          vpc: customVpc,
          transform: {
            accessPoint: {
              rootDirectory: {
                creationInfo: {
                  ownerUid: 1000,
                  ownerGid: 1000,
                  permissions: "755",
                },
              },
            },
          },
        });

      expect(await takesOver(create(OriginalEfs), create(Efs))).toEqual({
        unclaimed: [`${VPC}::MyEfsVpc`],
        changed: expect.arrayContaining([
          ["MyEfsAccessPoint", ["rootDirectory"]],
          ...inIds,
        ]),
      });
      expect(resource("MyEfsAccessPoint").inputs.rootDirectory).toEqual({
        path: "/",
        creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: "755" },
      });
    });
  });

  describe("the VPC it's in", () => {
    it("has a mount target in each AZ of a Vpc it's given, by the AZ's number", async () => {
      const efs = new Efs("MyEfs", { vpc: new V5Vpc("MyVpc") });
      await pulumi.settle();

      expect(Object.keys(efs.nodes.mountTarget)).toEqual(["1", "2"]);
      expect(resource("MyEfsMountTarget1").inputs.subnetId).toBe(
        "MyVpcPrivateSubnet1_id",
      );
      expect(resource("MyEfsMountTarget2").inputs.subnetId).toBe(
        "MyVpcPrivateSubnet2_id",
      );
    });

    // So a new stage's preview, which doesn't know the subnets' ids, has
    // them. The subnets of any other VPC are looked up first.
    it("makes them without waiting for the subnets, in a Vpc it creates", async () => {
      const efs = new Efs("MyEfs", { vpc: new V5Vpc("MyVpc") });

      expect(Object.keys(efs.nodes.mountTarget)).toEqual(["1", "2"]);
      await pulumi.settle();
    });

    it("keeps its mount targets when it's switched with its Vpc", async () => {
      const result = await takesOver(
        () => new OriginalEfs("MyEfs", { vpc: new Vpc("MyVpc") }),
        () => new Efs("MyEfs", { vpc: new V5Vpc("MyVpc") }),
      );

      expect(result.unclaimed).toEqual(["sst:sst:Version::MyVpcVersion"]);
      expect(result.changed).toEqual(inVpc);
    });

    // Its lookup keeps no order, so they're kept by the AZ each is in
    it("has one in each AZ of a Vpc from get, by the AZ's name", async () => {
      const efs = new Efs("MyEfs", { vpc: V5Vpc.get("MyVpc", "vpc-shared") });
      await pulumi.settle();

      expect(Object.keys(efs.nodes.mountTarget).sort()).toEqual([
        "us-east-1a",
        "us-east-1b",
      ]);
      expect(
        await pulumi.resolve(efs.nodes.mountTarget["us-east-1a"].subnetId),
      ).toBe("subnet-priv-a");
      expect(
        resource("MyEfsAccessPoint").options.dependencies.filter(
          (urn: string) => urn.includes("efs/mountTarget"),
        ),
      ).toHaveLength(2);
    });

    it("refuses a Vpc from get with two private subnets in one AZ", async () => {
      const errors = await applyErrors(
        () => new Efs("MyEfs", { vpc: V5Vpc.get("MyVpc", "vpc-twice") }),
        pulumi.settle,
      );

      expect([...new Set(errors)]).toContainEqual(
        expect.stringContaining(
          'Two of the subnets of the "MyEfs" file system are in "us-east-1a": "subnet-one-a" and "subnet-two-a".',
        ),
      );
      expect(names()).not.toContain("MyEfsMountTargetUsEast1a");
    });

    // Each is kept by its subnet's AZ, so an edit of the list changes only
    // the AZs it adds or removes
    it("keeps the others when a subnet is removed from the ids, or they're reordered", async () => {
      const create = (subnets: string[]) => () =>
        new Efs("MyEfs", { vpc: { id: "vpc-1", subnets } });

      expect(
        await takesOver(
          create(["subnet-0a1b", "subnet-2c3d"]),
          create(["subnet-2c3d"]),
        ),
      ).toEqual({
        unclaimed: [`${MOUNT_TARGET}::MyEfsMountTargetUseast1b`],
        changed: [],
      });
      expect(
        await takesOver(
          create(["subnet-0a1b", "subnet-2c3d"]),
          create(["subnet-2c3d", "subnet-0a1b"]),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    // As the 4.x Efs was often given a Vpc's subnets
    it("takes the ids in an output", async () => {
      const vpc = new V5Vpc("MyVpc");
      const efs = new Efs("MyEfs", {
        vpc: { id: vpc.id, subnets: vpc.privateSubnets },
      });
      await pulumi.settle();

      expect(Object.keys(efs.nodes.mountTarget)).toHaveLength(2);
    });

    it("refuses ids without subnets", async () => {
      const errors = await applyErrors(
        () => new Efs("MyEfs", { vpc: { id: "vpc-1" } as any }),
        pulumi.settle,
      );

      expect([...new Set(errors)]).toContainEqual(
        'The "vpc" of the "MyEfs" file system has no "subnets". Its mount targets are created in them.',
      );
    });

    it("refuses another resource in place of a Vpc", () => {
      expect(
        () => new Efs("InAnEc2Vpc", { vpc: new aws.ec2.Vpc("Raw", {}) as any }),
      ).toThrow(
        'The "vpc" of the "InAnEc2Vpc" file system isn\'t a "Vpc" component. Pass a "Vpc", or the ids of a VPC.',
      );
    });
  });

  describe("a file system that's already deployed", () => {
    it("is looked up with the first access point it has", async () => {
      const efs = new Efs("MyEfs", {
        existing: { fileSystem: "fs-123" },
      } as any);
      await pulumi.settle();

      expect(created()).toEqual(["MyEfsFileSystem", "MyEfsAccessPoint"]);
      expect(lookups).toEqual(["fs-123"]);
      expect(resource("MyEfsFileSystem")).toMatchObject({
        kind: "read",
        parent: expect.stringContaining("sst:aws:Efs::MyEfs"),
      });
      expect(resource("MyEfsAccessPoint").parent).toEqual(
        resource("MyEfsFileSystem").parent,
      );
      expect(await pulumi.resolve(efs.id)).toBe("fs-123");
      expect(await pulumi.resolve(efs.accessPoint)).toBe("fsap-first");
      expect(await pulumi.resolve(efs.nodes.accessPoint.arn)).toBe(
        "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-first",
      );
    });

    it("is what get passes, with the options it's given", async () => {
      const parent = new aws.s3.Bucket("Parent", {});
      const efs = Efs.get("MyEfs", "fs-123", { parent });
      await pulumi.settle();

      expect(resource("MyEfs").parent).toContain("Parent");
      expect(await pulumi.resolve(efs.id)).toBe("fs-123");
    });

    it("uses the access point it's given", async () => {
      const efs = new Efs("MyEfs", {
        existing: { fileSystem: "fs-123", accessPoint: "fsap-mine" },
      } as any);
      await pulumi.settle();

      expect(lookups).toEqual([]);
      expect(resource("MyEfsAccessPoint").options.id).toBe("fsap-mine");
      expect(await pulumi.resolve(efs.accessPoint)).toBe("fsap-mine");
    });

    // It's used the way it is: what would configure it, or make its mount
    // targets, would be dropped
    it("refuses what would configure it", async () => {
      expect(
        () =>
          new Efs("MyEfs", {
            vpc: customVpc,
            throughput: "bursting",
            existing: { fileSystem: "fs-123" },
          }),
      ).toThrow(
        'The "MyEfs" file system is given an existing "fileSystem", which it uses the way it is. Remove "throughput", "vpc" from its args.',
      );
      for (const key of ["securityGroup", "mountTarget"])
        expect(
          () =>
            new Efs("MyEfs", {
              existing: { fileSystem: "fs-123", [key]: "theirs" },
            } as any),
        ).toThrow(
          `"existing.${key}" isn't an option for the "MyEfs" file system. The "fileSystem" it's given has its mount targets already.`,
        );
      await pulumi.settle();
    });

    // What a $transform sets for every file system isn't meant for one from
    // get
    it("takes what a $transform gives one from get", async () => {
      const { $transform } = await import("../../../src/components/component");
      $transform(Efs, (args, _opts, name) => {
        if (name === "Shared") args!.throughput = "bursting";
      });
      const efs = Efs.get("Shared", "fs-123");
      await pulumi.settle();
      expect(await pulumi.resolve(efs.id)).toBe("fs-123");
    });
  });

  describe("what mounts it", () => {
    it("gives a function the access point's ARN", async () => {
      const vpc = { privateSubnets: ["subnet-0a1b"], securityGroups: ["sg-1"] };
      new Function("New", {
        handler: "src/index.handler",
        vpc,
        volume: {
          efs: new Efs("MyEfs", { vpc: customVpc }),
          path: "/mnt/files",
        },
      });
      await pulumi.settle();

      expect(resource("NewFunction").inputs.fileSystemConfig).toEqual({
        arn: mockArn("MyEfsAccessPoint"),
        localMountPath: "/mnt/files",
      });
    });

    it("gives a task the ids of the file system and the access point", async () => {
      const cluster = new Cluster("MyCluster", {
        vpc: {
          id: "vpc-1",
          securityGroups: ["sg-1"],
          containerSubnets: ["subnet-0a1b"],
          loadBalancerSubnets: ["subnet-0a1b"],
        },
      });
      new Task("MyTask", {
        cluster,
        image: "nginx:latest",
        volumes: [
          { efs: new Efs("MyEfs", { vpc: customVpc }), path: "/mine" },
          { efs: { fileSystem: "fs-9", accessPoint: "fsap-9" }, path: "/ids" },
        ],
      });
      await pulumi.settle();

      expect(
        resource("MyTaskTaskDefinition").inputs.volumes.map(
          (volume: any) => volume.efsVolumeConfiguration,
        ),
      ).toMatchObject([
        {
          fileSystemId: "MyEfsFileSystem_id",
          authorizationConfig: { accessPointId: "MyEfsAccessPoint_id" },
        },
        {
          fileSystemId: "fs-9",
          authorizationConfig: { accessPointId: "fsap-9" },
        },
      ]);
    });
  });

  describe("what it's given", () => {
    it("refuses a part it doesn't have", () => {
      expect(
        () =>
          new Efs("MyEfs", {
            vpc: customVpc,
            transform: { mountTargets: {} } as any,
          }),
      ).toThrow(/fileSystem, securityGroup, mountTarget, accessPoint/);
    });
  });
});
