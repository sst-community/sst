import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi, sidedClass } from "../../helpers/graph";

const CLUSTER = "aws:elasticache/replicationGroup:ReplicationGroup";
const SERVERLESS = "aws:elasticache/serverlessCache:ServerlessCache";

const pulumi = mockPulumi({
  state: (args) =>
    args.type === CLUSTER
      ? {
          clusterEnabled: false,
          primaryEndpointAddress: "primary.cache.example.com",
          port: 6379,
          tagsAll: {
            "sst:component-version": "2",
            "sst:ref:secret": "secret-id",
          },
        }
      : args.type === SERVERLESS
        ? { endpoints: [{ address: "serverless.cache.example.com", port: 6379 }] }
        : {},
  call: (args) => {
    switch (args.token) {
      // The token in the secret a cluster is tagged with, or in another
      case "aws:secretsmanager/getSecretVersion:getSecretVersion":
        return {
          secretString: JSON.stringify({
            authToken:
              args.inputs.secretId === "secret-id"
                ? "stored-token"
                : `the token in ${args.inputs.secretId}`,
          }),
        };
      // For a `Vpc`
      case "aws:index/getAvailabilityZones:getAvailabilityZones":
        return { names: ["us-east-1a", "us-east-1b"] };
    }
    return undefined;
  },
});

const vpc = { subnets: ["subnet-1", "subnet-2"], securityGroups: ["sg-1"] };

type RedisClass =
  | typeof import("../../fixtures/v4/components/aws/redis").Redis
  | typeof import("../../../src/components/aws/redis").Redis;

describe("Redis", () => {
  let OriginalRedis: typeof import("../../fixtures/v4/components/aws/redis").Redis;
  let Redis: typeof import("../../../src/components/aws/redis").Redis;
  let OriginalVpc: typeof import("../../fixtures/v4/components/aws/vpc").Vpc;
  let SidedVpc: any;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;

  beforeAll(async () => {
    OriginalRedis = (await import("../../fixtures/v4/components/aws/redis")).Redis;
    Redis = (await import("../../../src/components/aws/redis")).Redis;
    OriginalVpc = (await import("../../fixtures/v4/components/aws/vpc")).Vpc;
    // SST 4's for SST 4's side, SST 5's for SST 5's
    SidedVpc = await sidedClass(
      "Vpc",
      import("../../fixtures/v4/components/aws/vpc"),
      import("../../../src/components/aws/vpc"),
      import("../../../src/components/aws/takeover/vpc"),
    );
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    await import("../../../src/components/aws/takeover/redis");
    await import("../../../src/components/aws/takeover/vpc");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  // Each case deploys the 4.x Redis, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs. The one thing that goes is the version marker the 4.x Redis writes,
  // which has nothing in AWS behind it.
  describe("takes over a deployed Redis", () => {
    pulumi.takeoverCases({
      original: () => OriginalRedis,
      v5: () => Redis,
      unclaimed: ["sst:sst:Version::MyRedisVersion"],
      cases: {
        "default cluster": (Redis, opts) => {
          new Redis("MyRedis", { vpc }, opts);
        },
        "valkey without cluster mode": (Redis, opts) => {
          new Redis(
            "MyRedis",
            {
              vpc,
              engine: "valkey",
              version: "8.0",
              instance: "r6gd.large",
              cluster: false,
              parameters: { "maxmemory-policy": "noeviction" },
            },
            opts,
          );
        },
        "cluster mode with three nodes": (Redis, opts) => {
          new Redis("MyRedis", { vpc, cluster: { nodes: 3 } }, opts);
        },
        // The V5 one takes the number of nodes as `cluster.nodes` alone
        "nodes without cluster": {
          original: (opts) =>
            new OriginalRedis("MyRedis", { vpc, nodes: 2 }, opts),
          v5: (opts) =>
            new Redis("MyRedis", { vpc, cluster: { nodes: 2 } }, opts),
        },
        transforms: (Redis, opts) => {
          new Redis(
            "MyRedis",
            {
              vpc,
              transform: {
                subnetGroup: { description: "custom" },
                parameterGroup: (args) => {
                  args.description = "tuned";
                },
                cluster: (args, opts) => {
                  args.snapshotRetentionLimit = 7;
                  opts.protect = true;
                },
              },
            },
            opts,
          );
        },
        // The 4.x Redis created a component for the pane `sst dev` shows in
        // every deploy. The V5 one reports the pane in `sst dev` alone.
        "dev args outside of sst dev": {
          create: (Redis, opts) => {
            new Redis(
              "MyRedis",
              { vpc, dev: { host: "localhost", port: 6380 } },
              opts,
            );
          },
          unclaimed: [
            "sst:sst:DevCommand::MyRedisDev",
            "sst:sst:Version::MyRedisVersion",
          ],
          check: () => expect(pulumi.reportOf("MyRedis")).toBeUndefined(),
        },
        "dev args in sst dev": {
          create: (Redis, opts) => {
            // @ts-ignore
            global.$dev = true;
            new Redis(
              "MyRedis",
              { vpc, dev: { host: "localhost", port: 6380 } },
              opts,
            );
          },
          unclaimed: [
            "sst:sst:DevCommand::MyRedisDev",
            "sst:sst:Version::MyRedisVersion",
          ],
          // The component itself reports the pane, in its outputs
          changed: [["MyRedis", ["outputs"]]],
          check: () => expect(pulumi.reportOf("MyRedis")).toHaveProperty("dev"),
        },
        // The 4.x Redis read the VPC's subnets and security groups as one
        // output, so its subnet group waited for the security group. A subnet
        // group has nothing to do with it; the cluster still does.
        "in a Vpc": {
          create: (Redis, opts) => {
            new Redis("MyRedis", { vpc: new SidedVpc("MyVpc") }, opts);
          },
          unordered: ["MyRedisSubnetGroup before MyVpcSecurityGroup"],
        },
        "in a Vpc switched with it": {
          original: (opts) =>
            new OriginalRedis(
              "MyRedis",
              { vpc: new OriginalVpc("MyVpc") },
              opts,
            ),
          v5: (opts) => new Redis("MyRedis", { vpc: new Vpc("MyVpc") }, opts),
          // Both version markers, with nothing in AWS behind them
          unclaimed: [
            "sst:sst:Version::MyRedisVersion",
            "sst:sst:Version::MyVpcVersion",
          ],
          unordered: ["MyRedisSubnetGroup before MyVpcSecurityGroup"],
        },
        "a cluster referenced with get": (Redis, opts) => {
          Redis.get("MyRedis", "app-dev-myredis", opts);
        },
        serverless: (Redis, opts) => {
          new Redis("MyRedis", { vpc, serverless: true }, opts);
        },
        "serverless valkey with limits": (Redis, opts) => {
          new Redis(
            "MyRedis",
            {
              vpc,
              engine: "valkey",
              version: "8.0",
              serverless: {
                storage: { minimum: "2 GB", maximum: "100 GB" },
                ecpuPerSecond: { minimum: 1000, maximum: 50000 },
              },
            },
            opts,
          );
        },
        "serverless without a password": (Redis, opts) => {
          new Redis("MyRedis", { vpc, serverless: { password: false } }, opts);
        },
        "serverless with a transform": (Redis, opts) => {
          new Redis(
            "MyRedis",
            {
              vpc,
              serverless: true,
              transform: { serverlessCache: { description: "custom" } },
            },
            opts,
          );
        },
      },
    });

    it("keeps the secret under its new name", async () => {
      new OriginalRedis("MyRedis", { vpc });
      await pulumi.settle();
      const original = pulumi.graph();
      expect(original.map((r) => r.name)).toContain("MyRedisProxySecret");

      pulumi.reset();
      new Redis("MyRedis", { vpc });
      await pulumi.settle();
      expect(pulumi.resources.map((r) => r.name)).toContain("MyRedisSecret");
      expect(pulumi.takeover(original).unclaimed).not.toContain(
        "aws:secretsmanager/secret:Secret::MyRedisProxySecret",
      );
    });
  });

  describe("in sst dev", () => {
    it("creates nothing and reports a pane when dev is set", async () => {
      // @ts-ignore
      global.$dev = true;
      const redis = new Redis("MyRedis", {
        vpc,
        dev: { host: "127.0.0.1", port: 6380, password: "local" },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Redis"]);
      expect(
        await pulumi.resolve([redis.host, redis.port, redis.username, redis.password]),
      ).toEqual(["127.0.0.1", 6380, "default", "local"]);
      expect(await pulumi.resolve(redis.clusterId)).toBe("placeholder");
      // The pane `sst dev` shows, titled with the component's name
      expect(pulumi.reportOf("MyRedis")).toEqual({
        contract: 1,
        dev: {
          command: "sst print-and-not-quit",
          autostart: true,
          links: [],
          environment: {
            SST_DEV_COMMAND_MESSAGE: [
              "Make sure your local Redis server is using:",
              "",
              '  username: "default"',
              '  password: "local"',
              "",
              'Listening on "127.0.0.1:6380"...',
            ].join("\n"),
          },
        },
      });
    });

    it.each([
      ["none", {}],
      ["an empty one", { password: "" }],
    ])("says there's no password in its pane, given %s", async (_, given) => {
      // @ts-ignore
      global.$dev = true;
      const redis = new Redis("MyRedis", { vpc, dev: given });
      await pulumi.settle();

      expect(
        pulumi.reportOf("MyRedis")?.dev.environment.SST_DEV_COMMAND_MESSAGE,
      ).toContain("[no password]");
      // Linked resources get an empty one, as with `sst.aws.Redis`
      expect(await pulumi.resolve(redis.password)).toBe("");
    });

    // An output that resolves to nothing is as good as leaving it out
    it("falls back for dev values that are outputs of nothing", async () => {
      const { output } = await import("@pulumi/pulumi");
      // @ts-ignore
      global.$dev = true;
      const redis = new Redis("MyRedis", {
        vpc,
        dev: {
          host: output(undefined as unknown as string),
          port: output(undefined as unknown as number),
        },
      });
      await pulumi.settle();

      expect(await pulumi.resolve([redis.host, redis.port])).toEqual([
        "localhost",
        6379,
      ]);
    });

    it("needs dev as a plain value", () => {
      const { output } = require("@pulumi/pulumi");
      expect(
        () => new Redis("MyRedis", { vpc, dev: output({}) as any }),
      ).toThrow(
        /The "dev" of the "MyRedis" Redis cluster has to be a plain value/,
      );
    });

    it("explains why nodes are missing", async () => {
      // @ts-ignore
      global.$dev = true;
      const redis = new Redis("MyRedis", { vpc, dev: {} });
      await pulumi.settle();

      expect(() => redis.nodes.cluster).toThrow(
        /Cannot access `nodes.cluster` of "MyRedis" in `sst dev`/,
      );
    });

    // `dev` says what `sst dev` connects to, whatever a deploy does
    it("connects to the local server in place of an existing cluster", async () => {
      // @ts-ignore
      global.$dev = true;
      const redis = new Redis("MyRedis", {
        vpc,
        existing: { cluster: "app-dev-myredis" },
        dev: { port: 6380 },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Redis"]);
      expect(await pulumi.resolve([redis.host, redis.port])).toEqual([
        "localhost",
        6380,
      ]);
    });

    it("deploys the cluster when dev isn't set", async () => {
      // @ts-ignore
      global.$dev = true;
      new Redis("MyRedis", { vpc });
      await pulumi.settle();

      expect(pulumi.resources.some((r) => r.type === CLUSTER)).toBe(true);
    });
  });

  describe("turns down the number of nodes given as nodes", () => {
    it("with what to write in its place", () => {
      expect(() => new Redis("MyRedis", { vpc, nodes: 2 } as any)).toThrow(
        `The "nodes" of the "MyRedis" Redis cluster is "cluster.nodes" now. Pass the same number as "cluster: { nodes }"; nothing in AWS changes.`,
      );
    });

    // `sst.aws.Redis` read it only when neither was set, and a 0 not at all:
    // moving it to `cluster.nodes` would change the cluster
    it.each([
      ["cluster: true", { cluster: true }],
      ["cluster: false", { cluster: false }],
      ["cluster.nodes", { cluster: { nodes: 2 } }],
      ["serverless", { serverless: true }],
      ["nodes: 0", { nodes: 0 }],
    ])("to be removed, with %s", (_, given) => {
      expect(
        () => new Redis("MyRedis", { vpc, nodes: 3, ...given } as any),
      ).toThrow(
        `The "nodes" of the "MyRedis" Redis cluster is gone, and sst.aws.Redis ignored it here. Remove it; nothing in AWS changes.`,
      );
    });
  });

  describe("in a Vpc", () => {
    it("is in the private subnets of a Vpc", async () => {
      const { Vpc } = await import("../../../src/components/aws/vpc");
      for (const [i, VpcClass] of [Vpc].entries()) {
        pulumi.reset();
        const net = new VpcClass(`Net${i}`);
        new Redis("MyRedis", { vpc: net });
        await pulumi.settle();

        const group = pulumi.resources.find(
          (r) => r.name === "MyRedisSubnetGroup",
        )!;
        expect(group.inputs.subnetIds).toEqual(
          await pulumi.resolve(net.privateSubnets),
        );
        const cluster = pulumi.resources.find((r) => r.type === CLUSTER)!;
        expect(cluster.inputs.securityGroupIds).toEqual(
          await pulumi.resolve(net.securityGroups),
        );
      }
    });

    it("turns down another resource in its place", async () => {
      const aws = await import("@pulumi/aws");
      const net = new aws.ec2.Vpc("Net", { cidrBlock: "10.0.0.0/16" });
      expect(() => new Redis("MyRedis", { vpc: net as any })).toThrow(
        /The "vpc" of the "MyRedis" Redis cluster isn't a "Vpc" component/,
      );
      await pulumi.settle();
    });
  });

  it("exposes every resource on nodes", async () => {
    const redis = new Redis("MyRedis", { vpc });
    await pulumi.settle();

    expect(Object.keys(redis.nodes)).toEqual([
      "authToken",
      "secret",
      "secretVersion",
      "subnetGroup",
      "parameterGroup",
      "cluster",
      "serverlessCache",
      "user",
      "userGroup",
    ]);
    expect(redis.nodes.secret?.constructor.name).toBe("Secret");
    expect(redis.nodes.cluster?.constructor.name).toBe("ReplicationGroup");
  });

  it("gives a transform function plain values from a plain config, as SST 4 did", async () => {
    let seen: any;
    new Redis("MyRedis", {
      vpc,
      cluster: { nodes: 2 },
      instance: "r6gd.xlarge",
      transform: {
        cluster: (args) => {
          seen = {
            clusterMode: args.clusterMode,
            numNodeGroups: args.numNodeGroups,
            replicasPerNodeGroup: args.replicasPerNodeGroup,
            automaticFailoverEnabled: args.automaticFailoverEnabled,
            nodeType: args.nodeType,
            dataTieringEnabled: args.dataTieringEnabled,
            engineVersion: args.engineVersion,
          };
        },
      },
    });
    await pulumi.settle();

    expect(seen).toEqual({
      clusterMode: "enabled",
      numNodeGroups: 2,
      replicasPerNodeGroup: 0,
      automaticFailoverEnabled: true,
      nodeType: "cache.r6gd.xlarge",
      dataTieringEnabled: true,
      engineVersion: "7.1",
    });
  });

  it("lets the secret be transformed, which Redis doesn't", async () => {
    new Redis("MyRedis", {
      vpc,
      transform: { secret: { description: "Redis auth token" } },
    });
    await pulumi.settle();

    const secret = pulumi.resources.find((r) => r.name === "MyRedisSecret")!;
    expect(secret.inputs.description).toBe("Redis auth token");
    expect(secret.inputs.recoveryWindowInDays).toBe(0);
  });

  it("connects to a referenced cluster with its stored auth token", async () => {
    const redis = Redis.get("MyRedis", "app-dev-myredis");
    await pulumi.settle();

    expect(
      await pulumi.resolve([redis.host, redis.port, redis.username, redis.password]),
    ).toEqual(["primary.cache.example.com", 6379, "default", "stored-token"]);
  });

  it("reads the auth token from the secret it's given", async () => {
    const redis = new Redis("MyRedis", {
      vpc,
      existing: { cluster: "app-dev-myredis", secret: "my-secret" },
    });
    await pulumi.settle();

    expect(
      pulumi.resources.find((r) => r.name === "MyRedisSecret"),
    ).toMatchObject({ kind: "read", options: { id: "my-secret" } });
    expect(await pulumi.resolve(redis.password)).toBe(
      "the token in my-secret",
    );
  });

  it("turns down what it would create next to a cluster it's given", () => {
    for (const part of ["subnetGroup", "parameterGroup", "secretVersion"])
      expect(
        () =>
          new Redis("MyRedis", {
            vpc,
            existing: { cluster: "app-dev-myredis", [part]: "x" },
          }),
      ).toThrow(
        `"existing.${part}" isn't an option for the "MyRedis" Redis cluster. It's given an existing "cluster", which it uses the way it is, so it creates nothing this would stand in for. Remove it.`,
      );
  });

  it("links with the connection details", async () => {
    const { Link } = await import("../../../src/components/link");
    const redis = new Redis("MyRedis", { vpc });
    await pulumi.settle();

    expect(Link.isLinkable(redis)).toBe(true);
    expect(Object.keys((redis as any).getSSTLink().properties)).toEqual([
      "host",
      "port",
      "username",
      "password",
    ]);
  });

  describe("serverless", () => {
    it("creates a cache with a password in place of the cluster", async () => {
      const redis = new Redis("MyRedis", { vpc, serverless: true });
      await pulumi.settle();

      expect(redis.nodes.cluster).toBeUndefined();
      expect(redis.nodes.subnetGroup).toBeUndefined();
      expect(redis.nodes.serverlessCache?.constructor.name).toBe("ServerlessCache");
      expect(redis.nodes.user?.constructor.name).toBe("User");
      const cache = pulumi.resources.find((r) => r.type === SERVERLESS)!;
      expect(cache.inputs.majorEngineVersion).toBe("7");
      expect(cache.inputs.cacheUsageLimits).toEqual({
        dataStorage: { maximum: 10, unit: "GB" },
        ecpuPerSeconds: [{ maximum: 5000 }],
      });
      expect(
        await pulumi.resolve([redis.host, redis.port, redis.username]),
      ).toEqual(["serverless.cache.example.com", 6379, "default"]);
      expect(Object.keys((redis as any).getSSTLink().properties)).toEqual([
        "host",
        "port",
        "username",
        "password",
      ]);
    });

    it("links no password with password: false", async () => {
      const redis = new Redis("MyRedis", {
        vpc,
        serverless: { password: false },
      });
      await pulumi.settle();

      expect(redis.password).toBeUndefined();
      expect(redis.nodes.authToken).toBeUndefined();
      expect(redis.nodes.userGroup).toBeUndefined();
      const cache = pulumi.resources.find((r) => r.type === SERVERLESS)!;
      expect(cache.inputs.userGroupId).toBeUndefined();
      expect(Object.keys((redis as any).getSSTLink().properties)).toEqual([
        "host",
        "port",
        "username",
      ]);
    });

    it("takes limits that are outputs, in whole GB", async () => {
      const { output } = await import("@pulumi/pulumi");
      new Redis("MyRedis", {
        vpc,
        serverless: {
          storage: output({ maximum: output("20.5 GB" as const) }),
          ecpuPerSecond: { maximum: output(8000) },
        },
      });
      await pulumi.settle();

      const cache = pulumi.resources.find((r) => r.type === SERVERLESS)!;
      expect(cache.inputs.cacheUsageLimits).toEqual({
        dataStorage: { maximum: 21, unit: "GB" },
        ecpuPerSeconds: [{ maximum: 8000 }],
      });
    });

    it("needs serverless as a plain value", () => {
      const { output } = require("@pulumi/pulumi");
      expect(
        () => new Redis("MyRedis", { vpc, serverless: output(true) as any }),
      ).toThrow(
        /The "serverless" of the "MyRedis" Redis cluster has to be a plain value/,
      );
      expect(
        () =>
          new Redis("MyRedis", {
            vpc,
            serverless: { password: output(false) as any },
          }),
      ).toThrow(
        /The "serverless.password" of the "MyRedis" Redis cluster has to be a plain value/,
      );
    });

    // Its password is set through the user and user group SST creates, and
    // it can't be read from one SST didn't
    it("turns down a cache, a user or a user group that's already there", () => {
      expect(
        () =>
          new Redis("MyRedis", {
            vpc,
            serverless: true,
            existing: { serverlessCache: "my-cache" },
          }),
      ).toThrow(
        `"existing.serverlessCache" isn't an option for the "MyRedis" Redis cluster. SST can't find the password of a serverless cache it didn't create. Link it with an "sst.Linkable" that has its endpoint and password.`,
      );
      for (const part of ["user", "userGroup"])
        expect(
          () =>
            new Redis("MyRedis", {
              vpc,
              serverless: true,
              existing: { [part]: "mine" },
            }),
        ).toThrow(
          `"existing.${part}" isn't an option for the "MyRedis" Redis cluster. A serverless cache's password is set through the "user" and the "userGroup" it creates. To set up its users yourself, set "serverless.password" to false and change the cache in "transform.serverlessCache".`,
        );
    });
  });
});
