import type {
  Membership,
  Page,
  PageArgs,
  Patch,
  Store,
  Tenant,
  User,
} from "./types";

/**
 * A store that keeps everything in memory, for tests. It behaves as the
 * DynamoDB one does, apart from being consistent at once.
 */
export function memoryStore(): Store & {
  users: Map<string, User>;
  tenants: Map<string, Tenant>;
  memberships: Map<string, Membership>;
} {
  const users = new Map<string, User>();
  const tenants = new Map<string, Tenant>();
  const memberships = new Map<string, Membership>();
  const key = (tenantId: string, userId: string) => `${tenantId}\n${userId}`;
  const copy = <T>(value: T | undefined) =>
    value === undefined ? undefined : structuredClone(value);
  const now = () => new Date().toISOString();

  return {
    users,
    tenants,
    memberships,

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
    async listUsers(page) {
      return paginate([...users.values()], page);
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
      tenants.delete(id);
    },
    async listTenants(page) {
      return paginate([...tenants.values()], page);
    },

    async getMembership(tenantId, userId) {
      return copy(memberships.get(key(tenantId, userId)));
    },
    async listMembers(tenantId) {
      return [...memberships.values()]
        .filter((membership) => membership.tenantId === tenantId)
        .map((membership) => copy(membership)!);
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

  function paginate<T extends { id: string }>(
    items: T[],
    page: PageArgs = {},
  ): Page<T> {
    const sorted = items.sort((a, b) => a.id.localeCompare(b.id));
    const start = page.cursor
      ? sorted.findIndex((item) => item.id > page.cursor!)
      : 0;
    if (start < 0) return { items: [] };
    const limit = page.limit ?? 50;
    const slice = sorted.slice(start, start + limit);
    const more = start + limit < sorted.length;
    return {
      items: slice.map((item) => copy(item)!),
      cursor: more ? slice[slice.length - 1].id : undefined,
    };
  }
}
