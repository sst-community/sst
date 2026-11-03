import type { Bus as OriginalBus } from "../bus";
import type { Bus } from "../v5/bus";

/**
 * A `Bus` component: the 4.x one or the V5 one. Each gives the bus's ARN in
 * `arn` and its name in `name`.
 */
export type AnyBus = OriginalBus | Bus;
