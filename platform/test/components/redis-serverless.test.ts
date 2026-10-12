import { describe, beforeAll, beforeEach, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = { name: "app", stage: "test" };
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$cli = { state: { version: {} } };
global.$util = pulumi;

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: args.name + "_id",
        state: {
          ...args.inputs,
          endpoints: [{ address: "cache.example.com", port: 6379 }],
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

async function settle() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const vpc = { subnets: ["subnet-a", "subnet-b"], securityGroups: ["sg-a"] };

function ofType(type: string) {
  return createdResources.filter((r) => r.type === type);
}

describe("Redis serverless", function () {
  let Redis: typeof import("../../src/components/aws/redis").Redis;

  beforeAll(async function () {
    Redis = (await import("../../src/components/aws/redis")).Redis;
  });

  beforeEach(function () {
    createdResources = [];
  });

  it("creates a provisioned cluster and no serverless cache by default", async () => {
    new Redis("Plain", { vpc });
    await settle();
    expect(ofType("aws:elasticache/replicationGroup:ReplicationGroup")).toHaveLength(1);
    expect(ofType("aws:elasticache/serverlessCache:ServerlessCache")).toHaveLength(0);
  });

  it("creates a provisioned cluster when serverless is false", async () => {
    new Redis("Off", { vpc, serverless: false });
    await settle();
    expect(ofType("aws:elasticache/replicationGroup:ReplicationGroup")).toHaveLength(1);
    expect(ofType("aws:elasticache/serverlessCache:ServerlessCache")).toHaveLength(0);
  });

  it("uses the default limits with serverless: true", async () => {
    const redis = new Redis("Defaults", { vpc, serverless: true });
    await settle();
    expect(ofType("aws:elasticache/replicationGroup:ReplicationGroup")).toHaveLength(0);
    const [cache] = ofType("aws:elasticache/serverlessCache:ServerlessCache");
    expect(cache.inputs.cacheUsageLimits.dataStorage).toMatchObject({
      maximum: 10,
      unit: "GB",
    });
    expect(cache.inputs.cacheUsageLimits.ecpuPerSeconds[0].maximum).toBe(5000);
    expect(cache.inputs.majorEngineVersion).toBe("7");
    expect(cache.inputs.securityGroupIds).toEqual(["sg-a"]);
    expect(cache.inputs.subnetIds).toEqual(["subnet-a", "subnet-b"]);
    expect(redis.password).toBeUndefined();
  });

  it("passes minimum and maximum limits through", async () => {
    new Redis("Limits", {
      vpc,
      serverless: {
        storage: { minimum: "1 GB", maximum: "20 GB" },
        ecpuPerSecond: { minimum: 1000, maximum: 6000 },
      },
    });
    await settle();
    const [cache] = ofType("aws:elasticache/serverlessCache:ServerlessCache");
    expect(cache.inputs.cacheUsageLimits.dataStorage).toMatchObject({
      minimum: 1,
      maximum: 20,
    });
    expect(cache.inputs.cacheUsageLimits.ecpuPerSeconds[0]).toMatchObject({
      minimum: 1000,
      maximum: 6000,
    });
  });

  it("links host, port and username, but no password", async () => {
    const redis = new Redis("Link", { vpc, serverless: true });
    await settle();
    const properties = (redis.getSSTLink() as any).properties;
    expect(Object.keys(properties).sort()).toEqual(["host", "port", "username"]);
  });

  it("throws for the node of the other mode", async () => {
    const serverless = new Redis("A", { vpc, serverless: true });
    const plain = new Redis("B", { vpc });
    await settle();
    expect(() => serverless.nodes.cluster).toThrow(/serverless/);
    expect(() => plain.nodes.serverlessCache).toThrow(/not set/);
  });
});
