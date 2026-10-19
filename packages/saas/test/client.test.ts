import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { saasClient, SaasError, type SaasClient } from "../src/client";
import { saasApp } from "../src/runtime/app";
import {
  createHandlers,
  type CognitoTriggerEvent,
} from "../src/runtime/handlers";
import { memoryStore } from "../src/runtime/store/memory";
import { config } from "./helpers";

// An unsigned JWT: the client only reads it, and the "gateway" below trusts it
const jwt = (claims: object) =>
  [{ alg: "none" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".") + ".";
const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

describe("saasClient()", () => {
  let store: ReturnType<typeof memoryStore>;
  let requests: {
    method: string;
    path: string;
    authorization?: string;
    tenant?: string;
  }[];
  let gateway: typeof fetch;
  let handlers: ReturnType<typeof createHandlers>;

  beforeEach(() => {
    store = memoryStore();
    requests = [];
    const setup = { store, config: config({ path: "/saas" }) };
    handlers = createHandlers(setup);
    const api = new Hono()
      .route("/saas", saasApp(setup))
      // A route of the app's own, at the API's root, as saas.route() puts it
      .get("/projects", (c) => c.json([{ name: "Rocket" }]));

    // What API Gateway does: turn away a request without a token, and pass
    // the token's claims and the headers, in lowercase, to the function
    gateway = async (input, init) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(
          ([name, value]) => [name.toLowerCase(), value],
        ),
      );
      const authorization = headers.authorization;
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
        authorization,
        tenant: headers["x-tenant-id"],
      });
      if (!authorization)
        return new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
        });
      const claims = decode(authorization.slice("Bearer ".length));
      return api.request(url.pathname + url.search, init, {
        event: { headers, requestContext: { authorizer: { jwt: { claims } } } },
      });
    };
  });

  // Sign in as someone: the pre token generation trigger issues each token,
  // as the user pool would, so a refresh picks up what changed
  async function signIn(sub: string) {
    let token: string | undefined;
    const issue = async () => {
      const event: CognitoTriggerEvent = {
        version: "2",
        triggerSource: "TokenGeneration_RefreshTokens",
        userPoolId: "us-west-2_abc",
        userName: sub,
        request: {
          userAttributes: {
            sub,
            email: `${sub}@example.com`,
            email_verified: "true",
            name: sub.charAt(0).toUpperCase() + sub.slice(1),
          },
        },
        response: {},
      };
      const result: any = await handlers.preTokenGeneration(event);
      const access =
        result.response.claimsAndScopeOverrideDetails.accessTokenGeneration;
      token = jwt({
        sub,
        ...access.claimsToAddOrOverride,
        scope: [
          "aws.cognito.signin.user.admin",
          ...(access.scopesToAdd ?? []),
        ].join(" "),
      });
    };
    await issue();
    // A tab: a client of its own, with the tokens every tab shares
    const tab = () =>
      saasClient({
        url: "https://api.example.com/",
        path: "/saas/",
        token: () => token,
        refresh: issue,
        fetch: gateway,
      });
    return Object.assign(tab(), { tab, signOut: () => (token = undefined) });
  }

  it("sends the access token, and refreshes it when it switches tenants", async () => {
    const ann = await signIn("ann");
    const own = (await ann.claims())!.tenantId;
    const acme = await ann.createTenant({ name: "Acme" });
    // Creating one doesn't switch to it
    expect((await ann.claims())!.tenantId).toBe(own);

    await ann.switchTenant(acme.id);
    expect((await ann.claims())!.tenantId).toBe(acme.id);
    expect(await ann.tenantId()).toBe(acme.id);
    expect((await ann.tenant()).name).toBe("Acme");
    // A tab of its own follows the token
    expect((await ann.tab().tenant()).name).toBe("Acme");
    expect(requests.find((r) => r.method === "PUT")).toMatchObject({
      path: "/saas/me/tenant",
      authorization: expect.stringMatching(/^Bearer ey/),
    });
  });

  it("reads what the token says", async () => {
    const ann = await signIn("ann");
    // The tenant, and nothing of what the role lets her do
    expect(await ann.claims()).toEqual({
      userId: "ann",
      tenantId: expect.any(String),
      platformAdmin: false,
      scopes: ["aws.cognito.signin.user.admin"],
    });
    ann.signOut();
    expect(await ann.claims()).toBeUndefined();
  });

  it("says whether the user's role has a permission, from the API", async () => {
    const ann = await signIn("ann");
    const bob = await signIn("bob");
    // An owner has every permission, ones of the app's own too
    expect(await ann.can("projects:write")).toBe(true);

    const acme = await ann.createTenant({ name: "Acme" });
    await ann.switchTenant(acme.id);
    await ann.addMember({ userId: "bob" });
    bob.useTenant(acme.id);
    expect(await bob.can("members:read")).toBe(true);
    expect(await bob.can("members:write")).toBe(false);
    const asked = requests.filter((r) => r.path === "/saas/me").length;
    await bob.can("members:read");
    // Kept, not asked again
    expect(requests.filter((r) => r.path === "/saas/me").length).toBe(asked);

    // Ann makes him an admin: his client sees it at its next refresh
    await ann.changeRole("bob", "admin");
    expect(await bob.can("members:write")).toBe(false);
    await bob.refresh();
    expect(await bob.can("members:write")).toBe(true);
  });

  it("puts each tab in a tenant of its own, without new tokens", async () => {
    const ann = await signIn("ann");
    const acme = await ann.createTenant({ name: "Acme" });
    const own = (await ann.tenant()).id;
    const tab = ann.tab();
    tab.useTenant(acme.id);

    expect((await tab.tenant()).name).toBe("Acme");
    expect(requests.at(-1)).toMatchObject({
      path: "/saas/tenant",
      tenant: acme.id,
    });
    expect(await tab.tenantId()).toBe(acme.id);
    // The first tab, and the token, are where they were
    expect((await ann.tenant()).id).toBe(own);
    expect(requests.at(-1)!.tenant).toBeUndefined();
    expect((await ann.claims())!.tenantId).toBe(own);

    // Back to the token's
    tab.useTenant(undefined);
    expect((await tab.tenant()).id).toBe(own);
  });

  it("is turned away from a tenant the user isn't in", async () => {
    const ann = await signIn("ann");
    const bob = await signIn("bob");
    bob.useTenant((await ann.claims())!.tenantId);
    await expect(bob.tenant()).rejects.toMatchObject({
      status: 404,
      code: "no_tenant",
    });
    expect(await bob.can("tenant:read")).toBe(false);
  });

  it("invites someone, who joins at their next refresh", async () => {
    const ann = await signIn("ann");
    const bob = await signIn("bob");
    const acme = await ann.createTenant({ name: "Acme" });
    await ann.switchTenant(acme.id);

    const invitation = await ann.invite({ email: "bob@example.com" });
    expect(invitation).toMatchObject({
      email: "bob@example.com",
      role: "member",
    });
    expect((await bob.tenants()).map((t) => t.name)).toEqual([
      "Bob's workspace",
    ]);

    await bob.refresh();
    expect(
      (await bob.tenants()).map((t) => `${t.name} ${t.role}`).sort(),
    ).toEqual(["Acme member", "Bob's workspace owner"]);
    expect((await ann.members()).map((m) => m.email).sort()).toEqual([
      "ann@example.com",
      "bob@example.com",
    ]);
  });

  it("revokes an invitation, with the email in the path", async () => {
    const ann = await signIn("ann");
    await ann.invite({ email: "cat+test@example.com", role: "admin" });
    expect(await ann.revokeInvitation("cat+test@example.com")).toBeUndefined();
    expect(requests.at(-1)!.path).toBe(
      "/saas/tenant/invitations/cat%2Btest%40example.com",
    );
    expect(await ann.invitations()).toEqual([]);
  });

  it("leaves the tenant it's in, and refreshes for the one it's moved to", async () => {
    const ann = await signIn("ann");
    const bob = await signIn("bob");
    const own = (await bob.claims())!.tenantId;
    const acme = await ann.createTenant({ name: "Acme" });
    await ann.switchTenant(acme.id);
    await ann.addMember({ userId: "bob" });
    await bob.switchTenant(acme.id);

    await bob.leave();
    expect((await bob.claims())!.tenantId).toBe(own);
    expect(await bob.tenantId()).toBe(own);
    expect(await store.getMembership(acme.id, "bob")).toBeUndefined();

    // From a tab that only uses the tenant, the same
    await ann.addMember({ userId: "bob" });
    const tab = bob.tab();
    tab.useTenant(acme.id);
    await tab.leave();
    expect(await tab.tenantId()).toBe(own);
    expect(await store.getMembership(acme.id, "bob")).toBeUndefined();
  });

  it("turns an error into a SaasError with its code", async () => {
    const ann = await signIn("ann");
    const error = await ann.createTenant({ name: "" }).catch((e) => e);
    expect(error).toBeInstanceOf(SaasError);
    expect(error).toMatchObject({
      status: 400,
      code: "bad_request",
      message: `"name" has to be a string.`,
    });

    // API Gateway's own answer, without a token
    ann.signOut();
    await expect(ann.me()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "Unauthorized",
    });
  });

  it("pages through the admin lists, for a platform admin", async () => {
    const ann = await signIn("ann");
    await signIn("bob");
    await expect(ann.admin.users()).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });

    await store.updateUser("ann", { platformAdmin: true });
    await ann.refresh();
    expect((await ann.claims())!.platformAdmin).toBe(true);
    const page = await ann.admin.users({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(requests.at(-1)!.path).toBe("/saas/admin/users?limit=1");
    const next = await ann.admin.users({ limit: 1, cursor: page.cursor });
    expect(next.items[0].id).not.toBe(page.items[0].id);
  });

  it("calls routes of your own on the same API, from its root", async () => {
    const ann: SaasClient = await signIn("ann");
    expect(await ann.request("GET", "projects")).toEqual([{ name: "Rocket" }]);
    expect(requests.at(-1)!.path).toBe("/projects");
  });

  it("imports nothing a browser bundle would have to carry", () => {
    const source = (file: string) =>
      readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    const imports = (text: string) =>
      [...text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)].map(
        ([, type, from]) => `${type ? "type " : ""}${from}`,
      );
    expect(imports(source("client.ts"))).toEqual([
      "./config",
      "type ./runtime/store/types",
    ]);
    expect(imports(source("config.ts"))).toEqual([]);
  });
});
