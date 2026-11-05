import { Alb } from "../alb";

/** Whether a `loadBalancer.instance` arg is an `Alb` component. */
export function isAlb(value: unknown): value is Alb {
  return value instanceof Alb;
}
