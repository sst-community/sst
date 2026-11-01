import { describe, beforeAll, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = { name: "app", stage: "test" };
// @ts-ignore
global.$dev = false;
global.$util = pulumi;

// What each subscriber asks functionBuilder for: the name of the function it
// creates, and the options it creates it with.
const calls = vi.hoisted(
  () => [] as { name: string; opts: { parent?: unknown; aliases?: unknown } }[],
);

vi.mock("../../src/components/aws/helpers/function-builder", () => ({
  functionBuilder: (
    name: string,
    _definition: unknown,
    _defaults: unknown,
    _transform: unknown,
    opts: { parent?: unknown; aliases?: unknown },
  ) => {
    calls.push({ name, opts });
    return pulumi.output({
      arn: "arn:aws:lambda:us-east-1:TESTACCOUNT:function:fn",
      targetArn: "arn:aws:lambda:us-east-1:TESTACCOUNT:function:fn:$LATEST",
      qualifier: "$LATEST",
      getFunction: () => ({}),
    });
  },
}));

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
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

// A subscriber's function used to be named `<name>Function`, and the Function
// component adds `Function` to its own name for the log group, so the log group
// was named `...FunctionFunction-...` and lost 8 characters of the app prefix. The
// subscriber passes its own name now, and an alias to the old name, so a stage
// that is already deployed keeps its function.
describe("subscriber function names", () => {
  const subscribers: [string, string, () => Promise<unknown>][] = [];

  beforeAll(async () => {
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
    const subscriber = "src/handler.main";
    subscribers.push(
      [
        "Queue",
        "QueueSub",
        async () =>
          new QueueLambdaSubscriber("QueueSub", {
            queue: { arn: "arn:q" },
            subscriber,
          } as any),
      ],
      [
        "SnsTopic",
        "TopicSub",
        async () =>
          new SnsTopicLambdaSubscriber("TopicSub", {
            topic: { arn: "arn:t" },
            subscriber,
          } as any),
      ],
      [
        "Bus",
        "BusSub",
        async () =>
          new BusLambdaSubscriber("BusSub", {
            bus: { name: "bus", arn: "arn:b" },
            subscriber,
          } as any),
      ],
      [
        "Bucket",
        "BucketSub",
        async () =>
          new BucketLambdaSubscriber("BucketSub", {
            bucket: { name: "bucket", arn: "arn:bk" },
            subscriberId: "x",
            subscriber,
          } as any),
      ],
      [
        "Dynamo",
        "DynamoSub",
        async () =>
          new DynamoLambdaSubscriber("DynamoSub", {
            dynamo: { streamArn: "arn:d" },
            subscriber,
          } as any),
      ],
      [
        "KinesisStream",
        "StreamSub",
        async () =>
          new KinesisStreamLambdaSubscriber("StreamSub", {
            stream: { arn: "arn:k" },
            subscriber,
          } as any),
      ],
    );
  });

  beforeEach(() => {
    calls.length = 0;
  });

  for (const kind of [
    "Queue",
    "SnsTopic",
    "Bus",
    "Bucket",
    "Dynamo",
    "KinesisStream",
  ]) {
    it(`${kind} names its function after itself and aliases the old name`, async () => {
      const [, expected, make] = subscribers.find(([k]) => k === kind)!;
      const created: any = await make();
      await settle();

      expect(calls).toHaveLength(1);
      const { name, opts } = calls[0];
      expect(name).toBe(expected);
      expect(opts.aliases).toEqual([{ name: `${expected}Function` }]);
      expect(opts.parent).toBe(created);
    });
  }
});
