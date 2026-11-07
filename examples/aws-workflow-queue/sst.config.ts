/// <reference path="./.sst/platform/config.d.ts" />

/**
 * ## AWS Workflow Queue
 *
 * Starts [AWS Lambda durable workflows](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
 * from [`Queue`](/docs/component/aws/queue) messages that many tenants share.
 *
 * Each message is sent with the tenant's ID as its `MessageGroupId`. So SQS
 * [delivers the messages of quieter tenants first](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html)
 * when one tenant has a backlog.
 *
 * There are two queues, one for each way to start a workflow.
 *
 * - `Resize` is a short workflow that subscribes to its queue directly. SQS waits for
 *   each execution, so it has to finish within 15 minutes. The subscription runs at
 *   most 50 at once, so a large batch from one tenant makes a backlog.
 * - `Import` is a long workflow. A function subscribes to its queue and starts an
 *   execution for each message with `workflow.dispatcher()`, named after the job, so a
 *   message delivered twice starts it once.
 *
 * Messages that keep failing go to a dead-letter queue.
 *
 * Send 1000 resize jobs for tenant `a`, then 5 for tenant `b`. Tenant `b`'s jobs don't
 * wait for `a`'s to drain.
 *
 * ```bash
 * curl "$URL?queue=resize&tenant=a&count=1000"
 * curl "$URL?queue=resize&tenant=b&count=5"
 * ```
 *
 * SQS only treats a tenant as noisy once it has many messages in flight. A
 * subscription that runs 30 at a time didn't get this, and one that runs 50 did.
 *
 * Each execution logs its tenant and how long its message waited in the queue.
 */
export default $config({
  app(input) {
    return {
      name: "aws-workflow-queue",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    const dlq = new sst.aws.Queue("DeadLetters");

    // Subscribe the workflow: it gets the SQS event.
    const resizeQueue = new sst.aws.Queue("ResizeQueue", {
      // At least the workflow's execution timeout.
      visibilityTimeout: "5 minutes",
      dlq: dlq.arn,
    });
    const resize = new sst.aws.Workflow("Resize", {
      handler: "src/resize.handler",
      link: [resizeQueue],
      timeout: { execution: "5 minutes" },
    });
    resizeQueue.subscribe(resize, {
      batch: { size: 1 },
      transform: {
        eventSourceMapping: (args) => {
          args.scalingConfig = { maximumConcurrency: 50 };
        },
      },
    });

    // Subscribe a dispatcher: it starts the workflow and is done.
    const importQueue = new sst.aws.Queue("ImportQueue", { dlq: dlq.arn });
    const importer = new sst.aws.Workflow("Import", {
      handler: "src/import.handler",
    });
    importQueue.subscribe(
      { handler: "src/dispatcher.handler", link: [importer] },
      { batch: { partialResponses: true } },
    );

    const enqueue = new sst.aws.Function("Enqueue", {
      handler: "src/enqueue.handler",
      url: true,
      link: [resizeQueue, importQueue],
    });

    return {
      url: enqueue.url,
    };
  },
});
