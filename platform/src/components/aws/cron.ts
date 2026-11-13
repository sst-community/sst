import type { Task } from "./task";
import { all, ComponentResourceOptions, output } from "@pulumi/pulumi";
import { cloudwatch, iam, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  named,
  optional,
} from "../parts-component";
import { notAnExistingPart, notAnOption, plain, usedAsItIs } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { Function } from "./function";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "./helpers/function-part";
import { enabledState } from "./helpers/eventbridge";
import { invokePermissionArgs } from "./helpers/function-permission";
import { rolesToPass } from "./helpers/fargate";

const parts = () => ({
  /**
   * The function that's invoked when the cron job runs. There isn't one when the job runs
   * a task.
   */
  function: deferred(Function),
  /**
   * The permission for EventBridge to invoke the function. There isn't one when the job
   * runs a task.
   */
  permission: optional(lambda.Permission),
  /**
   * The EventBridge rule that runs on the schedule.
   */
  rule: cloudwatch.EventRule,
  /**
   * The IAM role EventBridge runs the task as. There isn't one when the job invokes a
   * function.
   */
  role: named(optional(iam.Role), "TargetRole"),
  /**
   * The rule's target: the function or the task.
   */
  target: cloudwatch.EventTarget,
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
  task?: Task;
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
   */
  schedule: Input<`rate(${string})` | `cron(${string})`>;
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
}

/**
 * The `Cron` component has been deprecated. Use [`CronV2`](/docs/component/aws/cron-v2) instead.
 *
 * :::caution
 * This component has been deprecated.
 * :::
 *
 * The `Cron` component lets you add cron jobs to your app
 * using [Amazon Event Bus](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-bus.html). The cron job can invoke a function or a container `Task`.
 *
 * `CronV2` uses EventBridge Scheduler, so switching a cron job to it replaces its rule
 * with a schedule.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @deprecated Use [`CronV2`](/docs/component/aws/cron-v2) instead.
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
 * #### Switch from SST 4's `sst.aws.Cron`
 *
 * Keep the name, and `sst migrate` moves it. The rule, its target, the permission, the
 * task's role and the function you've deployed are kept.
 *
 * A few things are written differently:
 *
 * - The deprecated `job` is gone. Use `function`. So is
 *   `nodes.job`: read `nodes.function`.
 * - The function is named after `function`: `MyCronJobFunction`, where it was
 *   `MyCronJobHandler`. The function you've deployed keeps its name in AWS.
 * - `nodes.function` is empty for a job that runs a task, where SST 4's `Cron` failed
 *   when it was read.
 * - `function`, as a handler or a function's args, has to be a plain value, not an output:
 *   it decides what's created. A function you already have, or its ARN, can still be an
 *   output.
 * - A function's args are typed as
 *   [`sst.aws.Function`](/docs/component/aws/function)'s; args written the way
 *   SST 4's `Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.Function`](/docs/component/aws/function) takes them.
 * - `nodes` has the permission and the task's role too, and `transform` takes them.
 * - If you set part of the target's `ecsTarget` with an object in `transform`, the rest
 *   of it is kept. To replace it, as SST 4 did, use a function.
 */
export class Cron extends component("sst:aws:Cron", parts) {
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
    // A rule or a target that's already there is used the way it is, and only
    // what the job runs is given in `existing`
    if (this.existingPart("rule")) usedAsItIs(args, ["enabled"], "rule", owner);
    if (this.existingPart("target"))
      usedAsItIs(args, ["event"], "target", owner);
    if (task)
      notAnExistingPart(
        args.existing,
        "permission",
        owner,
        `A cron job that runs a task gives no function permission to be invoked.`,
      );
    else
      notAnExistingPart(
        args.existing,
        "role",
        owner,
        `A cron job that invokes a function needs no role: the function's permission lets EventBridge invoke it.`,
      );

    const event = output(args.event || {});
    const rule = this.part("rule", {
      scheduleExpression: args.schedule,
      state: enabledState(args.enabled),
    });

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
    if (fn)
      this.part(
        "permission",
        invokePermissionArgs(fn, "events.amazonaws.com", rule.arn),
      );

    const role = task
      ? this.part("role", {
          assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
            Service: "events.amazonaws.com",
          }),
          inlinePolicies: [
            {
              name: "inline",
              policy: iam.getPolicyDocumentOutput(
                {
                  statements: [
                    {
                      actions: ["ecs:RunTask"],
                      resources: [task.nodes.taskDefinition.arn],
                    },
                    {
                      actions: ["iam:PassRole"],
                      resources: rolesToPass(task.nodes.taskDefinition),
                    },
                  ],
                },
                { parent: this },
              ).json,
            },
          ],
        })
      : undefined;

    this.part(
      "target",
      fn
        ? {
            arn: fn.targetArn,
            rule: rule.name,
            // A function is given the event as it is
            input: event.apply((event) => JSON.stringify(event)),
          }
        : {
            arn: task!.cluster,
            rule: rule.name,
            ecsTarget: {
              launchType: "FARGATE",
              taskDefinitionArn: task!.nodes.taskDefinition.arn,
              networkConfiguration: {
                subnets: task!.subnets,
                securityGroups: task!.securityGroups,
                assignPublicIp: task!.assignPublicIp,
              },
            },
            roleArn: role!.arn,
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
          },
    );
  }
}
