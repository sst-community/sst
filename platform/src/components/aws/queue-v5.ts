import { ComponentResourceOptions, jsonStringify, output } from "@pulumi/pulumi";
import { lambda, sqs } from "@pulumi/aws";
import { V5Args, component, deferred, optional } from "../parts-component";
import { ifSet, notAnOption, withDefault } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { toSeconds } from "../duration";
import type { FunctionArgs, FunctionArn } from "./function";
import { FunctionV5 } from "./function-v5";
import { parseQueueArn } from "./helpers/arn";
import { batchSettings, filterCriteria } from "./helpers/event-source";
import { functionPart } from "./helpers/function-part";
import { permission } from "./permission";
import type { QueueArgs, QueueSubscriberArgs } from "./queue";

const parts = () => ({
  /**
   * The Amazon SQS Queue.
   */
  queue: sqs.Queue,
  /**
   * The function subscribed to the queue.
   */
  subscriber: deferred(FunctionV5),
  /**
   * The Lambda event source mapping that sends the queue's messages to the subscriber.
   */
  eventSourceMapping: optional(lambda.EventSourceMapping),
});

export interface QueueV5Args
  extends V5Args<Omit<QueueArgs, "dlq">, typeof parts> {
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
   * const deadLetterQueue = new sst.aws.QueueV5("MyDLQ");
   *
   * new sst.aws.QueueV5("MyQueue", {
   *   dlq: deadLetterQueue.arn,
   * });
   * ```
   *
   * By default, the main queue will retry processing the message 3 times before sending it to the dead-letter queue. You can customize this.
   *
   * ```ts title="sst.config.ts" {3}
   * new sst.aws.QueueV5("MyQueue", {
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

export interface QueueV5SubscriberArgs
  extends Omit<QueueSubscriberArgs, "transform"> {}

/**
 * The `QueueV5` component lets you add a serverless queue to your app. It uses [Amazon SQS](https://aws.amazon.com/sqs/).
 *
 * It takes the same args as [`Queue`](/docs/component/aws/queue). It's built from parts, so
 * every resource it creates can be transformed, is available in `nodes`, and can be swapped
 * for one you already have.
 *
 * @example
 *
 * #### Create a queue
 *
 * ```ts title="sst.config.ts"
 * const queue = new sst.aws.QueueV5("MyQueue");
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
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [queue]
 * });
 * ```
 *
 * #### Switch from `Queue`
 *
 * Change `Queue` to `QueueV5` and keep the name. The queue and subscriber you've deployed
 * are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const queue = new sst.aws.Queue("MyQueue");
 * const queue = new sst.aws.QueueV5("MyQueue");
 * ```
 *
 * Two things work differently:
 *
 * - An object in `transform` is merged into the defaults, nested objects included, where
 *   `Queue` replaced a nested object whole. To replace one, use a function.
 * - `$transform(sst.aws.Queue, ...)` doesn't apply to it. Write one for
 *   `sst.aws.QueueV5`.
 *
 * #### Use a queue you already have
 *
 * Pass the queue, or its URL.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.QueueV5("MyQueue", {
 *   existing: {
 *     queue: "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue"
 *   }
 * });
 * ```
 */
export class QueueV5 extends component("sst:aws:QueueV5", parts) {
  constructor(
    name: string,
    args: QueueV5Args = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

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
   * @param subscriber The function that'll be notified.
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
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * queue.subscribe("arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   *
   * To change how the subscriber is created, use the queue's `transform`.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.QueueV5("MyQueue", {
   *   transform: {
   *     eventSourceMapping: { enabled: false }
   *   }
   * });
   * ```
   */
  public subscribe(
    subscriber: Input<string | FunctionArgs | FunctionArn>,
    args: QueueV5SubscriberArgs = {},
  ) {
    notAnOption(
      args,
      "transform",
      `Use the "transform" of the "${this.componentName}" queue: its "subscriber" and "eventSourceMapping".`,
    );
    if (this.nodes.eventSourceMapping)
      throw new VisibleError(
        `Cannot subscribe to the "${this.componentName}" queue multiple times. An SQS Queue can only have one subscriber.`,
      );

    const fn = functionPart(this, "subscriber", subscriber, {
      description: `Subscribed to ${this.componentName}`,
      permissions: [
        {
          actions: [
            "sqs:ChangeMessageVisibility",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
            "sqs:GetQueueUrl",
            "sqs:ReceiveMessage",
          ],
          resources: [this.arn],
        },
      ],
    });

    this.part("eventSourceMapping", {
      eventSourceArn: this.arn,
      functionName: fn.targetArn,
      filterCriteria: filterCriteria(args.filters),
      ...batchSettings(args.batch),
    });

    return this;
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
   *   ? sst.aws.QueueV5.get("MyQueue", "https://sqs.us-east-1.amazonaws.com/123456789012/app-dev-MyQueue")
   *   : new sst.aws.QueueV5("MyQueue");
   * ```
   *
   * Subscribe to a queue that isn't in your app.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.QueueV5
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
    return new QueueV5(name, { existing: { queue: url } }, opts);
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
