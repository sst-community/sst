import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const FILE_SYSTEM = "aws:efs/fileSystem:FileSystem";
const ACCESS_POINT = "aws:efs/accessPoint:AccessPoint";
const MOUNT_TARGET = "aws:efs/mountTarget:MountTarget";
const VPC = "aws:ec2/vpc:Vpc";
const LAMBDA = "aws:lambda/function:Function";
const mockArn = (name: string) => `arn:aws:mock:us-east-1:123456789012:${name}`;

const lookups: string[] = [];
const pulumi = mockPulumi({
  state: (args) => {
    // A VPC that's looked up has the CIDR block it has
    if (args.type === VPC && args.id) return { cidrBlock: "10.9.0.0/16" };
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
    if (args.token === "aws:efs/getAccessPoints:getAccessPoints") {
      lookups.push(args.inputs.fileSystemId);
      return { ids: ["fsap-first", "fsap-second"] };
    }
    return undefined;
  },
});

describe("Efs", () => {
  let OriginalEfs: typeof import("../../../src/components/aws/efs").Efs;
  let Efs: typeof import("../../../src/components/aws/v5/efs").Efs;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Cluster: typeof import("../../../src/components/aws/v5/cluster").Cluster;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;
  let Service: typeof import("../../../src/components/aws/v5/service").Service;
  let Task: typeof import("../../../src/components/aws/v5/task").Task;
  let aws: typeof import("@pulumi/aws");

  beforeAll(async () => {
    OriginalEfs = (await import("../../../src/components/aws/efs")).Efs;
    Efs = (await import("../../../src/components/aws/v5/efs")).Efs;
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Cluster = (await import("../../../src/components/aws/v5/cluster")).Cluster;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
    Service = (await import("../../../src/components/aws/v5/service")).Service;
    Task = (await import("../../../src/components/aws/v5/task")).Task;
    aws = await import("@pulumi/aws");
    await import("../../../src/components/aws/takeover/efs");
    await import("../../../src/components/aws/takeover/function");
    await import("../../../src/components/aws/takeover/service");
    await import("../../../src/components/aws/takeover/task");
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
      cases: {
        "in a Vpc": {
          create: (Efs, opts) => {
            new Efs("MyEfs", { vpc: new Vpc("MyVpc") }, opts);
          },
          check: () =>
            expect(
              pulumi.resources.filter((r) => r.type === MOUNT_TARGET),
            ).toHaveLength(2),
        },
        "in subnets given by their ids": {
          create: (Efs, opts) => {
            new Efs("MyEfs", { vpc: customVpc }, opts);
          },
          check: () => {
            // The VPC is looked up as it was, under the component
            expect(resource("MyEfsVpc")).toMatchObject({
              kind: "read",
              options: { id: "vpc-1" },
            });
            expect(
              pulumi.resources.filter((r) => r.type === MOUNT_TARGET),
            ).toHaveLength(2);
          },
        },
        "the ids as an output, with its own throughput and performance": (
          Efs,
          opts,
        ) => {
          new Efs(
            "MyEfs",
            {
              vpc: output({ id: "vpc-1", subnets: [output("subnet-0a1b")] }),
              throughput: "bursting",
              performance: output("max-io" as const),
            },
            opts,
          );
        },
        "transform functions": (Efs, opts) => {
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
        "mounted by a function, a service and a task": {
          create: (Efs, opts) => {
            const vpc = new Vpc("MyVpc");
            const efs = new Efs("MyEfs", { vpc }, opts);
            const cluster = new Cluster("MyCluster", { vpc });
            new Function("MyFunction", {
              handler: "src/index.handler",
              vpc,
              volume: { efs },
            });
            new Service("MyService", {
              cluster,
              image: "nginx:latest",
              volumes: [{ efs, path: "/mnt/efs" }],
            });
            new Task("MyTask", {
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
          new Function("MyFunction", {
            handler: "src/index.handler",
            vpc,
            volume: { efs, path: "/mnt/files" },
          });
          new Task("MyTask", {
            cluster: new Cluster("MyCluster", { vpc }),
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

      expect(created().sort()).toEqual([
        "MyEfsAccessPoint",
        "MyEfsFileSystem",
        "MyEfsMountTargetSubnet0a1b",
        "MyEfsMountTargetSubnet2c3d",
        "MyEfsSecurityGroup",
        "MyEfsVpc",
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
      expect(resource("MyEfsMountTargetSubnet2c3d").inputs).toEqual({
        fileSystemId: "MyEfsFileSystem_id",
        subnetId: "subnet-2c3d",
        securityGroups: ["MyEfsSecurityGroup_id"],
      });
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

    // A subnet can't be deleted while a mount target is in it. A mount target
    // is given its subnet's id as a plain value, and still depends on the
    // subnets: through its security group, which is given the VPC they're in.
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
        "MyEfsMountTargetSubnet0a1b",
        "MyEfsMountTargetSubnet2c3d",
      ])
        expect(dependencies.some((urn: string) => urn.endsWith(target))).toBe(
          true,
        );
    });

    it("has every part in nodes, the mount targets by subnet", async () => {
      const efs = new Efs("MyEfs", { vpc: customVpc });
      await pulumi.settle();

      expect(efs.nodes.fileSystem).toBeInstanceOf(aws.efs.FileSystem);
      expect(efs.nodes.accessPoint).toBeInstanceOf(aws.efs.AccessPoint);
      expect(efs.nodes.securityGroup).toBeInstanceOf(aws.ec2.SecurityGroup);
      expect(Object.keys(efs.nodes.mountTarget)).toEqual([
        "subnet-0a1b",
        "subnet-2c3d",
      ]);
      expect(efs.nodes.mountTarget["subnet-0a1b"]).toBeInstanceOf(
        aws.efs.MountTarget,
      );
    });

    it("transforms the mount targets, each with its subnet", async () => {
      new Efs("MyEfs", {
        vpc: customVpc,
        transform: {
          mountTarget: (args, _opts, _name, subnet) => {
            if (subnet === "subnet-0a1b") args.ipAddress = "10.9.0.10";
          },
        },
      });
      await pulumi.settle();

      expect(resource("MyEfsMountTargetSubnet0a1b").inputs.ipAddress).toBe(
        "10.9.0.10",
      );
      expect(
        resource("MyEfsMountTargetSubnet2c3d").inputs.ipAddress,
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
        unclaimed: [],
        changed: [["MyEfsAccessPoint", ["rootDirectory"]]],
      });
      expect(resource("MyEfsAccessPoint").inputs.rootDirectory).toEqual({
        path: "/",
        creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: "755" },
      });
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
  });

  // The V5 Function, Service and Task take the 4.x Efs and the V5 one, and
  // read the same things off both.
  describe("what mounts it", () => {
    it("gives a function the access point's ARN", async () => {
      const vpc = { privateSubnets: ["subnet-0a1b"], securityGroups: ["sg-1"] };
      new Function("Original", {
        handler: "src/index.handler",
        vpc,
        volume: { efs: new OriginalEfs("Theirs", { vpc: customVpc }) },
      });
      new Function("New", {
        handler: "src/index.handler",
        vpc,
        volume: {
          efs: new Efs("MyEfs", { vpc: customVpc }),
          path: "/mnt/files",
        },
      });
      await pulumi.settle();

      expect(resource("OriginalFunction").inputs.fileSystemConfig).toEqual({
        arn: mockArn("TheirsAccessPoint"),
        localMountPath: "/mnt/efs",
      });
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
          {
            efs: new OriginalEfs("Theirs", { vpc: customVpc }),
            path: "/theirs",
          },
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
          fileSystemId: "TheirsFileSystem_id",
          authorizationConfig: { accessPointId: "TheirsAccessPoint_id" },
        },
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
