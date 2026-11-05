import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

const STREAM = "aws:kinesis/stream:Stream";
// What the 4.x KinesisStream wraps each subscription in: nothing in AWS behind it
const WRAPPER = "sst:aws:KinesisStreamLambdaSubscriber";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const streamArn = (stream: string) =>
  `arn:aws:kinesis:us-east-1:123456789012:stream/${stream}`;

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type !== STREAM) return {};
    // A stream that's looked up has the name it's looked up by
    if (args.id) return { name: args.id, arn: streamArn(args.id) };
    // A created one, the ARN of its name in AWS
    return { arn: streamArn(args.inputs.name ?? args.name) };
  },
});

type StreamClass =
  | typeof import("../../fixtures/v4/components/aws/kinesis-stream").KinesisStream
  | typeof import("../../../src/components/aws/kinesis-stream").KinesisStream;

describe("KinesisStream", () => {
  let Original: typeof import("../../fixtures/v4/components/aws/kinesis-stream").KinesisStream;
  let KinesisStream: typeof import("../../../src/components/aws/kinesis-stream").KinesisStream;

  beforeAll(async () => {
    Original = (await import("../../fixtures/v4/components/aws/kinesis-stream"))
      .KinesisStream;
    KinesisStream = (await import("../../../src/components/aws/kinesis-stream"))
      .KinesisStream;
    await import("../../../src/components/aws/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  // The ARN of the stream the app created
  const createdArn = () => streamArn(resource("MyStreamStream").inputs.name);
  const filters = { filters: [{ data: { order: { type: ["buy"] } } }] };
  // A subscriber's function is kept. Its description is updated: it names the
  // stream now, where it named the subscriber component.
  const described: [string, string[]][] = [
    ["MyStreamSubscriberIndexerFunction", ["description"]],
  ];

  // Each case deploys the 4.x KinesisStream, then the same thing as the V5
  // one. Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs. 4.x keeps each subscription in a component at the top of the
  // app; V5 keeps them inside, so those components go, and what was in them
  // is kept.
  describe("takes over a deployed KinesisStream", () => {
    pulumi.takeoverCases<StreamClass, StreamClass>({
      original: () => Original,
      v5: () => KinesisStream,
      check: () => expect(resource("MyStreamStream").type).toBe(STREAM),
      cases: {
        "a stream": (KinesisStream, opts) => {
          new KinesisStream("MyStream", {}, opts);
        },
        "a stream transformed": (KinesisStream, opts) => {
          new KinesisStream(
            "MyStream",
            {
              transform: {
                stream: { retentionPeriod: 48, tags: { team: "data" } },
              },
            },
            opts,
          );
        },
        "subscribers given as function arns": {
          original: (opts) => {
            const stream = new Original("MyStream", {}, opts);
            stream.subscribe("Indexer", FUNCTION_ARN, {
              ...filters,
              transform: { eventSourceMapping: { batchSize: 5 } },
            });
            stream.subscribe("Auditor", FUNCTION_ARN);
          },
          v5: (opts) =>
            new KinesisStream(
              "MyStream",
              {
                transform: {
                  eventSourceMapping: (args, _opts, _name, subscriber) => {
                    if (subscriber === "Indexer") args.batchSize = 5;
                  },
                },
              },
              opts,
            )
              .subscribe("Indexer", FUNCTION_ARN, filters)
              .subscribe("Auditor", FUNCTION_ARN),
          unclaimed: [
            `${WRAPPER}::MyStreamSubscriberAuditor`,
            `${WRAPPER}::MyStreamSubscriberIndexer`,
          ],
          check: () =>
            expect(
              resource("MyStreamEventSourceMappingIndexer").inputs,
            ).toEqual({
              eventSourceArn: createdArn(),
              functionName: FUNCTION_ARN,
              filterCriteria: {
                filters: [{ pattern: JSON.stringify(filters.filters[0]) }],
              },
              startingPosition: "LATEST",
              batchSize: 5,
            }),
        },
        "a subscriber created from a handler": {
          create: (KinesisStream, opts) => {
            new KinesisStream("MyStream", {}, opts).subscribe(
              "Indexer",
              "src/indexer.handler",
            );
          },
          unclaimed: [`${WRAPPER}::MyStreamSubscriberIndexer`],
          changed: described,
          check: () =>
            expect(
              resource("MyStreamEventSourceMappingIndexer").parent,
            ).toMatch(/sst:aws:KinesisStream::MyStream$/),
        },
        "a subscriber created from function args": {
          create: (KinesisStream, opts) => {
            new KinesisStream("MyStream", {}, opts).subscribe("Indexer", {
              handler: "src/indexer.handler",
              timeout: "60 seconds",
              environment: { MODE: "index" },
            });
          },
          unclaimed: [`${WRAPPER}::MyStreamSubscriberIndexer`],
          changed: described,
          check: () =>
            expect(
              resource("MyStreamSubscriberIndexerFunction").inputs.timeout,
            ).toBe(60),
        },
        "a subscriber that links its stream": {
          create: (KinesisStream, opts) => {
            const stream = new KinesisStream("MyStream", {}, opts);
            stream.subscribe("Indexer", {
              handler: "src/indexer.handler",
              link: [stream],
            });
          },
          unclaimed: [`${WRAPPER}::MyStreamSubscriberIndexer`],
          changed: described,
        },
        // SST 4 takes a function's ARN, not the function component
        "a subscriber that's a function's ARN, in an output": {
          create: async (KinesisStream, opts) => {
            const { Function } = await import(
              "../../fixtures/v4/components/aws/function"
            );
            new KinesisStream("MyStream", {}, opts).subscribe(
              "Indexer",
              new Function("MyIndexer", { handler: "src/indexer.handler" }).arn,
            );
          },
          unclaimed: [`${WRAPPER}::MyStreamSubscriberIndexer`],
        },
        "a subscriber in sst dev": {
          create: (KinesisStream, opts) => {
            // @ts-ignore
            global.$dev = true;
            new KinesisStream("MyStream", {}, opts).subscribe(
              "Indexer",
              "src/indexer.handler",
            );
          },
          unclaimed: [`${WRAPPER}::MyStreamSubscriberIndexer`],
          changed: described,
        },
      },
    });

    // The static `subscribe` only has a stream ARN, so it names the
    // subscriber's component after the stream in it. A V5 stream that
    // references that stream takes the subscriber over, whatever it's called.
    it("a subscriber added with the static subscribe", async () => {
      expect(
        await pulumi.takesOver(
          () =>
            Original.subscribe("Indexer", streamArn("orders"), FUNCTION_ARN),
          () =>
            KinesisStream.get("ExternalOrders", "orders").subscribe(
              "Indexer",
              FUNCTION_ARN,
            ),
        ),
      ).toEqual({
        unclaimed: [`${WRAPPER}::OrdersSubscriberIndexer`],
        changed: [],
        unordered: [],
        revealed: [],
      });
      expect(
        resource("ExternalOrdersEventSourceMappingIndexer").inputs
          .eventSourceArn,
      ).toBe(streamArn("orders"));
    });

    // From a handler, the function was described after the stream's own name,
    // as the static `subscribe` named its component. It's described after the
    // component `get` created now. `get` takes the ARN the static `subscribe`
    // was given.
    it("a function subscribed with the static subscribe", async () => {
      const result = await pulumi.takesOver(
        () =>
          Original.subscribe(
            "Indexer",
            streamArn("orders"),
            "src/indexer.handler",
          ),
        () =>
          KinesisStream.get("ExternalOrders", streamArn("orders")).subscribe(
            "Indexer",
            "src/indexer.handler",
          ),
      );
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["OrdersSubscriberIndexerFunction", ["description"]],
      ]);
      expect(result.unclaimed).toEqual([`${WRAPPER}::OrdersSubscriberIndexer`]);
      expect(
        resource("ExternalOrdersSubscriberIndexerFunction").inputs.description,
      ).toBe("Subscribed to ExternalOrders");
      expect(resource("ExternalOrdersStream").options.id).toBe("orders");
    });

    // The static `subscribe` given the ARN of a stream in the app: the 5.0
    // stream subscribes itself
    it("a stream of the app subscribed to with the static subscribe", async () => {
      const result = await pulumi.takesOver(
        () => {
          const stream = new Original("MyStream");
          Original.subscribe("Mirror", stream.arn, FUNCTION_ARN);
        },
        () => new KinesisStream("MyStream").subscribe("Mirror", FUNCTION_ARN),
      );
      expect(result.changed).toEqual([]);
      expect(result.unclaimed).toEqual([
        expect.stringMatching(
          /^sst:aws:KinesisStreamLambdaSubscriber::\w+SubscriberMirror$/,
        ),
      ]);
    });

    // The static `subscribe` created its subscriber with the app's provider,
    // at the top of the app. `get` gives the component its options, and the
    // component gives them to the subscriber.
    it("a static subscriber, with get's options", async () => {
      const { ComponentResource } = await import("@pulumi/pulumi");
      const { Provider } = await import("@pulumi/aws");
      const original = () =>
        Original.subscribe("Indexer", streamArn("orders"), FUNCTION_ARN);
      const withParent = await pulumi.takesOver(original, () =>
        KinesisStream.get("Orders", "orders", {
          parent: new ComponentResource("test:index:Parent", "Parent", {}),
        }).subscribe("Indexer", FUNCTION_ARN),
      );
      expect(withParent.changed).toEqual([]);
      const withProvider = await pulumi.takesOver(original, () =>
        KinesisStream.get("Orders", "orders", {
          provider: new Provider("West", { region: "us-west-2" }),
        }).subscribe("Indexer", FUNCTION_ARN),
      );
      expect(
        withProvider.changed
          .filter((c) => c.fields.includes("options.provider"))
          .map((c) => c.name),
      ).toEqual(["OrdersSubscriberIndexerEventSourceMapping"]);
    });

    // SST 4 gave the subscribers only a provider passed to the stream itself,
    // so one it took from a parent didn't reach them. The 5.0 ones have the
    // stream's, so a switch replaces them, as "Switch from" says.
    it("replaces the subscribers of one that takes its provider from a parent", async () => {
      const { ComponentResource } = await import("@pulumi/pulumi");
      const { Provider } = await import("@pulumi/aws");
      const inParent = (C: any) => {
        const parent = new ComponentResource(
          "test:index:Parent",
          "Parent",
          {},
          {
            providers: { aws: new Provider("East", { region: "us-east-1" }) },
          },
        );
        new C("MyStream", {}, { parent }).subscribe(
          "Indexer",
          "src/indexer.handler",
        );
      };
      const result = await pulumi.takesOver(
        () => inParent(Original),
        () => inParent(KinesisStream),
      );
      const replaced = result.changed
        .filter((c) => c.fields.includes("options.provider"))
        .map((c) => c.name);
      expect(replaced).toContain("MyStreamSubscriberIndexerEventSourceMapping");
      expect(replaced).toContain("MyStreamSubscriberIndexerLogGroup");
      expect(result.changed.map((c) => c.name)).not.toContain("MyStreamStream");
    });
  });

  it("creates an on-demand stream, and links its name and every permission", async () => {
    const stream = new KinesisStream("MyStream");
    await pulumi.settle();
    expect(resource("MyStreamStream").inputs.streamModeDetails).toEqual({
      streamMode: "ON_DEMAND",
    });
    const link = stream.link();
    expect(await pulumi.resolve(link.properties)).toEqual({
      name: await pulumi.resolve(stream.name),
    });
    const [allowed] = await pulumi.resolve(link.include);
    expect(allowed.actions).toEqual(["kinesis:*"]);
    expect(allowed.resources).toEqual([createdArn()]);
  });

  it("keeps each subscriber's resources inside the stream, by its name", async () => {
    const stream = new KinesisStream("MyStream");
    expect(stream.subscribe("Indexer", "src/indexer.handler")).toBe(stream);
    await pulumi.settle();
    expect(Object.keys(stream.nodes.eventSourceMapping)).toEqual(["Indexer"]);
    expect(Object.keys(stream.nodes.subscriber)).toEqual(["Indexer"]);
    const policy = JSON.stringify(
      resource("MyStreamSubscriberIndexerRole").inputs.inlinePolicies,
    );
    expect(policy).toContain("kinesis:SubscribeToShard");
    expect(policy).toContain(createdArn());
    expect(
      resource("MyStreamSubscriberIndexerFunction").inputs.description,
    ).toBe("Subscribed to MyStream");
  });

  it("turns down a subscriber without a name, twice, with its own transform or in an output", async () => {
    const stream = new KinesisStream("MyStream");
    expect(() => (stream.subscribe as any)("src/indexer.handler")).toThrow(
      /A subscriber of the "MyStream" stream needs a name/,
    );
    expect(() =>
      (stream.subscribe as any)("src/indexer.handler", { filters: [] }),
    ).toThrow(/needs a name/);
    stream.subscribe("Indexer", FUNCTION_ARN);
    expect(() => stream.subscribe("Indexer", FUNCTION_ARN)).toThrow(/Indexer/);
    expect(() =>
      stream.subscribe("Other", FUNCTION_ARN, {
        transform: { eventSourceMapping: {} },
      } as any),
    ).toThrow(/transform/);
    const errors = await applyErrors(() => {
      stream.subscribe("Late", output("src/indexer.handler"));
    }, pulumi.settle);
    expect(errors.join("\n")).toMatch(
      /The subscriber "Late" of the "MyStream" stream/,
    );
  });

  it("says to use get in place of the static subscribe", () => {
    expect(() =>
      KinesisStream.subscribe(
        "Indexer",
        streamArn("orders"),
        "src/indexer.handler",
      ),
    ).toThrow(
      /reference it with "get" and subscribe to that: sst\.aws\.KinesisStream\.get\(/,
    );
  });

  it("subscribes to a stream it looks up by name", async () => {
    const stream = KinesisStream.get("Orders", "orders").subscribe(
      "Indexer",
      FUNCTION_ARN,
    );
    await pulumi.settle();
    expect(resource("OrdersStream")).toMatchObject({
      kind: "read",
      options: { id: "orders" },
    });
    expect(
      resource("OrdersEventSourceMappingIndexer").inputs.eventSourceArn,
    ).toBe(streamArn("orders"));
    expect(await pulumi.resolve(stream.name)).toBe("orders");
  });
});
