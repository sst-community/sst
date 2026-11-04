import { getArgs } from "../../args";
import { ComponentResourceOptions, output } from "@pulumi/pulumi";
import { kinesis, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
} from "../../parts-component";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { parseKinesisStreamArn } from "../helpers/arn";
import { Function } from "./function";
import {
  assertNamedSubscriber,
  eventSourceSubscriber,
  filterCriteria,
} from "../helpers/event-source";
import type { FunctionInput } from "../helpers/function-part";
import { permission } from "../permission";

const parts = () => ({
  /**
   * The Amazon Kinesis Data Stream.
   */
  stream: kinesis.Stream,
  /**
   * The functions subscribed to the stream, by subscriber name.
   */
  subscriber: many(deferred(Function)),
  /**
   * The Lambda event source mappings that send the stream's records to each subscriber,
   * by subscriber name.
   */
  eventSourceMapping: many(lambda.EventSourceMapping),
});

export interface KinesisStreamArgs extends ComponentArgs<typeof parts> {}

export interface KinesisStreamSubscriberArgs {
  /**
   * Filter the events that'll be processed by the subscriber's function.
   *
   * :::tip
   * You can pass in up to 5 different filters.
   * :::
   *
   * You can pass in up to 5 different filter policies. These will logically ORed together. Meaning that if any single policy matches, the record will be processed. Learn more about the [filter rule syntax](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html#filtering-syntax).
   *
   * @example
   * For example, if your Kinesis stream contains events in this JSON format.
   * ```js
   * {
   *   record: 12345,
   *   order: {
   *     type: "buy",
   *     stock: "ANYCO",
   *     quantity: 1000
   *   }
   * }
   * ```
   *
   * To process only those events where the `type` is `buy`.
   * ```js
   * {
   *   filters: [
   *     {
   *       data: {
   *         order: {
   *           type: ["buy"],
   *         },
   *       },
   *     },
   *   ],
   * }
   * ```
   */
  filters?: Input<Input<Record<string, any>>[]>;
}

/**
 * The `KinesisStream` component lets you add an [Amazon Kinesis Data Streams](https://docs.aws.amazon.com/streams/latest/dev/introduction.html) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have. That includes the resources of
 * each subscriber, which are kept inside the stream.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const stream = new sst.aws.v5.KinesisStream("MyStream");
 * ```
 *
 * #### Subscribe to a stream
 *
 * ```ts title="sst.config.ts"
 * stream.subscribe("MySubscriber", "src/subscriber.handler");
 * ```
 *
 * #### Link the stream to a resource
 *
 * You can link the stream to other resources, like a function or your Next.js app.
 *
 * ```ts {2} title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [stream]
 * });
 * ```
 *
 * Once linked, you can write to the stream from your function code.
 *
 * ```ts title="app/page.tsx" {1,7}
 * import { Resource } from "sst";
 * import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
 *
 * const client = new KinesisClient();
 *
 * await client.send(new PutRecordCommand({
 *   StreamName: Resource.MyStream.name,
 *   Data: JSON.stringify({ foo: "bar" }),
 *   PartitionKey: "myKey",
 * }));
 * ```
 *
 * #### Use a stream you already have
 *
 * Reference it by its name or ARN. The stream is used the way it is: the component
 * doesn't configure it.
 *
 * ```ts title="sst.config.ts"
 * const stream = sst.aws.v5.KinesisStream.get("MyStream", "app-dev-mystream");
 * ```
 *
 * #### Switch from `sst.aws.KinesisStream`
 *
 * Change `sst.aws.KinesisStream` to `sst.aws.v5.KinesisStream` and keep the name. The
 * stream and the subscribers you've deployed are kept, as long as the subscribers have
 * names.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const stream = new sst.aws.KinesisStream("MyStream");
 * const stream = new sst.aws.v5.KinesisStream("MyStream");
 * ```
 *
 * A few things work differently:
 *
 * - A subscriber's resources are parts of the stream. `subscribe()` returns the stream,
 *   and the subscriber's function and event source mapping are in `nodes.subscriber` and
 *   `nodes.eventSourceMapping` under its name. To change how they're created, use the
 *   stream's `transform`: a subscriber's own `transform` is refused.
 * - Every subscriber has a name. One that was added without a name isn't kept: remove it
 *   and deploy before you switch, then add it back with a name.
 * - A subscriber's handler or function args have to be a plain value, not an output:
 *   they decide what's created. A function you already have, or its ARN, can still be an
 *   output.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - A subscriber's function is described after the component, `Subscribed to MyStream`,
 *   where `sst.aws.KinesisStream` named the component it kept the subscriber in: an
 *   update in place. For a stream from `get`, it names the component `get` created,
 *   where the static `subscribe` named the stream.
 * - A subscriber is created with the provider the stream has. `sst.aws.KinesisStream`
 *   gave it only a `provider` passed to the stream itself, so if your stream takes its
 *   provider from a parent component or from `providers`, the switch gives its subscribers
 *   that provider and keeps them, with the provider's default tags.
 * - To subscribe to a stream that isn't in your app, reference it with `get`, by its
 *   name or the ARN you gave the static `subscribe`, and subscribe to that. The static
 *   `subscribe` is refused with what to write.
 *
 *   ```ts title="sst.config.ts" del={1} ins={2-4}
 *   sst.aws.KinesisStream.subscribe("MySubscriber", streamArn, "src/subscriber.handler");
 *   sst.aws.v5.KinesisStream
 *     .get("Orders", streamArn)
 *     .subscribe("MySubscriber", "src/subscriber.handler");
 *   ```
 * - `get` gives its options to the component, so a `provider` or `parent` you pass it
 *   applies to the stream's subscribers too. The static `subscribe` created a subscriber
 *   with your app's provider, at the top of your app. If you pass `get` a `provider`, or a
 *   parent that has `providers`, and subscribe to that stream, the switch gives the
 *   subscriber that provider and keeps it.
 */
export class KinesisStream extends component("sst:aws:KinesisStream", parts) {
  constructor(
    name: string,
    args: KinesisStreamArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    this.part("stream", { streamModeDetails: { streamMode: "ON_DEMAND" } });
  }

  /**
   * The name of the Kinesis Data Stream.
   */
  public get name() {
    return this.nodes.stream.name;
  }

  /**
   * The ARN of the Kinesis Data Stream.
   */
  public get arn() {
    return this.nodes.stream.arn;
  }

  /**
   * Subscribe to the Kinesis stream.
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
   * stream.subscribe("MySubscriber", "src/subscriber.handler");
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js title="sst.config.ts"
   * stream.subscribe("MySubscriber", "src/subscriber.handler", {
   *   filters: [
   *     {
   *       data: {
   *         order: {
   *           type: ["buy"],
   *         },
   *       },
   *     },
   *   ],
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js title="sst.config.ts"
   * stream.subscribe("MySubscriber", {
   *   handler: "src/subscriber.handler",
   *   timeout: "60 seconds"
   * });
   * ```
   *
   * Or pass in the ARN of an existing Lambda function. A function you pass in, or its ARN,
   * isn't given permission to read the stream: link the stream to a function in your app,
   * or give the function's role that permission yourself.
   *
   * ```js title="sst.config.ts"
   * stream.subscribe("MySubscriber", "arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   *
   * To change how one subscriber is created, use the stream's `transform`. Its function
   * form is given the subscriber's name.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.v5.KinesisStream("MyStream", {
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
    args: KinesisStreamSubscriberArgs = {},
  ) {
    assertNamedSubscriber(
      `the "${this.componentName}" stream`,
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
      kind: "stream",
      source: this.arn,
      actions: [
        "kinesis:DescribeStream",
        "kinesis:DescribeStreamSummary",
        "kinesis:GetRecords",
        "kinesis:GetShardIterator",
        "kinesis:ListShards",
        "kinesis:ListStreams",
        "kinesis:SubscribeToShard",
      ],
      mapping: {
        startingPosition: "LATEST",
        filterCriteria: filterCriteria(args.filters),
      },
    });

    return this;
  }

  /**
   * `sst.aws.KinesisStream.subscribe` subscribed to a stream by its ARN. Reference the
   * stream with `get` and subscribe to that.
   *
   * @internal
   */
  public static subscribe(..._args: unknown[]): never {
    throw new VisibleError(
      `To subscribe to a stream that isn't in your app, reference it with "get" and subscribe to that: sst.aws.v5.KinesisStream.get("MyStream", "my-stream-name").subscribe("MySubscriber", "src/subscriber.handler").`,
    );
  }

  /**
   * Reference an existing Kinesis Data Stream with the given stream name or ARN. This is
   * useful when you create a stream in one stage and want to share it in another stage,
   * or to subscribe to a stream that isn't in your app. The stream is used the way it is:
   * it isn't configured here.
   *
   * @param name The name of the component.
   * @param streamName The name of the Kinesis Data Stream, or its ARN.
   * @param opts Component resource options.
   *
   * @example
   * Subscribe to a stream that isn't in your app.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.v5.KinesisStream
   *   .get("Orders", "orders-stream")
   *   .subscribe("MySubscriber", "src/subscriber.handler");
   * ```
   */
  public static get(
    name: string,
    streamName: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    // A stream is looked up by its name
    const stream = output(streamName).apply((id) =>
      id.startsWith("arn:") ? parseKinesisStreamArn(id).streamName : id,
    );
    return new KinesisStream(name, getArgs({ existing: { stream } }), opts);
  }

  /**
   * Linking a stream gives the linked resource the stream's name and permission to use
   * it.
   */
  public link() {
    return {
      properties: { name: this.name },
      include: [
        permission({
          actions: ["kinesis:*"],
          resources: [this.arn],
        }),
      ],
    };
  }
}
