import { Cluster } from "../cluster";

/** Whether a `cluster` arg is a `Cluster` component. */
export function isCluster(value: unknown): value is Cluster {
  return value instanceof Cluster;
}
