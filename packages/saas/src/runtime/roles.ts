import type { Roles } from "../config";

/** What a role lets a member do: every permission, or the ones listed. */
export type Permissions = "*" | ReadonlySet<string>;

export function permissionsOf(roles: Roles, role: string): Permissions {
  const listed = roles[role] ?? [];
  return listed.includes("*") ? "*" : new Set(listed);
}

export function allows(permissions: Permissions, permission: string) {
  return permissions === "*" || permissions.has(permission);
}

/** Whether the first has every permission the second has. */
export function covers(a: Permissions, b: Permissions) {
  if (a === "*") return true;
  if (b === "*") return false;
  for (const permission of b) if (!a.has(permission)) return false;
  return true;
}
