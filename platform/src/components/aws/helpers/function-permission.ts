import { lambda } from "@pulumi/aws";
import type { Input } from "../../input";
import type { FunctionBuilder } from "./function-builder";

/**
 * The args of the permission that lets an AWS service invoke a function part.
 *
 * ```ts
 * const fn = functionPart(this, "subscriber", name, subscriber, {});
 * this.part("permission", name, invokePermissionArgs(fn, "sns.amazonaws.com", this.arn));
 * ```
 *
 * @param fn The function, from `functionPart()`.
 * @param principal The service that invokes it, like `sns.amazonaws.com`.
 * @param sourceArn What in that service may invoke it.
 */
export function invokePermissionArgs(
  fn: FunctionBuilder,
  principal: string,
  sourceArn: Input<string>,
): lambda.PermissionArgs {
  return {
    action: "lambda:InvokeFunction",
    function: fn.arn,
    qualifier: fn.qualifier.apply((qualifier) => qualifier!),
    principal,
    sourceArn,
  };
}
