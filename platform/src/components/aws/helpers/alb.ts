import { Alb } from "../alb";

/**
 * An `Alb` component. A `Service` that shares a load balancer reads its `arn`,
 * `dnsName`, `_vpc` and `getListener()`.
 */
export type AnyAlb = Alb;

/** Whether a `loadBalancer.instance` arg is an `Alb` component. */
export function isAlb(value: unknown): value is AnyAlb {
  return value instanceof Alb;
}
