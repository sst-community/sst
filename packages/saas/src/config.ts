// What the component and the code it deploys agree on. Nothing here imports
// Pulumi or the AWS SDK, so both sides can load it.

/** The permissions the built-in routes check. */
export const PERMISSIONS = [
  "tenant:read",
  "tenant:update",
  "tenant:delete",
  "members:read",
  "members:write",
] as const;

export type BuiltInPermission = (typeof PERMISSIONS)[number];

/**
 * Each role and the permissions it grants. `"*"` grants every permission,
 * the built-in ones and any your own routes check.
 */
export type Roles = Record<string, string[]>;

export const DEFAULT_ROLES: Roles = {
  owner: ["*"],
  admin: ["tenant:read", "tenant:update", "members:read", "members:write"],
  member: ["tenant:read", "members:read"],
};

/** The claims the pre token generation trigger adds to both tokens. */
export const CLAIMS = {
  tenant: "tenant_id",
  role: "tenant_role",
  platformAdmin: "platform_admin",
} as const;

/** The scope a permission is checked with at the API, in the access token. */
export const scopeOf = (permission: string) => `tenant/${permission}`;
/** The scope of a role that grants every permission. */
export const ALL_SCOPE = scopeOf("*");
/** The scope a platform admin's access token has. */
export const PLATFORM_ADMIN_SCOPE = "platform/admin";

/** Where the store keeps its records. */
export type StoreConfig =
  | {
      type: "dynamo";
      tables: { users: string; tenants: string; memberships: string };
    }
  | { type: "custom" };

/** What the deployed code is told, in `SAAS_CONFIG`. */
export interface SaasConfig {
  store: StoreConfig;
  roles: Roles;
  ownerRole: string;
  defaultRole: string;
  /** Create a tenant for each user who signs up. */
  personal: boolean;
  /** Let any user create a tenant, not only platform admins. */
  selfServe: boolean;
  /** Where the built-in routes are on the API, like `/saas`. Empty for the root. */
  path: string;
  /** The built-in routes that are turned off. */
  disabled: BuiltInRoute[];
  /** How emails are sent, when the component has `email`. */
  email?: EmailConfig;
}

/** The emails the component sends itself, after the change each is about. */
export const MESSAGES = [
  "welcome",
  "memberAdded",
  "roleChanged",
  "memberRemoved",
] as const;

export type BuiltInMessage = (typeof MESSAGES)[number];

/** Which of them are sent unless the component says otherwise. */
export const DEFAULT_MESSAGES: Record<BuiltInMessage, boolean> = {
  welcome: false,
  memberAdded: true,
  roleChanged: true,
  memberRemoved: true,
};

export interface EmailConfig {
  /** Who the emails are from, like `Acme <hello@acme.com>`. */
  from: string;
  replyTo?: string;
  /** The SES configuration set the emails are sent with. */
  configurationSet?: string;
  /** The app's name, in the emails' subjects and text. */
  appName: string;
  /** The app's URL, for the links in the emails. */
  url?: string;
  messages: Record<BuiltInMessage, boolean>;
}

export const CONFIG_ENV = "SAAS_CONFIG";

/**
 * The built-in routes, under the component's `path`. API Gateway sends them
 * all to one function, and checks only that the caller is signed in, or is
 * a platform admin for `/admin`. The routes check the rest against the
 * store.
 */
export const ROUTES = [
  "GET /me",
  "PATCH /me",
  "PUT /me/tenant",
  "GET /tenants",
  "POST /tenants",
  "GET /tenant",
  "PATCH /tenant",
  "DELETE /tenant",
  "GET /tenant/members",
  "POST /tenant/members",
  "PATCH /tenant/members/{userId}",
  "DELETE /tenant/members/{userId}",
  "GET /admin/users",
  "PATCH /admin/users/{userId}",
  "GET /admin/tenants",
  "PATCH /admin/tenants/{tenantId}",
  "DELETE /admin/tenants/{tenantId}",
] as const;

export type BuiltInRoute = (typeof ROUTES)[number];

/** The scopes a route of your own needs at the API, any one of them. */
export function scopesOf(auth: {
  permission?: string;
  platformAdmin?: boolean;
}): string[] | undefined {
  if (auth.platformAdmin) return [PLATFORM_ADMIN_SCOPE];
  if (auth.permission) return [scopeOf(auth.permission), ALL_SCOPE];
  return undefined;
}

const NAME = /^[a-z][a-z0-9_-]*$/;
const PERMISSION = /^(\*|[a-z0-9][a-z0-9:._-]*)$/;

/**
 * Check the roles, and the two roles that are named outside them. Returns
 * what's wrong, so each side can report it its own way.
 */
export function rolesProblem(
  roles: Roles,
  ownerRole: string,
  defaultRole: string,
): string | undefined {
  const names = Object.keys(roles);
  if (names.length === 0) return `"roles" needs at least one role.`;
  for (const name of names) {
    if (!NAME.test(name))
      return `The role "${name}" can only have lowercase letters, numbers, "-" and "_", and start with a letter.`;
    const permissions = roles[name];
    if (!Array.isArray(permissions))
      return `The role "${name}" has to be a list of permissions.`;
    const bad = permissions.find((p) => !PERMISSION.test(p));
    if (bad !== undefined)
      return `The permission "${bad}" of the role "${name}" can only have lowercase letters, numbers, ":", ".", "-" and "_", or be "*".`;
  }
  if (!(ownerRole in roles))
    return `"ownerRole" is "${ownerRole}", which isn't one of the roles: ${names.join(
      ", ",
    )}.`;
  if (!(defaultRole in roles))
    return `"defaultRole" is "${defaultRole}", which isn't one of the roles: ${names.join(
      ", ",
    )}.`;
  return undefined;
}

/** Check a permission name a route is given. */
export function permissionProblem(permission: string) {
  if (permission === "*" || !PERMISSION.test(permission))
    return `The permission "${permission}" can only have lowercase letters, numbers, ":", ".", "-" and "_".`;
  return undefined;
}
