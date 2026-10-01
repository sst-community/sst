import { Input, output } from "@pulumi/pulumi";
import { iam } from "@pulumi/aws";
import { parseQueueArn } from "./arn";

/**
 * The args for a queue policy that lets AWS services send messages to a
 * queue: SNS for topic subscriptions, S3 for bucket notifications, and
 * EventBridge for bus subscriptions.
 */
export function sendPolicyArgs(queueArn: Input<string>) {
  const arn = output(queueArn);
  return {
    queueUrl: arn.apply((arn) => parseQueueArn(arn).queueUrl),
    policy: iam.getPolicyDocumentOutput({
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
    }).json,
  };
}
