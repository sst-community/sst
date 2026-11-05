import { type ComponentResourceOptions } from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../parts-component";
import type { Input } from "../input";
import { notAnExistingPart, notAnOption, withDefault } from "../args";
import { VisibleError } from "../error";
import {
  type DurationMinutes,
  type DurationSeconds,
  toMilliseconds,
  toSeconds,
} from "../duration";
import { binding } from "./binding";
import { DEFAULT_ACCOUNT_ID } from "./account-id";
import { ownId, useExisting } from "./helpers/lookup";
import { workerArgsOf } from "./helpers/worker-part";
import { Worker, type WorkerArgs } from "./worker";

const parts = () => ({
  /**
   * The Cloudflare Queue.
   */
  queue: cf.Queue,
  /**
   * The Worker that consumes the queue's messages, once `subscribe` adds it.
   * Its script is named after it, `MyQueueSubscriberFunctionScript`.
   */
  subscriber: named(optional(Worker), "SubscriberFunction"),
  /**
   * The queue's consumer, which sends its messages to the subscriber, once
   * `subscribe` adds it.
   */
  consumer: optional(cf.QueueConsumer),
});

export interface QueueArgs extends ComponentArgs<typeof parts> {
  /**
   * The Cloudflare account ID to use for this Queue.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
  /**
   * The dead letter queue to send the messages the subscriber fails to
   * process to. It's a setting of the queue's consumer, so it applies once
   * `subscribe` adds one.
   *
   * @example
   * ```js
   * {
   *   dlq: {
   *     queue: "my-dead-letter-queue",
   *     retry: 5,
   *     retryDelay: "30 seconds"
   *   }
   * }
   * ```
   */
  dlq?: {
    /**
     * The name of the dead letter queue.
     */
    queue: Input<string>;
    /**
     * The number of times the queue retries a message before it sends it to
     * the dead letter queue.
     * @default `3`
     */
    retry?: Input<number>;
    /**
     * How long to wait before a message is retried.
     * @default `"0 seconds"`
     */
    retryDelay?: Input<DurationSeconds>;
  };
  /**
   * The maximum number of the subscriber's invocations that run at once. It's
   * a setting of the queue's consumer, so it applies once `subscribe` adds
   * one.
   * @default Cloudflare's maximum
   */
  maxConcurrency?: Input<number>;
}

export interface QueueSubscriberArgs {
  /**
   * How the queue's messages are batched for the subscriber.
   */
  batch?: {
    /**
     * The maximum number of messages that are processed together in a single
     * invocation of the subscriber.
     *
     * Value must be between 1 and 100.
     *
     * @default `10`
     * @example
     * Process messages one at a time.
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
     * The maximum amount of time to wait for a batch to fill up before it's
     * sent to the subscriber anyway.
     *
     * Value must be between 0 seconds and 60 seconds.
     * @default `"5 seconds"`
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
  };
}

/**
 * The `Queue` component lets you add a [Cloudflare Queue](https://developers.cloudflare.com/queues/) to
 * your app.
 *
 * @example
 * #### Create a Queue
 *
 * ```ts title="sst.config.ts"
 * const queue = new sst.cloudflare.Queue("MyQueue");
 * ```
 *
 * #### Subscribe to the Queue
 *
 * Create a worker file that exposes a default handler for queue messages:
 *
 * ```ts title="consumer.ts"
 * export default {
 *   async queue(batch, env) {
 *     for (const message of batch.messages) {
 *       console.log("Processing message:", message.body);
 *     }
 *   },
 * };
 * ```
 *
 * Subscribe to the queue with a consumer worker. A queue has one consumer.
 *
 * ```ts title="sst.config.ts"
 * queue.subscribe("consumer.ts");
 * ```
 *
 * #### Link to the Queue
 *
 * You can link other workers to the queue.
 *
 * ```ts title="sst.config.ts"
 * new sst.cloudflare.Worker("MyWorker", {
 *   handler: "producer.ts",
 *   link: [queue],
 *   url: true,
 * });
 * ```
 *
 * #### Subscribe with full worker props
 *
 * ```ts title="sst.config.ts"
 * queue.subscribe({
 *   handler: "consumer.ts",
 *   link: [bucket],
 * });
 * ```
 *
 * #### Switch from SST 4's `sst.cloudflare.Queue`
 *
 * Keep the name, and `sst migrate` moves it. The queue, its consumer and the consumer's Worker are kept.
 *
 * - `subscribe` returns the queue, where it returned a
 *   `QueueWorkerSubscriber`: the Worker is `queue.nodes.subscriber`, and the
 *   consumer `queue.nodes.consumer`.
 * - The `transform` of `subscribe` becomes the queue's `transform.subscriber`
 *   and `transform.consumer`, and `subscribe` takes no `opts`, which is
 *   refused: what it creates is the queue's, with the queue's options.
 * - The subscriber's handler or Worker args are a plain value, not an output:
 *   they decide what's created. Inside the args, `link` and `domain` are plain
 *   values too, as [`sst.cloudflare.Worker`](/docs/component/cloudflare/worker)
 *   takes them, and what else is in them can be an output.
 * - The subscriber's Worker is
 *   [`sst.cloudflare.Worker`](/docs/component/cloudflare/worker), inside
 *   the queue, with the name it had. `transform.subscriber` takes its args, as
 *   [`sst.cloudflare.Worker`](/docs/component/cloudflare/worker) takes
 *   them.
 * - `dlq.retryDelay` is sent to Cloudflare in seconds, as Cloudflare reads it.
 *   SST 4 sent it in milliseconds, so a retry set to wait 30 seconds waited
 *   30,000: if you set it, the consumer is updated in place to wait what you
 *   set.
 * - The subscriber is created with the provider the queue has. SST 4 gave it
 *   only a `provider` passed to the queue itself, so if your queue takes its
 *   provider from a parent component or from `providers`, the switch gives
 *   its Worker that provider and keeps it.
 */
export class Queue extends component("sst:cloudflare:Queue", parts) {
  constructor(
    name: string,
    args: QueueArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const owner = `the "${name}" queue`;
    // What `subscribe` creates is made from what it's given
    for (const part of ["subscriber", "consumer"] as const)
      notAnExistingPart(
        args.existing,
        part,
        owner,
        `"subscribe" creates the queue's subscriber Worker and its consumer from the handler or the Worker's args it's given.`,
      );

    this.settings = {
      accountId: args.accountId,
      dlq: args.dlq,
      maxConcurrency: args.maxConcurrency,
    };
    // A queue that's already deployed is used as it is. Cloudflare's provider
    // looks one up by its account and id.
    const accountId = args.accountId ?? DEFAULT_ACCOUNT_ID;
    const existing = args.existing?.queue;
    if (existing !== undefined)
      useExisting(existing, accountId, (id) => this.lookupPart("queue", id));
    else this.part("queue", { queueName: "", accountId });
  }

  // What the consumer `subscribe` adds is created with
  private settings!: Pick<QueueArgs, "accountId" | "dlq" | "maxConcurrency">;

  /**
   * The generated ID of the queue.
   */
  public get id() {
    // A looked-up queue's id has its account in front
    return ownId(this.nodes.queue.id);
  }

  /**
   * Subscribe to the queue with a worker. A queue has one consumer.
   *
   * @param subscriber The worker that'll process messages from the queue: the
   * path to its handler, or the Worker's args.
   * @param args Configure the subscription.
   *
   * @example
   *
   * Subscribe to the queue with a worker file.
   *
   * ```ts title="sst.config.ts"
   * queue.subscribe("consumer.ts");
   * ```
   *
   * Pass in full worker props.
   *
   * ```ts title="sst.config.ts"
   * queue.subscribe({
   *   handler: "consumer.ts",
   *   link: [bucket],
   * });
   * ```
   *
   * Configure batch settings.
   *
   * ```ts title="sst.config.ts"
   * queue.subscribe("consumer.ts", {
   *   batch: {
   *     size: 10,
   *     window: "20 seconds",
   *   },
   * });
   * ```
   *
   * To change how the subscriber is created, use the queue's `transform`.
   *
   * ```ts title="sst.config.ts"
   * new sst.cloudflare.Queue("MyQueue", {
   *   transform: {
   *     subscriber: { url: true }
   *   }
   * });
   * ```
   */
  public subscribe(
    subscriber: string | WorkerArgs,
    args: QueueSubscriberArgs = {},
  ) {
    const name = this.componentName;
    const owner = `the "${name}" queue`;
    notAnOption(
      args,
      "transform",
      `Use the "transform" of the "${name}" queue: its "subscriber" and "consumer".`,
    );
    // SST 4 took the subscriber's resource options third
    if (arguments[2] !== undefined)
      throw new VisibleError(
        `"subscribe" on the "${name}" queue takes no options: what it creates is the queue's, with the queue's options. Give them to the queue.`,
      );
    if (this.nodes.consumer)
      throw new VisibleError(
        `Cannot subscribe to the "${name}" queue multiple times. A Cloudflare Queue can only have one consumer.`,
      );

    const worker = workerArgsOf(subscriber, "subscriber", owner);

    const { accountId, dlq, maxConcurrency } = this.settings;
    const script = this.part("subscriber", { accountId, ...worker }).nodes
      .worker;
    this.part("consumer", {
      accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      deadLetterQueue: dlq?.queue,
      queueId: this.id,
      scriptName: script.scriptName,
      settings: {
        batchSize: withDefault(args.batch?.size, 10),
        maxConcurrency,
        maxRetries: dlq?.retry,
        // In seconds, as Cloudflare reads it
        retryDelay: withDefault(dlq?.retryDelay, "0 seconds", toSeconds),
        maxWaitTimeMs: withDefault(
          args.batch?.window,
          "5 seconds",
          toMilliseconds,
        ),
      },
      type: "worker",
    });

    return this;
  }

  /**
   * Linking a queue to a worker gives the worker a binding to send to it.
   *
   * @internal
   */
  public link() {
    return {
      properties: {},
      include: [
        binding({
          type: "queueBindings",
          properties: { queueName: this.nodes.queue.queueName },
        }),
      ],
    };
  }
}
