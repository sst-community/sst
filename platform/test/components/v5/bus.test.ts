import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi, type TakeoverWay } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

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
  let OriginalBus: typeof import("../../fixtures/v4/components/aws/bus").Bus;
  let Bus: typeof import("../../../src/components/aws/bus").Bus;

  beforeAll(async () => {
    OriginalBus = (await import("../../fixtures/v4/components/aws/bus")).Bus;
    Bus = (await import("../../../src/components/aws/bus")).Bus;
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
        // A function's links go into its code, which the check compares, and
        // a subscriber that links its own bus has to be created at all
        "a function subscriber that links the bus": {
          create: (Bus, opts) => {
            const bus = new Bus("MyBus", {}, opts);
            bus.subscribe("Emailer", {
              handler: "src/email.handler",
              link: [bus],
            } as any);
          },
          unclaimed: [`${FUNCTION}::MyBusSubscriberEmailer`],
          check: () =>
            expect(pulumi.resources.map((r) => r.name)).toContain(
              "MyBusSubscriberEmailerFunction",
            ),
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

    // 4.x's documented example: its function is kept, under the bus's
    // component now. `get` takes the ARN the static `subscribe` was given.
    it("a subscriber added with the static subscribe from a handler", async () => {
      const result = await pulumi.takesOver(
        () => OriginalBus.subscribe("Emailer", BUS_ARN, "src/email.handler"),
        () =>
          Bus.get("SharedBus", BUS_ARN).subscribe(
            "Emailer",
            "src/email.handler",
          ),
      );
      expect(result).toEqual({
        unclaimed: [`${FUNCTION}::sharedSubscriberEmailer`],
        changed: [],
        unordered: [],
        revealed: [],
      });
      expect(pulumi.resources.map((r) => r.name)).toContain(
        "SharedBusSubscriberEmailerFunction",
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

  // Whether a function is created is decided from what's given, which a
  // preview has to know. The error is thrown inside an apply, on deploy.
  it("refuses a handler or args in an output, and creates no function", async () => {
    const { output } = await import("@pulumi/pulumi");
    const errors = await applyErrors(
      () =>
        new Bus("MyBus")
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
          `The subscriber "${subscriber}" of the "MyBus" bus is an output that isn't a function or the ARN of one.`,
        ),
      );
  });

  it("takes a subscriber's ARN in an output", async () => {
    const { output } = await import("@pulumi/pulumi");
    new Bus("MyBus").subscribe("Emailer", output(FUNCTION_ARN));
    await pulumi.settle();

    expect(
      pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
    ).toEqual([]);
    expect(resource("MyBusTargetEmailer").inputs.arn).toBe(FUNCTION_ARN);
  });

  // 4.x gave a function subscriber only a `provider` passed to the bus
  // itself, and a queue subscriber the app's. The V5 subscribers have the
  // bus's, so a switch replaces them, as "Switch from" says.
  it("replaces the subscribers of a bus that takes its provider from a parent", async () => {
    const { ComponentResource } = await import("@pulumi/pulumi");
    const { Provider } = await import("@pulumi/aws");
    const inParent = (B: typeof Bus | typeof OriginalBus) => {
      const parent = new ComponentResource("test:index:Parent", "Parent", {}, {
        providers: { aws: new Provider("East", { region: "us-east-1" }) },
      });
      const bus = new B("MyBus", {}, { parent });
      bus.subscribe("Emailer", "src/email.handler");
      bus.subscribeQueue("Orders", QUEUE_ARN);
    };
    const result = await pulumi.takesOver(
      () => inParent(OriginalBus),
      () => inParent(Bus),
    );
    const replaced = result.changed
      .filter((c) => c.fields.includes("options.provider"))
      .map((c) => c.name);
    expect(replaced).toContain("MyBusSubscriberEmailerLogGroup");
    expect(replaced).toContain("MyBusSubscriberEmailerRule");
    expect(replaced).toContain("MyBusSubscriberOrdersRule");
    expect(result.changed.map((c) => c.name)).not.toContain("MyBusBus");
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

  it("says to use get in place of the static subscribe and subscribeQueue", () => {
    const Static = Bus as any;
    expect(() =>
      Static.subscribe("Emailer", BUS_ARN, "src/email.handler"),
    ).toThrow(/sst\.aws\.Bus\.get\("MyBus", busArn\)\.subscribe\(/);
    expect(() => Static.subscribeQueue("Orders", BUS_ARN, QUEUE_ARN)).toThrow(
      /sst\.aws\.Bus\.get\("MyBus", busArn\)\.subscribeQueue\(/,
    );
  });

  it("references a bus by its ARN", async () => {
    const bus = Bus.get("SharedBus", BUS_ARN);
    await pulumi.settle();
    expect(resource("SharedBusBus")).toMatchObject({
      kind: "read",
      options: { id: "shared" },
    });
    expect(await pulumi.resolve(bus.name)).toBe("shared");
  });

  it("refuses settings for a bus it's given, but not what a $transform gives one from get", async () => {
    expect(
      () =>
        new Bus("MyBus", {
          existing: { bus: "shared" },
          logging: { level: "info" },
        }),
    ).toThrow(
      'The "MyBus" bus is given an existing "bus", which it uses the way it is. Remove "logging" from its args.',
    );
    const { $transform } = await import("../../../src/components/component");
    $transform(Bus, (args, _opts, name) => {
      if (name === "Shared") args!.logging = { level: "error" };
    });
    Bus.get("Shared", "shared");
    await pulumi.settle();
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
