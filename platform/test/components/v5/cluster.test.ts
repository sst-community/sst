import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, setSide, sided, sidedClass } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

const CLUSTER = "aws:ecs/cluster:Cluster";
const CAPACITY_PROVIDERS =
  "aws:ecs/clusterCapacityProviders:ClusterCapacityProviders";
const SHARED = "arn:aws:ecs:us-east-1:123456789012:cluster/app-dev-MyCluster";
// A cluster SST didn't create: it has no version tag
const FOREIGN = "arn:aws:ecs:us-east-1:123456789012:cluster/their-cluster";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === CLUSTER && args.id)
      return {
        arn: args.id,
        name: args.id.split("/").pop(),
        tagsAll: args.id === SHARED ? { "sst:ref:version": "2.0" } : {},
      };
    return {};
  },
  call: (args) => {
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b"] };
    return undefined;
  },
});

describe("Cluster", () => {
  let OriginalCluster: typeof import("../../fixtures/v4/components/aws/cluster").Cluster;
  let Cluster: typeof import("../../../src/components/aws/cluster").Cluster;
  // SST 4's for SST 4's side, SST 5's for SST 5's
  let Vpc: any;
  let VpcV1: any;
  let OriginalService: typeof import("../../fixtures/v4/components/aws/service").Service;
  let Service: typeof import("../../../src/components/aws/service").Service;
  let OriginalTask: typeof import("../../fixtures/v4/components/aws/task").Task;
  let Task: typeof import("../../../src/components/aws/task").Task;
  let SidedService: any;
  let SidedTask: any;
  let aws: typeof import("@pulumi/aws");

  beforeAll(async () => {
    OriginalCluster = (await import("../../fixtures/v4/components/aws/cluster"))
      .Cluster;
    Cluster = (await import("../../../src/components/aws/cluster")).Cluster;
    Vpc = await sidedClass(
      "Vpc",
      import("../../fixtures/v4/components/aws/vpc"),
      import("../../../src/components/aws/vpc"),
      import("../../../src/components/aws/takeover/vpc"),
    );
    VpcV1 = (await import("../../fixtures/v4/components/aws/vpc-v1")).Vpc;
    OriginalService = (await import("../../fixtures/v4/components/aws/service"))
      .Service;
    Service = (await import("../../../src/components/aws/service")).Service;
    OriginalTask = (await import("../../fixtures/v4/components/aws/task")).Task;
    Task = (await import("../../../src/components/aws/task")).Task;
    aws = await import("@pulumi/aws");
    await import("../../../src/components/aws/takeover/service");
    await import("../../../src/components/aws/takeover/task");
    // SST 4's for the cluster SST 4's, SST 5's for SST 5's
    SidedService = sided(
      () => OriginalService,
      () => Service,
    );
    SidedTask = sided(
      () => OriginalTask,
      () => Task,
    );
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  // What's in AWS: everything but the components themselves
  const created = () =>
    pulumi.resources
      .filter((r) => r.type.startsWith("aws:"))
      .map((r) => r.name);
  const customVpc = {
    id: "vpc-1",
    securityGroups: ["sg-1"],
    containerSubnets: ["subnet-private-1", "subnet-private-2"],
    loadBalancerSubnets: ["subnet-public-1", "subnet-public-2"],
    publicSubnets: ["subnet-public-1", "subnet-public-2"],
    cloudmapNamespaceId: "ns-1",
    cloudmapNamespaceName: "internal",
  };
  const containerInsights = (args: any) => {
    args.settings = [{ name: "containerInsights", value: "enabled" }];
    return undefined;
  };
  const takesOver = async (original: () => void, v5: () => void) => {
    const result = await pulumi.takesOver(original, v5);
    return {
      unclaimed: result.unclaimed,
      changed: result.changed.map((c) => [c.name, c.fields]),
    };
  };

  // Each case deploys the 4.x Cluster, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs. The one thing that goes is the version marker the 4.x Cluster
  // writes, which has nothing in AWS behind it.
  describe("takes over a deployed Cluster", () => {
    pulumi.takeoverCases({
      original: () => OriginalCluster,
      v5: () => Cluster,
      unclaimed: ["sst:sst:Version::MyClusterVersion"],
      check: () => expect(resource("MyClusterCluster").type).toBe(CLUSTER),
      cases: {
        "in a Vpc": (Cluster, opts) => {
          new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }, opts);
        },
        "in a VPC given by its ids": (Cluster, opts) => {
          new Cluster("MyCluster", { vpc: customVpc }, opts);
        },
        // The V5 one takes the same subnets as `containerSubnets`
        "the ids as an output, with the deprecated serviceSubnets": {
          original: (opts) => {
            const { containerSubnets, ...vpc } = customVpc;
            new OriginalCluster(
              "MyCluster",
              { vpc: output({ ...vpc, serviceSubnets: containerSubnets }) },
              opts,
            );
          },
          v5: (opts) => {
            new Cluster("MyCluster", { vpc: output(customVpc) }, opts);
          },
        },
        // The V5 one has no `forceUpgrade`
        "a transform function, and forceUpgrade": {
          original: (opts) => {
            new OriginalCluster(
              "MyCluster",
              {
                vpc: customVpc,
                forceUpgrade: "v2",
                transform: { cluster: containerInsights },
              },
              opts,
            );
          },
          v5: (opts) => {
            new Cluster(
              "MyCluster",
              { vpc: customVpc, transform: { cluster: containerInsights } },
              opts,
            );
          },
        },
        "a service and a task in it": {
          create: (Cluster, opts) => {
            const cluster = new Cluster(
              "MyCluster",
              { vpc: new Vpc("MyVpc") },
              opts,
            );
            new SidedService("MyService", { cluster, image: "nginx:latest" });
            new SidedTask("MyTask", { cluster, image: "nginx:latest" });
          },
          // SST 4's Service's dev command, which SST 5's reports itself
          unclaimed: [
            "sst:sst:DevCommand::MyServiceDev",
            "sst:sst:Version::MyClusterVersion",
          ],
          check: () => {
            expect(resource("MyServiceService").inputs.cluster).toBe(
              "arn:aws:mock:us-east-1:123456789012:MyClusterCluster",
            );
            expect(names()).toContain("MyTaskTaskDefinition");
          },
        },
        "a cluster from another stage": {
          create: (Cluster, opts) => {
            Cluster.get("MyCluster", { id: SHARED, vpc: customVpc }, opts);
          },
          check: () => {
            expect(resource("MyClusterCluster").kind).toBe("read");
            expect(names()).not.toContain("MyClusterCapacityProviders");
          },
        },
        "a service in a cluster from another stage": {
          create: (Cluster, opts) => {
            const cluster = Cluster.get(
              "MyCluster",
              { id: SHARED, vpc: customVpc },
              opts,
            );
            new SidedService("MyService", { cluster, image: "nginx:latest" });
          },
          unclaimed: [
            "sst:sst:DevCommand::MyServiceDev",
            "sst:sst:Version::MyClusterVersion",
          ],
        },
      },
    });
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    pulumi.takeoverCases({
      original: () => OriginalCluster,
      v5: () => Cluster,
      unclaimed: ["sst:sst:Version::MyClusterVersion"],
      check: () => expect(resource("MyClusterCluster").type).toBe(CLUSTER),
      cases: {
        "is deployed all the same": (Cluster, opts) => {
          new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }, opts);
        },
      },
    });
  });

  describe("with what runs in it", () => {
    it("changes nothing in AWS when the cluster, its service and its task are all switched", async () => {
      const result = await takesOver(
        () => {
          setSide("original");
          const cluster = new OriginalCluster("MyCluster", {
            vpc: new Vpc("MyVpc"),
          });
          new OriginalService("MyService", { cluster, image: "nginx:latest" });
          new OriginalTask("MyTask", { cluster, image: "nginx:latest" });
        },
        () => {
          setSide("v5");
          const cluster = new Cluster("MyCluster", { vpc: new Vpc("MyVpc") });
          new Service("MyService", { cluster, image: "nginx:latest" });
          new Task("MyTask", { cluster, image: "nginx:latest" });
        },
      );

      expect(result).toEqual({
        // Neither has anything in AWS behind it
        unclaimed: [
          "sst:sst:DevCommand::MyServiceDev",
          "sst:sst:Version::MyClusterVersion",
          "sst:sst:Version::MyVpcVersion",
        ],
        changed: [],
      });
    });

    it("tells a task which cluster it's in", async () => {
      const cluster = new Cluster("MyCluster", { vpc: customVpc });
      const task = new Task("MyTask", { cluster, image: "nginx:latest" });
      await pulumi.settle();

      expect(await pulumi.resolve(task.cluster)).toBe(
        "arn:aws:mock:us-east-1:123456789012:MyClusterCluster",
      );
    });

    it("gives a service the same network as the 4.x cluster does", async () => {
      const placement = async (Cluster: any, Service: any) => {
        pulumi.reset();
        const cluster = new Cluster("MyCluster", { vpc: customVpc });
        const service = new Service("MyService", {
          cluster,
          image: "nginx:latest",
        });
        await pulumi.settle();
        return {
          network: resource("MyServiceService").inputs.networkConfiguration,
          registry: resource("MyServiceCloudmapService").inputs,
          host: await pulumi.resolve(service.service),
        };
      };

      const original = await placement(OriginalCluster, OriginalService);
      expect(original.network.subnets).toEqual(customVpc.containerSubnets);
      expect(original.registry.namespaceId).toBe("ns-1");
      expect(original.host).toMatch(/^MyService\..*\.internal$/);
      expect(await placement(Cluster, Service)).toEqual(original);
    });
  });

  describe("what it creates", () => {
    it("creates the cluster and its capacity providers", async () => {
      const cluster = new Cluster("MyCluster", { vpc: customVpc });
      await pulumi.settle();

      expect(created()).toEqual([
        "MyClusterCluster",
        "MyClusterCapacityProviders",
      ]);
      expect(resource("MyClusterCluster").inputs.tags).toEqual({
        "sst:ref:version": "2.0",
      });
      expect(resource("MyClusterCapacityProviders")).toMatchObject({
        type: CAPACITY_PROVIDERS,
        inputs: {
          clusterName: resource("MyClusterCluster").inputs.name,
          capacityProviders: ["FARGATE", "FARGATE_SPOT"],
        },
      });
      expect(await pulumi.resolve(cluster.id)).toBe("MyClusterCluster_id");
      expect(cluster.nodes.cluster).toBeInstanceOf(aws.ecs.Cluster);
      expect(cluster.nodes.capacityProviders).toBeInstanceOf(
        aws.ecs.ClusterCapacityProviders,
      );
      // No version marker
      expect(pulumi.resources.map((r) => r.type)).not.toContain(
        "sst:sst:Version",
      );
    });

    it("can be read by the 4.x Cluster's get", async () => {
      new Cluster("MyCluster", { vpc: customVpc });
      new OriginalCluster("Theirs", { vpc: customVpc });
      await pulumi.settle();

      expect(resource("MyClusterCluster").inputs.tags).toEqual(
        resource("TheirsCluster").inputs.tags,
      );
    });

    it("transforms each part", async () => {
      new Cluster("MyCluster", {
        vpc: customVpc,
        transform: {
          cluster: {
            settings: [{ name: "containerInsights", value: "enabled" }],
          },
          capacityProviders: {
            defaultCapacityProviderStrategies: [
              { capacityProvider: "FARGATE_SPOT", weight: 1 },
            ],
          },
        },
      });
      await pulumi.settle();

      expect(resource("MyClusterCluster").inputs.settings).toEqual([
        { name: "containerInsights", value: "enabled" },
      ]);
      expect(resource("MyClusterCapacityProviders").inputs).toMatchObject({
        capacityProviders: ["FARGATE", "FARGATE_SPOT"],
        defaultCapacityProviderStrategies: [
          { capacityProvider: "FARGATE_SPOT", weight: 1 },
        ],
      });
    });

    // 4.x replaced the tags with the ones in the transform. V5 merges them, so
    // SST's tag comes back on switch.
    it("keeps SST's tag next to the tags of an object transform", async () => {
      const create = (Cluster: any) => () =>
        new Cluster("MyCluster", {
          vpc: customVpc,
          transform: { cluster: { tags: { team: "platform" } } },
        });

      expect(await takesOver(create(OriginalCluster), create(Cluster))).toEqual(
        {
          unclaimed: ["sst:sst:Version::MyClusterVersion"],
          changed: [["MyClusterCluster", ["tags"]]],
        },
      );
      expect(resource("MyClusterCluster").inputs.tags).toEqual({
        "sst:ref:version": "2.0",
        team: "platform",
      });
    });
  });

  describe("the VPC it's in", () => {
    it("is the Vpc it was given", async () => {
      const vpc = new Vpc("MyVpc");
      const cluster = new Cluster("MyCluster", { vpc });
      await pulumi.settle();

      expect(cluster.vpc).toBe(vpc);
    });

    it("is the ids it was given", async () => {
      const cluster = new Cluster("MyCluster", { vpc: customVpc });
      await pulumi.settle();

      expect(await pulumi.resolve(cluster.vpc)).toEqual(customVpc);
    });

    // As the 4.x one gives them to its services and tasks
    it("gives the ids as the 4.x Cluster does", async () => {
      const cluster = new Cluster("MyCluster", { vpc: output(customVpc) });
      const original = new OriginalCluster("Theirs", { vpc: customVpc });
      await pulumi.settle();

      expect(await pulumi.resolve(cluster.vpc)).toEqual(
        await pulumi.resolve(original.vpc),
      );
    });

    it("refuses the deprecated serviceSubnets, with what to write", async () => {
      const { containerSubnets, ...vpc } = customVpc;
      const ids = { ...vpc, serviceSubnets: containerSubnets } as any;
      const message = (name: string) =>
        `"vpc.serviceSubnets" isn't an option for the "${name}" cluster. It's "vpc.containerSubnets" now.`;

      // As they're given, when the cluster is created
      expect(() => new Cluster("Given", { vpc: ids })).toThrow(
        message("Given"),
      );
      // In an output, once they're known. Each promise an output keeps
      // reports the error.
      const errors = await applyErrors(
        () => new Cluster("InAnOutput", { vpc: output(ids) }),
        pulumi.settle,
      );
      expect([...new Set(errors)]).toEqual([
        expect.stringContaining(message("InAnOutput")),
      ]);
    });

    it("refuses ids it can't place the containers or the services with", async () => {
      const { containerSubnets, cloudmapNamespaceName, ...vpc } = customVpc;

      expect(() => new Cluster("NoSubnets", { vpc: vpc as any })).toThrow(
        'The "vpc" of the "NoSubnets" cluster has no "containerSubnets". Give the subnets its containers run in.',
      );
      expect(
        () =>
          new Cluster("HalfANamespace", { vpc: { ...vpc, containerSubnets } }),
      ).toThrow(
        'The "vpc" of the "HalfANamespace" cluster has one of "cloudmapNamespaceId" and "cloudmapNamespaceName". Give both, or neither.',
      );
      // Ids whose values aren't known yet are checked again once they are
      const errors = await applyErrors(
        () =>
          new Cluster("Later", {
            vpc: { ...customVpc, containerSubnets: output(undefined as any) },
          }),
        pulumi.settle,
      );
      expect([...new Set(errors)]).toEqual([
        'The "vpc" of the "Later" cluster has no "containerSubnets". Give the subnets its containers run in.',
      ]);
    });

    it("refuses another resource in place of a Vpc", async () => {
      const message = (name: string) =>
        `The "vpc" of the "${name}" cluster isn't a "Vpc" component. Pass a "Vpc", or the ids of a VPC.`;

      expect(
        () => new Cluster("InAVpcV1", { vpc: new VpcV1("Old") as any }),
      ).toThrow(message("InAVpcV1"));
      expect(
        () =>
          new Cluster("InAnEc2Vpc", {
            vpc: new aws.ec2.Vpc("Raw", {}) as any,
          }),
      ).toThrow(message("InAnEc2Vpc"));
      // What the Vpc.v1 creates, before the next test
      await pulumi.settle();
    });
  });

  describe("a cluster that's already deployed", () => {
    it("is looked up, and nothing is created", async () => {
      const cluster = new Cluster("MyCluster", {
        vpc: customVpc,
        existing: { cluster: SHARED },
      });
      await pulumi.settle();

      expect(created()).toEqual(["MyClusterCluster"]);
      expect(resource("MyClusterCluster")).toMatchObject({
        kind: "read",
        type: CLUSTER,
        parent: expect.stringContaining("sst:aws:Cluster::MyCluster"),
        options: { id: SHARED },
      });
      expect(await pulumi.resolve(cluster.id)).toBe(SHARED);
      expect(await pulumi.resolve(cluster.nodes.cluster.name)).toBe(
        "app-dev-MyCluster",
      );
      expect(await pulumi.resolve(cluster.vpc)).toMatchObject({ id: "vpc-1" });
    });

    it("is what get passes", async () => {
      const cluster = Cluster.get("MyCluster", { id: SHARED, vpc: customVpc });
      await pulumi.settle();

      expect(resource("MyClusterCluster").options.id).toBe(SHARED);
      expect(names()).not.toContain("MyClusterCapacityProviders");
      expect(await pulumi.resolve(cluster.id)).toBe(SHARED);
    });

    it("can be one SST didn't create", async () => {
      const cluster = Cluster.get("MyCluster", { id: FOREIGN, vpc: customVpc });
      new Task("MyTask", { cluster, image: "nginx:latest" });
      await pulumi.settle();

      expect(await pulumi.resolve(cluster.nodes.cluster.name)).toBe(
        "their-cluster",
      );
      expect(resource("MyTaskTaskDefinition").inputs.family).toBe(
        "their-cluster-MyTask",
      );
    });

    it("can be given as the resource", async () => {
      const theirs = new aws.ecs.Cluster("Theirs", {});
      const cluster = new Cluster("MyCluster", {
        vpc: customVpc,
        existing: { cluster: theirs },
      });
      await pulumi.settle();

      expect(cluster.nodes.cluster).toBe(theirs);
      expect(names()).not.toContain("MyClusterCluster");
      expect(names()).not.toContain("MyClusterCapacityProviders");
    });

    // The cluster keeps the capacity providers it has
    it("refuses capacity providers next to it", async () => {
      expect(
        () =>
          new Cluster("MyCluster", {
            vpc: customVpc,
            existing: { cluster: SHARED, capacityProviders: "theirs" },
          }),
      ).toThrow(
        `"existing.capacityProviders" isn't an option for the "MyCluster" cluster. The "cluster" it's given keeps the capacity providers it has.`,
      );
      await pulumi.settle();
    });
  });

  describe("what it's given", () => {
    it("points addService and addTask at the components", async () => {
      const cluster = new Cluster("MyCluster", { vpc: customVpc });
      await pulumi.settle();

      expect(() => (cluster as any).addService("MyService", {})).toThrow(
        'new sst.aws.Service("MyService", { cluster, ...args })',
      );
      expect(() => (cluster as any).addTask("MyTask", {})).toThrow(
        'new sst.aws.Task("MyTask", { cluster, ...args })',
      );
    });

    // It upgraded a cluster from `Cluster.v1`, which has no V5 form
    it("ignores a forceUpgrade left in", async () => {
      const create = (args: object) => () =>
        new Cluster("MyCluster", { vpc: customVpc, ...args });

      expect(
        await takesOver(create({}), create({ forceUpgrade: "v2" })),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    it("refuses a part it doesn't have", () => {
      expect(
        () =>
          new Cluster("MyCluster", {
            vpc: customVpc,
            transform: { service: {} } as any,
          }),
      ).toThrow(/cluster, capacityProviders/);
    });
  });
});
