import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";
import {
  hashStringToPrettyString,
  logicalName,
} from "../../../src/components/naming";

// A queue that's looked up by its URL has the ARN that URL is for
const pulumi = mockPulumi({
  state: (args) => {
    if (args.type !== "aws:sqs/queue:Queue" || !args.id) return {};
    const [, , host, account, name] = args.id.split("/");
    const region = host.split(".")[1];
    return { url: args.id, arn: `arn:aws:sqs:${region}:${account}:${name}` };
  },
});

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/existing";
// A queue that isn't in the app, subscribed to with the static `subscribe` of
// the 4.x Queue, which named what it created after the queue's own name
const SHARED_ARN = "arn:aws:sqs:us-east-1:123456789012:orders-prod.fifo";
const STATIC_WRAPPER = `${logicalName("orders-prod.fifo")}Subscriber${logicalName(
  hashStringToPrettyString(SHARED_ARN, 6),
)}`;

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
            ["MyQueueSubscriberVkxuomFunction", ["description"]],
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
        // A queue referenced with `get`, under a name of its own, takes its
        // place. It's given the options the static `subscribe` was.
        "a subscriber added with the static subscribe": {
          original: (opts) =>
            OriginalQueue.subscribe(
              SHARED_ARN,
              "src/subscriber.handler",
              {},
              opts,
            ),
          v5: (opts) =>
            Queue.get("SharedOrders", SHARED_ARN, opts).subscribe(
              "src/subscriber.handler",
            ),
          unclaimed: [`sst:aws:QueueLambdaSubscriber::${STATIC_WRAPPER}`],
          // The description names the queue's component now
          changed: [[`${STATIC_WRAPPER}Function`, ["description"]]],
          check: () =>
            expect(pulumi.resources.map((r) => r.name)).toContain(
              "SharedOrdersEventSourceMapping",
            ),
        },
        "a subscriber of a queue referenced with get": {
          create: (Queue, opts) =>
            Queue.get("MyQueue", QUEUE_URL, opts).subscribe(FUNCTION_ARN),
          // Named after the ARN of the queue it looked up
          unclaimed: ["sst:aws:QueueLambdaSubscriber::MyQueueSubscriberWvswsc"],
        },
      },
    });
  });

  // 4.x gave the subscriber only a `provider` passed to the queue itself, so
  // one the queue took from a parent didn't reach it. The V5 subscriber has
  // the queue's, so a switch replaces it, as "Switch from" says.
  it("replaces the subscriber of a queue that takes its provider from a parent", async () => {
    const { ComponentResource } = await import("@pulumi/pulumi");
    const { Provider } = await import("@pulumi/aws");
    const inParent = (Q: QueueClass) => {
      const parent = new ComponentResource("test:index:Parent", "Parent", {}, {
        providers: { aws: new Provider("East", { region: "us-east-1" }) },
      });
      new Q("MyQueue", {}, { parent }).subscribe("src/subscriber.handler");
    };
    const result = await pulumi.takesOver(
      () => inParent(OriginalQueue),
      () => inParent(Queue),
    );
    const replaced = result.changed
      .filter((c) => c.fields.includes("options.provider"))
      .map((c) => c.name);
    expect(replaced).toContain("MyQueueSubscriberVkxuomLogGroup");
    expect(replaced).toContain("MyQueueSubscriberVkxuomEventSourceMapping");
    expect(result.changed.map((c) => c.name)).not.toContain("MyQueueQueue");
  });

  // Whether a function is created is decided from what's given, which a
  // preview has to know. The error is thrown inside an apply, on deploy.
  it("refuses a handler or args in an output, and creates no function", async () => {
    const { output } = await import("@pulumi/pulumi");
    const errors = await applyErrors(() => {
      new Queue("MyQueue").subscribe(output("src/subscriber.handler"));
      new Queue("Other").subscribe(
        output({ handler: "src/subscriber.handler" }) as any,
      );
    }, pulumi.settle);
    expect(
      pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
    ).toEqual([]);
    for (const queue of ["MyQueue", "Other"])
      expect(errors).toContainEqual(
        expect.stringContaining(
          `The subscriber of the "${queue}" queue is an output that isn't a function or the ARN of one.`,
        ),
      );
  });

  it("takes a subscriber's ARN in an output", async () => {
    const { output } = await import("@pulumi/pulumi");
    new Queue("MyQueue").subscribe(output(FUNCTION_ARN));
    await pulumi.settle();

    expect(
      pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
    ).toEqual([]);
    const mapping = pulumi.resources.find(
      (r) => r.name === "MyQueueEventSourceMapping",
    )!;
    expect(mapping.inputs.functionName).toBe(FUNCTION_ARN);
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

  // A value that's only known once deployed, like the ARN of a layer that's
  // being replaced. The preview still has to create the function, or `sst diff`
  // shows it as deleted.
  it("creates a subscriber whose args aren't known yet", async () => {
    const sdk = await import("@pulumi/pulumi");
    const unknown = sdk.output(sdk.unknown) as any;
    new Queue("MyQueue").subscribe({
      handler: "src/subscriber.handler",
      environment: { LAYER: unknown },
      layers: [unknown],
    });
    await pulumi.settle();

    expect(
      pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
    ).toHaveLength(1);
    expect(
      pulumi.resources.filter((r) => r.type === "aws:lambda/function:Function"),
    ).toHaveLength(1);
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
