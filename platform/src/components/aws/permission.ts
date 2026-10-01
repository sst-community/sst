/**
 * The AWS Permission Linkable helper is used to define the AWS permissions included with the
 * [`sst.Linkable`](/docs/component/linkable/) component.
 *
 * @example
 *
 * ```ts
 * sst.aws.permission({
 *   actions: ["lambda:InvokeFunction"],
 *   resources: ["*"]
 * })
 * ```
 *
 * @packageDocumentation
 */

import { Prettify } from "../component.js";
import type { Input } from "../input.js";
import { Link } from "../link.js";
import { FunctionPermissionArgs } from "./function.js";

export interface InputArgs extends Prettify<FunctionPermissionArgs> {}

/**
 * The AWS Permission Linkable helper is used to define the AWS permissions included with the
 * [`sst.Linkable`](/docs/component/linkable/) component.
 *
 * @example
 *
 * ```ts
 * sst.aws.permission({
 *   actions: ["lambda:InvokeFunction"],
 *   resources: ["*"]
 * })
 * ```
 */
export function permission(input: InputArgs) {
  return {
    type: "aws.permission" as const,
    ...input,
  };
}

export type Permission = ReturnType<typeof permission>;

/**
 * The IAM statements that grant access to a list of linked resources.
 *
 * Functions, services and tasks get these through their `link` prop. Use this
 * to grant the same access to compute you create yourself, like a role for an
 * ECS task definition or a Batch job.
 *
 * @example
 * ```ts title="sst.config.ts"
 * const bucket = new sst.aws.Bucket("MyBucket");
 * const queue = new sst.aws.Queue("MyQueue");
 *
 * new aws.iam.RolePolicy("MyJobLinks", {
 *   role: role.name,
 *   policy: aws.iam.getPolicyDocumentOutput({
 *     statements: sst.aws.iamStatements([bucket, queue]),
 *   }).json,
 * });
 * ```
 *
 * Pair it with `sst.Linkable.env()` so `Resource.MyBucket` works at runtime.
 * An IAM policy needs at least one statement, so don't create the policy when
 * the list of links can be empty.
 */
export function iamStatements(links: Input<any[]>) {
  return Link.getInclude<Permission>("aws.permission", links).apply(
    (permissions) =>
      permissions.map((item) => ({
        effect: item.effect === "deny" ? "Deny" : "Allow",
        actions: item.actions,
        resources: item.resources,
        conditions: item.conditions,
      })),
  );
}
