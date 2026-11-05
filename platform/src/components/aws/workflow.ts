import { ComponentResourceOptions, output } from "@pulumi/pulumi";
import { type ComponentArgs, component, named } from "../parts-component";
import { plain, usedAsItIs } from "../args";
import { VisibleError } from "../error";
import type { Input } from "../input";
import type { Duration, DurationDays, DurationMinutes } from "../duration";
import type { RETENTION } from "./logging";
import { Function, type FunctionArgs } from "./function";

const parts = () => ({
  /**
   * The SST Function component backing the workflow.
   */
  function: named(Function, "Handler"),
});

export interface WorkflowArgs
  extends Omit<
      FunctionArgs,
      | "concurrency"
      | "durable"
      | "existing"
      | "injections"
      | "logging"
      | "retries"
      | "runtime"
      | "streaming"
      | "timeout"
      | "transform"
      | "url"
      | "versioning"
      | "_skipHint"
      | "_skipMetadata"
    >,
    ComponentArgs<typeof parts> {
  /**
   * The language runtime for the workflow.
   *
   * AWS Lambda durable functions currently support `"nodejs22.x"`, `"nodejs24.x"`, and
   * `"python3.13"`.
   *
   * @default `"nodejs24.x"`
   * @example
   * ```js
   * {
   *   runtime: "python3.13"
   * }
   * ```
   */
  runtime?: "nodejs22.x" | "nodejs24.x" | "python3.13";
  /**
   * Number of days to retain the workflow execution state.
   *
   * @default `"30 days"`
   */
  retention?: Input<DurationDays>;
  /**
   * Configure timeout limits for the workflow execution and each underlying Lambda invocation.
   */
  timeout?: Input<{
    /**
     * Maximum execution time for the entire workflow execution, from when it starts until it completes.
     *
     * This includes time spent across retries, replays, waits, and all durable invocations.
     *
     * @default `"14 days"`
     */
    execution?: Input<Duration>;
    /**
     * Maximum execution time for each underlying Lambda invocation.
     *
     * This is not a per-step timeout. A single invocation can run multiple steps before the
     * workflow yields, waits, or replays.
     *
     * @default `"5 minutes"`
     */
    invocation?: Input<DurationMinutes>;
  }>;
  /**
   * Configure the workflow logs in CloudWatch. Or pass in `false` to disable writing logs.
   * The only supported log format is `json`.
   *
   * Whether there are logs decides whether the log group is created, so `logging` has to be
   * a plain value, not an output. What's in it can be an output.
   *
   * @default `{retention: "1 month", format: "json"}`
   */
  logging?:
    | false
    | {
        /**
         * The log format for the workflow.
         *
         * AWS Lambda durable functions require structured JSON logs, so `"json"` is the only
         * supported value.
         *
         * @default `"json"`
         */
        format?: Input<"json">;
        /**
         * The duration the workflow logs are kept in CloudWatch.
         *
         * It can't be set with `logGroup`, which has its own retention.
         *
         * @default `1 month`
         * @example
         * ```js
         * {
         *   logging: {
         *     retention: "forever"
         *   }
         * }
         * ```
         */
        retention?: Input<keyof typeof RETENTION>;
        /**
         * Assigns the given CloudWatch log group name to the workflow. This allows you to
         * pass in a previously created log group.
         *
         * By default, the workflow creates a new log group when it's created.
         *
         * @default Creates a log group
         * @example
         * ```js
         * {
         *   logging: {
         *     logGroup: "/existing/log-group"
         *   }
         * }
         * ```
         */
        logGroup?: Input<string>;
      };
}

/**
 * The `Workflow` component lets you add serverless workflows to your app using
 * [AWS Lambda Durable Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html).
 *
 * It's a thin wrapper around the [`Function`](/docs/component/aws/v5/function) component
 * with durable execution enabled.
 * It includes an [SDK](#sdk) that wraps the AWS SDK with a simpler interface, adds helper methods, and makes it easier to integrate with other SST components.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Workflow("MyWorkflow", {
 *   handler: "src/workflow.handler",
 * });
 * ```
 *
 * ```ts title="src/workflow.ts"
 * import { workflow } from "sst/aws/workflow";
 *
 * export const handler = workflow.handler(async (event, ctx) => {
 *   const user = await ctx.step("load-user", async () => {
 *     return { id: "user_123", email: "alice@example.com" };
 *   });
 *
 *   await ctx.wait("pause-before-email", "1 minute");
 *
 *   return ctx.step("send-email", async () => {
 *     return { sent: true, userId: user.id };
 *   });
 * });
 * ```
 *
 * #### Configure timeout and retention
 *
 * ```ts {3-7} title="sst.config.ts"
 * new sst.aws.Workflow("MyWorkflow", {
 *   handler: "src/workflow.handler",
 *   retention: "30 days",
 *   timeout: {
 *     execution: "2 hours",
 *     invocation: "30 seconds",
 *   },
 * });
 * ```
 *
 * #### Link resources
 *
 * ```ts {1,5} title="sst.config.ts"
 * const bucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.Workflow("MyWorkflow", {
 *   handler: "src/workflow.handler",
 *   link: [bucket],
 * });
 * ```
 *
 * ```ts title="src/workflow.ts"
 * import { Resource } from "sst";
 * import { workflow } from "sst/aws/workflow";
 *
 * export const handler = workflow.handler(async (event, ctx) => {
 *   return ctx.step("get-bucket-name", async () => {
 *     return Resource.MyBucket.name;
 *   });
 * });
 * ```
 *
 * #### Trigger with a cron job
 *
 * ```ts {5-8} title="sst.config.ts"
 * const workflow = new sst.aws.Workflow("MyWorkflow", {
 *   handler: "src/workflow.handler",
 * });
 *
 * new sst.aws.Cron("MyCron", {
 *   schedule: "rate(1 minute)",
 *   function: workflow,
 * });
 * ```
 *
 * ```ts title="src/workflow.ts"
 * import { workflow } from "sst/aws/workflow";
 *
 * export const handler = workflow.handler(async (event, ctx) => {
 *   await ctx.step("start", async ({ logger }) => {
 *     logger.info({ message: "Workflow invoked by cron" });
 *   });
 * });
 * ```
 *
 * [Check out the full example](/docs/examples/#aws-workflow-cron).
 *
 * #### Subscribe to a bus
 *
 * ```ts {6-9} title="sst.config.ts"
 * const workflow = new sst.aws.Workflow("MyWorkflow", {
 *   handler: "src/workflow.handler",
 * });
 *
 * const bus = new sst.aws.Bus("MyBus");
 *
 * bus.subscribe("MySubscriber", workflow, {
 *   pattern: {
 *     detailType: ["app.workflow.requested"],
 *   },
 * });
 * ```
 *
 * ```ts title="src/workflow.ts"
 * import { workflow } from "sst/aws/workflow";
 *
 * interface Event {
 *   "detail-type": string;
 *   detail: {
 *     properties: {
 *       message: string;
 *       requestId: string;
 *     };
 *   };
 * }
 *
 * export const handler = workflow.handler<Event>(async (event, ctx) => {
 *   await ctx.step("start", async ({ logger }) => {
 *     logger.info({
 *       message: "Workflow invoked by bus",
 *       requestId: event.detail.properties.requestId,
 *     });
 *   });
 * });
 * ```
 *
 * [Check out the full example](/docs/examples/#aws-workflow-bus).
 *
 * #### Switch from SST 4's `sst.aws.Workflow`
 *
 * Keep the name, and `sst migrate` moves it. Its function,
 * `<name>Handler`, becomes a V5 `Function` under the same name, as the `Function`'s own
 * "Switch from" says. A few things are written differently:
 *
 * - `transform.function` transforms the function's args, as the `transform` of any part
 *   does. What `sst.aws.Workflow` took there, the function's own `transform`, goes in
 *   `transform.function.transform`.
 * - What the function is built from, like `handler`, `runtime` or `bundle`, has to be a
 *   plain value, not an output, as [`sst.aws.Function`](/docs/component/aws/v5/function)
 *   takes it. So does `logging`, since whether there are logs decides whether a log group
 *   is created. What's in `logging` can be an output.
 * - A workflow can be given to the V5 `Cron`, `Bus` and the other V5 components that take
 *   a function, as `sst.aws.Workflow` could be to theirs. SST 4's components don't take the
 *   V5 one: switch a component the workflow is given to with it.
 * - `role` isn't one of its args, as it isn't the V5 `Function`'s. To give the function a
 *   role you have, write `transform: { function: { existing: { role } } }`.
 *
 * ---
 *
 * ### Limitations
 *
 * Durable workflows replay from the top on resume and retry. Keep the control flow
 * deterministic, and move side effects like API calls, database writes, timestamps, and random
 * ID generation inside durable operations like `ctx.step()`.
 *
 * :::caution
 * Workflow handlers have versioning enabled. Deploying an update won't update existing running workflows.
 * :::
 *
 * Before using workflows in production, review the
 * [AWS best practices for durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-best-practices.html).
 *
 * ---
 *
 * ### Cost
 *
 * A workflow has no idle monthly cost. You pay the standard Lambda request and compute charges
 * for each invocation.
 *
 * :::tip
 * When a workflow is suspended in a `wait`, functions don't incur costs until execution resumes.
 * :::
 *
 * Lambda durable functions usage is billed separately.
 *
 * - Durable operations like starting an execution, completing a step, and creating a wait are
 *   billed at $8.00 per 1 million operations.
 * - Data written by durable operations is billed at $0.25 per GB.
 * - Retained execution state is billed at $0.15 per GB-month.
 *
 * For example, a workflow with two `step()` calls and one `wait()` uses four durable operations:
 * one start, two steps, and one wait. That's about **$0.000032 per execution** for durable
 * operations, before Lambda compute, requests, written data, and retention.
 *
 * These are rough _us-east-1_ estimates. Check out the
 * [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/#Lambda_Durable_Functions_Pricing)
 * for more details.
 */
export class Workflow extends component("sst:aws:Workflow", parts) {
  constructor(
    name: string,
    args: WorkflowArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    // What SST 4 took in `transform.function` was the function's own
    // transform, which goes in its `transform` now
    const fnTransform = args.transform?.function;
    if (
      fnTransform &&
      typeof fnTransform === "object" &&
      (["function", "logGroup", "eventInvokeConfig"].some(
        (key) => key in fnTransform,
      ) ||
        typeof (fnTransform as Record<string, unknown>).role === "object")
    )
      throw new VisibleError(
        `The "transform.function" of the "${name}" workflow transforms the function's args. To transform the function's own resources, as SST 4 took there, put them in "transform.function.transform": { function: { transform: { function: { ... } } } }.`,
      );

    const {
      transform: _transform,
      existing: _existing,
      timeout,
      retention,
      logging: givenLogging,
      ...functionArgs
    } = args;
    // A function that's already there is used the way it is: whatever would
    // configure it is refused
    if (this.existingPart("function"))
      usedAsItIs(
        args,
        Object.keys(args).filter(
          (key) => key !== "transform" && key !== "existing",
        ),
        "function",
        `the "${name}" workflow`,
      );
    const timeouts = output(timeout);
    const logging = plain(
      givenLogging,
      `The "logging" of the "${name}" workflow`,
    );
    plain(args.runtime, `The "runtime" of the "${name}" workflow`);

    this.part("function", {
      ...functionArgs,
      logging:
        logging === undefined
          ? undefined
          : logging === false
            ? false
            : {
                retention: logging.retention,
                format: "json" as const,
              },
      ...(logging && logging.logGroup !== undefined
        ? { existing: { logGroup: logging.logGroup } }
        : {}),
      // A deploy doesn't change the code of a workflow that's running
      versioning: true,
      timeout: timeouts.apply((timeout) => timeout?.invocation ?? "5 minutes"),
      durable: {
        timeout: timeouts.apply((timeout) => timeout?.execution ?? "14 days"),
        retention,
      },
    });

    // As SST 4 registered them
    this.registerOutputs({
      name: this.name,
      arn: this.arn,
      qualifier: this.qualifier,
    });
  }

  /**
   * The function backing the workflow.
   */
  public getFunction() {
    return this.nodes.function;
  }

  /**
   * The name of the Lambda function backing the workflow.
   */
  public get name() {
    return this.nodes.function.name;
  }

  /**
   * The ARN of the Lambda function backing the workflow.
   */
  public get arn() {
    return this.nodes.function.arn;
  }

  /**
   * The published version qualifier backing the workflow.
   */
  public get qualifier() {
    return this.nodes.function.qualifier;
  }

  /**
   * Linking a workflow gives the linked resource the name of its function and the version
   * it runs, and lets it start the workflow and manage its executions.
   */
  public link() {
    const link = this.nodes.function.link();
    return {
      properties: {
        name: link.properties.name,
        qualifier: this.qualifier,
      },
      include: link.include,
    };
  }
}
