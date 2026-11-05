import { Cluster } from "../cluster";

/**
 * A `Cluster` component. A `Service` and a `Task` read its `nodes.cluster` and
 * `vpc`.
 */
export type AnyCluster = Cluster;

/** Whether a `cluster` arg is a `Cluster` component. */
export function isCluster(value: unknown): value is AnyCluster {
  return value instanceof Cluster;
}
