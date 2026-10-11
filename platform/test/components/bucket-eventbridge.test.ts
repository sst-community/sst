import { describe, beforeAll, beforeEach, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
// @ts-ignore
global.$dev = false;
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
          arn: `arn:aws:mock:us-east-1:TESTACCOUNT:${args.name}`,
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      if (args.token === "aws:index/getRegion:getRegion")
        return { name: "us-east-1", region: "us-east-1" };
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: "aws" };
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity")
        return { accountId: "TESTACCOUNT" };
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

function notificationsOf() {
  return createdResources.filter(
    (r) => r.type === "aws:s3/bucketNotification:BucketNotification",
  );
}

describe("Bucket EventBridge notifications", function () {
  let Bucket: typeof import("./../../src/components/aws/bucket").Bucket;

  beforeAll(async function () {
    Bucket = (await import("./../../src/components/aws/bucket")).Bucket;
  });

  beforeEach(function () {
    createdResources = [];
  });

  it("turns on EventBridge with no other notification", async () => {
    const bucket = new Bucket("Files");
    bucket.notify({ eventBridge: true });
    await settle();

    const [notification] = notificationsOf();
    expect(notification).toBeDefined();
    expect(notification.inputs.eventbridge).toBe(true);
    expect(notification.inputs.lambdaFunctions ?? []).toEqual([]);
    expect(notification.inputs.queues ?? []).toEqual([]);
    expect(notification.inputs.topics ?? []).toEqual([]);
  });

  it("leaves EventBridge off when it is not asked for", async () => {
    const bucket = new Bucket("Plain");
    bucket.notify({ notifications: [] });
    await settle();

    const [notification] = notificationsOf();
    expect(notification.inputs.eventbridge).toBeFalsy();
  });

  it("asks for either notifications or EventBridge", () => {
    const bucket = new Bucket("Empty");
    expect(() => bucket.notify({})).toThrow(
      /without notifications or EventBridge enabled/,
    );
  });

  it("still refuses a second call to notify", () => {
    const bucket = new Bucket("Twice");
    bucket.notify({ eventBridge: true });
    expect(() => bucket.notify({ eventBridge: true })).toThrow(
      /multiple times/,
    );
  });
});
