import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

const CLUSTER = "aws:elasticache/replicationGroup:ReplicationGroup";

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
      : {},
  call: (args) =>
    args.token === "aws:secretsmanager/getSecretVersion:getSecretVersion"
      ? { secretString: JSON.stringify({ authToken: "stored-token" }) }
      : undefined,
});

const vpc = { subnets: ["subnet-1", "subnet-2"], securityGroups: ["sg-1"] };

type RedisClass =
  | typeof import("../../../src/components/aws/redis").Redis
  | typeof import("../../../src/components/aws/v5/redis").Redis;

describe("Redis", () => {
  let OriginalRedis: typeof import("../../../src/components/aws/redis").Redis;
  let Redis: typeof import("../../../src/components/aws/v5/redis").Redis;

  beforeAll(async () => {
    OriginalRedis = (await import("../../../src/components/aws/redis")).Redis;
    Redis = (await import("../../../src/components/aws/v5/redis")).Redis;
    await import("../../../src/components/aws/takeover/redis");
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
        "nodes without cluster": (Redis, opts) => {
          new Redis("MyRedis", { vpc, nodes: 2 }, opts);
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
        "dev args outside of sst dev": (Redis, opts) => {
          new Redis(
            "MyRedis",
            { vpc, dev: { host: "localhost", port: 6380 } },
            opts,
          );
        },
        "a cluster referenced with get": (Redis, opts) => {
          Redis.get("MyRedis", "app-dev-myredis", opts);
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
    it("creates nothing but the dev command when dev is set", async () => {
      // @ts-ignore
      global.$dev = true;
      const redis = new Redis("MyRedis", {
        vpc,
        dev: { host: "127.0.0.1", port: 6380, password: "local" },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type).sort()).toEqual([
        "sst:aws:Redis",
        "sst:sst:DevCommand",
      ]);
      expect(
        await pulumi.resolve([redis.host, redis.port, redis.username, redis.password]),
      ).toEqual(["127.0.0.1", 6380, "default", "local"]);
      expect(await pulumi.resolve(redis.clusterId)).toBe("placeholder");
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

    it("deploys the cluster when dev isn't set", async () => {
      // @ts-ignore
      global.$dev = true;
      new Redis("MyRedis", { vpc });
      await pulumi.settle();

      expect(pulumi.resources.some((r) => r.type === CLUSTER)).toBe(true);
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
    ]);
    expect(redis.nodes.secret.constructor.name).toBe("Secret");
    expect(redis.nodes.cluster.constructor.name).toBe("ReplicationGroup");
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
});
