import {
  ComponentResourceOptions,
  jsonStringify,
  output,
} from "@pulumi/pulumi";
import { lambda, sqs } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  optional,
} from "../../parts-component";
import {
  ifSet,
  notAnOption,
  usedAsItIs,
  withDefault,
  getArgs,
} from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import {
  type DurationHours,
  type DurationMinutes,
  toSeconds,
} from "../../duration";
import { Function } from "./function";
import { parseQueueArn } from "../helpers/arn";
import {
  batchSettings,
  eventSourceSubscriber,
  filterCriteria,
} from "../helpers/event-source";
import type { FunctionInput } from "../helpers/function-part";
import { permission } from "../permission";

const parts = () => ({
  /**
   * The Amazon SQS Queue.
   */
  queue: sqs.Queue,
  /**
   * The function subscribed to the queue.
   */
  subscriber: deferred(Function),
  /**
   * The Lambda event source mapping that sends the queue's messages to the subscriber.
   */
  eventSourceMapping: optional(lambda.EventSourceMapping),
});

export interface QueueArgs extends ComponentArgs<typeof parts> {
  /**
   * FIFO or _first-in-first-out_ queues are designed to guarantee that messages are processed exactly once and in the order that they are sent.
   *
   * :::caution
   * Changing a standard queue to a FIFO queue (or the other way around) will cause the queue to be destroyed and recreated.
   * :::
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   fifo: true
   * }
   * ```
   *
   * By default, content based deduplication is disabled. You can enable it by configuring
   * the `fifo` property.
   *
   * ```js
   * {
   *   fifo: {
   *     contentBasedDeduplication: true
   *   }
   * }
   * ```
   */
  fifo?: Input<
    | boolean
    | {
        /**
         * Content-based deduplication automatically generates a deduplication ID by hashing
         * the message body to prevent duplicate message delivery.
         *
         * @default `false`
         */
        contentBasedDeduplication?: Input<boolean>;
      }
  >;
  /**
   * The period of time which the delivery of all messages in the queue is delayed.
   *
   * This can range from 0 seconds to 900 seconds (15 minutes).
   *
   * @default `"0 seconds"`
   * @example
   * ```js
   * {
   *   delay: "10 seconds"
   * }
   * ```
   */
  delay?: Input<DurationMinutes>;
  /**
   * Visibility timeout is a period of time during which a message is temporarily
   * invisible to other consumers after a consumer has retrieved it from the queue.
   * This mechanism prevents other consumers from processing the same message
   * concurrently, ensuring that each message is processed only once.
   *
   * This timeout can range from 0 seconds to 12 hours.
   *
   * @default `"30 seconds"`
   * @example
   * ```js
   * {
   *   visibilityTimeout: "1 hour"
   * }
   * ```
   */
  visibilityTimeout?: Input<DurationHours>;
  /**
   * Optionally add a dead-letter queue or DLQ for this queue.
   *
   * A dead-letter queue is used to store messages that can't be processed successfully by the
   * subscriber function after the `retry` limit is reached.
   *
   * This takes either the ARN of the dead-letter queue or an object to configure how the
   * dead-letter queue is used.
   *
   * @example
   * For example, here's how you can create a dead-letter queue and link it to the main queue.
   *
   * ```ts title="sst.config.ts" {4}
   * const deadLetterQueue = new sst.aws.v5.Queue("MyDLQ");
   *
   * new sst.aws.v5.Queue("MyQueue", {
   *   dlq: deadLetterQueue.arn,
   * });
   * ```
   *
   * By default, the main queue will retry processing the message 3 times before sending it to the dead-letter queue. You can customize this.
   *
   * ```ts title="sst.config.ts" {3}
   * new sst.aws.v5.Queue("MyQueue", {
   *   dlq: {
   *     retry: 5,
   *     queue: deadLetterQueue.arn,
   *   }
   * });
   * ```
   */
  dlq?: Input<
    | string
    | {
        /**
         * The ARN of the dead-letter queue.
         */
        queue: Input<string>;
        /**
         * The number of times the main queue will retry the message before sending it to the dead-letter queue.
         * @default `3`
         */
        retry: Input<number>;
      }
  >;
}

export interface QueueSubscriberArgs {
  /**
   * Filter the records that'll be processed by the `subscriber` function.
   *
   * :::tip
   * You can pass in up to 5 different filters.
   * :::
   *
   * You can pass in up to 5 different filter policies. These will logically ORed together. Meaning that if any single policy matches, the record will be processed. Learn more about the [filter rule syntax](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html#filtering-syntax).
   *
   * @example
   * For example, if you Queue contains records in this JSON format.
   * ```js
   * {
   *   RecordNumber: 0000,
   *   RequestCode: "AAAA",
   *   TimeStamp: "yyyy-mm-ddThh:mm:ss"
   * }
   * ```
   *
   * To process only those records where the `RequestCode` is `BBBB`.
   *
   * ```js
   * {
   *   filters: [
   *     {
   *       body: {
   *         RequestCode: ["BBBB"]
   *       }
   *     }
   *   ]
   * }
   * ```
   *
   * And to process only those records where `RecordNumber` greater than `9999`.
   *
   * ```js
   * {
   *   filters: [
   *     {
   *       body: {
   *         RecordNumber: [{ numeric: [ ">", 9999 ] }]
   *       }
   *     }
   *   ]
   * }
   * ```
   */
  filters?: Input<Input<Record<string, any>>[]>;
  /**
   * Configure batch processing options for the consumer function.
   * @default `{size: 10, window: "0 seconds", partialResponses: false}`
   */
  batch?: Input<{
    /**
     * The maximum number of events that will be processed together in a single invocation
     * of the consumer function.
     *
     * Value must be between 1 and 10000.
     *
     * :::note
     * When `size` is set to a value greater than 10, `window` must be set to at least `1 second`.
     * :::
     *
     * @default `10`
     * @example
     * Set batch size to 1. This will process events individually.
     * ```js
     * {
     *   batch: {
     *     size: 1
     *   }
     * }
     * ```
     */
    size?: Input<number>;
    /**
     * The maximum amount of time to wait for collecting events before sending the batch to
     * the consumer function, even if the batch size hasn't been reached.
     *
     * Value must be between 0 seconds and 5 minutes (300 seconds).
     * @default `"0 seconds"`
     * @example
     * ```js
     * {
     *   batch: {
     *     window: "20 seconds"
     *   }
     * }
     * ```
     */
    window?: Input<DurationMinutes>;
    /**
     * Whether to return partial successful responses for a batch.
     *
     * Enables reporting of individual message failures in a batch. When enabled, only failed
     * messages become visible in the queue again, preventing unnecessary reprocessing of
     * successful messages.
     *
     * The handler function must return a response with failed message IDs.
     *
     * :::note
     * Ensure your Lambda function is updated to handle `batchItemFailures` responses when
     * enabling this option.
     * :::
     *
     * Read more about [partial batch responses](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html#services-sqs-batchfailurereporting).
     * @default `false`
     * @example
     * Enable partial responses.
     * ```js
     * {
     *   batch: {
     *     partialResponses: true
     *   }
     * }
     * ```
     *
     * For a batch of messages (id1, id2, id3, id4, id5), if id2 and id4 fail:
     * ```json
     * {
     *   "batchItemFailures": [
     *         {
     *             "itemIdentifier": "id2"
     *         },
     *         {
     *             "itemIdentifier": "id4"
     *         }
     *     ]
     * }
     * ```
     *
     * This makes only id2 and id4 visible again in the queue.
     */
    partialResponses?: Input<boolean>;
  }>;
}

/**
 * The `Queue` component lets you add a serverless queue to your app. It uses [Amazon SQS](https://aws.amazon.com/sqs/).
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a queue
 *
 * ```ts title="sst.config.ts"
 * const queue = new sst.aws.v5.Queue("MyQueue");
 * ```
 *
 * #### Make it a FIFO queue
 *
 * You can optionally make it a FIFO queue.
 *
 * ```ts {2} title="sst.config.ts"
 * new sst.aws.v5.Queue("MyQueue", {
 *   fifo: true
 * });
 * ```
 *
 * #### Add a subscriber
 *
 * ```ts title="sst.config.ts"
 * queue.subscribe("src/subscriber.handler");
 * ```
 *
 * #### Link the queue to a resource
 *
 * You can link the queue to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [queue]
 * });
 * ```
 *
 * Once linked, you can send messages to the queue from your function code.
 *
 * ```ts title="app/page.tsx" {1,7}
 * import { Resource } from "sst";
 * import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
 *
 * const sqs = new SQSClient({});
 *
 * await sqs.send(new SendMessageCommand({
 *   QueueUrl: Resource.MyQueue.url,
 *   MessageBody: "Hello from Next.js!"
 * }));
 * ```
 *
 * #### Use a queue you already have
 *
 * Pass the queue, or its URL. The queue is used the way it is: the component doesn't
 * configure it, and refuses `fifo`, `delay`, `visibilityTimeout` and `dlq` next to it.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Queue("MyQueue", {
 *   existing: {
 *     queue: "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue"
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.Queue`
 *
 * Change `sst.aws.Queue` to `sst.aws.v5.Queue` and keep the name. The queue and subscriber
 * you've deployed are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const queue = new sst.aws.Queue("MyQueue");
 * const queue = new sst.aws.v5.Queue("MyQueue");
 * ```
 *
 * A few things are written differently:
 *
 * - A subscriber's handler or function args have to be a plain value, not an output:
 *   they decide what's created. A function you already have, or its ARN, can still be an
 *   output.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - A subscriber's function is described after the component, `Subscribed to MyQueue`,
 *   where `sst.aws.Queue` named the component it kept the subscriber in: an update in
 *   place.
 * - The subscriber is created with the provider the queue has. `sst.aws.Queue` gave it only
 *   a `provider` passed to the queue itself, so if your queue takes its provider from a
 *   parent component or from `providers`, its subscriber is replaced on switch, its log
 *   group with it, which `sst migrate --check` refuses: remove it and deploy before you
 *   switch, then add it back.
 * - `subscribe` returns the queue, where it returned the subscriber: its function is
 *   `queue.nodes.subscriber`, and its event source mapping
 *   `queue.nodes.eventSourceMapping`.
 * - The `transform` of `subscribe` becomes the queue's `transform.subscriber` and
 *   `transform.eventSourceMapping`, and `subscribe` takes no `opts`, which is refused:
 *   what it creates is the queue's, with the queue's options. For a queue that isn't in
 *   your app, write `new sst.aws.v5.Queue(name, { existing: { queue: queueUrl }, transform })`,
 *   which is what `get` does, with your `transform`.
 * - `sst.aws.Queue.subscribe(queueArn, subscriber)` becomes
 *   `sst.aws.v5.Queue.get(name, queueArn).subscribe(subscriber)`, and is refused with what
 *   to write. What it created is kept. It's created with the options you give `get`: if
 *   you gave `sst.aws.Queue.subscribe` a `parent` or a `provider`, give `get` the same, or
 *   the switch doesn't keep it.
 */
export class Queue extends component("sst:aws:Queue", parts) {
  constructor(
    name: string,
    args: QueueArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    // A queue that's already there is used the way it is
    if (this.existingPart("queue"))
      usedAsItIs(
        args,
        ["fifo", "delay", "visibilityTimeout", "dlq"],
        "queue",
        `the "${name}" queue`,
      );

    const fifo = output(args.fifo).apply((v) => (v === true ? {} : v));
    const dlq = output(args.dlq).apply((v) =>
      typeof v === "string" ? { queue: v, retry: 3 } : v,
    );

    this.part("queue", {
      fifoQueue: fifo.apply((v) => !!v),
      contentBasedDeduplication: fifo.apply(
        (v) => (v && v.contentBasedDeduplication) || false,
      ),
      visibilityTimeoutSeconds: withDefault(
        args.visibilityTimeout,
        "30 seconds",
        toSeconds,
      ),
      delaySeconds: withDefault(args.delay, "0 seconds", toSeconds),
      redrivePolicy: ifSet(dlq, (dlq) =>
        jsonStringify({
          deadLetterTargetArn: dlq.queue,
          maxReceiveCount: dlq.retry,
        }),
      ),
    });
  }

  /**
   * The ARN of the SQS Queue.
   */
  public get arn() {
    return this.nodes.queue.arn;
  }

  /**
   * The SQS Queue URL.
   */
  public get url() {
    return this.nodes.queue.url;
  }

  /**
   * Subscribe to this queue. A queue can have one subscriber.
   *
   * @param subscriber The function that'll be notified: the handler of one to create, its
   * args, a function component, or the ARN of a function you have. Only a function you
   * have, or its ARN, can be an output.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * queue.subscribe("src/subscriber.handler");
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js title="sst.config.ts"
   * queue.subscribe("src/subscriber.handler", {
   *   filters: [
   *     {
   *       body: {
   *         RequestCode: ["BBBB"]
   *       }
   *     }
   *   ]
   * });
   * ```
   *
   * Or pass in the ARN of an existing Lambda function. A function you pass in, or its ARN,
   * isn't given permission to receive from the queue: link the queue to a function in
   * your app, or give the function's role that permission yourself.
   *
   * ```js title="sst.config.ts"
   * queue.subscribe("arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   *
   * To change how the subscriber is created, use the queue's `transform`.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.v5.Queue("MyQueue", {
   *   transform: {
   *     eventSourceMapping: { enabled: false }
   *   }
   * });
   * ```
   */
  public subscribe(subscriber: FunctionInput, args: QueueSubscriberArgs = {}) {
    notAnOption(
      args,
      "transform",
      `Use the "transform" of the "${this.componentName}" queue: its "subscriber" and "eventSourceMapping".`,
    );
    // `sst.aws.Queue` took the subscriber's resource options third
    if (arguments[2] !== undefined)
      throw new VisibleError(
        `"subscribe" on the "${this.componentName}" queue takes no options: what it creates is the queue's, with the queue's options. Give them to the queue, or to "get" for a queue that isn't in your app.`,
      );
    if (this.nodes.eventSourceMapping)
      throw new VisibleError(
        `Cannot subscribe to the "${this.componentName}" queue multiple times. An SQS Queue can only have one subscriber.`,
      );

    eventSourceSubscriber(this.builder(), undefined, subscriber, {
      component: this.componentName,
      kind: "queue",
      source: this.arn,
      actions: [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ReceiveMessage",
      ],
      mapping: {
        filterCriteria: filterCriteria(args.filters),
        ...batchSettings(args.batch),
      },
    });

    return this;
  }

  /**
   * `sst.aws.Queue.subscribe` subscribed to a queue by its ARN. Reference the queue with
   * `get` and subscribe to that.
   *
   * @internal
   */
  public static subscribe(..._args: unknown[]): never {
    throw new VisibleError(
      `To subscribe to a queue that isn't in your app, reference it with "get" and subscribe to that: sst.aws.v5.Queue.get("MyQueue", queueArn).subscribe("src/subscriber.handler").`,
    );
  }

  /**
   * Reference an existing SQS Queue. This is useful when you create a queue in one stage and
   * want to share it in another, or to subscribe to a queue that isn't in your app.
   *
   * @param name The name of the component.
   * @param queue The URL or ARN of the existing SQS Queue.
   * @param opts Component resource options.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const queue = $app.stage === "frank"
   *   ? sst.aws.v5.Queue.get("MyQueue", "https://sqs.us-east-1.amazonaws.com/123456789012/app-dev-MyQueue")
   *   : new sst.aws.v5.Queue("MyQueue");
   * ```
   *
   * Subscribe to a queue that isn't in your app.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.v5.Queue
   *   .get("Orders", "arn:aws:sqs:us-east-1:123456789012:orders")
   *   .subscribe("src/subscriber.handler");
   * ```
   */
  public static get(
    name: string,
    queue: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    const url = output(queue).apply((v) =>
      v.startsWith("arn:") ? parseQueueArn(v).queueUrl : v,
    );
    return new Queue(name, getArgs({ existing: { queue: url } }), opts);
  }

  /**
   * Linking a queue gives the linked resource the queue's URL and permission
   * to use it.
   */
  public link() {
    return {
      properties: { url: this.url },
      include: [permission({ actions: ["sqs:*"], resources: [this.arn] })],
    };
  }
}
