import { iam } from "@pulumi/aws";
import {
  ComponentResource,
  CustomResourceOptions,
  Input,
  output,
  Resource,
} from "@pulumi/pulumi";
import { VisibleError } from "../../error";

export const permissionOwnershipKey = (name: string) =>
  `sst:aws:Function::${name}::permissions`;

class PermissionOwnership extends ComponentResource {
  constructor(name: string, opts: CustomResourceOptions) {
    super("sst:sst:Version", `${name}PermissionOwnershipVersion`, {}, opts);
    this.registerOutputs({ target: permissionOwnershipKey(name), version: 2 });
  }
}

export function inlinePolicyDocument(name: string, json: string) {
  const policy = JSON.parse(json);
  if (!policy.Statement?.length)
    throw new VisibleError(
      `Function "${name}" has no inline grants to restore. Supply a statically known list of links and permissions when removing all grants.`,
    );
  const compact = JSON.stringify(policy);
  if (compact.length > 10240)
    throw new VisibleError(
      `Function "${name}" needs ${compact.length} inline policy characters, exceeding IAM's 10,240-character limit. Keep managed link permissions enabled or reduce the grants before switching back.`,
    );
  return compact;
}

/** Adopt the existing role-local inline policy and own all attachments in one place. */
export function createFunctionRolePermissions(
  name: string,
  role: iam.Role,
  policy: Input<string>,
  policyArns: Input<string[]>,
  managed: boolean,
  opts: CustomResourceOptions,
  emptyInline = false,
) {
  // Persist ownership even when the option is removed; legacy Role outputs can be stale.
  new PermissionOwnership(name, opts);
  const inline = (dependsOn: Resource[]) =>
    new iam.RolePolicy(
      `${name}InlinePolicy`,
      {
        name: "inline",
        role: role.name,
        policy: output(policy).apply((json) =>
          inlinePolicyDocument(name, json),
        ),
      },
      { ...opts, dependsOn, retainOnDelete: true },
    );
  const attachments = (dependsOn: Resource[]) =>
    new iam.RolePolicyAttachmentsExclusive(
      `${name}PolicyAttachments`,
      {
        roleName: role.name,
        policyArns,
      },
      { ...opts, dependsOn },
    );

  const inlineOwnership = (dependsOn: Resource[]) => {
    const policy = emptyInline ? undefined : inline(dependsOn);
    const exclusive = new iam.RolePoliciesExclusive(
      `${name}InlinePolicyOwnership`,
      {
        roleName: role.name,
        policyNames: emptyInline ? [] : ["inline"],
      },
      { ...opts, dependsOn: policy ? [policy] : dependsOn },
    );
    return policy ? [policy, exclusive] : [exclusive];
  };
  if (managed) {
    const attached = attachments([]);
    return [attached, ...inlineOwnership([attached])];
  }
  const restored = inlineOwnership([]);
  return [...restored, attachments(restored)];
}
