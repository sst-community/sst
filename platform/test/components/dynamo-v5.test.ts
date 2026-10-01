import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ComponentResourceOptions, output } from "@pulumi/pulumi";
import { mockPulumi, type TakeoverWay } from "../helpers/graph";

const TABLE = "aws:dynamodb/table:Table";
// What Dynamo wraps each subscription in: nothing in AWS behind it
const WRAPPER = "sst:aws:DynamoLambdaSubscriber";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const streamArn = (table: string) =>
  `arn:aws:dynamodb:us-east-1:123456789012:table/${table}/stream/2024-02-25T23:17:55.264`;

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type !== TABLE) return {};
    // A table that's looked up has the name it has, and here a stream
    if (args.id)
      return { name: args.id, streamEnabled: true, streamArn: streamArn(args.id) };
    return { streamArn: args.inputs.streamEnabled ? streamArn(args.name) : "" };
  },
});

type DynamoClass =
  | typeof import("../../src/components/aws/dynamo").Dynamo
  | typeof import("../../src/components/aws/dynamo-v5").DynamoV5;
type DynamoArgs = import("../../src/components/aws/dynamo").DynamoArgs;
type DynamoV5Args = import("../../src/components/aws/dynamo-v5").DynamoV5Args;

const keys = {
  fields: { userId: "string", noteId: "string" },
  primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
} satisfies DynamoArgs;
const streaming = { ...keys, stream: "new-and-old-images" } satisfies DynamoArgs;

describe("DynamoV5", () => {
  let Dynamo: typeof import("../../src/components/aws/dynamo").Dynamo;
  let DynamoV5: typeof import("../../src/components/aws/dynamo-v5").DynamoV5;

  beforeAll(async () => {
    Dynamo = (await import("../../src/components/aws/dynamo")).Dynamo;
    DynamoV5 = (await import("../../src/components/aws/dynamo-v5")).DynamoV5;
    await import("../../src/components/aws/takeover/dynamo");
    await import("../../src/components/aws/takeover/function");
  });

  beforeEach(() => pulumi.reset());

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;

  // Each case deploys a Dynamo, then the same thing as a DynamoV5. Everything
  // the Dynamo created has to be kept by the DynamoV5, with the same inputs.
  // For a table that matters more than for most: replacing it loses its data.
  describe("takes over a deployed Dynamo", () => {
    const sameArgs: Record<string, DynamoArgs & DynamoV5Args> = {
      "hash key only": {
        fields: { userId: "string" },
        primaryIndex: { hashKey: "userId" },
      },
      "hash and range key": keys,
      "every field type": {
        fields: { id: "string", count: "number", blob: "binary" },
        primaryIndex: { hashKey: "id", rangeKey: "count" },
        globalIndexes: { Blobs: { hashKey: "blob" } },
      },
      "global indexes": {
        fields: {
          userId: "string",
          noteId: "string",
          createdAt: "number",
          region: "string",
          category: "string",
          status: "string",
        },
        primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
        globalIndexes: {
          HashOnly: { hashKey: "noteId" },
          WithRange: { hashKey: "userId", rangeKey: "createdAt" },
          KeysOnly: { hashKey: "region", projection: "keys-only" },
          Included: {
            hashKey: "category",
            rangeKey: "createdAt",
            projection: ["noteId", "status"],
          },
          All: { hashKey: "status", projection: "all" },
          CompositeHash: {
            hashKey: ["region", "category"],
            rangeKey: "createdAt",
          },
          CompositeRange: {
            hashKey: "region",
            rangeKey: ["createdAt", "status"],
            projection: "keys-only",
          },
          CompositeHashOnly: { hashKey: ["category", "status"] },
        },
      },
      "local indexes": {
        fields: { userId: "string", noteId: "string", createdAt: "number" },
        primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
        localIndexes: {
          ByCreated: { rangeKey: "createdAt" },
          KeysOnly: { rangeKey: "createdAt", projection: "keys-only" },
          Included: { rangeKey: "createdAt", projection: ["noteId"] },
        },
      },
      "stream of keys": { ...keys, stream: "keys-only" },
      "stream of new images": { ...keys, stream: "new-image" },
      "stream of old images": { ...keys, stream: "old-image" },
      "stream of new and old images": streaming,
      "ttl and deletion protection": {
        ...keys,
        ttl: "expireAt",
        deletionProtection: true,
      },
      "deletion protection switched off": { ...keys, deletionProtection: false },
      "args given as outputs": {
        fields: output({ userId: "string", createdAt: "number" } as const),
        primaryIndex: output({ hashKey: "userId", rangeKey: output("createdAt") }),
        globalIndexes: output({
          ByCreated: output({
            hashKey: "createdAt",
            projection: [output("userId")],
          }),
        }),
        localIndexes: output({ Recent: { rangeKey: "createdAt" } }),
        stream: output("old-image" as const),
        ttl: output("expireAt"),
        deletionProtection: output(true),
      },
      "transform as an object": {
        ...keys,
        transform: {
          table: {
            name: "custom-name",
            billingMode: "PROVISIONED",
            readCapacity: 5,
            writeCapacity: 5,
            pointInTimeRecovery: { enabled: false },
            tags: { team: "storage" },
          },
        },
      },
      "transform as a function": {
        ...keys,
        transform: {
          table: (args, opts) => {
            args.tableClass = "STANDARD_INFREQUENT_ACCESS";
            args.globalSecondaryIndexes = [
              { name: "Mine", hashKey: "noteId", projectionType: "ALL" },
            ];
            opts.protect = true;
          },
        },
      },
    };

    const filters = {
      filters: [{ dynamodb: { Keys: { CustomerName: { S: ["AnyCompany"] } } } }],
    };
    const subscriber = {
      handler: "src/indexer.handler",
      timeout: "60 seconds" as const,
      environment: { MODE: "index" },
    };
    // A subscriber's function is kept. Its description is updated: it names
    // the table now, where it named the subscriber component.
    const described: [string, string[]][] = [
      ["MyTableSubscriberIndexerFunctionFunction", ["description"]],
    ];

    // `Dynamo.get` gives its options to the table it looks up and not to the
    // component, which is at the top of the app wherever it's asked to be.
    // `DynamoV5.get` puts the component where it's asked to, so the old one,
    // which has nothing in AWS behind it, goes.
    const leftAtTheTop = (way: TakeoverWay) =>
      way === "inside another component" ? ["sst:aws:Dynamo::MyTable"] : [];

    pulumi.takeoverCases({
      original: () => Dynamo,
      v5: () => DynamoV5,
      cases: {
        ...Object.fromEntries(
          Object.entries(sameArgs).map(([name, args]) => [
            name,
            {
              create: (Dynamo: DynamoClass, opts?: ComponentResourceOptions) =>
                new Dynamo("MyTable", args, opts),
              check: () =>
                expect(resource("MyTableTable")).toMatchObject({
                  kind: "register",
                  type: TABLE,
                }),
            },
          ]),
        ),
        // Dynamo looks the table up beside the component. DynamoV5 looks the
        // same table up inside it, which this can't match: a lookup has no
        // aliases. Nothing is deployed for a lookup, so nothing is deleted.
        "a table referenced with get": {
          create: (Dynamo, opts) =>
            Dynamo.get("MyTable", "app-dev-mytable", opts),
          unclaimed: (way) => [`${TABLE}::MyTableTable`, ...leftAtTheTop(way)],
          check: () =>
            expect(resource("MyTableTable")).toMatchObject({
              kind: "read",
              options: { id: "app-dev-mytable" },
            }),
        },
        // A Dynamo keeps each subscription in a component at the top of the
        // app, wherever the table is. A DynamoV5 keeps them inside, so those
        // components go, and what was in them is kept.
        "subscribers given as function arns": {
          original: (opts) => {
            const table = new Dynamo("MyTable", streaming, opts);
            table.subscribe("Indexer", FUNCTION_ARN, {
              ...filters,
              transform: { eventSourceMapping: { batchSize: 5 } },
            });
            table.subscribe("Auditor", FUNCTION_ARN);
          },
          v5: (opts) =>
            new DynamoV5(
              "MyTable",
              {
                ...streaming,
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
            `${WRAPPER}::MyTableSubscriberAuditor`,
            `${WRAPPER}::MyTableSubscriberIndexer`,
          ],
          check: () =>
            expect(resource("MyTableEventSourceMappingIndexer").inputs).toEqual(
              {
                eventSourceArn: streamArn("MyTableTable"),
                functionName: FUNCTION_ARN,
                filterCriteria: {
                  filters: [{ pattern: JSON.stringify(filters.filters[0]) }],
                },
                startingPosition: "LATEST",
                batchSize: 5,
              },
            ),
        },
        "a subscriber created from a handler": {
          create: (Dynamo, opts) =>
            new Dynamo("MyTable", streaming, opts).subscribe(
              "Indexer",
              "src/indexer.handler",
            ),
          unclaimed: [`${WRAPPER}::MyTableSubscriberIndexer`],
          changed: described,
          check: () => {
            // The function and what it's made of are now inside the table
            expect(
              pulumi.resources
                .filter((r) => r.name.startsWith("MyTableSubscriberIndexer"))
                .map((r) => r.name)
                .sort(),
            ).toEqual([
              "MyTableSubscriberIndexer",
              "MyTableSubscriberIndexerCode",
              "MyTableSubscriberIndexerFunction",
              "MyTableSubscriberIndexerLogGroup",
              "MyTableSubscriberIndexerRole",
            ]);
            expect(resource("MyTableEventSourceMappingIndexer").parent).toMatch(
              /sst:aws:DynamoV5::MyTable$/,
            );
          },
        },
        "a subscriber created from function args": {
          create: (Dynamo, opts) =>
            new Dynamo("MyTable", streaming, opts).subscribe(
              "Indexer",
              subscriber,
            ),
          unclaimed: [`${WRAPPER}::MyTableSubscriberIndexer`],
          changed: described,
          check: () =>
            expect(
              resource("MyTableSubscriberIndexerFunction").inputs.timeout,
            ).toBe(60),
        },
        "a subscriber of a table referenced with get": {
          create: (Dynamo, opts) =>
            Dynamo.get("MyTable", "orders", opts).subscribe(
              "Indexer",
              FUNCTION_ARN,
            ),
          // The lookup, as above
          unclaimed: (way) => [
            `${TABLE}::MyTableTable`,
            `${WRAPPER}::MyTableSubscriberIndexer`,
            ...leftAtTheTop(way),
          ],
          // Dynamo doesn't give the subscriber the provider, so it's created
          // with the app's. DynamoV5 creates it with the one the table is
          // looked up with, which replaces the event source mapping.
          changed: (way) =>
            way === "with another provider"
              ? [
                  [
                    "MyTableSubscriberIndexerEventSourceMapping",
                    ["options.provider"],
                  ],
                ]
              : [],
        },
      },
    });

    // The static `subscribe` only has a stream ARN, so it names the
    // subscriber's component after the table in it. A DynamoV5 that
    // references that table takes the subscriber over, whatever it's called.
    it("a subscriber added with the static subscribe", async () => {
      expect(
        await pulumi.takesOver(
          () => Dynamo.subscribe("Indexer", streamArn("orders"), FUNCTION_ARN),
          () =>
            DynamoV5.get("ExternalOrders", "orders").subscribe(
              "Indexer",
              FUNCTION_ARN,
            ),
        ),
      ).toEqual({
        unclaimed: [`${WRAPPER}::OrdersSubscriberIndexer`],
        changed: [],
      });
      expect(
        resource("ExternalOrdersEventSourceMappingIndexer").inputs.eventSourceArn,
      ).toBe(streamArn("orders"));
    });

    it("a static subscriber, when the component is named after the table", async () => {
      const result = await pulumi.takesOver(
        () =>
          Dynamo.subscribe("Indexer", streamArn("orders"), "src/indexer.handler"),
        () =>
          DynamoV5.get("Orders", "orders").subscribe(
            "Indexer",
            "src/indexer.handler",
          ),
      );

      expect(result.unclaimed).toEqual([`${WRAPPER}::OrdersSubscriberIndexer`]);
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["OrdersSubscriberIndexerFunctionFunction", ["description"]],
      ]);
    });
  });

  it("creates the table from its fields and indexes", async () => {
    new DynamoV5("MyTable", {
      fields: { userId: "string", createdAt: "number", region: "string" },
      primaryIndex: { hashKey: "userId", rangeKey: "createdAt" },
      globalIndexes: {
        ByRegion: { hashKey: ["region", "userId"], projection: "keys-only" },
      },
      localIndexes: { Recent: { rangeKey: "createdAt", projection: ["region"] } },
      stream: "new-and-old-images",
      ttl: "expireAt",
    });
    await pulumi.settle();

    expect(resource("MyTableTable").inputs).toMatchObject({
      attributes: [
        { name: "userId", type: "S" },
        { name: "createdAt", type: "N" },
        { name: "region", type: "S" },
      ],
      billingMode: "PAY_PER_REQUEST",
      hashKey: "userId",
      rangeKey: "createdAt",
      streamEnabled: true,
      streamViewType: "NEW_AND_OLD_IMAGES",
      pointInTimeRecovery: { enabled: true },
      ttl: { attributeName: "expireAt", enabled: true },
      globalSecondaryIndexes: [
        {
          name: "ByRegion",
          keySchemas: [
            { attributeName: "region", keyType: "HASH" },
            { attributeName: "userId", keyType: "HASH" },
          ],
          projectionType: "KEYS_ONLY",
        },
      ],
      localSecondaryIndexes: [
        {
          name: "Recent",
          rangeKey: "createdAt",
          projectionType: "INCLUDE",
          nonKeyAttributes: ["region"],
        },
      ],
    });
  });

  it("merges a transform into the table's defaults", async () => {
    new DynamoV5("MyTable", {
      ...keys,
      transform: { table: { pointInTimeRecovery: { recoveryPeriodInDays: 7 } } },
    });
    await pulumi.settle();

    expect(resource("MyTableTable").inputs.pointInTimeRecovery).toEqual({
      enabled: true,
      recoveryPeriodInDays: 7,
    });
  });

  it("holds the table and each subscriber's resources on nodes", async () => {
    const table = new DynamoV5("MyTable", streaming);
    expect(table.nodes.table.constructor.name).toBe("Table");
    expect(Object.keys(table.nodes.eventSourceMapping)).toEqual([]);

    table
      .subscribe("Indexer", "src/indexer.handler")
      .subscribe("Auditor", FUNCTION_ARN);
    await pulumi.settle();

    expect(Object.keys(table.nodes.eventSourceMapping).sort()).toEqual([
      "Auditor",
      "Indexer",
    ]);
    const fn = await pulumi.resolve(table.nodes.subscriber.Indexer);
    expect(fn.constructor.name).toBe("FunctionV5");
  });

  it("lets a subscriber read the table's stream", async () => {
    new DynamoV5("MyTable", streaming).subscribe("Indexer", "src/indexer.handler");
    await pulumi.settle();

    expect(resource("MyTableSubscriberIndexerFunction").inputs.description).toBe(
      "Subscribed to MyTable",
    );
    const policy = JSON.parse(
      resource("MyTableSubscriberIndexerRole").inputs.inlinePolicies[0].policy,
    );
    expect(policy.statements).toContainEqual({
      effect: "Allow",
      actions: [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:ListStreams",
      ],
      resources: [streamArn("MyTableTable")],
    });
    expect(resource("MyTableEventSourceMappingIndexer").inputs).toMatchObject({
      eventSourceArn: streamArn("MyTableTable"),
      startingPosition: "LATEST",
    });
  });

  it("applies the table's transform to a subscriber's function", async () => {
    new DynamoV5("MyTable", {
      ...streaming,
      transform: { subscriber: { memory: "2048 MB" } },
    }).subscribe("Indexer", "src/indexer.handler");
    await pulumi.settle();

    expect(resource("MyTableSubscriberIndexerFunction").inputs.memorySize).toBe(
      2048,
    );
  });

  it("references a table by its name", async () => {
    const table = DynamoV5.get("MyTable", "app-dev-mytable");
    await pulumi.settle();

    expect(pulumi.resources.map((r) => [r.kind, r.name])).toEqual([
      ["register", "MyTable"],
      ["read", "MyTableTable"],
    ]);
    expect(await pulumi.resolve(table.name)).toBe("app-dev-mytable");
  });

  it("uses an existing table passed as a resource", async () => {
    const { dynamodb } = await import("@pulumi/aws");
    const mine = new dynamodb.Table("Mine", {
      attributes: [{ name: "id", type: "S" }],
      hashKey: "id",
    });
    await pulumi.settle();
    pulumi.reset();

    const table = new DynamoV5("MyTable", { ...keys, existing: { table: mine } });
    await pulumi.settle();

    expect(table.nodes.table).toBe(mine);
    expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:DynamoV5"]);
  });

  it("links with its name and permission to use the table", async () => {
    const { Link } = await import("../../src/components/link");
    const table = new DynamoV5("MyTable", keys);
    await pulumi.settle();

    expect(Link.isLinkable(table)).toBe(true);
    const definition = (table as any).getSSTLink();
    expect(Object.keys(definition.properties)).toEqual(["name"]);
    expect(definition.include).toMatchObject([
      { type: "aws.permission", actions: ["dynamodb:*"] },
    ]);
    expect(await pulumi.resolve(definition.include[0].resources)).toEqual([
      "arn:aws:mock:us-east-1:123456789012:MyTableTable",
      "arn:aws:mock:us-east-1:123456789012:MyTableTable/*",
    ]);
  });

  it("says a subscriber needs a name", () => {
    const table = new DynamoV5("MyTable", streaming);
    expect(() => (table as any).subscribe("src/indexer.handler")).toThrow(
      /A subscriber of the "MyTable" table needs a name/,
    );
    expect(() =>
      (table as any).subscribe({ handler: "src/indexer.handler" }, {}),
    ).toThrow(/needs a name/);
  });

  it("says where a subscriber's transform goes", () => {
    const table = new DynamoV5("MyTable", streaming);
    expect(() =>
      table.subscribe("Indexer", FUNCTION_ARN, { transform: {} } as any),
    ).toThrow(
      /"transform" isn't an option here. Use the "transform" of "MyTable": its "subscriber" and "eventSourceMapping" apply to every subscriber/,
    );
  });

  it("rejects two subscribers with the same name", async () => {
    const table = new DynamoV5("MyTable", streaming).subscribe(
      "Indexer",
      FUNCTION_ARN,
    );
    await pulumi.settle();
    expect(() => table.subscribe("Indexer", FUNCTION_ARN)).toThrow(
      /already has a subscriber named "Indexer"/,
    );
  });
});
