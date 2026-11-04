import { type Input, output } from "@pulumi/pulumi";
import type { SnsTopic as OriginalSnsTopic } from "../sns-topic";
import type { SnsTopic } from "../v5/sns-topic";

/**
 * An `SnsTopic` component: the 4.x one or the V5 one. Each gives the topic's
 * ARN in `arn`.
 */
export type AnySnsTopic = OriginalSnsTopic | SnsTopic;

/** The ARN of a topic that's given as an `SnsTopic` component, or as its ARN. */
export function topicArnOf(topic: Input<string | AnySnsTopic>) {
  return output(topic).apply((topic) =>
    typeof topic === "string" ? output(topic) : topic.arn,
  );
}
