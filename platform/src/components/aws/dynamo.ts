import {
  ComponentResourceOptions,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { dynamodb, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
} from "../parts-component";
import { ifSet, usedAsItIs, getArgs } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { Function } from "./function";
import { parseDynamoArn } from "./helpers/arn";
import {
  assertNamedSubscriber,
  eventSourceSubscriber,
  filterCriteria,
} from "./helpers/event-source";
import type { FunctionInput } from "./helpers/function-part";
import { permission } from "./permission";

const parts = () => ({
  /**
   * The Amazon DynamoDB Table.
   */
  table: dynamodb.Table,
  /**
   * The functions subscribed to the table's stream, by subscriber name.
   */
  subscriber: many(deferred(Function)),
  /**
   * The Lambda event source mappings that send the stream's records to each
   * subscriber, by subscriber name.
   */
  eventSourceMapping: many(lambda.EventSourceMapping),
});

export interface DynamoArgs extends ComponentArgs<typeof parts> {
  /**
   * An object defining the fields of the table that'll be used to create indexes. The key is the name of the field and the value is the type.
   *
   * :::note
   * You don't need to define all your fields here, just the ones you want to use for indexes.
   * :::
   *
   * While you can have fields field types other than `string`, `number`, and `binary`; you can only use these types for your indexes.
   *
   * :::caution
   * Field types cannot be changed after table creation. Any changes to field types will be ignored.
   * :::
   *
   * @example
   * ```js
   * {
   *   fields: {
   *     userId: "string",
   *     noteId: "string"
   *   }
   * }
   * ```
   */
  fields: Input<Record<string, "string" | "number" | "binary">>;
  /**
   * Define the table's primary index. You can only have one primary index.
   *
   * @example
   * ```js
   * {
   *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" }
   * }
   * ```
   */
  primaryIndex: Input<{
    /**
     * The hash key field of the index. This field needs to be defined in the `fields`.
     */
    hashKey: Input<string>;
    /**
     * The range key field of the index. This field needs to be defined in the `fields`.
     */
    rangeKey?: Input<string>;
  }>;
  /**
   * Configure the table's global secondary indexes.
   *
   * You can have up to 20 global secondary indexes per table. And each global secondary index should have a unique name.
   *
   * @example
   *
   * ```js
   * {
   *   globalIndexes: {
   *     CreatedAtIndex: { hashKey: "userId", rangeKey: "createdAt" }
   *   }
   * }
   * ```
   *
   * Use an array to create a composite key with multiple attributes.
   *
   * ```js
   * {
   *   globalIndexes: {
   *     RegionCategoryIndex: {
   *       hashKey: ["region", "category"],
   *       rangeKey: "createdAt"
   *     }
   *   }
   * }
   * ```
   */
  globalIndexes?: Input<
    Record<
      string,
      Input<{
        /**
         * The hash key field of the index. This field needs to be defined in the `fields`.
         *
         * You can also pass in an array of field names to create a composite key with
         * up to 4 attributes using the [multi-attribute keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.DesignPattern.MultiAttributeKeys.html) pattern.
         *
         * @example
         * ```js
         * {
         *   hashKey: ["region", "category"]
         * }
         * ```
         */
        hashKey: Input<string | string[]>;
        /**
         * The range key field of the index. This field needs to be defined in the `fields`.
         *
         * You can also pass in an array of field names to create a composite key with
         * up to 4 attributes using the [multi-attribute keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.DesignPattern.MultiAttributeKeys.html) pattern.
         *
         * @example
         * ```js
         * {
         *   rangeKey: ["createdAt", "status"]
         * }
         * ```
         */
        rangeKey?: Input<string | string[]>;
        /**
         * The fields to project into the index.
         * @default `"all"`
         * @example
         * Project only the key fields: `userId` and `createdAt`.
         * ```js
         * {
         *   hashKey: "userId",
         *   rangeKey: "createdAt",
         *   projection: "keys-only"
         * }
         * ```
         *
         * Project the `noteId` field in addition to the key fields.
         * ```js
         * {
         *   hashKey: "userId",
         *   rangeKey: "createdAt",
         *   projection: ["noteId"]
         * }
         * ```
         */
        projection?: Input<"all" | "keys-only" | Input<string>[]>;
      }>
    >
  >;
  /**
   * Configure the table's local secondary indexes.
   *
   * Unlike global indexes, local indexes use the same `hashKey` as the `primaryIndex` of the table.
   *
   * You can have up to 5 local secondary indexes per table. And each local secondary index should have a unique name.
   *
   * @example
   * ```js
   * {
   *   localIndexes: {
   *     CreatedAtIndex: { rangeKey: "createdAt" }
   *   }
   * }
   * ```
   */
  localIndexes?: Input<
    Record<
      string,
      Input<{
        /**
         * The range key field of the index. This field needs to be defined in the `fields`.
         */
        rangeKey: Input<string>;
        /**
         * The fields to project into the index.
         * @default `"all"`
         * @example
         * Project only the key field: `createdAt`.
         * ```js
         * {
         *   rangeKey: "createdAt",
         *   projection: "keys-only"
         * }
         * ```
         *
         * Project the `noteId` field in addition to the key field.
         * ```js
         * {
         *   rangeKey: "createdAt",
         *   projection: ["noteId"]
         * }
         * ```
         */
        projection?: Input<"all" | "keys-only" | Input<string>[]>;
      }>
    >
  >;
  /**
   * Enable [DynamoDB Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html) for the table.
   *
   * :::note
   * Streams are not enabled by default since there's a cost attached to storing them.
   * :::
   *
   * When an item in the table is modified, the stream captures the information and sends it to your subscriber function.
   *
   * :::tip
   * The `new-and-old-images` stream type is a good default option since it has both the new and old items.
   * :::
   *
   * You can configure what will be written to the stream:
   *
   * - `new-image`: The entire item after it was modified.
   * - `old-image`: The entire item before it was modified.
   * - `new-and-old-images`:	Both the new and the old items. A good default to use since it contains all the data.
   * - `keys-only`: Only the keys of the fields of the modified items. If you are worried about the costs, you can use this since it stores the least amount of data.
   * @default Disabled
   * @example
   * ```js
   * {
   *   stream: "new-and-old-images"
   * }
   * ```
   */
  stream?: Input<
    "keys-only" | "new-image" | "old-image" | "new-and-old-images"
  >;
  /**
   * The field in the table to store the _Time to Live_ or TTL timestamp in. This field should
   * be of type `number`. When the TTL timestamp is reached, the item will be deleted.
   *
   * Read more about [Time to Live](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).
   *
   * @example
   * Here the TTL field in our table is called `expireAt`.
   * ```js
   * {
   *   ttl: "expireAt"
   * }
   * ```
   */
  ttl?: Input<string>;
  /**
   * Enable deletion protection for the table. When enabled, the table cannot be deleted.
   *
   * @example
   * ```js
   * {
   *   deletionProtection: true,
   * }
   * ```
   */
  deletionProtection?: Input<boolean>;
}

export interface DynamoSubscriberArgs {
  /**
   * Filter the records processed by the `subscriber` function.
   *
   * :::tip
   * You can pass in up to 5 different filters.
   * :::
   *
   * You can pass in up to 5 different filter policies. These will logically ORed together. Meaning that if any single policy matches, the record will be processed.
   *
   * :::tip
   * Learn more about the [filter rule syntax](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html#filtering-syntax).
   * :::
   *
   * @example
   * For example, if your DynamoDB table's stream contains the follow record.
   * ```js
   * {
   *   eventID: "1",
   *   eventVersion: "1.0",
   *   dynamodb: {
   *     ApproximateCreationDateTime: "1678831218.0",
   *     Keys: {
   *       CustomerName: {
   *           "S": "AnyCompany Industries"
   *       },
   *       NewImage: {
   *         AccountManager: {
   *           S: "Pat Candella"
   *         },
   *         PaymentTerms: {
   *           S: "60 days"
   *         },
   *         CustomerName: {
   *           S: "AnyCompany Industries"
   *         }
   *       },
   *       SequenceNumber: "111",
   *       SizeBytes: 26,
   *       StreamViewType: "NEW_IMAGE"
   *     }
   *   }
   * }
   * ```
   *
   * To process only those records where the `CustomerName` is `AnyCompany Industries`.
   *
   * ```js
   * {
   *   filters: [
   *     {
   *       dynamodb: {
   *         Keys: {
   *           CustomerName: {
   *             S: ["AnyCompany Industries"]
   *           }
   *         }
   *       }
   *     }
   *   ]
   * }
   * ```
   */
  filters?: Input<Input<Record<string, any>>[]>;
}

// A field of any other type is created as binary, as `Dynamo` creates it
const fieldType = (type: string) =>
  type === "string" ? "S" : type === "number" ? "N" : "B";

type Projection = "all" | "keys-only" | string[];
type IndexKey = string | string[];

/**
 * The `Dynamo` component lets you add an [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) table to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const table = new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string"
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" }
 * });
 * ```
 *
 * #### Add a global index
 *
 * ```ts {8-10} title="sst.config.ts"
 * new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string",
 *     createdAt: "number",
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
 *   globalIndexes: {
 *     CreatedAtIndex: { hashKey: "userId", rangeKey: "createdAt" }
 *   }
 * });
 * ```
 *
 * #### Add a local index
 *
 * ```ts {8-10} title="sst.config.ts"
 * new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string",
 *     createdAt: "number",
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
 *   localIndexes: {
 *     CreatedAtIndex: { rangeKey: "createdAt" }
 *   }
 * });
 * ```
 *
 * #### Subscribe to a DynamoDB Stream
 *
 * To subscribe to a [DynamoDB Stream](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html), start by enabling it.
 *
 * ```ts {7} title="sst.config.ts"
 * const table = new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string"
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
 *   stream: "new-and-old-images"
 * });
 * ```
 *
 * Then subscribe to it. Each subscriber has a name.
 *
 * ```ts title="sst.config.ts"
 * table.subscribe("MySubscriber", "src/subscriber.handler");
 * ```
 *
 * #### Link the table to a resource
 *
 * You can link the table to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [table]
 * });
 * ```
 *
 * Once linked, you can query the table through your app.
 *
 * ```ts title="app/page.tsx" {1,7}
 * import { Resource } from "sst";
 * import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
 *
 * const client = new DynamoDBClient();
 *
 * await client.send(new QueryCommand({
 *   TableName: Resource.MyTable.name,
 *   KeyConditionExpression: "userId = :userId",
 *   ExpressionAttributeValues: {
 *     ":userId": "my-user-id"
 *   }
 * }));
 * ```
 *
 * #### Use a table you already have
 *
 * Reference it by its name or ARN. The table is used the way it is: the component doesn't
 * configure it, and refuses `fields`, `primaryIndex` and the other settings of a table
 * next to it.
 *
 * ```ts title="sst.config.ts"
 * const table = sst.aws.Dynamo.get("MyTable", "app-dev-mytable");
 * ```
 *
 * #### Switch from SST 4's `sst.aws.Dynamo`
 *
 * Keep the name, and `sst migrate` moves it. The table and the
 * subscribers you've deployed are kept, as long as the subscribers have names.
 *
 * A few things are written differently:
 *
 * - `nodes.table` is the table, not an output of it.
 * - A subscriber's resources are parts of the table. `subscribe()` returns the table, and
 *   the subscriber's function and event source mapping are in `nodes.subscriber` and
 *   `nodes.eventSourceMapping` under its name. To change how they're created, use the
 *   table's `transform`.
 * - Every subscriber has a name. One that was added without a name isn't kept: remove it
 *   and deploy before you switch, then add it back with a name.
 * - A subscriber's handler or function args have to be a plain value, not an output:
 *   they decide what's created. A function you already have, or its ARN, can still be an
 *   output.
 * - A function's args are typed as
 *   [`sst.aws.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.Function`](/docs/component/aws/v5/function) takes them.
 * - A subscriber's function is described after the component, `Subscribed to MyTable`,
 *   where `sst.aws.Dynamo` named the component it kept the subscriber in: an update in
 *   place.
 * - A subscriber is created with the provider the table has. `sst.aws.Dynamo` gave it only
 *   a `provider` passed to the table itself, so if your table takes its provider from a
 *   parent component or from `providers`, the switch gives its subscribers that provider
 *   and keeps them, with the provider's default tags.
 * - To subscribe to the stream of a table that isn't in your app, reference the table with
 *   `get`, by its name or the stream ARN you gave the static `subscribe`, and subscribe
 *   to that. The static `subscribe` is refused with what to write.
 *
 *   ```ts title="sst.config.ts" del={1} ins={2-4}
 *   sst.aws.Dynamo.subscribe("MySubscriber", streamArn, "src/subscriber.handler");
 *   sst.aws.Dynamo
 *     .get("Orders", streamArn)
 *     .subscribe("MySubscriber", "src/subscriber.handler");
 *   ```
 * - `get` gives its options to the component, so a `provider` or `parent` you pass it
 *   applies to the table's subscribers too. `sst.aws.Dynamo.get` gave them to the table it
 *   looked up and to nothing else. If you pass `get` a `provider` and subscribe to that
 *   table, the switch gives the subscriber that provider and keeps it.
 * - A `transform` function for the table is given the table's keys, indexes, attributes
 *   and stream settings as outputs. To replace one, set it; to change it, use `.apply()`.
 */
export class Dynamo extends component("sst:aws:Dynamo", parts) {
  constructor(name: string, args: DynamoArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    // A table that's already deployed has its fields and indexes
    if (this.existingPart("table")) {
      usedAsItIs(
        args,
        [
          "fields",
          "primaryIndex",
          "globalIndexes",
          "localIndexes",
          "stream",
          "ttl",
          "deletionProtection",
        ],
        "table",
        `the "${name}" table`,
      );
      return;
    }

    const primaryIndex = output(args.primaryIndex);
    const stream = output(args.stream);

    this.part("table", {
      attributes: output(args.fields).apply((fields) =>
        Object.entries(fields).map(([name, type]) => ({
          name,
          type: fieldType(type),
        })),
      ),
      billingMode: "PAY_PER_REQUEST",
      hashKey: primaryIndex.hashKey,
      rangeKey: ifSet(primaryIndex.rangeKey),
      streamEnabled: stream.apply((stream) => Boolean(stream)),
      streamViewType: ifSet(stream, (stream) =>
        stream.toUpperCase().replaceAll("-", "_"),
      ),
      pointInTimeRecovery: { enabled: true },
      ttl:
        args.ttl === undefined
          ? undefined
          : { attributeName: args.ttl, enabled: true },
      globalSecondaryIndexes: output(args.globalIndexes).apply((indexes) =>
        Object.entries(indexes ?? {}).map(([name, index]) => ({
          name,
          ...indexKeys(index),
          ...projection(index.projection),
        })),
      ),
      localSecondaryIndexes: output(args.localIndexes).apply((indexes) =>
        Object.entries(indexes ?? {}).map(([name, index]) => ({
          name,
          rangeKey: index.rangeKey,
          ...projection(index.projection),
        })),
      ),
      deletionProtectionEnabled: args.deletionProtection,
    });
  }

  /**
   * The ARN of the DynamoDB Table.
   */
  public get arn() {
    return this.nodes.table.arn;
  }

  /**
   * The name of the DynamoDB Table.
   */
  public get name() {
    return this.nodes.table.name;
  }

  // The ARN of the table's stream, for something that reads from it
  private get streamArn() {
    const table = this.nodes.table;
    return all([table.streamEnabled, table.streamArn]).apply(
      ([enabled, arn]) => {
        if (!enabled)
          throw new VisibleError(
            `Cannot subscribe to the "${this.componentName}" table because its stream is not enabled. Set "stream" on the table.`,
          );
        return arn;
      },
    );
  }

  /**
   * Subscribe to the DynamoDB Stream of this table.
   *
   * :::note
   * You'll first need to enable the `stream` before subscribing to it.
   * :::
   *
   * @param name The name of the subscriber.
   * @param subscriber The function that'll be notified: the handler of one to create, its
   * args, a function component, or the ARN of a function you have. Only a function you
   * have, or its ARN, can be an output.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * table.subscribe("MySubscriber", "src/subscriber.handler");
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js title="sst.config.ts"
   * table.subscribe("MySubscriber", "src/subscriber.handler", {
   *   filters: [
   *     {
   *       dynamodb: {
   *         Keys: {
   *           CustomerName: {
   *             S: ["AnyCompany Industries"]
   *           }
   *         }
   *       }
   *     }
   *   ]
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js title="sst.config.ts"
   * table.subscribe("MySubscriber", {
   *   handler: "src/subscriber.handler",
   *   timeout: "60 seconds"
   * });
   * ```
   *
   * Or pass in the ARN of an existing Lambda function. A function you pass in, or its ARN,
   * isn't given permission to read the stream: link the table to a function in your app,
   * or give the function's role that permission yourself.
   *
   * ```js title="sst.config.ts"
   * table.subscribe("MySubscriber", "arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   *
   * To change how one subscriber is created, use the table's `transform`. Its function
   * form is given the subscriber's name.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.Dynamo("MyTable", {
   *   // ...
   *   transform: {
   *     eventSourceMapping: (args, opts, name, subscriber) => {
   *       if (subscriber === "MySubscriber") args.startingPosition = "TRIM_HORIZON";
   *     }
   *   }
   * });
   * ```
   */
  public subscribe(
    name: string,
    subscriber: FunctionInput,
    args: DynamoSubscriberArgs = {},
  ) {
    assertNamedSubscriber(
      `the "${this.componentName}" table`,
      "subscribe",
      name,
      subscriber,
    );
    this.assertNew("subscriber", "eventSourceMapping", name, args, [
      "subscriber",
      "eventSourceMapping",
    ]);

    eventSourceSubscriber(this.builder(), name, subscriber, {
      component: this.componentName,
      kind: "table",
      source: this.streamArn,
      actions: [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:ListStreams",
      ],
      mapping: {
        filterCriteria: filterCriteria(args.filters),
        startingPosition: "LATEST",
      },
    });

    return this;
  }

  /**
   * `sst.aws.Dynamo.subscribe` subscribed to a table's stream by its ARN. Reference the
   * table with `get` and subscribe to that.
   *
   * @internal
   */
  public static subscribe(..._args: unknown[]): never {
    throw new VisibleError(
      `To subscribe to the stream of a table that isn't in your app, reference the table with "get" and subscribe to that: sst.aws.Dynamo.get("MyTable", streamArn).subscribe("MySubscriber", "src/subscriber.handler").`,
    );
  }

  /**
   * Reference an existing DynamoDB Table with the given table name, its ARN, or the ARN of
   * its stream. This is useful when you create a table in one stage and want to share it
   * in another stage, or to subscribe to the stream of a table that isn't in your app.
   *
   * :::tip
   * You can use the `static get` method to share a table across stages.
   * :::
   *
   * @param name The name of the component.
   * @param table The name of the DynamoDB Table, its ARN, or the ARN of its stream.
   * @param opts Component resource options.
   *
   * @example
   * Imagine you create a table in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new table, you want to share the table from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const table = $app.stage === "frank"
   *   ? sst.aws.Dynamo.get("MyTable", "app-dev-mytable")
   *   : new sst.aws.Dynamo("MyTable", {
   *       fields: { userId: "string" },
   *       primaryIndex: { hashKey: "userId" }
   *     });
   * ```
   *
   * Here `app-dev-mytable` is the name of the DynamoDB Table created in the `dev` stage.
   * You can find this by outputting the table name in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   table: table.name
   * };
   * ```
   *
   * Subscribe to the stream of a table that isn't in your app.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.Dynamo
   *   .get("Orders", "orders-table")
   *   .subscribe("MySubscriber", "src/subscriber.handler");
   * ```
   */
  public static get(
    name: string,
    table: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    // A table is looked up by its name
    const tableName = output(table).apply((id) =>
      id.startsWith("arn:") ? parseDynamoArn(id).tableName : id,
    );
    const args: Partial<DynamoArgs> = { existing: { table: tableName } };
    return new Dynamo(name, getArgs(args) as DynamoArgs, opts);
  }

  /**
   * Linking a table gives the linked resource the table's name and permission
   * to use it.
   */
  public link() {
    return {
      properties: { name: this.name },
      include: [
        permission({
          actions: ["dynamodb:*"],
          resources: [this.arn, interpolate`${this.arn}/*`],
        }),
      ],
    };
  }
}

// A key made of several fields is written as a key schema
function indexKeys(index: { hashKey: IndexKey; rangeKey?: IndexKey }) {
  if (Array.isArray(index.hashKey) || Array.isArray(index.rangeKey))
    return {
      keySchemas: [
        ...[index.hashKey].flat().map((attributeName) => ({
          attributeName,
          keyType: "HASH",
        })),
        ...(index.rangeKey ? [index.rangeKey].flat() : []).map(
          (attributeName) => ({ attributeName, keyType: "RANGE" }),
        ),
      ],
    };
  return {
    hashKey: index.hashKey,
    ...(index.rangeKey ? { rangeKey: index.rangeKey } : {}),
  };
}

function projection(fields?: Projection) {
  if (fields === "keys-only") return { projectionType: "KEYS_ONLY" };
  if (Array.isArray(fields))
    return { projectionType: "INCLUDE", nonKeyAttributes: fields };
  return { projectionType: "ALL" };
}
