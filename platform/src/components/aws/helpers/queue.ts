import type { Queue as OriginalQueue } from "../queue";
import type { Queue } from "../v5/queue";

/**
 * A `Queue` component: the 4.x one or the V5 one. Each gives the queue's ARN
 * in `arn`.
 */
export type AnyQueue = OriginalQueue | Queue;
