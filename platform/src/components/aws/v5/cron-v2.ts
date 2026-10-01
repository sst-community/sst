import { all, ComponentResourceOptions, output } from "@pulumi/pulumi";
import { iam, scheduler } from "@pulumi/aws";
import { V5Args, component, deferred } from "../../parts-component";
import { notAnOption, plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import type {
  Function as OriginalFunction,
  FunctionArgs as OriginalFunctionArgs,
  FunctionArn,
} from "../function";
import { Function, type FunctionArgs } from "./function";
import { functionPart } from "../helpers/function-part";
import type { Task as OriginalTask } from "../task";
import type { Task } from "./task";
import type { Workflow } from "../workflow";
import type { CronV2Args as OriginalCronV2Args } from "../cron-v2";

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

export interface CronV2Args
  extends V5Args<Omit<OriginalCronV2Args, "job" | "function" | "task">, typeof parts> {
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
   * You can also pass in a function ARN.
   *
   * ```ts
   * {
   *   function: "arn:aws:lambda:us-east-1:000000000000:function:my-sst-app-jayair-MyFunction",
   * }
   * ```
   */
  function?: Input<
    | string
    | Workflow
    | OriginalFunction
    | Function
    | OriginalFunctionArgs
    | FunctionArgs
    | FunctionArn
  >;
  /**
   * The task that'll be executed when the cron job runs.
   *
   * @example
   *
   * For example, let's say you have a task.
   *
   * ```js title="sst.config.ts"
   * const cluster = new sst.aws.Cluster("MyCluster");
   * const task = new sst.aws.v5.Task("MyTask", { cluster });
   * ```
   *
   * You can then pass in the task to the cron job.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.v5.CronV2("MyCronJob", {
   *   task,
   *   schedule: "rate(1 minute)"
   * });
   * ```
   */
  task?: OriginalTask | Task;
}

/**
 * The `CronV2` component lets you add cron jobs to your app
 * using [Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html). The cron job can invoke a function or a container `Task`.
 *
 * It takes the same args as [`sst.aws.CronV2`](/docs/component/aws/cron-v2) and creates
 * the same resources. It's built from parts, so every resource it creates can be
 * transformed, is available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 * #### Cron job function
 *
 * Pass in a `schedule` and a `function` that'll be executed.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CronV2("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)"
 * });
 * ```
 *
 * #### Cron job container task
 *
 * Create a container task and pass in a `schedule` and a `task` that'll be executed.
 *
 * ```ts title="sst.config.ts" {5}
 * const cluster = new sst.aws.Cluster("MyCluster");
 * const task = new sst.aws.v5.Task("MyTask", { cluster });
 *
 * new sst.aws.v5.CronV2("MyCronJob", {
 *   task,
 *   schedule: "rate(1 day)"
 * });
 * ```
 *
 * #### Set a timezone
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CronV2("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "cron(15 10 * * ? *)",
 *   timezone: "America/New_York"
 * });
 * ```
 *
 * #### Configure retries
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CronV2("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)",
 *   retries: 3
 * });
 * ```
 *
 * #### One-time schedule
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CronV2("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "at(2025-06-01T10:00:00)"
 * });
 * ```
 *
 * #### Customize the function
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.CronV2("MyCronJob", {
 *   schedule: "rate(1 minute)",
 *   function: {
 *     handler: "src/cron.handler",
 *     timeout: "60 seconds"
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.CronV2`
 *
 * Change `sst.aws.CronV2` to `sst.aws.v5.CronV2` and keep the name. The schedule, its role
 * and the function you've deployed are kept.
 *
 * ```ts title="sst.config.ts" del={1-4} ins={5-8}
 * new sst.aws.CronV2("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)"
 * });
 * new sst.aws.v5.CronV2("MyCronJob", {
 *   function: "src/cron.handler",
 *   schedule: "rate(1 minute)"
 * });
 * ```
 *
 * A few things are written differently:
 *
 * - The deprecated `job` is gone. Use `function`, which takes the same things. So is
 *   `nodes.job`: read `nodes.function`.
 * - The function is named after `function`: `MyCronJobFunction`, where it was
 *   `MyCronJobHandler`. The function you've deployed keeps its name in AWS.
 * - `nodes.function` is empty for a job that runs a task, where `sst.aws.CronV2` failed
 *   when it was read.
 * - The function is a [`sst.aws.v5.Function`](/docs/component/aws/v5/function), so its
 *   definition can be written the way that takes it. The way `sst.aws.Function` takes it
 *   still works.
 * - If you set part of the schedule's `target` with an object in `transform`, the rest
 *   of the target is kept.
 */
export class CronV2 extends component("sst:aws:CronV2V5", parts) {
  constructor(
    name: string,
    args: CronV2Args,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    notAnOption(args, "job", `Use "function" in the "${name}" cron job.`);
    const task = plain(args.task, `The "task" of the "${name}" cron job`);
    if (args.function && task)
      throw new VisibleError(
        `You cannot provide both a function and a task in the "${name}" CronV2 component.`,
      );
    if (!args.function && !task)
      throw new VisibleError(
        `You must provide either a function or a task in the "${name}" CronV2 component.`,
      );

    const event = output(args.event || {});
    const fn = args.function
      ? functionPart(this, "function", args.function, {})
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
            resources: [
              task!.nodes.executionRole.arn,
              task!.nodes.taskRole.arn,
            ],
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
      state: output(args.enabled ?? true).apply((enabled) =>
        enabled ? "ENABLED" : "DISABLED",
      ),
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
