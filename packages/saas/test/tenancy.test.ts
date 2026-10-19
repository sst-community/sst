import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ROLES, type SaasConfig } from "../src/config";
import { config } from "./helpers";
import { memoryStore } from "../src/runtime/store/memory";
import { tenancy, type TenancyHooks } from "../src/runtime/tenancy";
import { HttpError } from "../src/runtime/http";

const ann = { id: "ann", email: "Ann@Example.com", name: "Ann" };
const bob = { id: "bob", email: "bob@example.com" };
const cat = { id: "cat", email: "cat@example.com" };

async function fails(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(
    () => undefined,
    (error) => error,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect(error.status).toBe(status);
  if (code) expect(error.code).toBe(code);
}

describe("tenancy", () => {
  let store: ReturnType<typeof memoryStore>;
  let events: string[];
  const hooks: TenancyHooks = {
    userCreated: ({ user }) => events.push(`userCreated ${user.id}`),
    tenantCreated: ({ tenant }) => events.push(`tenantCreated ${tenant.name}`),
    memberAdded: ({ membership }) =>
      events.push(`memberAdded ${membership.userId} ${membership.role}`),
    memberChanged: ({ membership, previous }) =>
      events.push(`memberChanged ${previous.role} ${membership.role}`),
    memberRemoved: ({ membership }) =>
      events.push(`memberRemoved ${membership.userId}`),
    tenantDeleted: ({ tenant }) => events.push(`tenantDeleted ${tenant.name}`),
  };
  const make = (patch?: Partial<SaasConfig>) =>
    tenancy({ store, config: config(patch), hooks });

  beforeEach(() => {
    store = memoryStore();
    events = [];
  });

  describe("provision", () => {
    it("creates the user with a tenant of their own", async () => {
      const t = make();
      const { user, tenant, created } = await t.provision(ann);

      expect(created).toBe(true);
      expect(user.email).toBe("ann@example.com");
      expect(tenant).toMatchObject({ name: "Ann's workspace", personal: true });
      expect(user.activeTenantId).toBe(tenant!.id);
      expect(await store.getMembership(tenant!.id, "ann")).toMatchObject({
        role: "owner",
      });
      expect(events).toEqual(["userCreated ann"]);
    });

    it("does nothing the second time", async () => {
      const t = make();
      await t.provision(ann);
      const again = await t.provision(ann);

      expect(again.created).toBe(false);
      expect(store.tenants.size).toBe(1);
      expect(events).toEqual(["userCreated ann"]);
    });

    it("creates no tenant when personal tenants are off", async () => {
      const { user, tenant } = await make({ personal: false }).provision(ann);
      expect(tenant).toBeUndefined();
      expect(user.activeTenantId).toBeUndefined();
      expect(store.tenants.size).toBe(0);
    });

    it("names the tenant with the given function", async () => {
      const t = tenancy({
        store,
        config: config(),
        personalTenantName: (user) => `${user.email} HQ`,
      });
      expect((await t.provision(ann)).tenant?.name).toBe("ann@example.com HQ");
    });
  });

  describe("session", () => {
    it("is for the user's tenant, with their role", async () => {
      const t = make();
      const { tenant } = await t.provision(ann);
      const session = await t.session(ann);

      expect(session.tenantId).toBe(tenant!.id);
      expect(session.role).toBe("owner");
      expect(session.permissions).toBe("*");
    });

    it("moves a user who left their tenant to another one", async () => {
      const t = make();
      const { tenant: own } = await t.provision(ann);
      await t.provision(bob);
      const shared = await t.createTenant(bob, { name: "Shared" });
      await t.addMember(bob, shared.id, { email: "ann@example.com" });
      await t.switchTenant(ann, shared.id);
      await t.removeMember(bob, shared.id, "ann");

      const session = await t.session(ann);
      expect(session.tenantId).toBe(own!.id);
      expect((await store.getUser("ann"))?.activeTenantId).toBe(own!.id);
    });

    it("is for no tenant when the user has none", async () => {
      const t = make({ personal: false });
      const session = await t.session(ann);
      expect(session.tenantId).toBeUndefined();
      expect(session.role).toBeUndefined();
      expect(session.permissions).toEqual(new Set());
    });

    it("picks up a tenant the user was added to", async () => {
      const t = make({ personal: false });
      await t.provision(ann);
      await t.provision(bob);
      const tenant = await t.createTenant(bob, { name: "Team" });
      await t.addMember(bob, tenant.id, { userId: "ann", role: "admin" });

      const session = await t.session(ann);
      expect(session.tenantId).toBe(tenant.id);
      expect(session.role).toBe("admin");
      expect(session.permissions).toEqual(new Set(DEFAULT_ROLES.admin));
    });

    it("keeps the email in step with the user pool", async () => {
      const t = make();
      await t.provision(ann);
      await t.session({ ...ann, email: "ann@new.example.com" });
      expect((await store.getUser("ann"))?.email).toBe("ann@new.example.com");
    });

    it("lets a platform admin stay in a tenant they're not a member of", async () => {
      const t = make();
      await t.provision(ann);
      const { tenant } = await t.provision(bob);
      await store.updateUser("ann", { platformAdmin: true });
      await t.switchTenant(ann, tenant!.id);

      const session = await t.session(ann);
      expect(session.tenantId).toBe(tenant!.id);
      expect(session.role).toBe("owner");
    });
  });

  describe("tenants", () => {
    it("are created with the creator as owner", async () => {
      const t = make();
      await t.provision(ann);
      const tenant = await t.createTenant(ann, { name: "  Acme  " });

      expect(tenant).toMatchObject({ name: "Acme", role: "owner" });
      expect(events).toContain("tenantCreated Acme");
      const mine = await t.tenantsOf(ann);
      expect(mine.map((t) => t.name).sort()).toEqual([
        "Acme",
        "Ann's workspace",
      ]);
    });

    it("can only be created by platform admins when self-serve is off", async () => {
      const t = make({ selfServe: false });
      await fails(t.createTenant(ann, { name: "Acme" }), 403);
      await store.updateUser("ann", { platformAdmin: true });
      await expect(t.createTenant(ann, { name: "Acme" })).resolves.toBeTruthy();
    });

    it("need a name", async () => {
      const t = make();
      await fails(t.createTenant(ann, {}), 400);
      await fails(t.createTenant(ann, { name: "x".repeat(101) }), 400);
    });

    it("are the active one when the user had none", async () => {
      const t = make({ personal: false });
      const tenant = await t.createTenant(ann, { name: "Acme" });
      expect((await store.getUser("ann"))?.activeTenantId).toBe(tenant.id);
    });

    it("can't be seen by someone who isn't a member", async () => {
      const t = make();
      const { tenant } = await t.provision(ann);
      await fails(t.getTenant(bob, tenant!.id), 404, "no_tenant");
      await fails(t.switchTenant(bob, tenant!.id), 404, "no_tenant");
    });

    it("are updated by roles with tenant:update", async () => {
      const t = make();
      await t.provision(bob);
      const tenant = await t.createTenant(ann, { name: "Acme" });
      await t.addMember(ann, tenant.id, { userId: "bob" });
      await fails(t.updateTenant(bob, tenant.id, { name: "Bob's" }), 403);
      expect(
        (await t.updateTenant(ann, tenant.id, { name: "Acme Inc" })).name,
      ).toBe("Acme Inc");
    });

    it("are deleted with their members, but not a personal one", async () => {
      const t = make();
      const { tenant: own } = await t.provision(ann);
      await t.provision(bob);
      const tenant = await t.createTenant(ann, { name: "Acme" });
      await t.addMember(ann, tenant.id, { userId: "bob" });

      await fails(t.deleteTenant(bob, tenant.id), 403);
      await t.deleteTenant(ann, tenant.id);
      expect(await store.getTenant(tenant.id)).toBeUndefined();
      expect(await store.listMembers(tenant.id)).toEqual([]);
      expect(events).toContain("tenantDeleted Acme");

      await fails(t.deleteTenant(ann, own!.id), 409, "personal_tenant");
    });
  });

  describe("members", () => {
    async function team() {
      const t = make();
      for (const user of [ann, bob, cat]) await t.provision(user);
      const tenant = await t.createTenant(ann, { name: "Team" });
      return { t, tenantId: tenant.id };
    }

    it("are added by email, with the default role", async () => {
      const { t, tenantId } = await team();
      const member = await t.addMember(ann, tenantId, {
        email: "BOB@example.com",
      });

      expect(member).toMatchObject({
        userId: "bob",
        role: "member",
        email: "bob@example.com",
      });
      expect(events).toContain("memberAdded bob member");
      const members = await t.members(bob, tenantId);
      expect(members.map((m) => `${m.userId} ${m.role}`).sort()).toEqual([
        "ann owner",
        "bob member",
      ]);
    });

    it("can't be someone who hasn't signed up", async () => {
      const { t, tenantId } = await team();
      await fails(
        t.addMember(ann, tenantId, { email: "nobody@example.com" }),
        404,
        "no_user",
      );
    });

    it("can't be added twice", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob" });
      await fails(
        t.addMember(ann, tenantId, { userId: "bob" }),
        409,
        "member_exists",
      );
    });

    it("can't be given a role that isn't one", async () => {
      const { t, tenantId } = await team();
      await fails(
        t.addMember(ann, tenantId, { userId: "bob", role: "boss" }),
        400,
      );
    });

    it("can only be given roles the one adding them has every permission of", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob", role: "admin" });

      await fails(
        t.addMember(bob, tenantId, { userId: "cat", role: "owner" }),
        403,
      );
      await expect(
        t.addMember(bob, tenantId, { userId: "cat", role: "admin" }),
      ).resolves.toBeTruthy();
    });

    it("can't be changed or removed by someone with fewer permissions", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob", role: "admin" });

      await fails(t.changeRole(bob, tenantId, "ann", { role: "member" }), 403);
      await fails(t.removeMember(bob, tenantId, "ann"), 403);
    });

    it("have their role changed", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob" });
      const changed = await t.changeRole(ann, tenantId, "bob", {
        role: "admin",
      });

      expect(changed.role).toBe("admin");
      expect(events).toContain("memberChanged member admin");
    });

    it("always leave an owner", async () => {
      const { t, tenantId } = await team();
      await fails(
        t.changeRole(ann, tenantId, "ann", { role: "admin" }),
        409,
        "last_owner",
      );
      await fails(t.removeMember(ann, tenantId, "ann"), 409, "last_owner");

      await t.addMember(ann, tenantId, { userId: "bob", role: "owner" });
      await t.removeMember(ann, tenantId, "ann");
      expect(await store.getMembership(tenantId, "ann")).toBeUndefined();
    });

    it("can leave without members:write", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob" });
      await fails(t.removeMember(bob, tenantId, "cat"), 403);
      await t.removeMember(bob, tenantId, "bob");
      expect(events).toContain("memberRemoved bob");
    });

    it("are managed in any tenant by a platform admin", async () => {
      const { t, tenantId } = await team();
      await store.updateUser("cat", { platformAdmin: true });
      await t.addMember(cat, tenantId, { userId: "bob", role: "owner" });
      await t.changeRole(cat, tenantId, "ann", { role: "member" });
      expect(
        (await t.members(cat, tenantId)).map((m) => m.role).sort(),
      ).toEqual(["member", "owner"]);
    });
  });

  describe("custom roles", () => {
    const roles = {
      boss: ["*"],
      editor: ["tenant:read", "members:read", "projects:write"],
      viewer: ["tenant:read"],
    };

    it("are what the checks use", async () => {
      const t = make({ roles, ownerRole: "boss", defaultRole: "viewer" });
      await t.provision(bob);
      const tenant = await t.createTenant(ann, { name: "Studio" });
      expect(tenant.role).toBe("boss");

      const member = await t.addMember(ann, tenant.id, { userId: "bob" });
      expect(member.role).toBe("viewer");
      await fails(t.members(bob, tenant.id), 403);

      await t.changeRole(ann, tenant.id, "bob", { role: "editor" });
      const access = await t.authorize(bob, tenant.id, "projects:write");
      expect(access.role).toBe("editor");
      await fails(t.authorize(bob, tenant.id, "projects:delete"), 403);
    });
  });

  describe("admin", () => {
    it("is only for platform admins", async () => {
      const t = make();
      await t.provision(ann);
      await fails(t.admin.users(ann), 403);
      await store.updateUser("ann", { platformAdmin: true });
      expect((await t.admin.users(ann)).items.map((u) => u.id)).toEqual([
        "ann",
      ]);
    });

    it("sets and clears the platform admin flag and metadata", async () => {
      const t = make();
      await t.provision(ann);
      await t.provision(bob);
      await store.updateUser("ann", { platformAdmin: true });

      const made = await t.admin.updateUser(ann, "bob", {
        platformAdmin: true,
        metadata: { plan: "pro" },
      });
      expect(made).toMatchObject({
        platformAdmin: true,
        metadata: { plan: "pro" },
      });
      const cleared = await t.admin.updateUser(ann, "bob", {
        platformAdmin: false,
      });
      expect(cleared.platformAdmin).toBeUndefined();
      await fails(
        t.admin.updateUser(ann, "bob", { platformAdmin: "yes" }),
        400,
      );
      await fails(t.admin.updateUser(ann, "nobody", { name: "X" }), 404);
    });

    it("pages through tenants", async () => {
      const t = make();
      for (const user of [ann, bob, cat]) await t.provision(user);
      await store.updateUser("ann", { platformAdmin: true });

      const first = await t.admin.tenants(ann, { limit: 2 });
      expect(first.items).toHaveLength(2);
      const second = await t.admin.tenants(ann, {
        limit: 2,
        cursor: first.cursor,
      });
      expect(second.items).toHaveLength(1);
      expect(second.cursor).toBeUndefined();
    });

    it("deletes a personal tenant", async () => {
      const t = make();
      await t.provision(ann);
      const { tenant } = await t.provision(bob);
      await store.updateUser("ann", { platformAdmin: true });
      await t.admin.deleteTenant(ann, tenant!.id);
      expect(await store.getTenant(tenant!.id)).toBeUndefined();
    });
  });
});
