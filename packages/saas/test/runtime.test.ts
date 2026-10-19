import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG_ENV, type SaasConfig } from "../src/config";
import { authorized, saasApp, type SaasEnv } from "../src/runtime/app";
import {
  createHandlers,
  type CognitoTriggerEvent,
} from "../src/runtime/handlers";
import { route } from "../src/runtime/route";
import { memoryStore } from "../src/runtime/store/memory";
import { config } from "./helpers";

// What API Gateway sends after its JWT authorizer passed the token
const event = (claims: Record<string, string> = {}) => ({
  requestContext: { authorizer: { jwt: { claims, scopes: null } } },
});
const token = (sub: string, tenantId?: string) => ({
  sub,
  ...(tenantId ? { tenant_id: tenantId, tenant_role: "owner" } : {}),
});

const trigger = (
  triggerSource: string,
  attributes: Record<string, string>,
  version = "2",
): CognitoTriggerEvent => ({
  version,
  triggerSource,
  userPoolId: "us-west-2_abc",
  userName: attributes.sub,
  request: { userAttributes: attributes },
  response: {},
});
const ann = {
  sub: "ann",
  email: "ann@example.com",
  email_verified: "true",
  name: "Ann",
};

describe("the built-in routes", () => {
  let store: ReturnType<typeof memoryStore>;
  let app: Hono<SaasEnv>;
  const request = (
    method: string,
    path: string,
    claims: Record<string, string>,
    body?: unknown,
  ) =>
    app.request(
      path,
      {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
      },
      { event: event(claims) as any },
    );

  beforeEach(() => {
    store = memoryStore();
    app = saasApp({ store, config: config() });
  });

  it("answer who's signed in", async () => {
    const res = await request("GET", "/me", token("ann"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe("ann");
    expect(body.tenant.personal).toBe(true);
    expect(body.role).toBe("owner");
  });

  it("act on the tenant the token is for", async () => {
    const me = await (await request("GET", "/me", token("ann"))).json();
    const tenantId = me.tenant.id;

    const renamed = await request("PATCH", "/tenant", token("ann", tenantId), {
      name: "Ann & Co",
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("Ann & Co");

    const members = await request(
      "GET",
      "/tenant/members",
      token("ann", tenantId),
    );
    expect((await members.json()).map((m: any) => m.userId)).toEqual(["ann"]);
  });

  it("create a tenant and switch to it", async () => {
    const created = await request("POST", "/tenants", token("ann"), {
      name: "Acme",
    });
    expect(created.status).toBe(201);
    const tenant = await created.json();

    const switched = await request("PUT", "/me/tenant", token("ann"), {
      tenantId: tenant.id,
    });
    expect(switched.status).toBe(200);
    expect((await store.getUser("ann"))?.activeTenantId).toBe(tenant.id);
  });

  it("add, change and remove a member", async () => {
    await request("GET", "/me", token("bob"));
    const tenant = await (
      await request("POST", "/tenants", token("ann"), { name: "Acme" })
    ).json();
    const ann = token("ann", tenant.id);

    // Bob has no verified email here, so he's added by id
    const added = await request("POST", "/tenant/members", ann, {
      userId: "bob",
    });
    expect(added.status).toBe(201);
    const changed = await request("PATCH", "/tenant/members/bob", ann, {
      role: "admin",
    });
    expect((await changed.json()).role).toBe("admin");
    const removed = await request("DELETE", "/tenant/members/bob", ann);
    expect(removed.status).toBe(204);
    expect(await store.getMembership(tenant.id, "bob")).toBeUndefined();
  });

  it("invite by email, list the invitations and revoke one", async () => {
    const tenant = await (
      await request("POST", "/tenants", token("ann"), { name: "Acme" })
    ).json();
    const ann = token("ann", tenant.id);

    const sent = await request("POST", "/tenant/invitations", ann, {
      email: "dan+test@example.com",
      role: "admin",
    });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({
      email: "dan+test@example.com",
      role: "admin",
      invitedBy: "ann",
    });
    const listed = await request("GET", "/tenant/invitations", ann);
    expect((await listed.json()).map((i: any) => i.email)).toEqual([
      "dan+test@example.com",
    ]);

    // The email is in the path, encoded
    const revoked = await request(
      "DELETE",
      `/tenant/invitations/${encodeURIComponent("dan+test@example.com")}`,
      ann,
    );
    expect(revoked.status).toBe(204);
    expect(store.invitations.size).toBe(0);
  });

  it("answer with the error's status and code", async () => {
    const res = await request("POST", "/tenants", token("ann"), { name: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "bad_request", message: `"name" has to be a string.` },
    });
  });

  it("need a token", async () => {
    const res = await app.request("/me", {}, { event: event() as any });
    expect(res.status).toBe(401);
  });

  it("need a tenant in the token for /tenant", async () => {
    const res = await request("GET", "/tenant", token("ann"));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("no_active_tenant");
  });

  it("turn away invalid JSON", async () => {
    const res = await app.request(
      "/tenants",
      { method: "POST", body: "{" },
      { event: event(token("ann")) as any },
    );
    expect(res.status).toBe(400);
  });

  it("are left out when they're turned off", async () => {
    app = saasApp({
      store,
      config: config({ disabled: ["DELETE /tenant"] }),
      disabled: ["GET /tenants"],
    });
    expect((await request("DELETE", "/tenant", token("ann", "t"))).status).toBe(
      404,
    );
    expect((await request("GET", "/tenants", token("ann"))).status).toBe(404);
    expect((await request("GET", "/me", token("ann"))).status).toBe(200);
  });

  it("are only for platform admins under /admin", async () => {
    await request("GET", "/me", token("ann"));
    expect((await request("GET", "/admin/users", token("ann"))).status).toBe(
      403,
    );
    await store.updateUser("ann", { platformAdmin: true });
    const res = await request("GET", "/admin/users?limit=10", token("ann"));
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    expect(
      (await request("GET", "/admin/users?limit=0", token("ann"))).status,
    ).toBe(400);
  });

  it("mount in an app of your own, next to its routes", async () => {
    const own = new Hono<SaasEnv>()
      .route("/saas", saasApp({ store, config: config() }))
      .get(
        "/projects",
        authorized(
          { permission: "projects:read" },
          { store, config: config() },
        ),
        (c) =>
          c.json({
            tenant: c.var.saas.auth.tenantId,
            role: c.var.saas.access?.role,
          }),
      );
    const env = (claims: Record<string, string>) => ({
      event: event(claims) as any,
    });

    const me = await (
      await own.request("/saas/me", {}, env(token("ann")))
    ).json();
    const res = await own.request(
      "/projects",
      {},
      env(token("ann", me.tenant.id)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: me.tenant.id, role: "owner" });

    // A permission the role doesn't have, under Hono's own error handler
    await request("GET", "/me", token("bob"));
    const other = await own.request(
      "/projects",
      {},
      env(token("bob", me.tenant.id)),
    );
    expect(other.status).toBe(404);
    expect((await other.json()).error.code).toBe("no_tenant");
  });
});

describe("route()", () => {
  it("answers with what the function returns, after checking the permission", async () => {
    const store = memoryStore();
    const options = { store, config: config(), permission: "tenant:read" };
    const tenants = createHandlers({ store, config: config() });
    await tenants.preTokenGeneration(
      trigger("TokenGeneration_Authentication", ann),
    );
    const tenantId = (await store.getUser("ann"))!.activeTenantId!;

    const handler = route(
      async (_event, { auth, access }) => ({
        tenant: auth.tenantId,
        role: access?.role,
      }),
      options,
    );
    const ok = await handler(event(token("ann", tenantId)) as any);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body!)).toEqual({ tenant: tenantId, role: "owner" });

    const none = await route(
      async () => undefined,
      options,
    )(event(token("ann", tenantId)) as any);
    expect(none.statusCode).toBe(204);

    const denied = await handler(event(token("ann")) as any);
    expect(denied.statusCode).toBe(409);
  });
});

describe("the triggers", () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    store = memoryStore();
  });

  it("create the user once they've confirmed", async () => {
    const { postConfirmation } = createHandlers({ store, config: config() });
    await postConfirmation(
      trigger("PostConfirmation_ConfirmForgotPassword", ann),
    );
    expect(store.users.size).toBe(0);
    const result = await postConfirmation(
      trigger("PostConfirmation_ConfirmSignUp", ann),
    );
    expect(result.triggerSource).toBe("PostConfirmation_ConfirmSignUp");
    expect((await store.getUser("ann"))?.email).toBe("ann@example.com");
    expect(store.tenants.size).toBe(1);
  });

  it("keep an email that isn't verified out", async () => {
    const { postConfirmation } = createHandlers({ store, config: config() });
    await postConfirmation(
      trigger("PostConfirmation_ConfirmSignUp", {
        ...ann,
        email_verified: "false",
      }),
    );
    expect((await store.getUser("ann"))?.email).toBeUndefined();
  });

  it("put the tenant, role and scopes in the tokens", async () => {
    const { preTokenGeneration } = createHandlers({
      store,
      config: config(),
      claims: ({ role }) => ({ plan: "pro", admin: role === "owner" }),
    });
    const result = await preTokenGeneration(
      trigger("TokenGeneration_Authentication", ann),
    );
    const tenantId = (await store.getUser("ann"))!.activeTenantId;

    const claims = {
      tenant_id: tenantId,
      tenant_role: "owner",
      plan: "pro",
      admin: true,
    };
    expect(result.response).toEqual({
      claimsAndScopeOverrideDetails: {
        idTokenGeneration: { claimsToAddOrOverride: claims },
        accessTokenGeneration: {
          claimsToAddOrOverride: claims,
          scopesToAdd: ["tenant/*"],
        },
      },
    });
  });

  it("give each permission of a role as a scope, and platform admins theirs", async () => {
    const { preTokenGeneration } = createHandlers({ store, config: config() });
    const { tenancy } = await import("../src/runtime/tenancy");
    const t = tenancy({ store, config: config() });
    await t.provision({ id: "bob" });
    const tenant = await t.createTenant({ id: "bob" }, { name: "Team" });
    await t.provision({ id: "ann", email: "ann@example.com" });
    await t.addMember({ id: "bob" }, tenant.id, {
      userId: "ann",
      role: "admin",
    });
    await t.switchTenant({ id: "ann" }, tenant.id);
    await store.updateUser("ann", { platformAdmin: true });

    const result: any = await preTokenGeneration(
      trigger("TokenGeneration_RefreshTokens", ann),
    );
    const access =
      result.response.claimsAndScopeOverrideDetails.accessTokenGeneration;
    expect(access.claimsToAddOrOverride).toEqual({
      tenant_id: tenant.id,
      tenant_role: "admin",
      platform_admin: "true",
    });
    expect(access.scopesToAdd).toEqual([
      "tenant/tenant:read",
      "tenant/tenant:update",
      "tenant/members:read",
      "tenant/members:write",
      "platform/admin",
    ]);
  });

  it("put the tenant someone was invited to in their first tokens", async () => {
    const { tenancy } = await import("../src/runtime/tenancy");
    const t = tenancy({ store, config: config() });
    await t.provision({ id: "bob" });
    const tenant = await t.createTenant({ id: "bob" }, { name: "Team" });
    await t.invite({ id: "bob" }, tenant.id, {
      email: "ann@example.com",
      role: "admin",
    });

    const { postConfirmation, preTokenGeneration } = createHandlers({
      store,
      config: config(),
    });
    await postConfirmation(trigger("PostConfirmation_ConfirmSignUp", ann));
    const result: any = await preTokenGeneration(
      trigger("TokenGeneration_Authentication", ann),
    );
    expect(
      result.response.claimsAndScopeOverrideDetails.accessTokenGeneration
        .claimsToAddOrOverride,
    ).toEqual({ tenant_id: tenant.id, tenant_role: "admin" });
  });

  it("answer version 1 of the event with text claims in the ID token", async () => {
    const { preTokenGeneration } = createHandlers({
      store,
      config: config(),
      claims: () => ({ seats: 5 }),
    });
    const result: any = await preTokenGeneration(
      trigger("TokenGeneration_Authentication", ann, "1"),
    );
    expect(
      result.response.claimsOverrideDetails.claimsToAddOrOverride,
    ).toMatchObject({
      tenant_role: "owner",
      seats: "5",
    });
  });
});

describe("the api handler", () => {
  const original = process.env[CONFIG_ENV];
  beforeEach(() => {
    if (original === undefined) delete process.env[CONFIG_ENV];
    else process.env[CONFIG_ENV] = original;
  });

  // What API Gateway sends for a request to a path, through `{method} /saas/{proxy+}`
  const gatewayEvent = (
    path: string,
    method = "GET",
    claims: Record<string, string> = { sub: "ann" },
  ) => ({
    version: "2.0",
    routeKey: `${method} /saas/{proxy+}`,
    rawPath: path,
    rawQueryString: "",
    headers: { host: "api.example.com" },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: "123456789012",
      apiId: "api",
      domainName: "api.example.com",
      domainPrefix: "api",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      requestId: "id",
      routeKey: `${method} /saas/{proxy+}`,
      stage: "$default",
      time: "",
      timeEpoch: 0,
      authorizer: { jwt: { claims, scopes: null } },
    } as any,
  });

  it("serves the routes under the component's path, from an API Gateway event", async () => {
    const store = memoryStore();
    const { api } = createHandlers({
      store,
      config: config({ path: "/saas" }),
    });
    const result = await api(gatewayEvent("/saas/me"));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).user.id).toBe("ann");

    const missing = await api(gatewayEvent("/saas/nope"));
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).error.code).toBe("not_found");
  });

  it("reads an email in the path as API Gateway sends it", async () => {
    const store = memoryStore();
    const { tenancy } = await import("../src/runtime/tenancy");
    const t = tenancy({ store, config: config() });
    const { tenant } = await t.provision({ id: "ann" });
    await t.invite({ id: "ann" }, tenant!.id, { email: "dan+x@example.com" });

    const { api } = createHandlers({
      store,
      config: config({ path: "/saas" }),
    });
    const result = await api(
      gatewayEvent("/saas/tenant/invitations/dan%2Bx%40example.com", "DELETE", {
        sub: "ann",
        tenant_id: tenant!.id,
      }),
    );
    expect(result.statusCode).toBe(204);
    expect(store.invitations.size).toBe(0);
  });

  it("says what's missing when it isn't set up", async () => {
    const { loadConfig } = await import("../src/runtime/env");
    delete process.env[CONFIG_ENV];
    expect(() => loadConfig()).toThrow(`${CONFIG_ENV} isn't set`);
  });

  it("reads its config from the environment", async () => {
    const { loadConfig } = await import("../src/runtime/env");
    const value: SaasConfig = config({ path: "/x" });
    process.env[CONFIG_ENV] = JSON.stringify(value);
    expect(loadConfig().path).toBe("/x");
  });
});
