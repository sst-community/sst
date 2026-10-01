import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi();

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_ARN = "arn:aws:sqs:us-east-1:123456789012:orders";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:existing";

describe("SnsTopicV5", () => {
  let SnsTopic: typeof import("../../src/components/aws/sns-topic").SnsTopic;
  let SnsTopicV5: typeof import("../../src/components/aws/sns-topic-v5").SnsTopicV5;

  beforeAll(async () => {
    SnsTopic = (await import("../../src/components/aws/sns-topic")).SnsTopic;
    SnsTopicV5 = (await import("../../src/components/aws/sns-topic-v5"))
      .SnsTopicV5;
    await import("../../src/components/aws/takeover/sns-topic");
  });

  beforeEach(() => pulumi.reset());

  // Each case deploys an SnsTopic, then the same thing as an SnsTopicV5.
  // Everything the SnsTopic created has to be kept, with the same inputs.
  // What goes are the subscriber components SnsTopic wraps each subscription
  // in, which have nothing in AWS behind them.
  describe("takes over a deployed SnsTopic", () => {
    it("default topic", async () => {
      expect(
        await pulumi.takesOver(
          () => new SnsTopic("MyTopic"),
          () => new SnsTopicV5("MyTopic"),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    it("fifo topic with a transform", async () => {
      const args = {
        fifo: true,
        transform: { topic: { displayName: "Orders" } },
      };
      expect(
        await pulumi.takesOver(
          () => new SnsTopic("MyTopic", args),
          () => new SnsTopicV5("MyTopic", args),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    it("a topic referenced with get", async () => {
      expect(
        await pulumi.takesOver(
          () => SnsTopic.get("MyTopic", TOPIC_ARN),
          () => SnsTopicV5.get("MyTopic", TOPIC_ARN),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    it("function subscribers given as arns", async () => {
      const filter = { filter: { price_usd: [{ numeric: [">=", 100] }] } };
      expect(
        await pulumi.takesOver(
          () => {
            const topic = new SnsTopic("MyTopic");
            topic.subscribe("Emailer", FUNCTION_ARN, filter);
            topic.subscribe("Auditor", FUNCTION_ARN);
          },
          () =>
            new SnsTopicV5("MyTopic")
              .subscribe("Emailer", FUNCTION_ARN, filter)
              .subscribe("Auditor", FUNCTION_ARN),
        ),
      ).toEqual({
        unclaimed: [
          "sst:aws:SnsTopicLambdaSubscriber::MyTopicSubscriberAuditor",
          "sst:aws:SnsTopicLambdaSubscriber::MyTopicSubscriberEmailer",
        ],
        changed: [],
      });
    });

    it("a function subscriber created from a handler", async () => {
      const result = await pulumi.takesOver(
        () => new SnsTopic("MyTopic").subscribe("Emailer", "src/email.handler"),
        () =>
          new SnsTopicV5("MyTopic").subscribe("Emailer", "src/email.handler"),
      );
      expect(result.unclaimed).toEqual([
        "sst:aws:SnsTopicLambdaSubscriber::MyTopicSubscriberEmailer",
      ]);
      // The function is kept. Its description is updated: it names the topic
      // now, where it named the subscriber component.
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["MyTopicSubscriberEmailerFunctionFunction", ["description"]],
      ]);
      // The function and what it's made of are now inside the topic
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
      ]);
    });

    it("a queue subscriber", async () => {
      const filter = { filter: { type: ["order"] } };
      expect(
        await pulumi.takesOver(
          () => new SnsTopic("MyTopic").subscribeQueue("Orders", QUEUE_ARN, filter),
          () =>
            new SnsTopicV5("MyTopic").subscribeQueue("Orders", QUEUE_ARN, filter),
        ),
      ).toEqual({
        unclaimed: ["sst:aws:SnsTopicQueueSubscriber::MyTopicSubscriberOrders"],
        changed: [],
      });
    });
  });

  it("holds each subscriber's resources by its name", async () => {
    const topic = new SnsTopicV5("MyTopic")
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
    expect(fn.constructor.name).toBe("Function");
  });

  it("tells the topic's transform which subscriber it is given", async () => {
    new SnsTopicV5("MyTopic", {
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
    const { QueueV5 } = await import("../../src/components/aws/queue-v5");
    const queue = new QueueV5("Orders");
    new SnsTopicV5("MyTopic").subscribeQueue("Orders", queue);
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
    const topic = new SnsTopicV5("MyTopic");
    expect(() =>
      topic.subscribe("Emailer", FUNCTION_ARN, { transform: {} } as any),
    ).toThrow(/"transform" isn't an option here. Use the "transform" of "MyTopic": its "subscription" applies to every subscriber/);
  });

  it("rejects two subscribers with the same name", async () => {
    const topic = new SnsTopicV5("MyTopic").subscribe("Emailer", FUNCTION_ARN);
    await pulumi.settle();
    expect(() => topic.subscribeQueue("Emailer", QUEUE_ARN)).toThrow(
      /already has a subscriber named "Emailer"/,
    );
  });

  it("links with its arn and permission to use the topic", async () => {
    const { Link } = await import("../../src/components/link");
    const topic = new SnsTopicV5("MyTopic");
    await pulumi.settle();

    expect(Link.isLinkable(topic)).toBe(true);
    const definition = (topic as any).getSSTLink();
    expect(Object.keys(definition.properties)).toEqual(["arn"]);
    expect(definition.include).toMatchObject([
      { type: "aws.permission", actions: ["sns:*"] },
    ]);
  });
});
