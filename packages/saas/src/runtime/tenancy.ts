import { randomUUID } from "node:crypto";
import { DEFAULT_INVITATIONS, type SaasConfig } from "../config";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./http";
import { allows, covers, permissionsOf, type Permissions } from "./roles";
import type {
  Invitation,
  Member,
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
  /**
   * Only once it's verified: members are added and invitations taken up
   * by it.
   */
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
  /**
   * `invitation` is set when they took one up, and `by` is then who
   * invited them.
   */
  memberAdded?(event: {
    membership: Membership;
    by: User;
    invitation?: Invitation;
  }): unknown;
  memberChanged?(event: {
    membership: Membership;
    previous: Membership;
    by: User;
  }): unknown;
  memberRemoved?(event: { membership: Membership; by: User }): unknown;
  /** Someone was invited, or invited again. */
  invitationCreated?(event: {
    invitation: Invitation;
    tenant: Tenant;
    by: User;
  }): unknown;
  invitationRevoked?(event: { invitation: Invitation; by: User }): unknown;
}

export interface TenancyArgs {
  store: Store;
  config: SaasConfig;
  hooks?: TenancyHooks;
  /** The name of the tenant a user gets when they sign up. */
  personalTenantName?(user: User): string;
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

export type { Member };

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
  const invitationConfig = config.invitations ?? DEFAULT_INVITATIONS;
  const unknownRoles = new Set<string>();
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

    // Someone who signed up because they were invited starts in that tenant
    const joined = await takeUpInvitations(user);
    const latest = joined[joined.length - 1];
    const updated =
      latest &&
      (await store.updateUser(user.id, { activeTenantId: latest.tenantId }));
    return { user: updated || user, tenant: personal?.tenant, created: true };
  }

  /**
   * Make the user a member of each tenant their email was invited to. It's
   * done when they sign up, and each time they're issued tokens, so someone
   * who has signed up already joins at their next sign-in or refresh.
   * Returns the memberships, the most recent invitation's last.
   */
  async function takeUpInvitations(user: User) {
    if (!user.email) return [];
    const found = (await store.findInvitations(user.email)).sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    );
    const joined: Membership[] = [];
    for (const invitation of found) {
      const [tenant, membership] = await Promise.all([
        store.getTenant(invitation.tenantId),
        store.getMembership(invitation.tenantId, user.id),
      ]);
      if (expired(invitation) || !tenant || membership) {
        await store.deleteInvitation(invitation.tenantId, invitation.email);
        continue;
      }
      const added = member(
        invitation.tenantId,
        user.id,
        invitation.role,
        now(),
      );
      // Taken up already, by the other trigger
      if (!(await store.acceptInvitation(invitation, added))) continue;
      joined.push(added);
      const by = (await store.getUser(invitation.invitedBy)) ?? user;
      await hooks.memberAdded?.({ membership: added, by, invitation });
    }
    return joined;
  }

  /**
   * What a user's tokens say: the tenant they're for, the user's role in
   * it and what it lets them do. Creates the user when they're new, and
   * moves them to another of their tenants when they've left theirs.
   */
  async function session(identity: Identity) {
    let { user, created } = await provision(identity);
    const email = lower(identity.email);
    if (email && email !== user.email)
      user = (await store.updateUser(user.id, { email })) ?? user;
    if (!created) {
      const joined = await takeUpInvitations(user);
      // The index may not list a membership that was just added
      if (joined.length > 0 && !user.activeTenantId)
        user =
          (await store.updateUser(user.id, {
            activeTenantId: joined[joined.length - 1].tenantId,
          })) ?? user;
    }

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
      permissions: role ? permissionsFor(role) : new Set<string>(),
    };
  }

  /**
   * What a member's role lets them do. A role that isn't in the config any
   * more, because it was renamed or removed, lets them do nothing, and is
   * logged once.
   */
  function permissionsFor(role: string) {
    if (!(role in roles) && !unknownRoles.has(role)) {
      unknownRoles.add(role);
      console.warn(
        `Members have the role "${role}", which isn't one of the roles any more (${Object.keys(
          roles,
        ).join(", ")}), so they can do nothing. Move them to another role.`,
      );
    }
    return permissionsOf(roles, role);
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
    const permissions = permissionsFor(role);
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

  // A role can only be given, or an invitation with it changed, by someone
  // with all its permissions
  function canGive(
    granted: Access,
    role: string,
    what = `give the "${role}" role`,
  ) {
    if (!covers(granted.permissions, permissionsOf(roles, role)))
      throw forbidden(`You can't ${what}: it has permissions yours doesn't.`);
  }

  async function deleteTenant(tenant: Tenant, by: User) {
    await store.deleteTenant(tenant.id);
    await hooks.tenantDeleted?.({ tenant, by });
  }

  return {
    provision,
    session,
    takeUpInvitations,
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
     * Add a user who has signed up, by email or id. To add someone who
     * hasn't, invite them.
     */
    async addMember(
      identity: Identity,
      tenantId: string,
      input: { email?: unknown; userId?: unknown; role?: unknown },
    ) {
      const granted = await authorize(identity, tenantId, "members:write");
      const role = roleOf(input.role);
      canGive(granted, role);
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
      // An invitation they had to it is done with
      if (user.email) await store.deleteInvitation(tenantId, user.email);
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

    /** The invitations to a tenant that can still be taken up. */
    async invitations(identity: Identity, tenantId: string) {
      await authorize(identity, tenantId, "members:read");
      return (await store.listInvitations(tenantId))
        .filter((invitation) => !expired(invitation))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    /**
     * Invite someone by email. They become a member when they sign up, or
     * sign in, with that email, verified. The answer is the same whether
     * or not anyone has signed up with it. Inviting the same email again
     * replaces the invitation and sends it again.
     */
    async invite(
      identity: Identity,
      tenantId: string,
      input: { email?: unknown; role?: unknown },
    ) {
      const granted = await authorize(identity, tenantId, "members:write");
      const email = emailOf(input.email);
      const role = roleOf(input.role);
      canGive(granted, role);
      const [tenant, existing, waiting] = await Promise.all([
        existingTenant(tenantId),
        store.findUserByEmail(email),
        store.listInvitations(tenantId),
      ]);
      // They can see who's a member already
      if (existing && (await store.getMembership(tenantId, existing.id)))
        throw conflict("They're a member already.", "member_exists");
      const live = waiting.filter((invitation) => !expired(invitation));
      const previous = live.find((invitation) => invitation.email === email);
      if (previous) {
        canGive(
          granted,
          previous.role,
          `change an invitation with the "${previous.role}" role`,
        );
        if (Date.now() - Date.parse(previous.updatedAt) < RESEND_AFTER)
          throw new HttpError(
            429,
            "too_soon",
            "They were invited less than a minute ago.",
          );
      } else if (live.length >= invitationConfig.limit)
        throw conflict(
          `A tenant can have at most ${invitationConfig.limit} invitations waiting.`,
          "too_many_invitations",
        );

      const time = now();
      const invitation: Invitation = {
        tenantId,
        email,
        role,
        invitedBy: granted.user.id,
        expiresAt: new Date(
          Date.now() + invitationConfig.expiresIn * 1000,
        ).toISOString(),
        createdAt: previous?.createdAt ?? time,
        updatedAt: time,
      };
      await store.putInvitation(invitation);
      await hooks.invitationCreated?.({ invitation, tenant, by: granted.user });
      return invitation;
    },

    async revokeInvitation(
      identity: Identity,
      tenantId: string,
      email: string,
    ) {
      const granted = await authorize(identity, tenantId, "members:write");
      const invitation = await store.getInvitation(
        tenantId,
        lower(email) ?? "",
      );
      if (!invitation || expired(invitation))
        throw notFound("There's no such invitation.", "no_invitation");
      canGive(
        granted,
        invitation.role,
        `revoke an invitation with the "${invitation.role}" role`,
      );
      await store.deleteInvitation(tenantId, invitation.email);
      await hooks.invitationRevoked?.({ invitation, by: granted.user });
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

// Someone can't be sent an invitation more often than this
const RESEND_AFTER = 60 * 1000;

const expired = (invitation: Invitation) =>
  Date.parse(invitation.expiresAt) <= Date.now();

function emailOf(value: unknown): string {
  const email = typeof value === "string" ? lower(value) : undefined;
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw badRequest(`"email" has to be an email address.`);
  return email;
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
