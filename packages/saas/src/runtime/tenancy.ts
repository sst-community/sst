import { randomUUID } from "node:crypto";
import type { SaasConfig } from "../config";
import { badRequest, conflict, forbidden, notFound } from "./http";
import { allows, covers, permissionsOf, type Permissions } from "./roles";
import type {
  Membership,
  Metadata,
  PageArgs,
  Store,
  Tenant,
  User,
} from "./store/types";

/** Who's acting: a user's `sub`, and what the user pool knows of them. */
export interface Identity {
  id: string;
  email?: string;
  name?: string;
}

/**
 * Called after a change is made. A hook that throws fails the request, or
 * the sign-in for `userCreated`, but doesn't undo the change.
 */
export interface TenancyHooks {
  userCreated?(event: { user: User; tenant?: Tenant }): unknown;
  tenantCreated?(event: { tenant: Tenant; by: User }): unknown;
  tenantDeleted?(event: { tenant: Tenant; by: User }): unknown;
  memberAdded?(event: { membership: Membership; by: User }): unknown;
  memberChanged?(event: {
    membership: Membership;
    previous: Membership;
    by: User;
  }): unknown;
  memberRemoved?(event: { membership: Membership; by: User }): unknown;
}

export interface TenancyArgs {
  store: Store;
  config: SaasConfig;
  hooks?: TenancyHooks;
  /** The name of the tenant a user gets when they sign up. */
  personalTenantName?(user: User): string;
}

/** A member of a tenant, with who they are. */
export interface Member extends Membership {
  email?: string;
  name?: string;
}

/** What a user can do in a tenant. */
export interface Access {
  user: User;
  /** Not set for a platform admin who isn't a member. */
  membership?: Membership;
  /** The member's role. A platform admin who isn't a member acts as the owner role. */
  role: string;
  permissions: Permissions;
  can(permission: string): boolean;
}

export type Tenancy = ReturnType<typeof tenancy>;

/**
 * The rules for users, tenants and members, on a store. The built-in
 * routes and triggers are these, and your own code can call them too.
 *
 * Every operation is checked against the store, not the caller's token.
 * A platform admin can do anything in any tenant.
 */
export function tenancy(args: TenancyArgs) {
  const { store, config, hooks = {} } = args;
  const { roles, ownerRole, defaultRole } = config;
  const now = () => new Date().toISOString();
  const personalTenantName =
    args.personalTenantName ??
    ((user: User) => (user.name ? `${user.name}'s workspace` : "My workspace"));

  /**
   * Create the user, and their own tenant when `personal` is on. Does
   * nothing for a user who's there already, so it's safe to call twice.
   */
  async function provision(identity: Identity) {
    const found = await store.getUser(identity.id);
    if (found) return { user: found, created: false };

    const time = now();
    const user: User = {
      id: identity.id,
      email: lower(identity.email),
      name: identity.name || undefined,
      createdAt: time,
      updatedAt: time,
    };
    let personal: { tenant: Tenant; membership: Membership } | undefined;
    if (config.personal) {
      const tenant: Tenant = {
        id: randomUUID(),
        name: personalTenantName(user),
        personal: true,
        createdBy: user.id,
        createdAt: time,
        updatedAt: time,
      };
      const membership = member(tenant.id, user.id, ownerRole, time);
      personal = { tenant, membership };
      user.activeTenantId = tenant.id;
    }

    if (!(await store.createUser(user, personal))) {
      // Created by the other trigger in the meantime
      const created = await store.getUser(identity.id);
      if (created) return { user: created, created: false };
      throw new Error(`The user "${identity.id}" couldn't be created.`);
    }
    await hooks.userCreated?.({ user, tenant: personal?.tenant });
    return { user, tenant: personal?.tenant, created: true };
  }

  /**
   * What a user's tokens say: the tenant they're for, the user's role in
   * it and what it lets them do. Creates the user when they're new, and
   * moves them to another of their tenants when they've left theirs.
   */
  async function session(identity: Identity) {
    let { user } = await provision(identity);
    const email = lower(identity.email);
    if (email && email !== user.email)
      user = (await store.updateUser(user.id, { email })) ?? user;

    let tenantId = user.activeTenantId;
    let membership = tenantId
      ? await store.getMembership(tenantId, user.id)
      : undefined;
    const stays =
      membership !== undefined ||
      (tenantId !== undefined &&
        user.platformAdmin === true &&
        (await store.getTenant(tenantId)) !== undefined);
    if (!stays) {
      // The index can still list the membership that's gone
      const others = (await store.listMemberships(user.id)).filter(
        (m) => m.tenantId !== tenantId,
      );
      membership = first(others);
      if (membership?.tenantId !== tenantId) {
        tenantId = membership?.tenantId;
        user =
          (await store.updateUser(user.id, {
            activeTenantId: tenantId ?? null,
          })) ?? user;
      }
    }

    const role = membership?.role ?? (tenantId ? ownerRole : undefined);
    return {
      user,
      tenantId,
      membership,
      role,
      permissions: role ? permissionsOf(roles, role) : new Set<string>(),
    };
  }

  /** The user who's acting, created when they're new. */
  async function actor(identity: Identity) {
    return (await provision(identity)).user;
  }

  /** What a user can do in a tenant. Throws when they're not a member. */
  async function access(identity: Identity, tenantId: string): Promise<Access> {
    const [user, membership] = await Promise.all([
      actor(identity),
      store.getMembership(tenantId, identity.id),
    ]);
    if (!membership && !user.platformAdmin)
      throw notFound("There's no such tenant.", "no_tenant");
    const role = membership?.role ?? ownerRole;
    const permissions = permissionsOf(roles, role);
    return {
      user,
      membership,
      role,
      permissions,
      can: (permission) => allows(permissions, permission),
    };
  }

  /** What a user can do in a tenant, when it allows the permission. */
  async function authorize(
    identity: Identity,
    tenantId: string,
    permission: string,
  ) {
    const granted = await access(identity, tenantId);
    if (!granted.can(permission))
      throw forbidden(
        `Your role, "${granted.role}", doesn't allow "${permission}".`,
      );
    return granted;
  }

  async function platformAdmin(identity: Identity) {
    const user = await actor(identity);
    if (!user.platformAdmin)
      throw forbidden("Only a platform admin can do this.");
    return user;
  }

  async function existingTenant(tenantId: string) {
    const tenant = await store.getTenant(tenantId);
    if (!tenant) throw notFound("There's no such tenant.", "no_tenant");
    return tenant;
  }

  function roleOf(value: unknown) {
    if (value === undefined) return defaultRole;
    if (typeof value !== "string" || !(value in roles))
      throw badRequest(
        `"role" has to be one of: ${Object.keys(roles).join(", ")}.`,
      );
    return value;
  }

  // A tenant always keeps a member with the owner role
  async function keepsAnOwner(tenantId: string, without: string) {
    const owners = (await store.listMembers(tenantId)).filter(
      (m) => m.role === ownerRole && m.userId !== without,
    );
    if (owners.length === 0)
      throw conflict(
        `A tenant needs at least one member with the "${ownerRole}" role.`,
        "last_owner",
      );
  }

  async function withUsers(memberships: Membership[]): Promise<Member[]> {
    const users = new Map(
      (await store.getUsers(memberships.map((m) => m.userId))).map((u) => [
        u.id,
        u,
      ]),
    );
    return memberships.map((m) => ({
      ...m,
      email: users.get(m.userId)?.email,
      name: users.get(m.userId)?.name,
    }));
  }

  async function deleteTenant(tenant: Tenant, by: User) {
    await store.deleteTenant(tenant.id);
    await hooks.tenantDeleted?.({ tenant, by });
  }

  return {
    provision,
    session,
    actor,
    access,
    authorize,
    platformAdmin,

    /** The user, the tenant they're in, and their role in it. */
    async me(identity: Identity) {
      const user = await actor(identity);
      const tenantId = user.activeTenantId;
      if (!tenantId) return { user };
      const [tenant, membership] = await Promise.all([
        store.getTenant(tenantId),
        store.getMembership(tenantId, user.id),
      ]);
      if (!tenant || (!membership && !user.platformAdmin)) return { user };
      return { user, tenant, role: membership?.role ?? ownerRole };
    },

    async updateMe(identity: Identity, patch: { name?: unknown }) {
      await actor(identity);
      return (await store.updateUser(identity.id, {
        name: optionalName(patch.name),
      }))!;
    },

    /**
     * Make a tenant the one the user's tokens are for. The client refreshes
     * its tokens to get the new tenant in them.
     */
    async switchTenant(identity: Identity, tenantId: unknown) {
      if (typeof tenantId !== "string" || tenantId === "")
        throw badRequest(`"tenantId" has to be a string.`);
      const granted = await access(identity, tenantId);
      const tenant = await existingTenant(tenantId);
      await store.updateUser(identity.id, { activeTenantId: tenantId });
      return { tenant, role: granted.role };
    },

    /** The tenants the user is a member of, with their role in each. */
    async tenantsOf(identity: Identity) {
      await actor(identity);
      const memberships = await store.listMemberships(identity.id);
      const tenants = new Map(
        (await store.getTenants(memberships.map((m) => m.tenantId))).map(
          (t) => [t.id, t],
        ),
      );
      return memberships.flatMap((m) => {
        const tenant = tenants.get(m.tenantId);
        return tenant ? [{ ...tenant, role: m.role }] : [];
      });
    },

    async createTenant(identity: Identity, input: { name?: unknown }) {
      const user = await actor(identity);
      if (!config.selfServe && !user.platformAdmin)
        throw forbidden("Only a platform admin can create a tenant.");
      const time = now();
      const tenant: Tenant = {
        id: randomUUID(),
        name: nameOf(input.name),
        createdBy: user.id,
        createdAt: time,
        updatedAt: time,
      };
      await store.createTenant(
        tenant,
        member(tenant.id, user.id, ownerRole, time),
      );
      if (!user.activeTenantId)
        await store.updateUser(user.id, { activeTenantId: tenant.id });
      await hooks.tenantCreated?.({ tenant, by: user });
      return { ...tenant, role: ownerRole };
    },

    async getTenant(identity: Identity, tenantId: string) {
      await authorize(identity, tenantId, "tenant:read");
      return existingTenant(tenantId);
    },

    async updateTenant(
      identity: Identity,
      tenantId: string,
      patch: { name?: unknown },
    ) {
      await authorize(identity, tenantId, "tenant:update");
      const tenant = await store.updateTenant(tenantId, {
        name: nameOf(patch.name),
      });
      if (!tenant) throw notFound("There's no such tenant.", "no_tenant");
      return tenant;
    },

    async deleteTenant(identity: Identity, tenantId: string) {
      const { user } = await authorize(identity, tenantId, "tenant:delete");
      const tenant = await existingTenant(tenantId);
      if (tenant.personal && !user.platformAdmin)
        throw conflict(
          "A personal tenant can't be deleted.",
          "personal_tenant",
        );
      await deleteTenant(tenant, user);
    },

    async members(identity: Identity, tenantId: string) {
      await authorize(identity, tenantId, "members:read");
      return withUsers(await store.listMembers(tenantId));
    },

    /**
     * Add a user who has signed up, by email or id. There are no
     * invitations: someone who hasn't signed up yet can't be added.
     */
    async addMember(
      identity: Identity,
      tenantId: string,
      input: { email?: unknown; userId?: unknown; role?: unknown },
    ) {
      const granted = await authorize(identity, tenantId, "members:write");
      const role = roleOf(input.role);
      if (!covers(granted.permissions, permissionsOf(roles, role)))
        throw forbidden(
          `You can't give the "${role}" role: it has permissions yours doesn't.`,
        );
      let user: User | undefined;
      if (typeof input.userId === "string" && input.userId !== "")
        user = await store.getUser(input.userId);
      else if (typeof input.email === "string" && input.email.includes("@"))
        user = await store.findUserByEmail(input.email);
      else throw badRequest(`Give the user's "email" or "userId".`);
      if (!user)
        throw notFound(
          "No one with that email or id has signed up.",
          "no_user",
        );
      if (await store.getMembership(tenantId, user.id))
        throw conflict("They're a member already.", "member_exists");

      const membership = member(tenantId, user.id, role, now());
      await store.putMembership(membership);
      await hooks.memberAdded?.({ membership, by: granted.user });
      return (await withUsers([membership]))[0];
    },

    async changeRole(
      identity: Identity,
      tenantId: string,
      userId: string,
      input: { role?: unknown },
    ) {
      const granted = await authorize(identity, tenantId, "members:write");
      if (input.role === undefined) throw badRequest(`Give the new "role".`);
      const role = roleOf(input.role);
      const previous = await store.getMembership(tenantId, userId);
      if (!previous) throw notFound("They're not a member.", "no_member");
      if (
        !covers(granted.permissions, permissionsOf(roles, previous.role)) ||
        !covers(granted.permissions, permissionsOf(roles, role))
      )
        throw forbidden(
          "You can't change a role that has permissions yours doesn't.",
        );
      if (previous.role === role) return (await withUsers([previous]))[0];
      if (previous.role === ownerRole) await keepsAnOwner(tenantId, userId);

      const membership = { ...previous, role, updatedAt: now() };
      await store.putMembership(membership);
      await hooks.memberChanged?.({ membership, previous, by: granted.user });
      return (await withUsers([membership]))[0];
    },

    /** Remove a member. Anyone can leave a tenant, unless they're its last owner. */
    async removeMember(identity: Identity, tenantId: string, userId: string) {
      const leaving = userId === identity.id;
      const granted = leaving
        ? await access(identity, tenantId)
        : await authorize(identity, tenantId, "members:write");
      const membership = await store.getMembership(tenantId, userId);
      if (!membership) throw notFound("They're not a member.", "no_member");
      if (
        !leaving &&
        !covers(granted.permissions, permissionsOf(roles, membership.role))
      )
        throw forbidden(
          "You can't remove a member whose role has permissions yours doesn't.",
        );
      if (membership.role === ownerRole) await keepsAnOwner(tenantId, userId);

      await store.deleteMembership(tenantId, userId);
      await hooks.memberRemoved?.({ membership, by: granted.user });
    },

    admin: {
      async users(identity: Identity, page?: PageArgs) {
        await platformAdmin(identity);
        return paged(() => store.listUsers(page));
      },

      async updateUser(
        identity: Identity,
        userId: string,
        patch: { name?: unknown; platformAdmin?: unknown; metadata?: unknown },
      ) {
        await platformAdmin(identity);
        if (
          patch.platformAdmin !== undefined &&
          typeof patch.platformAdmin !== "boolean"
        )
          throw badRequest(`"platformAdmin" has to be true or false.`);
        const user = await store.updateUser(userId, {
          name: optionalName(patch.name),
          platformAdmin:
            patch.platformAdmin === false
              ? null
              : (patch.platformAdmin as true | undefined),
          metadata: metadataOf(patch.metadata),
        });
        if (!user) throw notFound("There's no such user.", "no_user");
        return user;
      },

      async tenants(identity: Identity, page?: PageArgs) {
        await platformAdmin(identity);
        return paged(() => store.listTenants(page));
      },

      async updateTenant(
        identity: Identity,
        tenantId: string,
        patch: { name?: unknown; metadata?: unknown },
      ) {
        await platformAdmin(identity);
        const tenant = await store.updateTenant(tenantId, {
          name: patch.name === undefined ? undefined : nameOf(patch.name),
          metadata: metadataOf(patch.metadata),
        });
        if (!tenant) throw notFound("There's no such tenant.", "no_tenant");
        return tenant;
      },

      async deleteTenant(identity: Identity, tenantId: string) {
        const user = await platformAdmin(identity);
        await deleteTenant(await existingTenant(tenantId), user);
      },
    },
  };
}

// A cursor the store can't read is the caller's mistake
async function paged<T>(list: () => Promise<T>) {
  try {
    return await list();
  } catch (error) {
    if ((error as Error)?.name === "InvalidCursor")
      throw badRequest((error as Error).message);
    throw error;
  }
}

function member(
  tenantId: string,
  userId: string,
  role: string,
  time: string,
): Membership {
  return { tenantId, userId, role, createdAt: time, updatedAt: time };
}

// The membership a user is moved to when they leave their tenant: the
// oldest, so it's the same one each time.
function first(memberships: Membership[]) {
  return memberships.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

function lower(email: string | undefined) {
  return email ? email.trim().toLowerCase() : undefined;
}

function nameOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw badRequest(`"name" has to be a string.`);
  const name = value.trim();
  if (name.length > 100)
    throw badRequest(`"name" can be at most 100 characters.`);
  return name;
}

// A name to set, `null` to remove it, or nothing to leave it
function optionalName(value: unknown) {
  if (value === undefined || value === null) return value;
  return nameOf(value);
}

function metadataOf(value: unknown): Metadata | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object" || Array.isArray(value))
    throw badRequest(`"metadata" has to be an object.`);
  return value as Metadata;
}
