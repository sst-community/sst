import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi();

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/existing";

type QueueArgs = import("../../src/components/aws/queue").QueueArgs;
type QueueV5Args = import("../../src/components/aws/queue-v5").QueueV5Args;

describe("QueueV5", () => {
  let Queue: typeof import("../../src/components/aws/queue").Queue;
  let QueueV5: typeof import("../../src/components/aws/queue-v5").QueueV5;

  beforeAll(async () => {
    Queue = (await import("../../src/components/aws/queue")).Queue;
    QueueV5 = (await import("../../src/components/aws/queue-v5")).QueueV5;
    await import("../../src/components/aws/takeover/queue");
  });

  beforeEach(() => pulumi.reset());

  // Each case deploys a Queue, then the same thing as a QueueV5. Everything
  // the Queue created has to be kept by the QueueV5, with the same inputs.
  describe("takes over a deployed Queue", () => {
    const sameArgs: Record<string, QueueArgs & QueueV5Args> = {
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

    for (const [name, args] of Object.entries(sameArgs)) {
      it(name, async () => {
        expect(
          await pulumi.takesOver(
            () => new Queue("MyQueue", args),
            () => new QueueV5("MyQueue", args),
          ),
        ).toEqual({ unclaimed: [], changed: [] });
      });
    }

    it("a queue referenced with get", async () => {
      expect(
        await pulumi.takesOver(
          () => Queue.get("MyQueue", QUEUE_URL),
          () => QueueV5.get("MyQueue", QUEUE_URL),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    // A Queue keeps its subscription in a component next to it. A QueueV5
    // keeps it inside, so that component goes, and what was in it is kept.
    it("a subscriber given as a function arn", async () => {
      const subscription = {
        filters: [{ body: { type: ["order"] } }],
        batch: { size: 5, window: "20 seconds" as const, partialResponses: true },
      };
      const result = await pulumi.takesOver(
        () =>
          new Queue("MyQueue").subscribe(FUNCTION_ARN, {
            ...subscription,
            transform: { eventSourceMapping: { enabled: false } },
          }),
        () =>
          new QueueV5("MyQueue", {
            transform: { eventSourceMapping: { enabled: false } },
          }).subscribe(FUNCTION_ARN, subscription),
      );

      expect(result.changed).toEqual([]);
      expect(result.unclaimed).toEqual([
        "sst:aws:QueueLambdaSubscriber::MyQueueSubscriberVkxuom",
      ]);
    });

    it("a subscriber created from a handler", async () => {
      const result = await pulumi.takesOver(
        () => new Queue("MyQueue").subscribe("src/subscriber.handler"),
        () => new QueueV5("MyQueue").subscribe("src/subscriber.handler"),
      );

      expect(result.unclaimed).toEqual([
        "sst:aws:QueueLambdaSubscriber::MyQueueSubscriberVkxuom",
      ]);
      // The function is kept. Its description is updated: it names the queue
      // now, where it named the subscriber component.
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["MyQueueSubscriberVkxuomFunctionFunction", ["description"]],
      ]);
      // The function and what it's made of are now inside the queue
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
      ]);
    });
  });

  it("exposes the queue and its subscriber on nodes", async () => {
    const queue = new QueueV5("MyQueue");
    expect(queue.nodes.eventSourceMapping).toBeUndefined();

    queue.subscribe("src/subscriber.handler");
    await pulumi.settle();

    expect(queue.nodes.queue.constructor.name).toBe("Queue");
    const fn = await new Promise<any>((done) =>
      queue.nodes.subscriber.apply(done),
    );
    expect(fn.constructor.name).toBe("Function");
  });

  it("applies the queue's transform to the subscriber", async () => {
    new QueueV5("MyQueue", {
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
    QueueV5.get("Orders", "arn:aws:sqs:us-east-1:123456789012:orders");
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

    const queue = new QueueV5("MyQueue", { existing: { queue: mine } });
    await pulumi.settle();

    expect(queue.nodes.queue).toBe(mine);
    expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:QueueV5"]);
  });

  it("links with its url and permission to use the queue", async () => {
    const { Link } = await import("../../src/components/link");
    const queue = new QueueV5("MyQueue");
    await pulumi.settle();

    expect(Link.isLinkable(queue)).toBe(true);
    const definition = (queue as any).getSSTLink();
    expect(Object.keys(definition.properties)).toEqual(["url"]);
    expect(definition.include).toMatchObject([
      { type: "aws.permission", actions: ["sqs:*"] },
    ]);
  });

  it("says where a subscriber's transform goes", () => {
    const queue = new QueueV5("MyQueue");
    expect(() =>
      queue.subscribe(FUNCTION_ARN, { transform: {} } as any),
    ).toThrow(/"transform" isn't an option here. Use the "transform" of the "MyQueue" queue/);
  });

  it("allows only one subscriber", async () => {
    const queue = new QueueV5("MyQueue");
    queue.subscribe(FUNCTION_ARN);
    await pulumi.settle();
    expect(() => queue.subscribe(FUNCTION_ARN)).toThrow(/multiple times/);
  });
});
