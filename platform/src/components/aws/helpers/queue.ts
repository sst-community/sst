import { type Input, output } from "@pulumi/pulumi";
import type { Queue as OriginalQueue } from "../queue";
import type { Queue } from "../v5/queue";

/**
 * A `Queue` component: the 4.x one or the V5 one. Each gives the queue's ARN
 * in `arn`.
 */
export type AnyQueue = OriginalQueue | Queue;

/** The ARN of a queue that's given as a `Queue` component, or as its ARN. */
export function queueArnOf(queue: Input<string | AnyQueue>) {
  return output(queue).apply((queue) =>
    typeof queue === "string" ? output(queue) : queue.arn,
  );
}
