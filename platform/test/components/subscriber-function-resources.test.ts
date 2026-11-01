import { describe, beforeAll, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subscriber-function-"));
const out = path.join(root, "out");
fs.mkdirSync(out);
fs.writeFileSync(
  path.join(out, "index.mjs"),
  "export const handler = async () => 1;\n",
);

vi.mock("../../src/components/aws/helpers/bootstrap", () => ({
  bootstrap: {
    forRegion: async () => ({ asset: "sst-asset-test" }),
  },
}));

vi.mock("../../src/components/rpc/rpc", () => ({
  rpc: {
    call: async (method: string) => {
      if (method === "Runtime.Build")
        return { handler: "index.handler", out, errors: [], sourcemaps: [] };
      return {};
    },
  },
}));

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$cli = {
  paths: { root, work: path.join(root, ".sst"), platform: root },
  state: { version: {} },
};

interface Registered {
  type: string;
  name: string;
  inputs: any;
}

let registered: Registered[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      registered.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: `${args.name}_id`,
        state: { ...args.inputs, arn: `arn:aws:test:::${args.name}` },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity")
        return { accountId: "111111111111" };
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: "aws" };
      if (args.token === "aws:index/getRegion:getRegion")
        return { name: "us-east-1", region: "us-east-1" };
      if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument")
        return { ...args.inputs, json: "{}" };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

// Waits until no resource has been registered for 250 ms.
async function settle() {
  let count = -1;
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = registered.length === count ? quiet + 1 : 0;
    count = registered.length;
  }
}

// A subscriber's function is renamed from `<name>Function` to `<name>`, with an
// alias to the old name on the Function component. Pulumi gives a child the
// parent's aliases only when the child's name starts with the parent's name, so
// the role, log group, Lambda and code object that Function creates must keep
// being named after the Function, and the log group must not double `Function`.
describe("subscriber function resources", function () {
  const names: [string, string][] = [
    ["Queue", "QueueSub"],
    ["SnsTopic", "TopicSub"],
    ["Bus", "BusSub"],
    ["Bucket", "BucketSub"],
    ["Dynamo", "DynamoSub"],
    ["KinesisStream", "StreamSub"],
  ];
  let make: Record<string, (name: string) => unknown>;

  beforeAll(async function () {
    const aws = "./../../src/components/aws";
    const { QueueLambdaSubscriber } = await import(
      `${aws}/queue-lambda-subscriber`
    );
    const { SnsTopicLambdaSubscriber } = await import(
      `${aws}/sns-topic-lambda-subscriber`
    );
    const { BusLambdaSubscriber } = await import(
      `${aws}/bus-lambda-subscriber`
    );
    const { BucketLambdaSubscriber } = await import(
      `${aws}/bucket-lambda-subscriber`
    );
    const { DynamoLambdaSubscriber } = await import(
      `${aws}/dynamo-lambda-subscriber`
    );
    const { KinesisStreamLambdaSubscriber } = await import(
      `${aws}/kinesis-stream-lambda-subscriber`
    );
    const subscriber = { handler: "src/handler.main" };
    make = {
      Queue: (n) =>
        new QueueLambdaSubscriber(n, {
          queue: { arn: "arn:q" },
          subscriber,
        } as any),
      SnsTopic: (n) =>
        new SnsTopicLambdaSubscriber(n, {
          topic: { arn: "arn:t" },
          subscriber,
        } as any),
      Bus: (n) =>
        new BusLambdaSubscriber(n, {
          bus: { name: "bus", arn: "arn:b" },
          subscriber,
        } as any),
      Bucket: (n) =>
        new BucketLambdaSubscriber(n, {
          bucket: { name: "bucket", arn: "arn:bk" },
          subscriberId: "x",
          subscriber,
        } as any),
      Dynamo: (n) =>
        new DynamoLambdaSubscriber(n, {
          dynamo: { streamArn: "arn:d" },
          subscriber,
        } as any),
      KinesisStream: (n) =>
        new KinesisStreamLambdaSubscriber(n, {
          stream: { arn: "arn:k" },
          subscriber,
        } as any),
    };
  });

  beforeEach(function () {
    registered = [];
  });

  for (const [kind, name] of names) {
    it(`${kind}: the Function and its resources are named after the subscriber, and the log group has one Function`, async () => {
      make[kind](name);
      await settle();

      const fn = registered.filter((r) => r.type === "sst:aws:Function");
      expect(fn.map((r) => r.name)).toEqual([name]);

      const byType = (type: string) =>
        registered.filter((r) => r.type === type).map((r) => r.name);
      expect(byType("aws:iam/role:Role")).toEqual([`${name}Role`]);
      expect(byType("aws:cloudwatch/logGroup:LogGroup")).toEqual([
        `${name}LogGroup`,
      ]);
      expect(byType("aws:lambda/function:Function")).toEqual([
        `${name}Function`,
      ]);
      expect(byType("aws:s3/bucketObjectv2:BucketObjectv2")).toEqual([
        `${name}Code`,
      ]);

      const logGroup = registered.find(
        (r) => r.type === "aws:cloudwatch/logGroup:LogGroup",
      )!;
      expect(logGroup.inputs.name).toContain(`${name}Function`);
      expect(logGroup.inputs.name).not.toContain("FunctionFunction");
    });
  }
});
