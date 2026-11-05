import { type Input, output } from "@pulumi/pulumi";
import type { SnsTopic } from "../sns-topic";

/** The ARN of a topic that's given as an `SnsTopic` component, or as its ARN. */
export function topicArnOf(topic: Input<string | SnsTopic>) {
  return output(topic).apply((topic) =>
    typeof topic === "string" ? output(topic) : topic.arn,
  );
}
