import { type ComponentResourceOptions } from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import { type ComponentArgs, component, named } from "../parts-component";
import type { Input } from "../input";
import { notAnExistingPart, plain } from "../args";
import { binding } from "./binding";
import { DEFAULT_ACCOUNT_ID } from "./account-id";
import { Worker } from "./worker";

const parts = () => ({
  /**
   * The Worker that hosts the workflow class. Its script is named after it,
   * `MyWorkflowScriptScript`.
   */
  worker: named(Worker, "Script"),
  /**
   * The Cloudflare Workflow.
   */
  workflow: cf.Workflow,
});

export interface WorkflowArgs extends ComponentArgs<typeof parts> {
  /**
   * Path to the handler file that exports the class that extends `WorkflowEntrypoint`.
   *
   * The handler path is relative to the root of your repo or the `sst.config.ts`.
   *
   * @example
   *
   * ```js
   * {
   *   handler: "src/workflow.ts"
   * }
   * ```
   */
  handler: Input<string>;
  /**
   * The name of the class in your handler file that extends `WorkflowEntrypoint`.
   *
   * Cloudflare Workflows are defined as classes that extend the
   * [`WorkflowEntrypoint`](https://developers.cloudflare.com/workflows/build/workers-api/#workflowentrypoint)
   * class. You must specify the name of the class so SST can bind to it.
   *
   * :::caution
   * The class must be exported as a named export, not as `export default`.
   * :::
   *
   * @example
   *
   * Given this handler file:
   *
   * ```ts title="src/workflow.ts"
   * import { WorkflowEntrypoint } from "cloudflare:workers";
   *
   * export class OrderProcessor extends WorkflowEntrypoint<Env, Params> {
   *   async run(event, step) {
   *     // ...
   *   }
   * }
   * ```
   *
   * You would set:
   *
   * ```js
   * {
   *   className: "OrderProcessor"
   * }
   * ```
   */
  className: Input<string>;
  /**
   * [Link resources](/docs/linking/) to your workflow. This will:
   *
   * 1. Make them available on `this.env` inside your workflow class.
   * 2. Allow you to access them in your workflow using the [SDK](/docs/reference/sdk/).
   *
   * A link to something in AWS gives the workflow's Worker an IAM user, so
   * the list is a plain value, not an output.
   *
   * @example
   *
   * Takes a list of components to link to the workflow.
   *
   * ```js
   * {
   *   link: [bucket, db]
   * }
   * ```
   */
  link?: any[];
  /**
   * Key-value pairs that are set as environment variables on the workflow's Worker.
   *
   * They can be accessed in your workflow through `this.env.<key>`.
   *
   * @example
   *
   * ```js
   * {
   *   environment: {
   *     DEBUG: "true"
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * The Cloudflare account ID to use for this Workflow and its Worker.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * The `Workflow` component lets you add [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
 * to your app.
 *
 * :::caution
 * Workflow `console.log` output doesn't stream in real time during `sst dev`.
 * :::
 *
 * A Workflow is a durable, multi-step function that runs on Cloudflare Workers. You
 * define it as a class that extends `WorkflowEntrypoint` and pass it to this component.
 *
 * @example
 * #### Minimal example
 *
 * Define a workflow class:
 *
 * ```ts title="src/workflow.ts"
 * import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
 *
 * export class OrderProcessor extends WorkflowEntrypoint<Env, { orderId: string }> {
 *   async run(event: WorkflowEvent<{ orderId: string }>, step: WorkflowStep) {
 *     await step.do("validate", async () => {});
 *     await step.sleep("cooldown", "10 seconds");
 *     await step.do("charge", async () => {});
 *   }
 * }
 * ```
 *
 * Then register it with SST:
 *
 * ```ts title="sst.config.ts"
 * const processor = new sst.cloudflare.Workflow("OrderProcessor", {
 *   handler: "src/workflow.ts",
 *   className: "OrderProcessor",
 * });
 * ```
 *
 * #### Trigger from a Worker
 *
 * Link the workflow to a Worker to get a native Cloudflare
 * [`Workflow`](https://developers.cloudflare.com/workflows/build/workers-api/#workflow)
 * binding:
 *
 * ```ts title="sst.config.ts" {4}
 * new sst.cloudflare.Worker("Api", {
 *   handler: "src/api.ts",
 *   url: true,
 *   link: [processor],
 * });
 * ```
 *
 * Then invoke it from your worker code:
 *
 * ```ts title="src/api.ts"
 * import { Resource } from "sst";
 *
 * export default {
 *   async fetch(req: Request) {
 *     const instance = await Resource.OrderProcessor.create({
 *       params: { orderId: "ord_123" },
 *     });
 *     return Response.json({ id: instance.id });
 *   },
 * };
 * ```
 *
 * #### Give the workflow access to other resources
 *
 * ```ts title="sst.config.ts"
 * const processor = new sst.cloudflare.Workflow("OrderProcessor", {
 *   handler: "src/workflow.ts",
 *   className: "OrderProcessor",
 *   link: [bucket],
 * });
 * ```
 *
 * #### Switch from SST 4's `sst.cloudflare.Workflow`
 *
 * Keep the name, and `sst migrate` moves it. The workflow and its Worker are kept.
 *
 * - `link` is a plain value, not an output: a link to something in AWS gives
 *   the Worker an IAM user. Each link's values can still be outputs.
 * - The Worker is [`sst.cloudflare.Worker`](/docs/component/cloudflare/v5/worker).
 *   `transform.worker` takes its args, as
 *   [`sst.cloudflare.Worker`](/docs/component/cloudflare/v5/worker) takes
 *   them.
 */
export class Workflow extends component("sst:cloudflare:Workflow", parts) {
  constructor(
    name: string,
    args: WorkflowArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const owner = `the "${name}" workflow`;
    notAnExistingPart(
      args.existing,
      "worker",
      owner,
      `The workflow creates the Worker that hosts its class from "handler".`,
    );
    notAnExistingPart(
      args.existing,
      "workflow",
      owner,
      `The workflow is created for the Worker it creates from "handler". To bind a workflow you have, link a worker to it with "sst.cloudflare.binding()".`,
    );

    const worker = this.part("worker", {
      handler: args.handler,
      link: plain(
        args.link,
        `The "link" of ${owner}`,
        "A link to something in AWS gives the Worker an IAM user, so the list has to be known before the user is created.",
      ),
      environment: args.environment,
      accountId: args.accountId,
    });
    this.part("workflow", {
      accountId: args.accountId ?? DEFAULT_ACCOUNT_ID,
      workflowName: "",
      className: args.className,
      scriptName: worker.nodes.worker.scriptName,
    });
  }

  /**
   * The name of the Cloudflare Workflow.
   */
  public get workflowName() {
    return this.nodes.workflow.workflowName;
  }

  /**
   * The name of the workflow class.
   */
  public get className() {
    return this.nodes.workflow.className;
  }

  /**
   * The name of the Worker script that hosts the workflow class.
   */
  public get scriptName() {
    return this.nodes.workflow.scriptName;
  }

  /**
   * When you link a workflow to a worker, it automatically creates a
   * [Workflow binding](https://developers.cloudflare.com/workflows/build/workers-api/#call-workflows-from-workers)
   * on the worker. This lets you trigger, inspect, and manage workflow instances
   * from your worker code.
   *
   * @example
   * ```ts title="src/api.ts"
   * import { Resource } from "sst";
   *
   * const instance = await Resource.MyWorkflow.create({ params: { hello: "world" } });
   * ```
   *
   * @internal
   */
  public link() {
    const properties = {
      workflowName: this.workflowName,
      className: this.className,
      scriptName: this.scriptName,
    };
    return {
      properties,
      include: [binding({ type: "workflowBindings", properties })],
    };
  }
}
