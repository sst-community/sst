import {
  all,
  ComponentResourceOptions,
  interpolate,
  Output,
  output,
} from "@pulumi/pulumi";
import { getCallerIdentityOutput, getPartitionOutput, getRegionOutput, lambda } from "@pulumi/aws";
import { Component, Transform, transform } from "../component.js";
import type { Input } from "../input.js";
import { Duration, DurationDays, DurationMinutes, toSeconds } from "../duration.js";
import { hashStringToPrettyString, prefixName } from "../naming.js";
import { RandomPassword } from "@pulumi/random";
import { Linkable } from "../linkable.js";
import { queueWorkflowInFlightWarning } from "./queue-lambda-subscriber.js";
import { VisibleError } from "../error.js";
import { Function, FunctionArgs } from "./function.js";
import { Workflow, WorkflowArgs } from "./workflow.js";
import { Queue, QueueArgs } from "./queue.js";
import { Dynamo, DynamoArgs } from "./dynamo.js";
import { CronV2, CronV2Args } from "./cron-v2.js";
import { permission } from "./permission.js";

export interface EventFlowArgs
  extends Omit<
    WorkflowArgs,
    "runtime" | "transform" | "timeout" | "retention" | "python" | "name"
  > {
  /**
   * The handler for all the functions of this EventFlow: the one `serve()` returns.
   *
   * The same handler runs as the worker, which runs the functions, and as the router,
   * which reads the events. So adding a function to `serve()` doesn't change what's
   * deployed.
   *
   * @example
   * ```js
   * {
   *   handler: "src/flow.handler"
   * }
   * ```
   */
  handler: Input<string>;
  /**
   * The Node.js runtime of the worker and the router.
   *
   * @default `"nodejs24.x"`
   */
  runtime?: Input<"nodejs22.x" | "nodejs24.x">;
  /**
   * How long a run's state is kept after it finishes, so it can be inspected and
   * replayed. AWS allows 1 to 90 days.
   *
   * A run ID can't be used again while its run is kept, so this is also how long an
   * event can't start a second run of a function.
   *
   * @default `"30 days"`
   */
  retention?: Input<DurationDays>;
  /**
   * The timeouts of a run.
   */
  timeout?: Input<{
    /**
     * The longest a run can take, from its start to its end, including its sleeps and
     * waits. AWS allows up to 366 days.
     *
     * @default `"14 days"`
     */
    execution?: Input<Duration>;
    /**
     * The longest one invocation of the worker can take. A run is many invocations:
     * it stops at each sleep or wait, and starts again after it. A step has to finish
     * within one invocation.
     *
     * @default `"5 minutes"`
     */
    invocation?: Input<DurationMinutes>;
  }>;
  /**
   * The router, which reads the events from the queue, starts the runs and resumes the
   * waits.
   */
  router?: Input<{
    /**
     * The memory of the router.
     * @default `"512 MB"`
     */
    memory?: FunctionArgs["memory"];
    /**
     * How many messages the router gets at once.
     * @default `10`
     */
    batchSize?: Input<number>;
    /**
     * The most routers that run at once. By default Lambda adds routers while there's a
     * backlog.
     *
     * SQS fair queues need about 50 messages in flight to deliver the events of quieter
     * tenants first, so keep `maxConcurrency` × `batchSize` at 50 or more.
     *
     * @default No limit
     */
    maxConcurrency?: Input<number>;
  }>;
  /**
   * How many times an event the router can't route is retried, before it goes to the
   * dead-letter queue.
   *
   * @default `5`
   */
  retries?: Input<number>;
  /**
   * The schedule that ticks every minute, to start the functions with cron triggers.
   * Turn it off if no function has a cron trigger.
   *
   * @default `true`
   */
  schedule?: Input<boolean>;
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /** Transform the worker's Function. */
    worker?: FunctionArgs["transform"];
    /** Transform the router's Function. */
    router?: Transform<FunctionArgs>;
    /** Transform the queue. */
    queue?: Transform<QueueArgs>;
    /** Transform the dead-letter queue. */
    deadLetterQueue?: Transform<QueueArgs>;
    /** Transform the table. */
    table?: Transform<DynamoArgs>;
    /** Transform the schedule. */
    schedule?: Transform<CronV2Args>;
    /** Transform the router's event source mapping. */
    eventSourceMapping?: Transform<lambda.EventSourceMappingArgs>;
  };
}

/**
 * The `EventFlow` component runs event-driven functions, written with an API shaped
 * like [Inngest's](https://www.inngest.com/docs/reference/typescript), on
 * [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
 * in your AWS account.
 *
 * You create it once. It makes a fixed set of resources: a queue for the events, a
 * router that reads them, a worker that runs every function, a table for its state,
 * and a schedule for cron triggers. Adding a function is a code change. It doesn't
 * add infrastructure.
 *
 * To run some functions apart from the others, like ones that need more memory or
 * other permissions, create a second EventFlow. That's the only way to get a second
 * set of resources, so it's always a choice made in `sst.config.ts`.
 *
 * Read the [EventFlow guide](/docs/eventflow) for how it works, what it guarantees,
 * its limits, cost, and measured performance. Moving from Inngest? Read
 * [Migrate from Inngest](/docs/migrate-from-inngest).
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const flow = new sst.aws.EventFlow("Flow", {
 *   handler: "src/flow.handler",
 * });
 *
 * new sst.aws.Function("Api", {
 *   handler: "src/api.handler",
 *   link: [flow],
 *   url: true,
 * });
 * ```
 *
 * ```ts title="src/flow.ts"
 * import { EventFlow, serve } from "sst/aws/eventflow";
 *
 * export const flow = new EventFlow({ id: "my-app" });
 *
 * const welcome = flow.createFunction(
 *   { id: "send-welcome", triggers: { event: "user/created" } },
 *   async ({ event, step }) => {
 *     await step.sleep("wait-a-day", "1d");
 *     await step.run("send-email", () => sendEmail(event.data.email));
 *   },
 * );
 *
 * export const handler = serve({ client: flow, functions: [welcome] });
 * ```
 *
 * ```ts title="src/api.ts"
 * import { flow } from "./flow";
 *
 * export async function handler() {
 *   await flow.send({ name: "user/created", data: { email: "alice@example.com" } });
 *   return { statusCode: 202 };
 * }
 * ```
 *
 * #### Link resources to the functions
 *
 * Everything linked to the EventFlow is linked to its worker, so every function can
 * use it. A function the EventFlow is linked to can send events, and nothing more.
 *
 * ```ts title="sst.config.ts" {4}
 * const bucket = new sst.aws.Bucket("Uploads");
 *
 * new sst.aws.EventFlow("Flow", {
 *   handler: "src/flow.handler",
 *   link: [bucket],
 * });
 * ```
 *
 * #### Look at it, and retry after a fix
 *
 * The `sst eventflow` CLI shows the queue, the functions, the concurrency leases, the
 * waits and the runs, and retries a failed run on the latest deploy without running
 * again the steps that succeeded.
 *
 * ```bash
 * sst eventflow
 * sst eventflow retry --failed --function sync-contacts --since 1h
 * ```
 *
 * To build your own page on the same data, link `flow.admin`.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Function("Ops", { handler: "src/ops.handler", link: [flow, flow.admin] });
 * ```
 *
 * #### Limit each tenant
 *
 * Send each event with the tenant it belongs to, from your own authentication. Flow
 * control uses it, and so does the queue, so one tenant's backlog doesn't hold up the
 * others.
 *
 * ```ts title="src/flow.ts"
 * const sync = flow.createFunction(
 *   {
 *     id: "sync-contacts",
 *     triggers: { event: "contacts/sync" },
 *     concurrency: [{ limit: 5, key: "event.tenant" }, { limit: 50 }],
 *     throttle: { limit: 100, period: "1m" },
 *   },
 *   async ({ event, step }) => {
 *     // ...
 *   },
 * );
 *
 * await flow.send({ name: "contacts/sync", data: { tenantId }, tenant: tenantId });
 * ```
 *
 * #### Run some functions apart
 *
 * Each EventFlow has its own queue, router, worker and table. Link both to a
 * function that sends to both, and pass the one to use.
 *
 * ```ts title="sst.config.ts"
 * const flow = new sst.aws.EventFlow("Flow", { handler: "src/flow.handler" });
 * const media = new sst.aws.EventFlow("Media", {
 *   handler: "src/media.handler",
 *   memory: "4 GB",
 *   timeout: { invocation: "15 minutes" },
 * });
 * ```
 *
 * ```ts title="src/media.ts"
 * import { Resource } from "sst";
 * import { EventFlow } from "sst/aws/eventflow";
 *
 * export const media = new EventFlow({ id: "media", resource: Resource.Media });
 * ```
 *
 * ---
 *
 * ### Cost
 *
 * An EventFlow that isn't used costs under about **$0.50 a month**: the queue's event
 * source mapping polls it, and the schedule invokes the router once a minute. Turn
 * off `schedule` if no function has a cron trigger. The table and the functions are
 * billed by use.
 *
 * A run of a function with two steps and a sleep, started by an event, costs about
 * **$0.00004**, mostly in durable operations. The [EventFlow guide](/docs/eventflow#cost)
 * breaks it down, with what flow control and waits add.
 */
export class EventFlow extends Component {
  private readonly worker: Workflow;
  private readonly router: Function;
  private readonly queue: Queue;
  private readonly deadLetterQueue: Queue;
  private readonly table: Dynamo;
  private readonly tick: CronV2;
  private readonly _workerName: Output<string>;
  private readonly _routerName: Output<string>;
  private readonly routerArn: Output<string>;
  private readonly _admin: Linkable<{ routerName: Output<string> }>;

  constructor(name: string, args: EventFlowArgs, opts?: ComponentResourceOptions) {
    super(__pulumiType, name, args, opts);
    const parent = this;

    if (!args?.handler)
      throw new VisibleError(`The "${name}" EventFlow needs a "handler": the one serve() returns.`);
    if ((args as any).role)
      throw new VisibleError(
        `The "${name}" EventFlow doesn't take a "role". Its worker and router each need their own permissions. Add yours with "permissions" or "link".`,
      );

    const partition = getPartitionOutput({}, { parent }).partition;
    const region = getRegionOutput({}, { parent }).region;
    const account = getCallerIdentityOutput({}, { parent }).accountId;

    const {
      router: routerInput,
      retries,
      schedule,
      transform: transforms,
      ...workflowArgs
    } = args;

    // The names are known before the functions are created, so their permissions can
    // name each other. They're stable from one deploy to the next: the app, stage and
    // name, with a hash of them, so two that shorten the same way don't collide.
    const stableName = (suffix: string) => {
      const hash = hashStringToPrettyString(`${$app.name}/${$app.stage}/${name}/${suffix}`, 8);
      return `${prefixName(64 - 9, `${name}${suffix}`)}-${hash}`;
    };
    const workerName = output(stableName("Worker"));
    const routerName = output(stableName("Router"));
    const workerArn = interpolate`arn:${partition}:lambda:${region}:${account}:function:${workerName}`;
    const routerArn = interpolate`arn:${partition}:lambda:${region}:${account}:function:${routerName}`;

    // The router and the worker sign the runs they start with this key, and the worker
    // runs nothing that isn't signed. Only they have it.
    const key = new RandomPassword(`${name}SigningKey`, { length: 48, special: false }, { parent });

    const deadLetterQueue = new Queue(
      ...transform(
        transforms?.deadLetterQueue,
        `${name}DeadLetterQueue`,
        // Two weeks, the most SQS keeps a message, to look at it and move it back.
        { transform: { queue: { messageRetentionSeconds: 1_209_600 } } },
        { parent },
      ),
    );
    // The router's timeout is a minute. AWS recommends a visibility timeout of six
    // times the function's timeout for an event source mapping.
    const queue = new Queue(
      ...transform(
        transforms?.queue,
        `${name}Queue`,
        {
          visibilityTimeout: "6 minutes",
          dlq: {
            queue: deadLetterQueue.arn,
            // The first delivery, and `retries` more.
            retry: output(retries ?? 5).apply((r) => r + 1),
          },
        },
        { parent },
      ),
    );

    const table = new Dynamo(
      ...transform(
        transforms?.table,
        `${name}Table`,
        {
          fields: { pk: "string", sk: "string" },
          primaryIndex: { hashKey: "pk", rangeKey: "sk" },
          ttl: "expires",
        },
        { parent },
      ),
    );

    const tableActions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ];
    // What both need: the table, sending to the queue, and resuming and stopping runs.
    // A callback and a stop are checked against the ARN of the run, which has the
    // worker's version.
    const shared = [
      permission({ actions: ["sqs:SendMessage"], resources: [queue.arn] }),
      permission({
        actions: ["lambda:SendDurableExecutionCallbackSuccess", "lambda:StopDurableExecution"],
        resources: [interpolate`${workerArn}:*`],
      }),
    ];

    const runTimeout = output(args.timeout).apply((t) => toSeconds(t?.execution ?? "14 days"));
    const env = (fields: Record<string, Input<string | number | undefined>>) =>
      all([output(args.environment ?? {}), output(fields), key.result]).apply(([environment, f, secret]) => ({
        ...environment,
        SST_EVENTFLOW: JSON.stringify(f),
        SST_EVENTFLOW_KEY: secret,
      }));

    const worker = new Workflow(
      `${name}Worker`,
      {
        ...workflowArgs,
        name: workerName,
        environment: env({
          queueUrl: queue.url,
          routerName,
          workerName,
          tableName: table.name,
          runTimeoutSeconds: runTimeout,
        }),
        permissions: all([args.permissions ?? []]).apply(([p]) => [
          ...p,
          ...shared,
          permission({ actions: tableActions, resources: [table.arn] }),
          // So a function can use flow.runs and flow.admin, through the router.
          permission({ actions: ["lambda:InvokeFunction"], resources: [routerArn] }),
        ]),
        transform: { function: transforms?.worker },
      },
      { parent },
    );

    const routerArgs = output(routerInput ?? {});
    // The router runs the same handler, so it gets the same build, layers, VPC and
    // links, so the module loads. It doesn't get `permissions`: it runs no step code.
    const router = new Function(
      ...transform(
        transforms?.router,
        `${name}Router`,
        {
          name: routerName,
          description: `The router of the ${name} EventFlow`,
          handler: args.handler,
          runtime: args.runtime ?? "nodejs24.x",
          architecture: args.architecture,
          bundle: args.bundle,
          nodejs: args.nodejs,
          copyFiles: args.copyFiles,
          layers: args.layers,
          volume: args.volume,
          hook: args.hook,
          dev: args.dev,
          tags: args.tags,
          vpc: args.vpc,
          link: args.link,
          memory: routerArgs.apply((r) => r.memory ?? "512 MB"),
          timeout: "1 minute" as const,
          environment: env({
            queueUrl: queue.url,
            deadLetterQueueUrl: deadLetterQueue.url,
            routerName,
            workerName,
            workerQualifier: worker.qualifier.apply((q) => q ?? ""),
            tableName: table.name,
            runTimeoutSeconds: runTimeout,
          }),
          permissions: [
            ...shared,
            permission({ actions: [...tableActions, "dynamodb:Scan"], resources: [table.arn] }),
            permission({
              actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"],
              resources: [queue.arn],
            }),
            // To look at the dead letters, and move them back.
            permission({
              actions: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
                "sqs:StartMessageMoveTask",
                "sqs:ListMessageMoveTasks",
              ],
              resources: [deadLetterQueue.arn],
            }),
            // To start runs, and look at them for the admin API.
            permission({ actions: ["lambda:InvokeFunction"], resources: [workerArn, interpolate`${workerArn}:*`] }),
            permission({ actions: ["lambda:ListDurableExecutionsByFunction"], resources: [workerArn, interpolate`${workerArn}:*`] }),
            permission({
              actions: ["lambda:GetDurableExecution", "lambda:GetDurableExecutionHistory"],
              resources: [interpolate`${workerArn}:*`],
            }),
          ],
        },
        { parent },
      ),
    );

    const mapping = all([routerArgs]).apply(([r]) => {
      const batchSize = r.batchSize ?? 10;
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
        throw new VisibleError(`The "${name}" EventFlow's router.batchSize must be 1 to 10000.`);
      if (r.maxConcurrency !== undefined && (!Number.isInteger(r.maxConcurrency) || r.maxConcurrency < 2 || r.maxConcurrency > 1000))
        throw new VisibleError(`The "${name}" EventFlow's router.maxConcurrency must be 2 to 1000, as AWS allows.`);
      const warning = queueWorkflowInFlightWarning(name, r.maxConcurrency, batchSize);
      if (warning) console.warn(warning.replace("queue subscriber is a workflow", "EventFlow's router is"));
      return { batchSize, maxConcurrency: r.maxConcurrency };
    });
    new lambda.EventSourceMapping(
      ...transform(
        transforms?.eventSourceMapping,
        `${name}RouterEventSourceMapping`,
        {
          eventSourceArn: queue.arn,
          functionName: router.arn,
          batchSize: mapping.batchSize,
          // More than 10 messages at once needs a batching window.
          maximumBatchingWindowInSeconds: mapping.batchSize.apply((b) => (b > 10 ? 1 : undefined)),
          functionResponseTypes: ["ReportBatchItemFailures"],
          scalingConfig: mapping.maxConcurrency.apply((m) => (m === undefined ? undefined : { maximumConcurrency: m })),
        },
        { parent },
      ),
    );

    // The schedule is always there, so turning it off and on is an update, not a new
    // resource.
    const tick = new CronV2(
      ...transform(
        transforms?.schedule,
        `${name}Tick`,
        {
          schedule: "rate(1 minute)",
          function: router,
          enabled: output(schedule ?? true),
          // The scheduler fills in when the tick was due, so a tick that's retried
          // starts the same runs.
          event: { "sst:eventflow:tick": "<aws.scheduler.scheduled-time>" },
        },
        { parent },
      ),
    );

    // Whatever is linked to this can use the admin API: look at the EventFlow's state,
    // and stop, retry and replay runs.
    const admin = new Linkable(
      `${name}Admin`,
      {
        properties: { routerName },
        include: [permission({ actions: ["lambda:InvokeFunction"], resources: [routerArn] })],
      },
    );

    this.worker = worker;
    this.router = router;
    this.queue = queue;
    this.deadLetterQueue = deadLetterQueue;
    this.table = table;
    this.tick = tick;
    this._workerName = workerName;
    this._routerName = routerName;
    this.routerArn = routerArn;
    this._admin = admin;

    this.registerOutputs({ queue: queue.url, worker: workerName, router: routerName });
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /** The Workflow that runs every function. */
      worker: this.worker,
      /** The Function that reads the queue, and serves the admin API. */
      router: this.router,
      /** The queue of events. */
      queue: this.queue,
      /** The queue for events that couldn't be routed. */
      deadLetterQueue: this.deadLetterQueue,
      /** The table for the engine's state. */
      table: this.table,
      /** The schedule that ticks each minute, for cron triggers. */
      schedule: this.tick,
    };
  }

  /**
   * Link this to a function to let it use the admin API: `flow.admin`, and
   * `flow.runs` to look at, stop, retry and replay runs. Linking the EventFlow itself
   * only lets a function send events.
   *
   * @example
   * ```ts title="sst.config.ts"
   * new sst.aws.Function("Ops", {
   *   handler: "src/ops.handler",
   *   link: [flow, flow.admin],
   * });
   * ```
   */
  public get admin() {
    return this._admin;
  }

  /** The URL of the queue that events are sent to. */
  public get queueUrl() {
    return this.queue.url;
  }

  /** The name of the router function, which also serves the admin API. */
  public get routerName() {
    return this._routerName;
  }

  /** The name of the worker function, which runs every function. */
  public get workerName() {
    return this._workerName;
  }

  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        queueUrl: this.queueUrl,
        routerName: this.routerName,
      },
      // Sending only. Looking at runs, and changing them, is the admin link's.
      include: [permission({ actions: ["sqs:SendMessage"], resources: [this.queue.arn] })],
    };
  }
}

const __pulumiType = "sst:aws:EventFlow";
// @ts-expect-error
EventFlow.__pulumiType = __pulumiType;
