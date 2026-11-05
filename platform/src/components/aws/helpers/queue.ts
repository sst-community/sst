import { type Input, output } from "@pulumi/pulumi";
import type { Queue } from "../queue";

/** The ARN of a queue that's given as a `Queue` component, or as its ARN. */
export function queueArnOf(queue: Input<string | Queue>) {
  return output(queue).apply((queue) =>
    typeof queue === "string" ? output(queue) : queue.arn,
  );
}
