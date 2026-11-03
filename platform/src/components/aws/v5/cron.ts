import { all, ComponentResourceOptions, output } from "@pulumi/pulumi";
import { cloudwatch, iam, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  named,
  optional,
} from "../../parts-component";
import { notAnOption, plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { Function } from "./function";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import type { AnyTask } from "../helpers/task";

const parts = () => ({
  /**
   * The AWS Lambda function the cron job runs, when it's given a handler or the
   * function's args. An output, as it's created once its args are known.
   */
  function: deferred(Function),
  /**
   * The permission for EventBridge to invoke the function.
   */
  permission: optional(lambda.Permission),
  /**
   * The EventBridge rule that runs on the schedule.
   */
  rule: cloudwatch.EventRule,
  /**
   * The IAM role EventBridge runs the task as, when the cron job runs a task.
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
   * You can also pass in a function ARN.
   *
   * ```ts
   * {
   *   function: "arn:aws:lambda:us-east-1:000000000000:function:my-sst-app-jayair-MyFunction",
   * }
   * ```
   *
   * A handler or the function's args have to be plain values, since whether a function is
   * created is decided from them. A function you have, or its ARN, can be an output.
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
   * const myCluster = new sst.aws.v5.Cluster("MyCluster");
   * const myTask = new sst.aws.v5.Task("MyTask", { cluster: myCluster });
   * ```
   *
   * You can then pass in the task to the cron job.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.v5.Cron("MyCronJob", {
   *   task: myTask,
   *   schedule: "rate(1 minute)"
   * });
   * ```
   *
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
 * The `Cron` component has been deprecated. Use [`CronV2`](/docs/component/aws/v5/cron-v2) instead.
 *
 * :::caution
 * This component has been deprecated.
 * :::
 *
 * The `Cron` component lets you add cron jobs to your app
 * using [Amazon Event Bus](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-bus.html). The cron job can invoke a `Function` or a container `Task`.
 *
 * `CronV2` uses EventBridge Scheduler, so switching a cron job to it replaces its rule
 * with a schedule. This one keeps an app's rule as it is, and moves to 5.0 with it.
 *
 * @deprecated Use [`CronV2`](/docs/component/aws/v5/cron-v2) instead.
 *
 * @example
 * #### Cron job function
 *
 * Pass in a `schedule` and a `function` that'll be executed.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Cron("MyCronJob", {
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
 * const myCluster = new sst.aws.v5.Cluster("MyCluster");
 * const myTask = new sst.aws.v5.Task("MyTask", { cluster: myCluster });
 *
 * new sst.aws.v5.Cron("MyCronJob", {
 *   task: myTask,
 *   schedule: "rate(1 day)"
 * });
 * ```
 *
 * #### Customize the function
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.Cron("MyCronJob", {
 *   schedule: "rate(1 minute)",
 *   function: {
 *     handler: "src/cron.handler",
 *     timeout: "60 seconds"
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.Cron`
 *
 * Change `sst.aws.Cron` to `sst.aws.v5.Cron` and keep the name. The rule, its target, the
 * permission and the task's role are kept. A few things are written differently:
 *
 * - `job` is gone. Use `function`.
 * - The function is `nodes.function`, and `transform.function`. `sst.aws.Cron` called it the
 *   handler, `<name>Handler`; it's moved to `<name>Function`, not replaced. `nodes.job` is
 *   gone.
 * - A handler or the function's args have to be plain values, not outputs: whether a
 *   function is created is decided from them. A function you have, or its ARN, can be an
 *   output.
 * - `task` takes the V5 `Task` as well as the 4.x one.
 * - `nodes` has the permission and the task's role too, and `transform` takes them.
 */
export class Cron extends component("sst:aws:Cron", parts) {
  constructor(name: string, args: CronArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);
    notAnOption(args, "job", `Use "function" in the "${name}" cron job.`);

    const task = plain(args.task, `The "task" of the "${name}" cron job`);
    if (args.function && task)
      throw new VisibleError(
        `You cannot provide both a function and a task in the "${name}" Cron component.`,
      );
    const event = output(args.event || {});

    const rule = this.part("rule", {
      scheduleExpression: args.schedule,
      state: output(args.enabled ?? true).apply((enabled) =>
        enabled ? "ENABLED" : "DISABLED",
      ),
    });

    const fn = args.function
      ? functionPart(
          this,
          "function",
          plainFunction(
            args.function,
            `The "function" of the "${name}" cron job`,
          ),
          {},
        )
      : undefined;
    if (fn)
      this.part("permission", {
        action: "lambda:InvokeFunction",
        function: fn.arn,
        qualifier: fn.qualifier.apply((qualifier) => qualifier!),
        principal: "events.amazonaws.com",
        sourceArn: rule.arn,
      });

    const role = task
      ? this.part("role", {
          assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
            Service: "events.amazonaws.com",
          }),
          inlinePolicies: [
            {
              name: "inline",
              policy: iam.getPolicyDocumentOutput({
                statements: [
                  {
                    actions: ["ecs:RunTask"],
                    resources: [task.nodes.taskDefinition.arn],
                  },
                  {
                    actions: ["iam:PassRole"],
                    resources: [
                      task.nodes.executionRole.arn,
                      task.nodes.taskRole.arn,
                    ],
                  },
                ],
              }).json,
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
        : task
          ? {
              arn: task.cluster,
              rule: rule.name,
              ecsTarget: {
                launchType: "FARGATE",
                taskDefinitionArn: task.nodes.taskDefinition.arn,
                networkConfiguration: {
                  subnets: task.subnets,
                  securityGroups: task.securityGroups,
                  assignPublicIp: task.assignPublicIp,
                },
              },
              roleArn: role!.arn,
              // A task's containers are given the event in `SST_EVENT`
              input: all([
                event,
                output(task.containers as Input<string[]>),
              ]).apply(([event, containers]) =>
                JSON.stringify({
                  containerOverrides: containers.map((name: string) => ({
                    name,
                    environment: [
                      { name: "SST_EVENT", value: JSON.stringify(event) },
                    ],
                  })),
                }),
              ),
            }
          : missingTarget(),
    );

    function missingTarget(): never {
      throw new VisibleError(
        `You must provide either a function or a task in the "${name}" Cron component.`,
      );
    }
  }
}
