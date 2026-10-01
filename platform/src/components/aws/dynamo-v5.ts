import {
  ComponentResourceOptions,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { dynamodb, lambda } from "@pulumi/aws";
import { V5Args, component, deferred, many } from "../parts-component";
import { ifSet } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import type { DynamoArgs, DynamoSubscriberArgs } from "./dynamo";
import type { FunctionArgs, FunctionArn } from "./function";
import { FunctionV5 } from "./function-v5";
import { filterCriteria } from "./helpers/event-source";
import { functionPart } from "./helpers/function-part";
import { permission } from "./permission";

const parts = () => ({
  /**
   * The Amazon DynamoDB Table.
   */
  table: dynamodb.Table,
  /**
   * The functions subscribed to the table's stream, by subscriber name.
   */
  subscriber: many(deferred(FunctionV5)),
  /**
   * The Lambda event source mappings that send the stream's records to each
   * subscriber, by subscriber name.
   */
  eventSourceMapping: many(lambda.EventSourceMapping),
});

export interface DynamoV5Args extends V5Args<DynamoArgs, typeof parts> {}

export interface DynamoV5SubscriberArgs
  extends Omit<DynamoSubscriberArgs, "transform"> {}

// A field of any other type is created as binary, as `Dynamo` creates it
const fieldType = (type: string) =>
  type === "string" ? "S" : type === "number" ? "N" : "B";

type Projection = "all" | "keys-only" | string[];
type IndexKey = string | string[];

/**
 * The `DynamoV5` component lets you add an [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) table to your app.
 *
 * It takes the same args as [`Dynamo`](/docs/component/aws/dynamo). It's built from parts,
 * so every resource it creates can be transformed, is available in `nodes`, and can be
 * swapped for one you already have.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const table = new sst.aws.DynamoV5("MyTable", {
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
 * new sst.aws.DynamoV5("MyTable", {
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
 * new sst.aws.DynamoV5("MyTable", {
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
 * const table = new sst.aws.DynamoV5("MyTable", {
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
 * #### Switch from `Dynamo`
 *
 * Change `Dynamo` to `DynamoV5` and keep the name. The table and the subscribers you've
 * deployed are kept, as long as the subscribers have names.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const table = new sst.aws.Dynamo("MyTable", { fields, primaryIndex });
 * const table = new sst.aws.DynamoV5("MyTable", { fields, primaryIndex });
 * ```
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
 * - To subscribe to the stream of a table that isn't in your app, reference the table with
 *   `get` and subscribe to that, in place of the static `subscribe`.
 *
 *   ```ts title="sst.config.ts" del={1} ins={2-4}
 *   sst.aws.Dynamo.subscribe("MySubscriber", streamArn, "src/subscriber.handler");
 *   sst.aws.DynamoV5
 *     .get("Orders", "orders-table")
 *     .subscribe("MySubscriber", "src/subscriber.handler");
 *   ```
 * - `get` gives its options to the component, so a `provider` or `parent` you pass it
 *   applies to the table's subscribers too. `Dynamo.get` gave them to the table it looked
 *   up and to nothing else. If you pass `get` a `provider` and subscribe to that table,
 *   the subscriber is replaced on switch, to be created with that provider: remove it and
 *   deploy before you switch, then add it back.
 * - A `transform` function for the table is given the table's indexes, attributes and
 *   stream settings as outputs. To replace one, set it; to change it, use `.apply()`.
 *
 * #### Use a table you already have
 *
 * Reference it by its name.
 *
 * ```ts title="sst.config.ts"
 * const table = sst.aws.DynamoV5.get("MyTable", "app-dev-mytable");
 * ```
 */
export class DynamoV5 extends component("sst:aws:DynamoV5", parts) {
  constructor(
    name: string,
    args: DynamoV5Args,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    // A table that's already deployed has its fields and indexes
    if (this.existingPart("table")) return;

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
   * @param subscriber The function that'll be notified.
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
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * table.subscribe("MySubscriber", "arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   *
   * To change how one subscriber is created, use the table's `transform`. Its function
   * form is given the subscriber's name.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.DynamoV5("MyTable", {
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
    subscriber: Input<string | FunctionArgs | FunctionArn>,
    args: DynamoV5SubscriberArgs = {},
  ) {
    if (typeof name !== "string" || subscriber === undefined)
      throw new VisibleError(
        `A subscriber of the "${this.componentName}" table needs a name: subscribe("MySubscriber", "src/subscriber.handler").`,
      );
    this.assertNew("subscriber", "eventSourceMapping", name, args, [
      "subscriber",
      "eventSourceMapping",
    ]);

    const streamArn = this.streamArn;
    const fn = functionPart(this, "subscriber", name, subscriber, {
      description: `Subscribed to ${this.componentName}`,
      permissions: [
        {
          actions: [
            "dynamodb:DescribeStream",
            "dynamodb:GetRecords",
            "dynamodb:GetShardIterator",
            "dynamodb:ListStreams",
          ],
          resources: [streamArn],
        },
      ],
    });
    this.part("eventSourceMapping", name, {
      eventSourceArn: streamArn,
      functionName: fn.targetArn,
      filterCriteria: filterCriteria(args.filters),
      startingPosition: "LATEST",
    });

    return this;
  }

  /**
   * Reference an existing DynamoDB Table with the given table name. This is useful when you
   * create a table in one stage and want to share it in another stage, or to subscribe to
   * the stream of a table that isn't in your app.
   *
   * :::tip
   * You can use the `static get` method to share a table across stages.
   * :::
   *
   * @param name The name of the component.
   * @param tableName The name of the DynamoDB Table.
   * @param opts Component resource options.
   *
   * @example
   * Imagine you create a table in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new table, you want to share the table from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const table = $app.stage === "frank"
   *   ? sst.aws.DynamoV5.get("MyTable", "app-dev-mytable")
   *   : new sst.aws.DynamoV5("MyTable", {
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
   * sst.aws.DynamoV5
   *   .get("Orders", "orders-table")
   *   .subscribe("MySubscriber", "src/subscriber.handler");
   * ```
   */
  public static get(
    name: string,
    tableName: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new DynamoV5(
      name,
      { existing: { table: tableName } } as DynamoV5Args,
      opts,
    );
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
