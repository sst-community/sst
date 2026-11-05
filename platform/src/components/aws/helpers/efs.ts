import { Efs } from "../efs";

/**
 * An `Efs` component. Every component that mounts a file system reads its
 * `nodes.accessPoint`.
 */
export type AnyEfs = Efs;

/** Whether a `volume.efs` arg is an `Efs` component, and not an access point's ARN. */
export function isEfs(value: unknown): value is AnyEfs {
  return value instanceof Efs;
}
