import { createRequire } from "node:module";
import { component, type ComponentArgs, type LinkDefinition } from "sst/components";
import { permission, v5 } from "sst/components/aws";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// The handler this package ships, found wherever the app installed the
// package: in its node_modules, or in .sst/platform when the app lists it
// under `packages`
const handler = createRequire(import.meta.url)
  .resolve("@acme/webhook/receiver")
  .replace(/\.js$/, ".handler");

const parts = {
  queue: aws.sqs.Queue,
  receiver: v5.Function,
};

export interface WebhookArgs extends ComponentArgs<typeof parts> {
  /**
   * How long a delivery waits on the queue to be read, in seconds.
   * @default 345600 (4 days)
   */
  retention?: number;
}

/**
 * A URL that takes webhook deliveries and puts each on a queue, for your app
 * to read at its own pace.
 *
 * @example
 * ```ts title="sst.config.ts"
 * const { Webhook } = await import("@acme/webhook");
 *
 * const hook = new Webhook("Payments");
 * new sst.aws.v5.Function("Worker", {
 *   handler: "src/worker.handler",
 *   link: [hook],
 * });
 * ```
 */
export class Webhook extends component("acme:index:Webhook", parts) {
  constructor(name: string, args: WebhookArgs = {}, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const queue = this.part("queue", { messageRetentionSeconds: args.retention });
    this.part("receiver", {
      handler,
      url: true,
      environment: { QUEUE_URL: queue.url },
      permissions: [{ actions: ["sqs:SendMessage"], resources: [queue.arn] }],
    });
  }

  /** The URL to give the service that sends the webhooks. */
  get url() {
    return this.nodes.receiver.url;
  }

  link(): LinkDefinition {
    return {
      properties: { url: this.url, queue: this.nodes.queue.url },
      include: [
        permission({
          actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
          resources: [this.nodes.queue.arn],
        }),
      ],
    };
  }
}
