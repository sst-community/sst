import { all, ComponentResourceOptions, output } from "@pulumi/pulumi";
import { iam, scheduler } from "@pulumi/aws";
import { type ComponentArgs, component, deferred } from "../parts-component";
import { notAnOption, plain, usedAsItIs } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { Function } from "./function";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "./helpers/function-part";
import type { AnyTask } from "./helpers/task";
import { enabledState } from "./helpers/eventbridge";
import { rolesToPass } from "./helpers/fargate";

const parts = () => ({
  /**
   * The function that's invoked when the cron job runs. There isn't one when the job runs
   * a task.
   */
  function: deferred(Function),
  /**
   * The IAM role EventBridge Scheduler assumes to invoke the function or run the task.
   */
  role: iam.Role,
  /**
   * The EventBridge Scheduler schedule.
   */
  schedule: scheduler.Schedule,
});

export interface CronArgs extends ComponentArgs<typeof parts> {
  /**
   * The function that'll be executed when the cron job runs.
   *
   * @example
   *
   * ```ts
   * {
   *   function: "src/cron.handler"
   * }
   * ```
   *
   * You can pass in the full function props.
   *
   * ```ts
   * {
   *   function: {
   *     handler: "src/cron.handler",
   *     timeout: "60 seconds"
   *   }
   * }
   * ```
   *
   * You can also pass in a function you have, or its ARN. Only those can be an output: a
   * handler and the function's args are plain values, since whether a function is created
   * is decided from them.
   *
   * ```ts
   * {
   *   function: "arn:aws:lambda:us-east-1:000000000000:function:my-sst-app-jayair-MyFunction",
   * }
   * ```
   */
  function?: FunctionInput;
  /**
   * The task that'll be executed when the cron job runs.
   *
   * @example
   *
   * For example, let's say you have a task.
   *
   * ```js title="sst.config.ts"
   * const vpc = new sst.aws.Vpc("MyVpc");
   * const cluster = new sst.aws.Cluster("MyCluster", { vpc });
   * const task = new sst.aws.Task("MyTask", { cluster });
   * ```
   *
   * You can then pass in the task to the cron job.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.Cron("MyCronJob", {
   *   task,
   *   schedule: "rate(1 minute)"
   * });
   * ```
   */
  task?: AnyTask;
  /**
   * The event that'll be passed to the function or task.
   *
   * @example
   * ```ts
   * {
   *   event: {
   *     foo: "bar",
   *   }
   * }
   * ```
   *
   * For Lambda functions, the event will be passed to the function as an event.
   *
   * ```ts
   * function handler(event) {
   *   console.log(event.foo);
   * }
   * ```
   *
   * For ECS Fargate tasks, the event will be passed to the task as the `SST_EVENT`
   * environment variable.
   *
   * ```ts
   * const event = JSON.parse(process.env.SST_EVENT);
   * console.log(event.foo);
   * ```
   */
  event?: Input<any>;
  /**
   * The schedule for the cron job.
   *
   * :::note
   * The cron job continues to run even after you exit `sst dev`.
   * :::
   *
   * @example
   *
   * You can use a [rate expression](https://docs.aws.amazon.com/lambda/latest/dg/services-cloudwatchevents-expressions.html).
   *
   * ```ts
   * {
   *   schedule: "rate(5 minutes)"
   *   // schedule: "rate(1 minute)"
   *   // schedule: "rate(5 minutes)"
   *   // schedule: "rate(1 hour)"
   *   // schedule: "rate(5 hours)"
   *   // schedule: "rate(1 day)"
   *   // schedule: "rate(5 days)"
   * }
   * ```
   * Or a [cron expression](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html#eb-cron-expressions).
   *
   * ```ts
   * {
   *   schedule: "cron(15 10 * * ? *)", // 10:15 AM (UTC) every day
   * }
   * ```
   *
   * Or an [at expression](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html#one-time) for a one-time schedule.
   *
   * ```ts
   * {
   *   schedule: "at(2025-06-01T10:00:00)",
   * }
   * ```
   */
  schedule: Input<`rate(${string})` | `cron(${string})` | `at(${string})`>;
  /**
   * The IANA timezone for the cron schedule. When set, the cron expression is
   * evaluated in this timezone, with automatic DST handling.
   *
   * @default `"UTC"`
   * @example
   * ```ts
   * {
   *   timezone: "America/New_York"
   * }
   * ```
   */
  timezone?: Input<string>;
  /**
   * Configures whether the cron job is enabled. When disabled, the cron job won't run.
   * @default true
   * @example
   * ```ts
   * {
   *   enabled: false
   * }
   * ```
   */
  enabled?: Input<boolean>;
  /**
   * The number of retry attempts for failed invocations. Between 0 and 185.
   *
   * @default `0`
   * @example
   * ```ts
   * {
   *   retries: 3
   * }
   * ```
   */
  retries?: Input<number>;
  /**
   * The ARN of an SQS queue to use as a dead-letter queue. When all retry
   * attempts are exhausted, failed events are sent to this queue.
   *
   * @example
   * ```ts
   * {
   *   dlq: myQueue.arn
   * }
   * ```
   */
  dlq?: Input<string>;
}

/**
 * The `Cron` component lets you add cron jobs to your app
 * using [Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html). The cron job can invoke a function or a container `Task`.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 * #### Cron job function
 *
 * Pass in a `schedule` and a `function` that'll be executed.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Cron("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)"
 * });
 * ```
 *
 * #### Cron job container task
 *
 * Create a container task and pass in a `schedule` and a `task` that'll be executed.
 *
 * ```ts title="sst.config.ts" {6}
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const cluster = new sst.aws.Cluster("MyCluster", { vpc });
 * const task = new sst.aws.Task("MyTask", { cluster });
 *
 * new sst.aws.Cron("MyCronJob", {
 *   task,
 *   schedule: "rate(1 day)"
 * });
 * ```
 *
 * #### Set a timezone
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Cron("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "cron(15 10 * * ? *)",
 *   timezone: "America/New_York"
 * });
 * ```
 *
 * #### Configure retries
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Cron("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)",
 *   retries: 3
 * });
 * ```
 *
 * #### One-time schedule
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Cron("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "at(2025-06-01T10:00:00)"
 * });
 * ```
 *
 * #### Customize the function
 *
 * ```js title="sst.config.ts"
 * new sst.aws.Cron("MyCronJob", {
 *   schedule: "rate(1 minute)",
 *   function: {
 *     handler: "src/cron.handler",
 *     timeout: "60 seconds"
 *   }
 * });
 * ```
 *
 * #### Switch from SST 4's `sst.aws.CronV2`
 *
 * Change `sst.aws.CronV2` to `sst.aws.Cron`, without the version, and keep the name. The
 * schedule, its role and the function you've deployed are kept.
 *
 * ```ts title="sst.config.ts" del={1-4} ins={5-8}
 * new sst.aws.CronV2("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)"
 * });
 * new sst.aws.Cron("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)"
 * });
 * ```
 *
 * A few things are written differently:
 *
 * - It's named `Cron`. `sst.aws.CronV2` had the version in its name because it replaced
 *   SST 4's first `Cron`, which has no 5.0 form. It keeps its type, `sst:aws:CronV2`, which
 *   is what a deployed one has.
 * - The deprecated `job` is gone. Use `function`, as written below. So is
 *   `nodes.job`: read `nodes.function`.
 * - The function is named after `function`: `MyCronJobFunction`, where it was
 *   `MyCronJobHandler`. The function you've deployed keeps its name in AWS.
 * - `nodes.function` is empty for a job that runs a task, where `sst.aws.CronV2` failed
 *   when it was read.
 * - `function`, as a handler or a function's args, has to be a plain value, not an output:
 *   it decides what's created. A function you already have, or its ARN, can still be an
 *   output.
 * - A function's args are typed as
 *   [`sst.aws.Function`](/docs/component/aws/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.Function`](/docs/component/aws/function) takes them.
 * - If you set part of the schedule's `target` with an object in `transform`, the rest
 *   of the target is kept.
 */
export class Cron extends component("sst:aws:CronV2", parts) {
  constructor(name: string, args: CronArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const owner = `the "${name}" cron job`;
    notAnOption(args, "job", `Use "function".`, owner);
    const task = plain(args.task, `The "task" of ${owner}`);
    // A function you have can be given in `existing`
    const existingFunction = args.existing?.function !== undefined;
    if (existingFunction) usedAsItIs(args, ["function"], "function", owner);
    if (existingFunction && task)
      throw new VisibleError(
        `The "${name}" cron job is given an existing "function" and a "task". A cron job runs one or the other.`,
      );
    if (args.function && task)
      throw new VisibleError(
        `The "${name}" cron job is given both a "function" and a "task". A cron job runs one or the other.`,
      );
    if (!args.function && !existingFunction && !task)
      throw new VisibleError(
        `The "${name}" cron job needs a "function" or a "task" to run.`,
      );

    const event = output(args.event || {});
    const fn =
      args.function || existingFunction
        ? functionPart(
            this,
            "function",
            // Without one, `functionPart()` uses the existing function
            plainFunction(args.function!, `The "function" of ${owner}`),
            {},
          )
        : undefined;

    // What the schedule runs, and what it takes to run it
    const runs = fn
      ? [{ actions: ["lambda:InvokeFunction"], resources: [fn.targetArn] }]
      : [
          {
            actions: ["ecs:RunTask"],
            resources: [task!.nodes.taskDefinition.arn],
          },
          {
            actions: ["iam:PassRole"],
            resources: rolesToPass(task!.nodes.taskDefinition),
          },
        ];
    const role = this.part("role", {
      assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
        Service: "scheduler.amazonaws.com",
      }),
      inlinePolicies: [
        {
          name: "inline",
          policy: output(args.dlq).apply(
            (dlq) =>
              iam.getPolicyDocumentOutput({
                statements: [
                  ...runs,
                  // Failed events are sent to the dead-letter queue
                  ...(dlq
                    ? [{ actions: ["sqs:SendMessage"], resources: [dlq] }]
                    : []),
                ],
              }).json,
          ),
        },
      ],
    });

    const retries = {
      retryPolicy: { maximumRetryAttempts: output(args.retries ?? 0) },
      deadLetterConfig: args.dlq ? { arn: args.dlq } : undefined,
    };
    this.part("schedule", {
      scheduleExpression: args.schedule,
      scheduleExpressionTimezone: args.timezone,
      flexibleTimeWindow: { mode: "OFF" },
      state: enabledState(args.enabled),
      target: fn
        ? {
            arn: fn.targetArn,
            roleArn: role.arn,
            // A function is given the event as it is
            input: event.apply((event) => JSON.stringify(event)),
            ...retries,
          }
        : {
            arn: task!.cluster,
            roleArn: role.arn,
            // A task's containers are given the event in `SST_EVENT`
            input: all([event, task!.containers]).apply(([event, containers]) =>
              JSON.stringify({
                containerOverrides: containers.map((name: string) => ({
                  name,
                  environment: [
                    { name: "SST_EVENT", value: JSON.stringify(event) },
                  ],
                })),
              }),
            ),
            ecsParameters: {
              taskDefinitionArn: task!.nodes.taskDefinition.arn,
              launchType: "FARGATE",
              networkConfiguration: {
                subnets: task!.subnets,
                securityGroups: task!.securityGroups,
                assignPublicIp: task!.assignPublicIp,
              },
            },
            ...retries,
          },
    });
  }
}
