import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi, type TakeoverWay } from "../../helpers/graph";

const pulumi = mockPulumi();

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_ARN = "arn:aws:sqs:us-east-1:123456789012:orders";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:existing";

describe("SnsTopic", () => {
  let OriginalSnsTopic: typeof import("../../../src/components/aws/sns-topic").SnsTopic;
  let SnsTopic: typeof import("../../../src/components/aws/v5/sns-topic").SnsTopic;

  beforeAll(async () => {
    OriginalSnsTopic = (await import("../../../src/components/aws/sns-topic")).SnsTopic;
    SnsTopic = (await import("../../../src/components/aws/v5/sns-topic"))
      .SnsTopic;
    await import("../../../src/components/aws/takeover/sns-topic");
    await import("../../../src/components/aws/takeover/function");
  });

  beforeEach(() => pulumi.reset());

  // Each case deploys the 4.x SnsTopic, then the same thing as the V5 one.
  // Everything the 4.x SnsTopic created has to be kept, with the same inputs.
  // What goes are the subscriber components the 4.x SnsTopic wraps each
  // subscription in, which have nothing in AWS behind them.
  describe("takes over a deployed SnsTopic", () => {
    const filter = { filter: { price_usd: [{ numeric: [">=", 100] }] } };
    // The 4.x SnsTopic gives a function subscriber the topic's provider, and
    // not a queue subscriber, which is created with the app's. V5 creates both
    // with the topic's, which replaces a queue's subscription and policy.
    const queueSubscriber = (way: TakeoverWay): [string, string[]][] =>
      way === "with another provider"
        ? [
            ["MyTopicSubscriberOrdersSubscription", ["options.provider"]],
            ["MyTopicSubscriberOrdersPolicy", ["options.provider"]],
          ]
        : [];

    pulumi.takeoverCases({
      original: () => OriginalSnsTopic,
      v5: () => SnsTopic,
      cases: {
        "default topic": (SnsTopic, opts) => new SnsTopic("MyTopic", {}, opts),
        "fifo topic with a transform": (SnsTopic, opts) =>
          new SnsTopic(
            "MyTopic",
            { fifo: true, transform: { topic: { displayName: "Orders" } } },
            opts,
          ),
        "a topic referenced with get": (SnsTopic, opts) =>
          SnsTopic.get("MyTopic", TOPIC_ARN, opts),
        "function subscribers given as arns": {
          original: (opts) => {
            const topic = new OriginalSnsTopic("MyTopic", {}, opts);
            topic.subscribe("Emailer", FUNCTION_ARN, filter);
            topic.subscribe("Auditor", FUNCTION_ARN);
          },
          v5: (opts) =>
            new SnsTopic("MyTopic", {}, opts)
              .subscribe("Emailer", FUNCTION_ARN, filter)
              .subscribe("Auditor", FUNCTION_ARN),
          unclaimed: [
            "sst:aws:SnsTopicLambdaSubscriber::MyTopicSubscriberAuditor",
            "sst:aws:SnsTopicLambdaSubscriber::MyTopicSubscriberEmailer",
          ],
        },
        "a function subscriber created from a handler": {
          create: (SnsTopic, opts) =>
            new SnsTopic("MyTopic", {}, opts).subscribe(
              "Emailer",
              "src/email.handler",
            ),
          unclaimed: [
            "sst:aws:SnsTopicLambdaSubscriber::MyTopicSubscriberEmailer",
          ],
          // The function is kept. Its description is updated: it names the
          // topic now, where it named the subscriber component.
          changed: [
            ["MyTopicSubscriberEmailerFunctionFunction", ["description"]],
          ],
          // The function and what it's made of are now inside the topic
          check: () =>
            expect(
              pulumi.resources
                .filter((r) => r.name.startsWith("MyTopicSubscriberEmailer"))
                .map((r) => r.name)
                .sort(),
            ).toEqual([
              "MyTopicSubscriberEmailer",
              "MyTopicSubscriberEmailerCode",
              "MyTopicSubscriberEmailerFunction",
              "MyTopicSubscriberEmailerLogGroup",
              "MyTopicSubscriberEmailerRole",
            ]),
        },
        "a queue subscriber": {
          create: (SnsTopic, opts) =>
            new SnsTopic("MyTopic", {}, opts).subscribeQueue(
              "Orders",
              QUEUE_ARN,
              {
                filter: { type: ["order"] },
              },
            ),
          unclaimed: [
            "sst:aws:SnsTopicQueueSubscriber::MyTopicSubscriberOrders",
          ],
          changed: queueSubscriber,
        },
        "subscribers of a topic referenced with get": {
          create: (SnsTopic, opts) => {
            const topic = SnsTopic.get("MyTopic", TOPIC_ARN, opts);
            topic.subscribe("Emailer", FUNCTION_ARN);
            topic.subscribeQueue("Orders", QUEUE_ARN);
          },
          unclaimed: [
            "sst:aws:SnsTopicLambdaSubscriber::MyTopicSubscriberEmailer",
            "sst:aws:SnsTopicQueueSubscriber::MyTopicSubscriberOrders",
          ],
          changed: queueSubscriber,
        },
      },
    });
  });

  it("holds each subscriber's resources by its name", async () => {
    const topic = new SnsTopic("MyTopic")
      .subscribe("Emailer", "src/email.handler")
      .subscribe("Auditor", FUNCTION_ARN)
      .subscribeQueue("Orders", QUEUE_ARN);
    await pulumi.settle();

    expect(Object.keys(topic.nodes.subscription).sort()).toEqual([
      "Auditor",
      "Emailer",
      "Orders",
    ]);
    expect(Object.keys(topic.nodes.permission).sort()).toEqual([
      "Auditor",
      "Emailer",
    ]);
    expect(Object.keys(topic.nodes.queuePolicy)).toEqual(["Orders"]);

    const fn = await new Promise<any>((done) =>
      topic.nodes.subscriber.Emailer.apply(done),
    );
    expect((fn.constructor as any).__pulumiType).toBe("sst:aws:FunctionV5");
  });

  it("tells the topic's transform which subscriber it is given", async () => {
    new SnsTopic("MyTopic", {
      transform: {
        subscription: (args, _opts, _name, subscriber) => {
          if (subscriber === "Orders") args.rawMessageDelivery = true;
        },
      },
    })
      .subscribe("Auditor", FUNCTION_ARN)
      .subscribeQueue("Orders", QUEUE_ARN);
    await pulumi.settle();

    const subscription = (name: string) =>
      pulumi.resources.find((r) => r.name === `MyTopicSubscription${name}`)!;
    expect(subscription("Orders").inputs.rawMessageDelivery).toBe(true);
    expect(subscription("Auditor").inputs.rawMessageDelivery).toBeUndefined();
  });

  it("accepts a queue component as a subscriber", async () => {
    const { Queue } = await import("../../../src/components/aws/v5/queue");
    const queue = new Queue("Orders");
    new SnsTopic("MyTopic").subscribeQueue("Orders", queue);
    await pulumi.settle();

    const subscription = pulumi.resources.find(
      (r) => r.name === "MyTopicSubscriptionOrders",
    )!;
    expect(subscription.inputs.protocol).toBe("sqs");
    expect(subscription.inputs.endpoint).toBe(
      "arn:aws:mock:us-east-1:123456789012:OrdersQueue",
    );
  });

  it("says where a subscriber's transform goes", () => {
    const topic = new SnsTopic("MyTopic");
    expect(() =>
      topic.subscribe("Emailer", FUNCTION_ARN, { transform: {} } as any),
    ).toThrow(/"transform" isn't an option here. Use the "transform" of "MyTopic": its "subscription" applies to every subscriber/);
  });

  it("rejects two subscribers with the same name", async () => {
    const topic = new SnsTopic("MyTopic").subscribe("Emailer", FUNCTION_ARN);
    await pulumi.settle();
    expect(() => topic.subscribeQueue("Emailer", QUEUE_ARN)).toThrow(
      /already has a subscriber named "Emailer"/,
    );
  });

  it("links with its arn and permission to use the topic", async () => {
    const { Link } = await import("../../../src/components/link");
    const topic = new SnsTopic("MyTopic");
    await pulumi.settle();

    expect(Link.isLinkable(topic)).toBe(true);
    const definition = (topic as any).getSSTLink();
    expect(Object.keys(definition.properties)).toEqual(["arn"]);
    expect(definition.include).toMatchObject([
      { type: "aws.permission", actions: ["sns:*"] },
    ]);
  });
});
