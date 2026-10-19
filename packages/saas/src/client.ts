// A client for the built-in routes, for the browser or any other code that
// calls the API. It only uses `fetch`, and imports only types and the
// config's constants, so it brings nothing else into a bundle.

import { CLAIMS, TENANT_HEADER } from "./config.js";
import type {
  Invitation,
  Member,
  Metadata,
  Page,
  Tenant,
  User,
} from "./runtime/store/types.js";

export type { Invitation, Member, Metadata, Page, Tenant, User };

/**
 * A role's permissions, as the component's `roles` list them: `["*"]` for
 * every permission.
 */
export type Permissions = string[];

/** A tenant the user is a member of, with their role in it. */
export type MyTenant = Tenant & { role: string; permissions: Permissions };

/**
 * `GET /me`: the user, and the tenant the request is for, with their role in
 * it and what it lets them do. No tenant when they're in none.
 */
export interface Me {
  user: User;
  tenant?: Tenant;
  role?: string;
  permissions?: Permissions;
}

/** What the user's access token says. Read from the token, not checked: the API checks it. */
export interface TokenClaims {
  userId: string;
  /** The user's current tenant, when the token was issued. */
  tenantId?: string;
  platformAdmin: boolean;
  scopes: string[];
}

export interface SaasClientOptions {
  /** The API's URL: the component's `url`. */
  url: string;
  /** The component's `path`, when it has one, like `/saas`. */
  path?: string;
  /**
   * The user's access token, from whatever signs them in, like Amplify's
   * `fetchAuthSession()`. Not the ID token: the API takes the access token.
   */
  token(): string | undefined | Promise<string | undefined>;
  /**
   * Get new tokens from the user pool, so that the next `token()` is for
   * the user's tenant as it is now. With Amplify, `fetchAuthSession({
   * forceRefresh: true })`.
   */
  refresh(): unknown;
  /**
   * The tenant this client's requests are for, in place of the one in the
   * token. `useTenant()` changes it.
   */
  tenantId?: string;
  /** In place of the global `fetch`. */
  fetch?: typeof fetch;
}

/** An error the API answered with. `code` is the one the routes document, like `no_active_tenant`. */
export class SaasError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SaasError";
  }
}

/**
 * A client for the built-in routes. It sends the user's access token with
 * each request, and the tenant the client is in, and turns an error into a
 * `SaasError`.
 *
 * Its requests are for the tenant in the user's token, their current one,
 * unless `useTenant()` names another: then they're for that one, with no
 * new tokens, so each tab can be in a tenant of its own. Either way the
 * API checks that the user is a member.
 *
 * ```ts
 * const saas = saasClient({
 *   url: import.meta.env.VITE_SAAS_URL,
 *   token: async () => (await fetchAuthSession()).tokens?.accessToken?.toString(),
 *   refresh: () => fetchAuthSession({ forceRefresh: true }),
 * });
 * saas.useTenant(tenantId);
 * ```
 */
export function saasClient(options: SaasClientOptions) {
  const api = options.url.replace(/\/+$/, "");
  const prefix = slash(options.path ?? "").replace(/\/+$/, "");
  const segment = encodeURIComponent;
  let current = options.tenantId;
  // What the user can do in each tenant, from `GET /me`, until it may have
  // changed
  const known = new Map<string, Promise<Me>>();

  // A built-in route, under the component's path
  const call = <T>(method: string, path: string, body?: unknown) =>
    request<T>(method, prefix + path, body);

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await options.token();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (current) headers[TENANT_HEADER] = current;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await (options.fetch ?? fetch)(api + slash(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const value = text === "" ? undefined : parse(text);
    if (!response.ok) throw errorOf(response.status, value, text);
    return value as T;
  }

  async function claims(): Promise<TokenClaims | undefined> {
    const token = await options.token();
    return token ? claimsOf(token) : undefined;
  }

  async function tenantId() {
    return current ?? (await claims())?.tenantId;
  }

  async function refresh() {
    known.clear();
    await options.refresh();
  }

  async function me() {
    const tenant = (await tenantId()) ?? "";
    let found = known.get(tenant);
    if (!found) {
      found = call<Me>("GET", "/me");
      known.set(tenant, found);
      // Asked again next time, when it failed
      found.catch(() => known.delete(tenant));
    }
    return found;
  }

  // A change that can change what the user can do
  const changes = async <T>(done: Promise<T>) => {
    try {
      return await done;
    } finally {
      known.clear();
    }
  };

  return {
    /**
     * Call a route of your own on the same API, with the user's access
     * token and the client's tenant, like `request("GET", "/projects")`.
     * The path is from the API's root, where `saas.route()` puts routes,
     * not under the component's.
     */
    request,

    /**
     * Get new tokens. The user takes up any invitation to their email, and
     * the tokens are for their current tenant.
     */
    refresh,

    /** What the user's access token says. Nothing when they're not signed in. */
    claims,

    /** The tenant the client's requests are for: the one it uses, or else the one in the token. */
    tenantId,

    /**
     * Send the client's requests for this tenant, without new tokens, or
     * for the one in the token again with nothing. The tenant isn't
     * checked until a request: one the user isn't in is a `no_tenant`.
     */
    useTenant(tenantId: string | undefined) {
      current = tenantId || undefined;
    },

    /**
     * The user, and the tenant the client is in, with their role and its
     * permissions. Kept until a change that could change them, or a
     * `refresh()`.
     */
    me,

    /**
     * Whether the user's role in the tenant the client is in has a
     * permission, for showing or hiding parts of your UI. It's read from
     * the API, and kept like `me()`. The API checks it again for each
     * request.
     */
    async can(permission: string) {
      const permissions = (await me()).permissions ?? [];
      return permissions.includes("*") || permissions.includes(permission);
    },

    updateMe: (patch: { name?: string | null }) =>
      changes(call<User>("PATCH", "/me", patch)),

    /** The tenants the user is a member of, with their role in each and its permissions. */
    tenants: () => call<MyTenant[]>("GET", "/tenants"),
    /** Create a tenant, with the user as its owner. It doesn't switch to it. */
    createTenant: (input: { name: string }) =>
      call<MyTenant>("POST", "/tenants", input),
    /**
     * Make a tenant the user's current one, in this client and in their
     * tokens, which it refreshes: for other tabs and devices, and for
     * whatever else reads the tokens. To change only this client's, use
     * `useTenant()`.
     */
    async switchTenant(tenantId: string) {
      const switched = await call<{ tenant: Tenant; role: string }>(
        "PUT",
        "/me/tenant",
        { tenantId },
      );
      current = tenantId;
      await refresh();
      return switched;
    },

    /** The tenant the client is in. */
    tenant: () => call<Tenant>("GET", "/tenant"),
    updateTenant: (patch: { name: string }) =>
      call<Tenant>("PATCH", "/tenant", patch),
    /**
     * Delete the tenant the client is in. The client goes back to the
     * tenant in the user's tokens, which it refreshes, as the user is moved
     * to another.
     */
    async deleteTenant() {
      await call("DELETE", "/tenant");
      current = undefined;
      await refresh();
    },

    /** A page of the members of the tenant the client is in, in the order of their ids. */
    members: (page?: PageQuery) =>
      call<Page<Member>>("GET", `/tenant/members${query(page)}`),
    /** Add someone who has signed up. To add anyone else, `invite()` them. */
    addMember: (
      input: ({ email: string } | { userId: string }) & { role?: string },
    ) => call<Member>("POST", "/tenant/members", input),
    changeRole: (userId: string, role: string) =>
      changes(
        call<Member>("PATCH", `/tenant/members/${segment(userId)}`, { role }),
      ),
    removeMember: (userId: string) =>
      changes(call<void>("DELETE", `/tenant/members/${segment(userId)}`)),
    /**
     * Leave the tenant the client is in. The client goes back to the tenant
     * in the user's tokens, which it refreshes, as the user is moved to
     * another.
     */
    async leave() {
      const signedIn = await claims();
      if (!signedIn) throw new SaasError(401, "unauthorized", "Sign in first.");
      await call("DELETE", `/tenant/members/${segment(signedIn.userId)}`);
      current = undefined;
      await refresh();
    },

    /** The invitations waiting to be taken up. */
    invitations: () => call<Invitation[]>("GET", "/tenant/invitations"),
    /** Invite someone by email. Inviting them again sends it again. */
    invite: (input: { email: string; role?: string }) =>
      call<Invitation>("POST", "/tenant/invitations", input),
    revokeInvitation: (email: string) =>
      call<void>("DELETE", `/tenant/invitations/${segment(email)}`),

    /** For platform admins. */
    admin: {
      /** A page of users, in the order of their email: `search` finds those whose email starts with it. */
      users: (page?: SearchQuery) =>
        call<Page<User>>("GET", `/admin/users${query(page)}`),
      updateUser: (
        userId: string,
        patch: {
          name?: string | null;
          platformAdmin?: boolean;
          metadata?: Metadata | null;
        },
      ) =>
        changes(call<User>("PATCH", `/admin/users/${segment(userId)}`, patch)),
      /** A page of tenants, in the order of their name: `search` finds those whose name starts with it. */
      tenants: (page?: SearchQuery) =>
        call<Page<Tenant>>("GET", `/admin/tenants${query(page)}`),
      updateTenant: (
        tenantId: string,
        patch: { name?: string; metadata?: Metadata | null },
      ) => call<Tenant>("PATCH", `/admin/tenants/${segment(tenantId)}`, patch),
      deleteTenant: (tenantId: string) =>
        changes(call<void>("DELETE", `/admin/tenants/${segment(tenantId)}`)),
    },
  };
}

export type SaasClient = ReturnType<typeof saasClient>;

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

export interface SearchQuery extends PageQuery {
  /** The start of an email, for users, or a name, for tenants, in any case. */
  search?: string;
}

const slash = (path: string) =>
  path === "" || path.startsWith("/") ? path : `/${path}`;

function query(page: SearchQuery = {}) {
  const params = new URLSearchParams();
  if (page.limit !== undefined) params.set("limit", String(page.limit));
  if (page.cursor) params.set("cursor", page.cursor);
  if (page.search) params.set("search", page.search);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The routes answer `{ error: { code, message } }`. API Gateway's own
// answers, like a token it turned away, are `{ message }`.
function errorOf(status: number, value: any, text: string) {
  const error = value?.error;
  if (typeof error?.code === "string")
    return new SaasError(status, error.code, String(error.message ?? ""));
  const message = typeof value?.message === "string" ? value.message : text;
  const code =
    status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "http";
  return new SaasError(status, code, message || `The API answered ${status}.`);
}

function claimsOf(token: string): TokenClaims {
  const part = token.split(".")[1];
  if (!part) throw new SaasError(401, "unauthorized", "The token isn't a JWT.");
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const claims = JSON.parse(new TextDecoder().decode(bytes));
  const text = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    userId: String(claims.sub),
    tenantId: text(claims[CLAIMS.tenant]),
    platformAdmin: String(claims[CLAIMS.platformAdmin]) === "true",
    scopes: text(claims.scope)?.split(" ") ?? [],
  };
}
