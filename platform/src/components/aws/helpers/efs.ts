import { Efs as OriginalEfs } from "../efs";
import { Efs } from "../v5/efs";

/**
 * An `Efs` component: the 4.x one or the V5 one. Every V5 component that
 * mounts a file system takes either, and reads its `nodes.accessPoint`, which
 * the two give alike.
 */
export type AnyEfs = OriginalEfs | Efs;

/** Whether a `volume.efs` arg is an `Efs` component, and not an access point's ARN. */
export function isEfs(value: unknown): value is AnyEfs {
  return value instanceof OriginalEfs || value instanceof Efs;
}
