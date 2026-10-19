import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    memberAdded: ({ membership, by, invitation }) =>
      events.push(
        `memberAdded ${membership.userId} ${membership.role}` +
          (invitation ? `, invited by ${by.id}` : ""),
      ),
    memberChanged: ({ membership, previous }) =>
      events.push(`memberChanged ${previous.role} ${membership.role}`),
    memberRemoved: ({ membership }) =>
      events.push(`memberRemoved ${membership.userId}`),
    tenantDeleted: ({ tenant }) => events.push(`tenantDeleted ${tenant.name}`),
    invitationCreated: ({ invitation }) =>
      events.push(`invitationCreated ${invitation.email}`),
    invitationRevoked: ({ invitation }) =>
      events.push(`invitationRevoked ${invitation.email}`),
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
      expect((await store.listMembers(tenant.id)).items).toEqual([]);
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
      expect(members.items.map((m) => `${m.userId} ${m.role}`)).toEqual([
        "ann owner",
        "bob member",
      ]);
    });

    it("are listed a page at a time, in the order of their ids", async () => {
      const { t, tenantId } = await team();
      for (const userId of ["bob", "cat"])
        await t.addMember(ann, tenantId, { userId });

      const first = await t.members(ann, tenantId, { limit: 2 });
      expect(first.items.map((m) => m.userId)).toEqual(["ann", "bob"]);
      expect(first.items[1]).toMatchObject({ email: "bob@example.com" });
      const second = await t.members(ann, tenantId, {
        limit: 2,
        cursor: first.cursor,
      });
      expect(second.items.map((m) => m.userId)).toEqual(["cat"]);
      expect(second.cursor).toBeUndefined();
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
        (await t.members(cat, tenantId)).items.map((m) => m.role).sort(),
      ).toEqual(["member", "owner"]);
    });
  });

  describe("invitations", () => {
    const dan = { id: "dan", email: "dan@example.com", name: "Dan" };

    async function team(patch?: Partial<SaasConfig>) {
      const t = make(patch);
      for (const user of [ann, bob]) await t.provision(user);
      const tenant = await t.createTenant(ann, { name: "Team" });
      events = [];
      return { t, tenantId: tenant.id };
    }
    // Time moves on, for `Date` only
    const later = (ms: number) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + ms);
    };
    afterEach(() => vi.useRealTimers());

    it("are sent to an email, with the default role", async () => {
      const { t, tenantId } = await team();
      const invitation = await t.invite(ann, tenantId, {
        email: " Dan@Example.com ",
      });

      expect(invitation).toMatchObject({
        tenantId,
        email: "dan@example.com",
        role: "member",
        invitedBy: "ann",
      });
      const days = (Date.parse(invitation.expiresAt) - Date.now()) / 86_400_000;
      expect(Math.round(days)).toBe(7);
      expect(events).toEqual(["invitationCreated dan@example.com"]);
      expect((await t.invitations(ann, tenantId)).map((i) => i.email)).toEqual([
        "dan@example.com",
      ]);
    });

    it("are taken up when someone signs up with the email", async () => {
      const { t, tenantId } = await team();
      await t.invite(ann, tenantId, {
        email: "dan@example.com",
        role: "admin",
      });
      const { user } = await t.provision(dan);

      expect(await store.getMembership(tenantId, "dan")).toMatchObject({
        role: "admin",
      });
      // They start in the tenant they were invited to, not their own
      expect(user.activeTenantId).toBe(tenantId);
      expect((await store.getUser("dan"))?.activeTenantId).toBe(tenantId);
      expect(store.invitations.size).toBe(0);
      expect(events).toEqual([
        "invitationCreated dan@example.com",
        "userCreated dan",
        "memberAdded dan admin, invited by ann",
      ]);
    });

    it("are taken up by someone who has signed up, at their next session", async () => {
      const { t, tenantId } = await team();
      const own = (await store.getUser("bob"))!.activeTenantId;
      const toBob = await t.invite(ann, tenantId, { email: "bob@example.com" });
      const toNobody = await t.invite(ann, tenantId, {
        email: "nobody@example.com",
      });

      // Nothing tells the one inviting that Bob has signed up
      expect(Object.keys(toBob).sort()).toEqual(Object.keys(toNobody).sort());
      expect(await store.getMembership(tenantId, "bob")).toBeUndefined();

      const session = await t.session(bob);
      expect(await store.getMembership(tenantId, "bob")).toMatchObject({
        role: "member",
      });
      // They stay in the tenant they're in
      expect(session.tenantId).toBe(own);
    });

    it("move someone whose tenant is gone to the one they've just joined", async () => {
      const { t, tenantId } = await team({ personal: false });
      // Bob is in Shared, which is then deleted
      const shared = await t.createTenant(bob, { name: "Shared" });
      await t.switchTenant(bob, shared.id);
      await t.deleteTenant(bob, shared.id);
      await t.invite(ann, tenantId, { email: "bob@example.com" });
      // The index doesn't list the membership yet
      const listed = store.listMemberships;
      store.listMemberships = async () => [];

      const session = await t.session(bob);
      store.listMemberships = listed;
      expect(session.tenantId).toBe(tenantId);
      expect(session.role).toBe("member");
      expect((await store.getUser("bob"))!.activeTenantId).toBe(tenantId);
    });

    it("are for a verified email", async () => {
      const { t, tenantId } = await team();
      await t.invite(ann, tenantId, { email: "dan@example.com" });
      // The triggers leave out an email that isn't verified
      await t.provision({ id: "dan" });
      expect(await store.getMembership(tenantId, "dan")).toBeUndefined();

      await t.session(dan);
      expect(await store.getMembership(tenantId, "dan")).toBeDefined();
    });

    it("are taken up once when both triggers run at once", async () => {
      const { t, tenantId } = await team();
      await t.invite(ann, tenantId, { email: "dan@example.com" });
      await Promise.all([t.provision(dan), t.session(dan)]);

      expect(await store.getMembership(tenantId, "dan")).toBeDefined();
      expect(events.filter((e) => e.startsWith("memberAdded"))).toHaveLength(1);
    });

    it("can't be for a member", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob" });
      await fails(
        t.invite(ann, tenantId, { email: "bob@example.com" }),
        409,
        "member_exists",
      );
    });

    it("are done with when the person is added", async () => {
      const { t, tenantId } = await team();
      await t.invite(ann, tenantId, { email: "bob@example.com" });
      await t.addMember(ann, tenantId, { userId: "bob" });
      expect(await t.invitations(ann, tenantId)).toEqual([]);
    });

    it("need an email, and a role that's one", async () => {
      const { t, tenantId } = await team();
      await fails(t.invite(ann, tenantId, {}), 400);
      await fails(t.invite(ann, tenantId, { email: "dan" }), 400);
      await fails(
        t.invite(ann, tenantId, { email: "dan@example.com", role: "boss" }),
        400,
      );
    });

    it("can only give, change or revoke roles the one inviting has every permission of", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob", role: "admin" });
      await fails(
        t.invite(bob, tenantId, { email: "dan@example.com", role: "owner" }),
        403,
      );

      await t.invite(ann, tenantId, {
        email: "dan@example.com",
        role: "owner",
      });
      await fails(
        t.invite(bob, tenantId, { email: "dan@example.com", role: "member" }),
        403,
      );
      await fails(t.revokeInvitation(bob, tenantId, "dan@example.com"), 403);
    });

    it("need members:write to send, and members:read to see", async () => {
      const { t, tenantId } = await team();
      await t.addMember(ann, tenantId, { userId: "bob" });
      await fails(t.invite(bob, tenantId, { email: "dan@example.com" }), 403);
      await expect(t.invitations(bob, tenantId)).resolves.toEqual([]);
      await t.provision(cat);
      await fails(t.invitations(cat, tenantId), 404, "no_tenant");
    });

    it("are sent again, at most once a minute", async () => {
      const { t, tenantId } = await team();
      const first = await t.invite(ann, tenantId, { email: "dan@example.com" });
      await fails(
        t.invite(ann, tenantId, { email: "dan@example.com" }),
        429,
        "too_soon",
      );

      later(61_000);
      const again = await t.invite(ann, tenantId, {
        email: "dan@example.com",
        role: "admin",
      });
      expect(again.role).toBe("admin");
      expect(again.createdAt).toBe(first.createdAt);
      expect(again.expiresAt > first.expiresAt).toBe(true);
      expect(store.invitations.size).toBe(1);
      expect(events).toEqual([
        "invitationCreated dan@example.com",
        "invitationCreated dan@example.com",
      ]);
    });

    it("expire", async () => {
      const { t, tenantId } = await team({
        invitations: { expiresIn: 3600, limit: 100 },
      });
      await t.invite(ann, tenantId, { email: "dan@example.com" });

      later(3601_000);
      expect(await t.invitations(ann, tenantId)).toEqual([]);
      await fails(
        t.revokeInvitation(ann, tenantId, "dan@example.com"),
        404,
        "no_invitation",
      );
      await t.provision(dan);
      expect(await store.getMembership(tenantId, "dan")).toBeUndefined();
      // Removed once it's found
      expect(store.invitations.size).toBe(0);
    });

    it("are sent as new when the last one expired", async () => {
      const { t, tenantId } = await team({
        invitations: { expiresIn: 3600, limit: 100 },
      });
      await t.addMember(ann, tenantId, { userId: "bob", role: "admin" });
      const first = await t.invite(ann, tenantId, {
        email: "dan@example.com",
        role: "owner",
      });

      later(3601_000);
      // An admin can't give the owner role, but that invitation is gone
      const again = await t.invite(bob, tenantId, { email: "dan@example.com" });
      expect(again.role).toBe("member");
      expect(again.createdAt).not.toBe(first.createdAt);
    });

    it("are limited for each tenant", async () => {
      const { t, tenantId } = await team({
        invitations: { expiresIn: 3600, limit: 2 },
      });
      await t.invite(ann, tenantId, { email: "a@example.com" });
      await t.invite(ann, tenantId, { email: "b@example.com" });
      await fails(
        t.invite(ann, tenantId, { email: "c@example.com" }),
        409,
        "too_many_invitations",
      );

      await t.revokeInvitation(ann, tenantId, "a@example.com");
      await expect(
        t.invite(ann, tenantId, { email: "c@example.com" }),
      ).resolves.toBeTruthy();
    });

    it("are revoked", async () => {
      const { t, tenantId } = await team();
      await t.invite(ann, tenantId, { email: "dan@example.com" });
      await t.revokeInvitation(ann, tenantId, "Dan@Example.com");

      expect(events).toContain("invitationRevoked dan@example.com");
      await t.provision(dan);
      expect(await store.getMembership(tenantId, "dan")).toBeUndefined();
    });

    it("go with their tenant", async () => {
      const { t, tenantId } = await team();
      await t.invite(ann, tenantId, { email: "dan@example.com" });
      await t.deleteTenant(ann, tenantId);
      expect(store.invitations.size).toBe(0);
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

  describe("a role that's renamed", () => {
    it("leaves its members with no permissions, and says so once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const before = make();
      const { tenant } = await before.provision(ann);

      // The owner role is renamed "boss" in the config, and redeployed
      const after = make({
        roles: { boss: ["*"], member: ["tenant:read"] },
        ownerRole: "boss",
      });
      const session = await after.session(ann);
      expect(session.role).toBe("owner");
      expect(session.permissions).toEqual(new Set());
      await fails(after.getTenant(ann, tenant!.id), 403);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(
        `Members have the role "owner", which isn't one of the roles any more (boss, member)`,
      );
      warn.mockRestore();
    });

    it("is renamed by adding the new one, moving its members, then removing it", async () => {
      await make().provision(ann);
      const tenantId = (await store.getUser("ann"))!.activeTenantId!;

      // 1. Add "boss", as the owner role, and keep "owner" for now
      const step1 = make({
        roles: { ...DEFAULT_ROLES, boss: ["*"] },
        ownerRole: "boss",
      });
      // 2. Move the owners to it: the last owner can, as "owner" isn't the owner role any more
      await step1.changeRole(ann, tenantId, "ann", { role: "boss" });
      // 3. Remove "owner"
      const step3 = make({
        roles: {
          boss: ["*"],
          admin: DEFAULT_ROLES.admin,
          member: DEFAULT_ROLES.member,
        },
        ownerRole: "boss",
      });
      expect((await step3.session(ann)).permissions).toBe("*");
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

    it("lists users in the order of their email, and finds them by its start", async () => {
      const t = make();
      for (const user of [cat, ann, bob, { id: "dan" }])
        await t.provision(user);
      await store.updateUser("ann", { platformAdmin: true });

      const all = await t.admin.users(ann);
      // One with no email is last
      expect(all.items.map((u) => u.id)).toEqual(["ann", "bob", "cat", "dan"]);
      const found = await t.admin.users(ann, { search: " BO" });
      expect(found.items.map((u) => u.email)).toEqual(["bob@example.com"]);
    });

    it("lists tenants in the order of their name, and finds them by its start", async () => {
      const t = make({ personal: false });
      await t.provision(ann);
      await store.updateUser("ann", { platformAdmin: true });
      for (const name of ["beta", "Acme", "acme labs", "Zed"])
        await t.createTenant(ann, { name });

      const all = await t.admin.tenants(ann);
      expect(all.items.map((t) => t.name)).toEqual([
        "Acme",
        "acme labs",
        "beta",
        "Zed",
      ]);
      const found = await t.admin.tenants(ann, { search: "ACME" });
      expect(found.items.map((t) => t.name)).toEqual(["Acme", "acme labs"]);
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
