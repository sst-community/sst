/// <reference path="./.sst/platform/config.d.ts" />

/**
 * ## AWS EventFlow
 *
 * An order pipeline built with [`EventFlow`](/docs/component/aws/eventflow): event-driven
 * functions with an Inngest-shaped API, running on Lambda durable functions in your
 * account.
 *
 * There's one EventFlow, and every function runs in its one worker. Adding a function
 * is a code change in `src/flow.ts`, and doesn't add infrastructure.
 *
 * - `process-order` runs for each `order/placed` event. It charges the card with a
 *   payment API that fails about half the time, so the step retries. A large order
 *   waits up to an hour for its `order/approved` event. Then it sleeps, and invokes
 *   `send-receipt`.
 * - `send-receipt` is only invoked.
 * - `hourly-report` runs at the top of each hour, from a cron trigger.
 *
 * Place an order, then look at its run with the CLI.
 *
 * ```bash
 * curl -X POST "$API/orders?amount=25"
 * sst eventflow run <runId>
 * ```
 *
 * A large order waits for approval.
 *
 * ```bash
 * sst secret set ApproverToken my-token
 * curl -X POST "$API/orders?amount=5000"
 * curl -X POST "$API/orders/<orderId>/approve" -H "x-approver-token: my-token"
 * ```
 *
 * Retry a failed run after you deploy a fix: the steps that succeeded aren't run
 * again. Or replay it, to run every step again.
 *
 * ```bash
 * sst eventflow retry <runId>
 * sst eventflow replay <runId>
 * ```
 *
 * The README in the example walks through each file.
 */
export default $config({
  app(input) {
    return {
      name: "aws-eventflow",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    // Who may approve a large order. Set it with `sst secret set ApproverToken ...`.
    const approverToken = new sst.Secret("ApproverToken");

    // The engine: a queue, a router, a worker for every function, a table and a
    // schedule. It's made once. The functions are in src/flow.ts.
    const flow = new sst.aws.EventFlow("Flow", {
      handler: "src/flow.handler",
      // hourly-report lists the runs of the last hour, with flow.runs.
      functionAdmin: true,
    });

    // Linking the EventFlow lets a function send events, and nothing more. To look at
    // runs and retry them, use `sst eventflow`, or link `flow.admin`.
    const api = new sst.aws.Function("Api", {
      handler: "src/api.handler",
      url: true,
      link: [flow, approverToken],
    });

    return {
      api: api.url,
    };
  },
});
