import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi, type TakeoverWay } from "../../helpers/graph";

// A bus that's looked up has its name, as in AWS
const pulumi = mockPulumi({
  state: (args) =>
    args.type === "aws:cloudwatch/eventBus:EventBus" && args.id
      ? { name: args.id }
      : {},
});

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_ARN = "arn:aws:sqs:us-east-1:123456789012:orders";
const BUS_ARN = "arn:aws:events:us-east-1:123456789012:event-bus/shared";
const FUNCTION = "sst:aws:BusLambdaSubscriber";
const QUEUE = "sst:aws:BusQueueSubscriber";

const resource = (name: string) =>
  pulumi.resources.find((r) => r.name === name)!;

describe("Bus", () => {
  let OriginalBus: typeof import("../../../src/components/aws/bus").Bus;
  let Bus: typeof import("../../../src/components/aws/v5/bus").Bus;

  beforeAll(async () => {
    OriginalBus = (await import("../../../src/components/aws/bus")).Bus;
    Bus = (await import("../../../src/components/aws/v5/bus")).Bus;
    await import("../../../src/components/aws/takeover/bus");
    await import("../../../src/components/aws/takeover/function");
  });

  beforeEach(() => pulumi.reset());

  // Each case deploys the 4.x Bus, then the same thing as the V5 one.
  // Everything the 4.x Bus created has to be kept, with the same inputs. What
  // goes are the subscriber components the 4.x Bus wraps each subscription
  // in, which have nothing in AWS behind them.
  describe("takes over a deployed Bus", () => {
    const pattern = {
      pattern: { detailType: ["order.created"], detail: { total: [100] } },
    };
    // The 4.x Bus gives a function subscriber the bus's provider, and not a
    // queue subscriber, which is created with the app's. V5 creates both with
    // the bus's, which replaces a queue's rule, target and policy.
    const queueSubscriber = (way: TakeoverWay): [string, string[]][] =>
      way === "with another provider"
        ? [
            ["MyBusSubscriberOrdersRule", ["options.provider"]],
            ["MyBusSubscriberOrdersTarget", ["options.provider"]],
            ["MyBusSubscriberOrdersPolicy", ["options.provider"]],
          ]
        : [];

    pulumi.takeoverCases({
      original: () => OriginalBus,
      v5: () => Bus,
      cases: {
        "default bus": (Bus, opts) => new Bus("MyBus", {}, opts),
        "logging and a transform": (Bus, opts) =>
          new Bus(
            "MyBus",
            {
              logging: { level: "info", detail: true },
              transform: { bus: { description: "Orders" } },
            },
            opts,
          ),
        "a bus referenced with get": (Bus, opts) =>
          Bus.get("MyBus", "existing-bus", opts),
        "function subscribers given as arns": {
          original: (opts) => {
            const bus = new OriginalBus("MyBus", {}, opts);
            bus.subscribe("Emailer", FUNCTION_ARN, pattern);
            bus.subscribe("Auditor", FUNCTION_ARN, { enabled: false });
          },
          v5: (opts) =>
            new Bus("MyBus", {}, opts)
              .subscribe("Emailer", FUNCTION_ARN, pattern)
              .subscribe("Auditor", FUNCTION_ARN, { enabled: false }),
          unclaimed: [
            `${FUNCTION}::MyBusSubscriberAuditor`,
            `${FUNCTION}::MyBusSubscriberEmailer`,
          ],
        },
        "a function subscriber created from a handler": {
          create: (Bus, opts) => {
            new Bus("MyBus", {}, opts).subscribe("Emailer", "src/email.handler");
          },
          unclaimed: [`${FUNCTION}::MyBusSubscriberEmailer`],
          // The function and what it's made of are now inside the bus
          check: () =>
            expect(
              pulumi.resources
                .filter((r) => r.name.startsWith("MyBusSubscriberEmailer"))
                .map((r) => r.name)
                .sort(),
            ).toEqual([
              "MyBusSubscriberEmailer",
              "MyBusSubscriberEmailerCode",
              "MyBusSubscriberEmailerFunction",
              "MyBusSubscriberEmailerLogGroup",
              "MyBusSubscriberEmailerRole",
            ]),
        },
        "a queue subscriber": {
          create: (Bus, opts) => {
            new Bus("MyBus", {}, opts).subscribeQueue("Orders", QUEUE_ARN, pattern);
          },
          unclaimed: [`${QUEUE}::MyBusSubscriberOrders`],
          changed: queueSubscriber,
        },
        "subscribers of a bus referenced with get": {
          create: (Bus, opts) => {
            const bus = Bus.get("MyBus", "existing-bus", opts);
            bus.subscribe("Emailer", FUNCTION_ARN);
            bus.subscribeQueue("Orders", QUEUE_ARN);
          },
          unclaimed: [
            `${FUNCTION}::MyBusSubscriberEmailer`,
            `${QUEUE}::MyBusSubscriberOrders`,
          ],
          changed: queueSubscriber,
        },
      },
    });

    // The static `subscribe` and `subscribeQueue` only have the bus's ARN, so
    // they name the subscriber's component after the bus in it. A V5 bus that
    // references that bus takes the subscriber over, whatever it's called.
    it("subscribers added with the static methods", async () => {
      expect(
        await pulumi.takesOver(
          () => {
            OriginalBus.subscribe("Emailer", BUS_ARN, FUNCTION_ARN, {
              pattern: { source: ["orders"] },
            });
            OriginalBus.subscribeQueue("Orders", BUS_ARN, QUEUE_ARN);
          },
          () =>
            Bus.get("SharedBus", "shared")
              .subscribe("Emailer", FUNCTION_ARN, {
                pattern: { source: ["orders"] },
              })
              .subscribeQueue("Orders", QUEUE_ARN),
        ),
      ).toEqual({
        unclaimed: [
          `${FUNCTION}::sharedSubscriberEmailer`,
          `${QUEUE}::sharedSubscriberOrders`,
        ],
        changed: [],
        unordered: [],
        revealed: [],
      });
      expect(resource("SharedBusRuleEmailer").inputs.eventBusName).toBe(
        "shared",
      );
    });
  });

  it("holds each subscriber's resources by its name", async () => {
    const bus = new Bus("MyBus")
      .subscribe("Emailer", "src/email.handler")
      .subscribe("Auditor", FUNCTION_ARN)
      .subscribeQueue("Orders", QUEUE_ARN);
    await pulumi.settle();

    expect(Object.keys(bus.nodes.rule).sort()).toEqual([
      "Auditor",
      "Emailer",
      "Orders",
    ]);
    expect(Object.keys(bus.nodes.permission).sort()).toEqual([
      "Auditor",
      "Emailer",
    ]);
    expect(Object.keys(bus.nodes.queuePolicy)).toEqual(["Orders"]);
  });

  it("matches every event without a pattern", async () => {
    new Bus("MyBus").subscribe("All", FUNCTION_ARN);
    await pulumi.settle();

    expect(resource("MyBusRuleAll").inputs.eventPattern).toBe(
      JSON.stringify({ source: [{ prefix: "" }] }),
    );
    expect(resource("MyBusRuleAll").inputs.state).toBe("ENABLED");
  });

  it("refuses a subscriber's transform, and a name used twice", () => {
    const bus = new Bus("MyBus").subscribe("Emailer", FUNCTION_ARN);
    expect(() =>
      bus.subscribe("Other", FUNCTION_ARN, { transform: {} } as any),
    ).toThrow(/Use the "transform" of "MyBus": its "rule" and "target" apply/);
    expect(() => bus.subscribeQueue("Emailer", QUEUE_ARN)).toThrow();
  });

  it("links its name and arn, with permission to use it", async () => {
    const { Link } = await import("../../../src/components/link");
    const bus = new Bus("MyBus");
    await pulumi.settle();

    expect(Link.isLinkable(bus)).toBe(true);
    expect(Object.keys((bus as any).getSSTLink().properties)).toEqual([
      "name",
      "arn",
    ]);
  });
});
