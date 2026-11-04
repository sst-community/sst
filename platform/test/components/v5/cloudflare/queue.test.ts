import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";

const QUEUE = "cloudflare:index/queue:Queue";
const CONSUMER = "cloudflare:index/queueConsumer:QueueConsumer";
const SCRIPT = "cloudflare:index/workersScript:WorkersScript";
// What the 4.x Queue keeps its consumer in: nothing in Cloudflare behind it
const WRAPPER = "sst:cloudflare:QueueWorkerSubscriber::MyQueueSubscriber";
// The mock builds a worker into a file of this extension
const handler = "src/consumer.mjs";

const pulumi = mockPulumi();

type QueueClass =
  | typeof import("../../../../src/components/cloudflare/queue").Queue
  | typeof import("../../../../src/components/cloudflare/v5/queue").Queue;

describe("Queue", () => {
  let Original: typeof import("../../../../src/components/cloudflare/queue").Queue;
  let Queue: typeof import("../../../../src/components/cloudflare/v5/queue").Queue;
  let Secret: typeof import("../../../../src/components/secret").Secret;

  beforeAll(async () => {
    Original = (await import("../../../../src/components/cloudflare/queue"))
      .Queue;
    Queue = (await import("../../../../src/components/cloudflare/v5/queue"))
      .Queue;
    Secret = (await import("../../../../src/components/secret")).Secret;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const named = (type: string) =>
    pulumi.resources.filter((r) => r.type === type).map((r) => r.name);
  // A secret among them keeps them all secret, recorded under `value`
  const bindingsOf = (name: string) => {
    const bindings = resource(name).inputs.bindings;
    return (bindings.value ?? bindings) as Record<string, any>[];
  };

  // Each case deploys the 4.x Queue, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs. 4.x keeps the consumer in a component at the top of the app;
  // V5 keeps it inside, so that component goes, and what was in it is kept.
  describe("takes over a deployed Queue", () => {
    pulumi.takeoverCases<QueueClass, QueueClass>({
      original: () => Original,
      v5: () => Queue,
      provider: "cloudflare",
      check: () => expect(resource("MyQueueQueue").type).toBe(QUEUE),
      cases: {
        "a queue": (Queue, opts) => {
          new Queue("MyQueue", {}, opts);
        },
        "a queue transformed": (Queue, opts) => {
          new Queue(
            "MyQueue",
            { transform: { queue: { settings: { deliveryDelay: 5 } } } },
            opts,
          );
        },
        "a subscriber created from a handler": {
          create: (Queue, opts) => {
            new Queue("MyQueue", {}, opts).subscribe(handler);
          },
          unclaimed: [WRAPPER],
          check: () => {
            expect(named(CONSUMER)).toEqual(["MyQueueConsumer"]);
            expect(resource("MyQueueConsumer").inputs).toMatchObject({
              queueId: "MyQueueQueue_id",
              scriptName: resource("MyQueueSubscriberFunctionScript").inputs
                .scriptName,
              type: "worker",
              settings: { batchSize: 10, retryDelay: 0, maxWaitTimeMs: 5000 },
            });
          },
        },
        "a subscriber created from worker args, with batch settings": {
          create: (Queue, opts) => {
            new Queue(
              "MyQueue",
              { dlq: { queue: "my-dlq", retry: 5 }, maxConcurrency: 4 },
              opts,
            ).subscribe(
              {
                handler,
                url: true,
                environment: { MODE: "consume" },
              },
              { batch: { size: 50, window: "20 seconds" } },
            );
          },
          unclaimed: [WRAPPER],
          check: () =>
            expect(resource("MyQueueConsumer").inputs).toMatchObject({
              deadLetterQueue: "my-dlq",
              settings: {
                batchSize: 50,
                maxConcurrency: 4,
                maxRetries: 5,
                maxWaitTimeMs: 20000,
              },
            }),
        },
        // SST 4 sent the delay in milliseconds, where Cloudflare reads
        // seconds
        "a subscriber with a retry delay": {
          create: (Queue, opts) => {
            new Queue(
              "MyQueue",
              { dlq: { queue: "my-dlq", retryDelay: "30 seconds" } },
              opts,
            ).subscribe(handler);
          },
          unclaimed: [WRAPPER],
          changed: [["MyQueueSubscriberConsumer", ["settings"]]],
          check: () =>
            expect(resource("MyQueueConsumer").inputs.settings.retryDelay).toBe(
              30,
            ),
        },
        "a subscriber transformed": {
          original: (opts) =>
            new Original("MyQueue", {}, opts).subscribe(handler, {
              transform: {
                worker: { url: true },
                consumer: (args) => {
                  args.settings = { batchSize: 1 };
                },
              },
            }),
          v5: (opts) =>
            new Queue(
              "MyQueue",
              {
                transform: {
                  subscriber: { url: true },
                  consumer: (args) => {
                    args.settings = { batchSize: 1 };
                  },
                },
              },
              opts,
            ).subscribe(handler),
          unclaimed: [WRAPPER],
        },
        // What `sst dev` runs, which the CLI reads from the Worker
        "a subscriber in sst dev": {
          create: (Queue, opts) => {
            // @ts-ignore
            global.$dev = true;
            new Queue("MyQueue", {}, opts).subscribe(handler);
          },
          unclaimed: [WRAPPER],
          check: () =>
            expect(
              pulumi.outputsOf("MyQueueSubscriberFunction")?._live,
            ).toMatchObject({
              functionID: "MyQueueSubscriberFunction",
              handler,
            }),
        },
        "a subscriber that links its queue and a secret": {
          create: (Queue, opts) => {
            const queue = new Queue("MyQueue", {}, opts);
            const secret = new Secret("MySecret", "shh");
            queue.subscribe({ handler, link: [queue, secret] });
          },
          unclaimed: [WRAPPER],
          check: () =>
            expect(
              bindingsOf("MyQueueSubscriberFunctionScript").map((b) => [
                b.type,
                b.name,
              ]),
            ).toEqual([
              ["plain_text", "SST_RESOURCE_App"],
              ["queue", "MyQueue"],
              ["secret_text", "SST_RESOURCE_MySecret"],
            ]),
        },
      },
    });
  });

  it("binds a worker linked to it to the queue", async () => {
    const { Worker } = await import(
      "../../../../src/components/cloudflare/v5/worker"
    );
    const queue = new Queue("MyQueue");
    new Worker("Producer", { handler, link: [queue] });
    await pulumi.settle();
    expect(bindingsOf("ProducerScript")).toContainEqual({
      type: "queue",
      name: "MyQueue",
      queueName: resource("MyQueueQueue").inputs.queueName,
    });
  });

  it("creates its subscriber's Worker and consumer inside the queue", async () => {
    const queue = new Queue("MyQueue");
    expect(queue.subscribe(handler)).toBe(queue);
    await pulumi.settle();
    expect(named(SCRIPT)).toEqual(["MyQueueSubscriberFunctionScript"]);
    // The name SST 4 gave it: a Worker's Durable Object migrations are looked
    // up by the name it works out
    expect(resource("MyQueueSubscriberFunctionScript").inputs.scriptName).toBe(
      "app-test-myqueuesubscriberfunctionscript",
    );
    expect(resource("MyQueueSubscriberFunction").parent).toMatch(
      /sst:cloudflare:Queue::MyQueue$/,
    );
    expect(resource("MyQueueConsumer").parent).toMatch(
      /sst:cloudflare:Queue::MyQueue$/,
    );
    expect(queue.nodes.consumer).toBeDefined();
    expect(queue.nodes.subscriber?.nodes.worker).toBeDefined();
  });

  it("is created with nothing else when nothing subscribes", async () => {
    const queue = new Queue("MyQueue");
    await pulumi.settle();
    expect(named(QUEUE)).toEqual(["MyQueueQueue"]);
    expect(named(CONSUMER)).toEqual([]);
    expect(queue.nodes.subscriber).toBeUndefined();
  });

  it("subscribes to a queue it's given in existing", async () => {
    const cf = await import("@pulumi/cloudflare");
    const existing = new cf.Queue("Orders", {
      accountId: "a",
      queueName: "orders",
    });
    new Queue("MyQueue", { existing: { queue: existing } }).subscribe(handler);
    await pulumi.settle();
    expect(named(QUEUE)).toEqual(["Orders"]);
    expect(resource("MyQueueConsumer").inputs.queueId).toBe("Orders_id");
  });

  it("refuses a second subscriber", () => {
    const queue = new Queue("MyQueue").subscribe(handler);
    expect(() => queue.subscribe(handler)).toThrow(
      'Cannot subscribe to the "MyQueue" queue multiple times. A Cloudflare Queue can only have one consumer.',
    );
  });

  it("refuses what SST 4's subscribe took, saying what to write", () => {
    const queue = new Queue("MyQueue");
    expect(() =>
      queue.subscribe(handler, { transform: { consumer: {} } } as any),
    ).toThrow(
      '"transform" isn\'t an option here. Use the "transform" of the "MyQueue" queue: its "subscriber" and "consumer".',
    );
    expect(() =>
      (queue.subscribe as any)(handler, {}, { parent: queue }),
    ).toThrow('"subscribe" on the "MyQueue" queue takes no options');
  });

  it("refuses a subscriber that's an output, or has no handler", () => {
    const queue = new Queue("MyQueue");
    expect(() => queue.subscribe(output(handler) as any)).toThrow(
      'The subscriber of the "MyQueue" queue has to be a plain value, not an output.',
    );
    expect(() => queue.subscribe({} as any)).toThrow(
      'The subscriber of the "MyQueue" queue needs a "handler"',
    );
    expect(() => queue.subscribe(undefined as any)).toThrow(
      `The "MyQueue" queue is given no subscriber: pass the path to the Worker's handler, or the Worker's args.`,
    );
  });

  // Cloudflare's provider gives a looked-up queue the id it was read by,
  // with the account in front
  it("looks a queue it's given the id of up by its account, and has its own id", async () => {
    const looked = new Queue("Looked", {
      accountId: "acct",
      existing: { queue: "queue-id" },
    }).subscribe(handler);
    const other = new Queue("Other", { existing: { queue: "acct/other-id" } });
    await pulumi.settle();
    expect(resource("LookedQueue")).toMatchObject({
      kind: "read",
      options: { id: "acct/queue-id" },
    });
    expect(resource("OtherQueue").options.id).toBe("acct/other-id");
    const value = (v: any) =>
      new Promise((resolve) => output(v).apply(resolve));
    expect(await value(looked.id)).toBe("queue-id");
    expect(await value(other.id)).toBe("other-id");
    expect(resource("LookedConsumer").inputs.queueId).toBe("queue-id");
  });

  it("has the id of a queue it creates as it is", async () => {
    const queue = new Queue("MyQueue").subscribe(handler);
    await pulumi.settle();
    expect(await new Promise((resolve) => queue.id.apply(resolve))).toBe(
      "MyQueueQueue_id",
    );
    expect(resource("MyQueueConsumer").inputs.queueId).toBe("MyQueueQueue_id");
  });

  it("refuses an existing subscriber or consumer", () => {
    expect(
      () => new Queue("MyQueue", { existing: { consumer: "id" } as any }),
    ).toThrow(
      `"existing.consumer" isn't an option for the "MyQueue" queue. "subscribe" creates`,
    );
  });
});
