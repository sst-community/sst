import { type Input, output } from "@pulumi/pulumi";
import type { SnsTopic } from "../sns-topic";

/**
 * An `SnsTopic` component. Each gives the topic's
 * ARN in `arn`.
 */
export type AnySnsTopic = SnsTopic;

/** The ARN of a topic that's given as an `SnsTopic` component, or as its ARN. */
export function topicArnOf(topic: Input<string | AnySnsTopic>) {
  return output(topic).apply((topic) =>
    typeof topic === "string" ? output(topic) : topic.arn,
  );
}
