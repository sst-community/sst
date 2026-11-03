import { Alb as OriginalAlb } from "../alb";
import { Alb } from "../v5/alb";

/**
 * An `Alb` component: the 4.x one or the V5 one. A V5 `Service` that shares a
 * load balancer takes either, and reads its `arn`, `dnsName`, `_vpc` and
 * `getListener()`, which the two give alike.
 */
export type AnyAlb = OriginalAlb | Alb;

/** Whether a `loadBalancer.instance` arg is an `Alb` component. */
export function isAlb(value: unknown): value is AnyAlb {
  return value instanceof OriginalAlb || value instanceof Alb;
}
