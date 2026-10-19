import type {
  Invitation,
  Membership,
  Page,
  PageArgs,
  Patch,
  Store,
  Tenant,
  User,
} from "./types.js";

// The order the lists are in, as the DynamoDB store's indexes keep it
const userOrder = (user: User) => `${user.email ?? "~"} #${user.id}`;
const tenantOrder = (tenant: Tenant) =>
  `${tenant.name.toLowerCase()} #${tenant.id}`;

/**
 * A store that keeps everything in memory, for tests. It behaves as the
 * DynamoDB one does, apart from being consistent at once.
 */
export function memoryStore(): Store & {
  users: Map<string, User>;
  tenants: Map<string, Tenant>;
  memberships: Map<string, Membership>;
  invitations: Map<string, Invitation>;
} {
  const users = new Map<string, User>();
  const tenants = new Map<string, Tenant>();
  const memberships = new Map<string, Membership>();
  const invitations = new Map<string, Invitation>();
  const key = (tenantId: string, other: string) => `${tenantId}\n${other}`;
  const copy = <T>(value: T | undefined) =>
    value === undefined ? undefined : structuredClone(value);
  const now = () => new Date().toISOString();

  return {
    users,
    tenants,
    memberships,
    invitations,

    async getUser(id) {
      return copy(users.get(id));
    },
    async getUsers(ids) {
      return ids.flatMap((id) => copy(users.get(id)) ?? []);
    },
    async findUserByEmail(email) {
      const lower = email.toLowerCase();
      return copy([...users.values()].find((user) => user.email === lower));
    },
    async createUser(user, personal) {
      if (users.has(user.id)) return false;
      if (personal && tenants.has(personal.tenant.id))
        throw new Error(`The tenant "${personal.tenant.id}" exists already.`);
      users.set(user.id, copy(user)!);
      if (personal) {
        tenants.set(personal.tenant.id, copy(personal.tenant)!);
        const { tenantId, userId } = personal.membership;
        memberships.set(key(tenantId, userId), copy(personal.membership)!);
      }
      return true;
    },
    async updateUser(id, patch) {
      const user = users.get(id);
      if (!user) return undefined;
      const updated = apply(user, patch);
      users.set(id, updated);
      return copy(updated);
    },
    async listUsers(page = {}) {
      return paginate([...users.values()], userOrder, page, page.search);
    },

    async getTenant(id) {
      return copy(tenants.get(id));
    },
    async getTenants(ids) {
      return ids.flatMap((id) => copy(tenants.get(id)) ?? []);
    },
    async createTenant(tenant, owner) {
      if (tenants.has(tenant.id))
        throw new Error(`The tenant "${tenant.id}" exists already.`);
      tenants.set(tenant.id, copy(tenant)!);
      memberships.set(key(owner.tenantId, owner.userId), copy(owner)!);
    },
    async updateTenant(id, patch) {
      const tenant = tenants.get(id);
      if (!tenant) return undefined;
      const updated = apply(tenant, patch);
      tenants.set(id, updated);
      return copy(updated);
    },
    async deleteTenant(id) {
      for (const [k, membership] of memberships)
        if (membership.tenantId === id) memberships.delete(k);
      for (const [k, invitation] of invitations)
        if (invitation.tenantId === id) invitations.delete(k);
      tenants.delete(id);
    },
    async listTenants(page = {}) {
      return paginate([...tenants.values()], tenantOrder, page, page.search);
    },

    async getMembership(tenantId, userId) {
      return copy(memberships.get(key(tenantId, userId)));
    },
    async listMembers(tenantId, page) {
      return paginate(
        [...memberships.values()].filter((m) => m.tenantId === tenantId),
        (m) => m.userId,
        page,
      );
    },
    async membersWithRole(tenantId, role, page) {
      return paginate(
        [...memberships.values()].filter(
          (m) => m.tenantId === tenantId && m.role === role,
        ),
        (m) => m.userId,
        page,
      );
    },
    async listMemberships(userId) {
      return [...memberships.values()]
        .filter((membership) => membership.userId === userId)
        .map((membership) => copy(membership)!);
    },
    async putMembership(membership) {
      memberships.set(
        key(membership.tenantId, membership.userId),
        copy(membership)!,
      );
    },
    async deleteMembership(tenantId, userId) {
      memberships.delete(key(tenantId, userId));
    },

    async getInvitation(tenantId, email) {
      return copy(invitations.get(key(tenantId, email.toLowerCase())));
    },
    async listInvitations(tenantId) {
      return [...invitations.values()]
        .filter((invitation) => invitation.tenantId === tenantId)
        .map((invitation) => copy(invitation)!);
    },
    async findInvitations(email) {
      const lower = email.toLowerCase();
      return [...invitations.values()]
        .filter((invitation) => invitation.email === lower)
        .map((invitation) => copy(invitation)!);
    },
    async putInvitation(invitation) {
      invitations.set(
        key(invitation.tenantId, invitation.email),
        copy(invitation)!,
      );
    },
    async deleteInvitation(tenantId, email) {
      invitations.delete(key(tenantId, email.toLowerCase()));
    },
    async acceptInvitation(invitation, membership) {
      const invited = key(invitation.tenantId, invitation.email);
      const member = key(membership.tenantId, membership.userId);
      if (!invitations.has(invited) || memberships.has(member)) return false;
      invitations.delete(invited);
      memberships.set(member, copy(membership)!);
      return true;
    },
  };

  function apply<T extends { updatedAt: string }>(
    record: T,
    patch: Patch<Partial<T>>,
  ): T {
    const updated: Record<string, unknown> = { ...record };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete updated[field];
      else updated[field] = structuredClone(value);
    }
    updated.updatedAt = now();
    return updated as T;
  }

  // A page of items in the order of their keys, from after the cursor,
  // which is the last key of the page before
  function paginate<T>(
    items: T[],
    keyOf: (item: T) => string,
    page: PageArgs = {},
    search?: string,
  ): Page<T> {
    const prefix = search?.trim().toLowerCase();
    const sorted = items
      .map((item) => ({ item, key: keyOf(item) }))
      .filter(({ key }) => !prefix || key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const start = page.cursor
      ? sorted.findIndex(({ key }) => key > page.cursor!)
      : 0;
    if (start < 0) return { items: [] };
    const limit = page.limit ?? 50;
    const slice = sorted.slice(start, start + limit);
    const more = start + limit < sorted.length;
    return {
      items: slice.map(({ item }) => copy(item)!),
      cursor: more ? slice[slice.length - 1].key : undefined,
    };
  }
}
