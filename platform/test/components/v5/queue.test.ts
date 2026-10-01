import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const pulumi = mockPulumi();

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/existing";

type QueueClass =
  | typeof import("../../../src/components/aws/queue").Queue
  | typeof import("../../../src/components/aws/v5/queue").Queue;
type OriginalQueueArgs = import("../../../src/components/aws/queue").QueueArgs;
type QueueArgs = import("../../../src/components/aws/v5/queue").QueueArgs;

describe("Queue", () => {
  let OriginalQueue: typeof import("../../../src/components/aws/queue").Queue;
  let Queue: typeof import("../../../src/components/aws/v5/queue").Queue;

  beforeAll(async () => {
    OriginalQueue = (await import("../../../src/components/aws/queue")).Queue;
    Queue = (await import("../../../src/components/aws/v5/queue")).Queue;
    await import("../../../src/components/aws/takeover/queue");
    await import("../../../src/components/aws/takeover/function");
  });

  beforeEach(() => pulumi.reset());

  // Each case deploys the 4.x Queue, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs.
  describe("takes over a deployed Queue", () => {
    const sameArgs: Record<string, OriginalQueueArgs & QueueArgs> = {
      "default queue": {},
      "fifo queue with delay, visibility timeout and dlq": {
        fifo: { contentBasedDeduplication: true },
        delay: "5 seconds",
        visibilityTimeout: "2 minutes",
        dlq: {
          queue: "arn:aws:sqs:us-east-1:123456789012:dead-letters.fifo",
          retry: 5,
        },
      },
      "fifo as a boolean": { fifo: true },
      "dlq given as an arn": {
        dlq: "arn:aws:sqs:us-east-1:123456789012:dead-letters",
      },
      "transform as an object": {
        transform: {
          queue: { messageRetentionSeconds: 86400, name: "custom-name" },
        },
      },
      "transform as a function": {
        transform: {
          queue: (args, opts) => {
            args.maxMessageSize = 1024;
            opts.protect = true;
          },
        },
      },
    };

    // 4.x keeps the subscription in a component next to the queue. V5 keeps
    // it inside, so that component goes, and what was in it is kept.
    const WRAPPER = "sst:aws:QueueLambdaSubscriber::MyQueueSubscriberVkxuom";
    const subscription = {
      filters: [{ body: { type: ["order"] } }],
      batch: { size: 5, window: "20 seconds" as const, partialResponses: true },
    };

    pulumi.takeoverCases({
      original: () => OriginalQueue,
      v5: () => Queue,
      cases: {
        ...Object.fromEntries(
          Object.entries(sameArgs).map(([name, args]) => [
            name,
            (Queue: QueueClass, opts?: ComponentResourceOptions) =>
              new Queue("MyQueue", args, opts),
          ]),
        ),
        "a queue referenced with get": (Queue, opts) =>
          Queue.get("MyQueue", QUEUE_URL, opts),
        "a subscriber given as a function arn": {
          original: (opts) =>
            new OriginalQueue("MyQueue", {}, opts).subscribe(FUNCTION_ARN, {
              ...subscription,
              transform: { eventSourceMapping: { enabled: false } },
            }),
          v5: (opts) =>
            new Queue(
              "MyQueue",
              { transform: { eventSourceMapping: { enabled: false } } },
              opts,
            ).subscribe(FUNCTION_ARN, subscription),
          unclaimed: [WRAPPER],
        },
        "a subscriber created from a handler": {
          create: (Queue, opts) =>
            new Queue("MyQueue", {}, opts).subscribe("src/subscriber.handler"),
          unclaimed: [WRAPPER],
          // The function is kept. Its description is updated: it names the
          // queue now, where it named the subscriber component.
          changed: [
            ["MyQueueSubscriberVkxuomFunctionFunction", ["description"]],
          ],
          // The function and what it's made of are now inside the queue
          check: () =>
            expect(
              pulumi.resources
                .filter((r) => r.name.startsWith("MyQueueSubscriber"))
                .map((r) => r.name)
                .sort(),
            ).toEqual([
              "MyQueueSubscriber",
              "MyQueueSubscriberCode",
              "MyQueueSubscriberFunction",
              "MyQueueSubscriberLogGroup",
              "MyQueueSubscriberRole",
            ]),
        },
        "a subscriber of a queue referenced with get": {
          create: (Queue, opts) =>
            Queue.get("MyQueue", QUEUE_URL, opts).subscribe(FUNCTION_ARN),
          unclaimed: [WRAPPER],
        },
      },
    });
  });

  it("exposes the queue and its subscriber on nodes", async () => {
    const queue = new Queue("MyQueue");
    expect(queue.nodes.eventSourceMapping).toBeUndefined();

    queue.subscribe("src/subscriber.handler");
    await pulumi.settle();

    expect(queue.nodes.queue.constructor.name).toBe("Queue");
    const fn = await new Promise<any>((done) =>
      queue.nodes.subscriber.apply(done),
    );
    expect(fn).toBeInstanceOf(
      (await import("../../../src/components/aws/v5/function")).Function,
    );
  });

  it("applies the queue's transform to the subscriber", async () => {
    new Queue("MyQueue", {
      transform: { eventSourceMapping: { enabled: false } },
    }).subscribe(FUNCTION_ARN);
    await pulumi.settle();

    const mapping = pulumi.resources.find(
      (r) => r.name === "MyQueueEventSourceMapping",
    )!;
    expect(mapping.inputs.enabled).toBe(false);
    expect(mapping.inputs.batchSize).toBe(10);
  });

  it("references a queue by its arn", async () => {
    Queue.get("Orders", "arn:aws:sqs:us-east-1:123456789012:orders");
    await pulumi.settle();

    const read = pulumi.resources.find((r) => r.kind === "read")!;
    expect(read.options.id).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/orders",
    );
  });

  it("uses an existing queue passed as a resource", async () => {
    const { sqs } = await import("@pulumi/aws");
    const mine = new sqs.Queue("Mine", {});
    await pulumi.settle();
    pulumi.reset();

    const queue = new Queue("MyQueue", { existing: { queue: mine } });
    await pulumi.settle();

    expect(queue.nodes.queue).toBe(mine);
    expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Queue"]);
  });

  it("links with its url and permission to use the queue", async () => {
    const { Link } = await import("../../../src/components/link");
    const queue = new Queue("MyQueue");
    await pulumi.settle();

    expect(Link.isLinkable(queue)).toBe(true);
    const definition = (queue as any).getSSTLink();
    expect(Object.keys(definition.properties)).toEqual(["url"]);
    expect(definition.include).toMatchObject([
      { type: "aws.permission", actions: ["sqs:*"] },
    ]);
  });

  it("says where a subscriber's transform goes", () => {
    const queue = new Queue("MyQueue");
    expect(() =>
      queue.subscribe(FUNCTION_ARN, { transform: {} } as any),
    ).toThrow(/"transform" isn't an option here. Use the "transform" of the "MyQueue" queue/);
  });

  it("allows only one subscriber", async () => {
    const queue = new Queue("MyQueue");
    queue.subscribe(FUNCTION_ARN);
    await pulumi.settle();
    expect(() => queue.subscribe(FUNCTION_ARN)).toThrow(/multiple times/);
  });
});
