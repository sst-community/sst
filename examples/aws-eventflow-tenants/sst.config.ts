/// <reference path="./.sst/platform/config.d.ts" />

/**
 * ## AWS EventFlow tenants
 *
 * A multi-tenant contacts import, moved from Inngest to
 * [`EventFlow`](/docs/component/aws/eventflow). The Inngest app is in `inngest/`, and
 * the port is in `src/flow.ts`, so you can compare them line by line.
 *
 * - `import-contacts` has two concurrency limits: 5 steps of each tenant at once, and
 *   20 in all. Its "save" step is a second of an external API. A large import waits
 *   for a confirmation event, which holds no lease, and its "finish" step takes a
 *   lease again.
 * - `notify-tenant` is throttled to 60 runs a minute per tenant. Runs over it are
 *   held, and start later.
 *
 * Each step records when it ran, so the example also measures EventFlow. Send 1000
 * imports for tenant `a`, then 10 for tenant `b` a few seconds later, from the `Load`
 * function in the same region.
 *
 * ```bash
 * sst shell -- aws lambda invoke --function-name "$LOAD" \
 *   --payload '{"action":"burst","test":"t1","tenant":"a","count":1000}' --cli-binary-format raw-in-base64-out /dev/stdout
 * sst shell -- aws lambda invoke --function-name "$LOAD" \
 *   --payload '{"action":"burst","test":"t1","tenant":"b","count":10}' --cli-binary-format raw-in-base64-out /dev/stdout
 * ```
 *
 * Then get the report: how long each tenant's runs waited to start, the most steps
 * that ran at once, how fast waits resumed, and the throttle per minute.
 *
 * ```bash
 * sst shell -- aws lambda invoke --function-name "$REPORT" \
 *   --payload '{"test":"t1"}' --cli-binary-format raw-in-base64-out /dev/stdout
 * ```
 *
 * The numbers are in the [EventFlow guide](/docs/eventflow#performance).
 */
export default $config({
  app(input) {
    return {
      name: "aws-eventflow-tenants",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    const results = new sst.aws.Dynamo("Results", {
      fields: { test: "string", importId: "string" },
      primaryIndex: { hashKey: "test", rangeKey: "importId" },
    });

    const flow = new sst.aws.EventFlow("Flow", {
      handler: "src/flow.handler",
      link: [results],
      schedule: false,
    });

    const load = new sst.aws.Function("Load", {
      handler: "src/load.handler",
      link: [flow, results],
      timeout: "5 minutes",
      memory: "1024 MB",
    });

    const report = new sst.aws.Function("Report", {
      handler: "src/report.handler",
      link: [results],
      timeout: "1 minute",
    });

    return {
      load: load.name,
      report: report.name,
    };
  },
});
