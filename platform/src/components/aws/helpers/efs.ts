import { Efs } from "../efs";

/** Whether a `volume.efs` arg is an `Efs` component, and not an access point's ARN. */
export function isEfs(value: unknown): value is Efs {
  return value instanceof Efs;
}
