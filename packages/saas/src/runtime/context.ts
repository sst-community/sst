import type { SaasConfig } from "../config";
import type { lazySetup } from "./env";
import { auth, HttpError, type ApiEvent, type Auth } from "./http";
import type { Store } from "./store/types";
import type { Access, Identity, Tenancy } from "./tenancy";

/** What a route is given about the request. */
export interface SaasContext {
  /** Who's calling, from their token. */
  auth: Auth;
  identity: Identity;
  /**
   * What the caller can do in the tenant their token is for, checked
   * against the store. Set when the route asks for a permission.
   */
  access?: Access;
  config: SaasConfig;
  store: Store;
  tenancy: Tenancy;
}

/** What a route asks of its caller. */
export interface Requirement {
  /** A permission in the tenant the token is for. */
  permission?: string;
  /** Only platform admins. */
  platformAdmin?: boolean;
}

export const noActiveTenant = () =>
  new HttpError(
    409,
    "no_active_tenant",
    "Your token isn't for a tenant. Switch to one with PUT /me/tenant, then refresh your tokens.",
  );

/** Who's calling, checked against what the route asks for. */
export async function contextOf(
  event: ApiEvent,
  setup: ReturnType<typeof lazySetup>,
  requirement: Requirement = {},
): Promise<SaasContext> {
  const caller = auth(event);
  const identity = { id: caller.userId };
  const { config, store, tenancy } = setup();
  let access: Access | undefined;
  if (requirement.platformAdmin) await tenancy.platformAdmin(identity);
  if (requirement.permission) {
    if (!caller.tenantId) throw noActiveTenant();
    access = await tenancy.authorize(
      identity,
      caller.tenantId,
      requirement.permission,
    );
  }
  return { auth: caller, identity, access, config, store, tenancy };
}
