import { all, type Resource } from "@pulumi/pulumi";
import { iam } from "@pulumi/aws";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import type { FunctionPermissionArgs } from "../function";

/**
 * The inline policies of a role that's granted the given permissions: one,
 * named `inline`, or none when there's nothing to grant, since IAM refuses a
 * policy with no statements.
 *
 * ```ts
 * inlinePolicies: inlinePolicies([
 *   args.permissions,
 *   Link.getInclude<Permission>("aws.permission", args.link),
 * ]),
 * ```
 *
 * @param permissions Lists of permissions, granted in this order.
 */
export function inlinePolicies(
  permissions: Input<Input<FunctionPermissionArgs>[] | undefined>[],
  parent: Resource,
) {
  const policy = all(permissions).apply((lists) =>
    iam.getPolicyDocumentOutput(
      {
        statements: lists
          .flatMap((list) => list ?? [])
          .map((item) => ({
            effect: (() => {
              const effect = item.effect ?? "allow";
              return effect.charAt(0).toUpperCase() + effect.slice(1);
            })(),
            actions: item.actions,
            resources: item.resources,
            conditions: "conditions" in item ? item.conditions : undefined,
          })),
      },
      { parent },
    ),
  );
  return policy.apply(({ statements }) =>
    statements ? [{ name: "inline", policy: policy.json }] : [],
  );
}

/**
 * Fail when a component given a role in `existing` is also given
 * `permissions` for it. The role is used the way it is, so they'd be dropped
 * without a word. An empty list is taken.
 *
 * ```ts
 * noPermissionsFor(
 *   args.existing?.taskRole,
 *   args.permissions,
 *   "taskRole",
 *   `the "${name}" task`,
 * );
 * ```
 *
 * @param role The role in `existing`, if there's one.
 * @param key The part it's given for.
 * @param owner The component, for the error: `the "MyTask" task`.
 */
export function noPermissionsFor(
  role: unknown,
  permissions: unknown,
  key: string,
  owner: string,
) {
  if (
    role === undefined ||
    permissions === undefined ||
    (Array.isArray(permissions) && permissions.length === 0)
  )
    return;
  const Owner = owner[0].toUpperCase() + owner.slice(1);
  throw new VisibleError(
    `${Owner} is given an existing "${key}", which it doesn't change. Add the "permissions" to the role itself.`,
  );
}
