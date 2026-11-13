import { Input, output, type Resource } from "@pulumi/pulumi";
import { iam } from "@pulumi/aws";
import { parseQueueArn } from "./arn";

/**
 * The args for a queue policy that lets AWS services send messages to a
 * queue: SNS for topic subscriptions, S3 for bucket notifications, and
 * EventBridge for bus subscriptions.
 */
export function sendPolicyArgs(queueArn: Input<string>, parent: Resource) {
  const arn = output(queueArn);
  return {
    queueUrl: arn.apply((arn) => parseQueueArn(arn).queueUrl),
    policy: iam.getPolicyDocumentOutput(
      {
        statements: [
          {
            actions: ["sqs:SendMessage"],
            resources: [arn],
            principals: [
              {
                type: "Service",
                identifiers: [
                  "sns.amazonaws.com",
                  "s3.amazonaws.com",
                  "events.amazonaws.com",
                ],
              },
            ],
          },
        ],
      },
      { parent },
    ).json,
  };
}

/**
 * The queue policy that lets AWS services send messages to a queue, as a
 * part's args and options. A queue has one policy: whatever replaces this one
 * sets its own, so deleting this one would remove the replacement, and it's
 * kept when it's deleted.
 *
 * ```ts
 * this.part("queuePolicy", name, ...sendPolicy(queueArn, this));
 * ```
 */
export function sendPolicy(queueArn: Input<string>, parent: Resource) {
  return [sendPolicyArgs(queueArn, parent), { retainOnDelete: true }] as const;
}
