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

/**
 * The claims the pre token generation trigger adds to both tokens: the
 * user's current tenant, and whether they're a platform admin. What their
 * role lets them do isn't in the tokens, as it can change while they're
 * valid: it's read from the store.
 */
export const CLAIMS = {
  tenant: "tenant_id",
  platformAdmin: "platform_admin",
} as const;

/** The scope a platform admin's access token has, which the API checks for `/admin`. */
export const PLATFORM_ADMIN_SCOPE = "platform/admin";

/**
 * The header a request names its tenant in, in place of the one in the
 * token. It's checked against the store like the token's: it only says
 * which tenant, not what the caller can do in it.
 */
export const TENANT_HEADER = "x-tenant-id";

/** Where the store keeps its records. */
export type StoreConfig =
  | {
      type: "dynamo";
      tables: {
        users: string;
        tenants: string;
        memberships: string;
        invitations: string;
      };
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
  /** How invitations work. The defaults when it isn't set. */
  invitations?: InvitationConfig;
  /** How emails are sent, when the component has `email`. */
  email?: EmailConfig;
}

export interface InvitationConfig {
  /** How long an invitation can be taken up for, in seconds. */
  expiresIn: number;
  /** How many invitations a tenant can have waiting at once. */
  limit: number;
}

export const DEFAULT_INVITATIONS: InvitationConfig = {
  expiresIn: 7 * 24 * 60 * 60,
  limit: 100,
};

/** A length of time, like `"7 days"`. */
export type Duration = `${number} ${"hour" | "hours" | "day" | "days"}`;

/** A duration in seconds, or nothing when it isn't one. */
export function secondsOf(duration: string): number | undefined {
  const match = duration.match(/^(\d+) (hour|day)s?$/);
  if (!match) return undefined;
  return Number(match[1]) * (match[2] === "hour" ? 3600 : 86400);
}

/** The emails the component sends itself, after the change each is about. */
export const MESSAGES = [
  "welcome",
  "invitation",
  "memberAdded",
  "roleChanged",
  "memberRemoved",
] as const;

export type BuiltInMessage = (typeof MESSAGES)[number];

/** Which of them are sent unless the component says otherwise. */
export const DEFAULT_MESSAGES: Record<BuiltInMessage, boolean> = {
  welcome: false,
  invitation: true,
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
  /** The URL of the image at the top of each email. */
  logo?: string;
  /** The color of the emails' links. */
  color?: string;
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
  "GET /tenant/invitations",
  "POST /tenant/invitations",
  "DELETE /tenant/invitations/{email}",
  "GET /admin/users",
  "PATCH /admin/users/{userId}",
  "GET /admin/tenants",
  "PATCH /admin/tenants/{tenantId}",
  "DELETE /admin/tenants/{tenantId}",
] as const;

export type BuiltInRoute = (typeof ROUTES)[number];

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
