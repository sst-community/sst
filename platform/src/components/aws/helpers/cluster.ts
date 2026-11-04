import { Cluster as OriginalCluster } from "../cluster";
import { Cluster } from "../v5/cluster";

/**
 * A `Cluster` component: the 4.x one or the V5 one. A V5 `Service` and `Task`
 * take either, and read its `nodes.cluster` and `vpc`, which the two give
 * alike.
 */
export type AnyCluster = OriginalCluster | Cluster;

/** Whether a `cluster` arg is a `Cluster` component. */
export function isCluster(value: unknown): value is AnyCluster {
  return value instanceof OriginalCluster || value instanceof Cluster;
}
