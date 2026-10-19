// A client for the built-in routes, for the browser or any other code that
// calls the API. It only uses `fetch`, and imports only types and the
// config's constants, so it brings nothing else into a bundle.

import { ALL_SCOPE, CLAIMS, scopeOf } from "./config";
import type {
  Invitation,
  Member,
  Metadata,
  Page,
  Tenant,
  User,
} from "./runtime/store/types";

export type { Invitation, Member, Metadata, Page, Tenant, User };

/** A tenant the user is a member of, with their role in it. */
export type MyTenant = Tenant & { role: string };

/** `GET /me`: the user, and the tenant they're in, with their role in it. */
export interface Me {
  user: User;
  tenant?: Tenant;
  role?: string;
}

/** What the user's access token says. Read from the token, not checked: the API checks it. */
export interface TokenClaims {
  userId: string;
  /** The tenant the token is for. */
  tenantId?: string;
  role?: string;
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
   * `fetchAuthSession()`. Not the ID token: only the access token has the
   * scopes the API checks.
   */
  token(): string | undefined | Promise<string | undefined>;
  /**
   * Get new tokens from the user pool, so that the next `token()` is for
   * the user's tenant as it is now. With Amplify, `fetchAuthSession({
   * forceRefresh: true })`.
   */
  refresh(): unknown;
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
 * each request, turns an error into a `SaasError`, and refreshes the tokens
 * after a change to the tenant they're in, which the tokens say.
 *
 * ```ts
 * const saas = saasClient({
 *   url: import.meta.env.VITE_SAAS_URL,
 *   token: async () => (await fetchAuthSession()).tokens?.accessToken?.toString(),
 *   refresh: () => fetchAuthSession({ forceRefresh: true }),
 * });
 * await saas.switchTenant(tenantId);
 * ```
 */
export function saasClient(options: SaasClientOptions) {
  const api = options.url.replace(/\/+$/, "");
  const prefix = slash(options.path ?? "").replace(/\/+$/, "");
  const segment = encodeURIComponent;

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

  const refresh = async () => {
    await options.refresh();
  };

  async function claims(): Promise<TokenClaims | undefined> {
    const token = await options.token();
    return token ? claimsOf(token) : undefined;
  }

  return {
    /**
     * Call a route of your own on the same API, with the user's access
     * token, like `request("GET", "/projects")`. The path is from the API's
     * root, where `saas.route()` puts routes, not under the component's.
     */
    request,

    /**
     * Get new tokens. The user takes up any invitation to their email, and
     * the tokens have their role as it is now.
     */
    refresh,

    /** What the user's access token says. Nothing when they're not signed in. */
    claims,

    /**
     * Whether the user's role, in the tenant their token is for, has a
     * permission. It reads the token, to show or hide parts of your UI: the
     * API checks the store.
     */
    async can(permission: string) {
      const scopes = (await claims())?.scopes ?? [];
      return scopes.includes(ALL_SCOPE) || scopes.includes(scopeOf(permission));
    },

    me: () => call<Me>("GET", "/me"),
    updateMe: (patch: { name?: string | null }) =>
      call<User>("PATCH", "/me", patch),

    /** The tenants the user is a member of, with their role in each. */
    tenants: () => call<MyTenant[]>("GET", "/tenants"),
    /** Create a tenant, with the user as its owner. It doesn't switch to it. */
    createTenant: (input: { name: string }) =>
      call<MyTenant>("POST", "/tenants", input),
    /** Make a tenant the one the user is in, and refresh the tokens for it. */
    async switchTenant(tenantId: string) {
      const switched = await call<{ tenant: Tenant; role: string }>(
        "PUT",
        "/me/tenant",
        { tenantId },
      );
      await refresh();
      return switched;
    },

    /** The tenant the user is in. */
    tenant: () => call<Tenant>("GET", "/tenant"),
    updateTenant: (patch: { name: string }) =>
      call<Tenant>("PATCH", "/tenant", patch),
    /** Delete the tenant the user is in, and refresh the tokens for the one they're moved to. */
    async deleteTenant() {
      await call("DELETE", "/tenant");
      await refresh();
    },

    members: () => call<Member[]>("GET", "/tenant/members"),
    /** Add someone who has signed up. To add anyone else, `invite()` them. */
    addMember: (
      input: ({ email: string } | { userId: string }) & { role?: string },
    ) => call<Member>("POST", "/tenant/members", input),
    changeRole: (userId: string, role: string) =>
      call<Member>("PATCH", `/tenant/members/${segment(userId)}`, { role }),
    removeMember: (userId: string) =>
      call<void>("DELETE", `/tenant/members/${segment(userId)}`),
    /** Leave the tenant the user is in, and refresh the tokens for the one they're moved to. */
    async leave() {
      const token = await options.token();
      if (!token) throw new SaasError(401, "unauthorized", "Sign in first.");
      await call(
        "DELETE",
        `/tenant/members/${segment(claimsOf(token).userId)}`,
      );
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
      users: (page?: PageQuery) =>
        call<Page<User>>("GET", `/admin/users${query(page)}`),
      updateUser: (
        userId: string,
        patch: {
          name?: string | null;
          platformAdmin?: boolean;
          metadata?: Metadata | null;
        },
      ) => call<User>("PATCH", `/admin/users/${segment(userId)}`, patch),
      tenants: (page?: PageQuery) =>
        call<Page<Tenant>>("GET", `/admin/tenants${query(page)}`),
      updateTenant: (
        tenantId: string,
        patch: { name?: string; metadata?: Metadata | null },
      ) => call<Tenant>("PATCH", `/admin/tenants/${segment(tenantId)}`, patch),
      deleteTenant: (tenantId: string) =>
        call<void>("DELETE", `/admin/tenants/${segment(tenantId)}`),
    },
  };
}

export type SaasClient = ReturnType<typeof saasClient>;

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

const slash = (path: string) =>
  path === "" || path.startsWith("/") ? path : `/${path}`;

function query(page: PageQuery = {}) {
  const params = new URLSearchParams();
  if (page.limit !== undefined) params.set("limit", String(page.limit));
  if (page.cursor) params.set("cursor", page.cursor);
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
    role: text(claims[CLAIMS.role]),
    platformAdmin: String(claims[CLAIMS.platformAdmin]) === "true",
    scopes: text(claims.scope)?.split(" ") ?? [],
  };
}
