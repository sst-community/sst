import { type Input, type Resource, output } from "@pulumi/pulumi";
import type { cloudwatch } from "@pulumi/aws";
import type { PartsBuilder } from "../../parts-component";
import { type FunctionDefinition, functionPart } from "./function-part";
import { invokePermissionArgs } from "./function-permission";

/**
 * The state of an EventBridge rule or schedule that's on unless `enabled` is
 * `false`.
 */
export function enabledState(enabled: Input<boolean> | undefined) {
  return output(enabled ?? true).apply((enabled) =>
    enabled ? "ENABLED" : "DISABLED",
  );
}

/**
 * A function an EventBridge rule sends what it matches to: the function part,
 * the permission that lets EventBridge invoke it, and the rule's target. The
 * component declares each as a `many` part, by the subscriber's name.
 *
 * ```ts
 * const rule = this.part("rule", name, { ... });
 * ruleFunctionTarget(this.builder(), PARTS, name, rule, {
 *   bus: this.name,
 *   subscriber: plainFunction(subscriber, `The subscriber "${name}" of the "${this.componentName}" bus`),
 *   description: `Subscribed to ${this.componentName}`,
 * });
 * ```
 *
 * @param keys The parts the function, the permission and the target are.
 * @param id The subscriber's name.
 * @param rule The rule that sends to the function.
 */
export function ruleFunctionTarget(
  builder: PartsBuilder<any>,
  keys: { subscriber: string; permission: string; target: string },
  id: string,
  rule: cloudwatch.EventRule,
  args: {
    /** The name of the bus the rule is on. */
    bus: Input<string>;
    /** The function, checked with `plainFunction()`. */
    subscriber: FunctionDefinition;
    /** The function's description. */
    description: Input<string>;
  },
) {
  // The component's own parts, which its types know and these don't
  const part = builder.part as unknown as (
    key: string,
    ...rest: unknown[]
  ) => Resource;
  const { subscriber, description } = args;
  const fn = functionPart(builder.component, keys.subscriber, id, subscriber, {
    description,
  });
  const permission = part(
    keys.permission,
    id,
    invokePermissionArgs(fn, "events.amazonaws.com", rule.arn),
  );
  part(
    keys.target,
    id,
    { arn: fn.targetArn, rule: rule.name, eventBusName: args.bus },
    { dependsOn: [permission] },
  );
}
