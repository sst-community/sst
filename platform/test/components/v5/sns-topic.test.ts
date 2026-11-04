import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi, type TakeoverWay } from "../../helpers/graph";
import { logicalName } from "../../../src/components/naming";
import { applyErrors } from "../../helpers/apply-errors";

// A topic that's looked up by its ARN has that ARN, and the name in it. A
// function that publishes versions, like a workflow's, is invoked by its
// version.
const pulumi = mockPulumi({
  state: (args) =>
    args.type === "aws:sns/topic:Topic" && args.id
      ? { arn: args.id, name: args.id.split(":")[5] }
      : args.type === "aws:lambda/function:Function"
        ? versioned(`arn:aws:mock:us-east-1:123456789012:${args.name}`)
        : {},
});

function versioned(arn: string) {
  const invoke = (api: string, path: string) =>
    `arn:aws:apigateway:us-east-1:lambda:path/${api}/functions/${arn}/${path}`;
  return {
    qualifiedArn: `${arn}:3`,
    invokeArn: invoke("2015-03-31", "invocations"),
    qualifiedInvokeArn: invoke("2015-03-31", "invocations").replace(
      arn,
      `${arn}:3`,
    ),
    responseStreamingInvokeArn: invoke(
      "2021-11-15",
      "response-streaming-invocations",
    ),
  };
}

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_ARN = "arn:aws:sqs:us-east-1:123456789012:orders";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:existing";
// A topic that isn't in the app, subscribed to with the static `subscribe`
// and `subscribeQueue` of the 4.x SnsTopic. They named what they created after
// the topic's own name, at the top of the app, with the app's provider.
const SHARED_ARN = "arn:aws:sns:us-east-1:123456789012:events-prod.fifo";
const STATIC = `${logicalName("events-prod.fifo")}Subscriber`;

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
            ["MyTopicSubscriberEmailerFunction", ["description"]],
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
    expect(fn).toBeInstanceOf(
      (await import("../../../src/components/aws/v5/function")).Function,
    );
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

  // A topic referenced with `get`, under a name of its own, takes their
  // place. The static methods took no options, so what they created is found
  // where it was, wherever the topic is now.
  describe("takes over subscribers added with the 4.x SnsTopic's static methods", () => {
    for (const [way, opts] of [
      ["as it is", () => ({})],
      ["inside another component", async () => {
        const { ComponentResource } = await import("@pulumi/pulumi");
        return { parent: new ComponentResource("test:index:Parent", "Parent") };
      }],
    ] as const)
      it(way, async () => {
        const result = await pulumi.takesOver(
          () => {
            OriginalSnsTopic.subscribe("Emailer", SHARED_ARN, "src/email.handler");
            OriginalSnsTopic.subscribeQueue("Orders", SHARED_ARN, QUEUE_ARN);
          },
          async () =>
            SnsTopic.get("SharedEvents", SHARED_ARN, await opts())
              .subscribe("Emailer", "src/email.handler")
              .subscribeQueue("Orders", QUEUE_ARN),
        );
        expect(result.unclaimed.sort()).toEqual([
          `sst:aws:SnsTopicLambdaSubscriber::${STATIC}Emailer`,
          `sst:aws:SnsTopicQueueSubscriber::${STATIC}Orders`,
        ]);
        // The function's description names the topic's component now
        expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
          [`${STATIC}EmailerFunction`, ["description"]],
        ]);
        expect(result.unordered).toEqual([]);
        expect(result.revealed).toEqual([]);
        expect(pulumi.resources.map((r) => r.name)).toEqual(
          expect.arrayContaining([
            "SharedEventsSubscriptionEmailer",
            "SharedEventsSubscriptionOrders",
          ]),
        );
        const component = pulumi.resources.find(
          (r) => r.name === "SharedEvents",
        )!;
        expect(component.parent.endsWith("::Parent")).toBe(
          way === "inside another component",
        );
      });
  });

  // 4.x gave a function subscriber only a `provider` passed to the topic
  // itself, so one the topic took from a parent didn't reach it. The V5
  // subscriber has the topic's, so a switch replaces it, as "Switch from" says.
  it("replaces the subscribers of a topic that takes its provider from a parent", async () => {
    const { ComponentResource } = await import("@pulumi/pulumi");
    const { Provider } = await import("@pulumi/aws");
    const inParent = (Topic: typeof SnsTopic | typeof OriginalSnsTopic) => {
      const parent = new ComponentResource("test:index:Parent", "Parent", {}, {
        providers: { aws: new Provider("East", { region: "us-east-1" }) },
      });
      const topic = new Topic("MyTopic", {}, { parent });
      topic.subscribe("Emailer", "src/email.handler");
      topic.subscribeQueue("Orders", QUEUE_ARN);
    };
    const result = await pulumi.takesOver(
      () => inParent(OriginalSnsTopic),
      () => inParent(SnsTopic),
    );
    const replaced = result.changed
      .filter((c) => c.fields.includes("options.provider"))
      .map((c) => c.name);
    expect(replaced).toContain("MyTopicSubscriberEmailerLogGroup");
    expect(replaced).toContain("MyTopicSubscriberEmailerSubscription");
    expect(replaced).toContain("MyTopicSubscriberOrdersSubscription");
    expect(result.changed.map((c) => c.name)).not.toContain("MyTopicTopic");
  });

  // Whether a function is created is decided from what's given, which a
  // preview has to know. The error is thrown inside an apply, on deploy.
  it("refuses a handler or args in an output, and creates no function", async () => {
    const { output } = await import("@pulumi/pulumi");
    const errors = await applyErrors(
      () =>
        new SnsTopic("MyTopic")
          .subscribe("Later", output("src/email.handler"))
          .subscribe("LaterArgs", output({ handler: "src/email.handler" }) as any),
      pulumi.settle,
    );
    expect(
      pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
    ).toEqual([]);
    for (const subscriber of ["Later", "LaterArgs"])
      expect(errors).toContainEqual(
        expect.stringContaining(
          `The subscriber "${subscriber}" of the "MyTopic" topic is an output that isn't a function or the ARN of one.`,
        ),
      );
  });

  it("takes a subscriber's ARN in an output", async () => {
    const { output } = await import("@pulumi/pulumi");
    new SnsTopic("MyTopic").subscribe("Emailer", output(FUNCTION_ARN));
    await pulumi.settle();

    expect(
      pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
    ).toEqual([]);
    const subscription = pulumi.resources.find(
      (r) => r.name === "MyTopicSubscriptionEmailer",
    )!;
    expect(subscription.inputs.endpoint).toBe(FUNCTION_ARN);
  });

  it("takes a subscriber written any way that has a name", async () => {
    const { output } = await import("@pulumi/pulumi");
    const { Function } = await import(
      "../../../src/components/aws/v5/function"
    );
    const { Function: OriginalFunction } = await import(
      "../../../src/components/aws/function"
    );
    const { Workflow } = await import("../../../src/components/aws/workflow");
    const { Queue } = await import("../../../src/components/aws/v5/queue");
    const { Queue: OriginalQueue } = await import(
      "../../../src/components/aws/queue"
    );
    const topic = new SnsTopic("MyTopic")
      .subscribe("Handler", "src/email.handler")
      .subscribe("Args", { handler: "src/email.handler", timeout: "60 seconds" })
      .subscribe("Arn", FUNCTION_ARN)
      .subscribe("Later", output(FUNCTION_ARN))
      .subscribe("Mine", new Function("Mine", { handler: "src/a.handler" }))
      .subscribe("Old", new OriginalFunction("Old", { handler: "src/b.handler" }))
      .subscribe("Flow", new Workflow("Flow", { handler: "src/c.handler" }))
      .subscribeQueue("QueueArn", QUEUE_ARN)
      .subscribeQueue("QueueLater", output(QUEUE_ARN))
      .subscribeQueue("Jobs", new Queue("Jobs"))
      .subscribeQueue("OldJobs", new OriginalQueue("OldJobs"));
    await pulumi.settle();

    expect(Object.keys(topic.nodes.subscription).sort()).toEqual([
      "Args",
      "Arn",
      "Flow",
      "Handler",
      "Jobs",
      "Later",
      "Mine",
      "Old",
      "OldJobs",
      "QueueArn",
      "QueueLater",
    ]);
  });

  // 4.x also took a subscriber without a name, which shifts the arguments
  it("refuses a subscriber without a name, and says what to write", () => {
    const topic = new SnsTopic("MyTopic") as any;
    expect(() => topic.subscribe("src/email.handler")).toThrow(
      `A subscriber of the "MyTopic" topic needs a name, given first: subscribe("MySubscriber", ...).`,
    );
    expect(() => topic.subscribe(FUNCTION_ARN, { filter: {} })).toThrow(
      /needs a name, given first/,
    );
    expect(() => topic.subscribeQueue(QUEUE_ARN)).toThrow(
      /given first: subscribeQueue\("MySubscriber", \.\.\.\)/,
    );
  });

  it("says to use get in place of the static subscribe and subscribeQueue", () => {
    const Static = SnsTopic as any;
    expect(() =>
      Static.subscribe("Emailer", FUNCTION_ARN, "src/email.handler"),
    ).toThrow(
      /sst\.aws\.v5\.SnsTopic\.get\("MyTopic", topicArn\)\.subscribe\(/,
    );
    expect(() =>
      Static.subscribeQueue("Orders", FUNCTION_ARN, QUEUE_ARN),
    ).toThrow(
      /sst\.aws\.v5\.SnsTopic\.get\("MyTopic", topicArn\)\.subscribeQueue\(/,
    );
  });

  it("refuses settings for a topic it's given, but not what a $transform gives one from get", async () => {
    expect(
      () =>
        new SnsTopic("MyTopic", {
          existing: { topic: TOPIC_ARN },
          fifo: true,
        }),
    ).toThrow(
      'The "MyTopic" topic is given an existing "topic", which it uses the way it is. Remove "fifo" from its args.',
    );
    const { $transform } = await import("../../../src/components/component");
    $transform(SnsTopic, (args, _opts, name) => {
      if (name === "Shared") args!.fifo = true;
    });
    SnsTopic.get("Shared", "arn:aws:sns:us-east-1:123456789012:shared");
    await pulumi.settle();
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
