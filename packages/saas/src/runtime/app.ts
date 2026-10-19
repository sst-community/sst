import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { LambdaContext, LambdaEvent } from "@hono/aws-lambda";
import { ROUTES, type BuiltInRoute } from "../config.js";
import {
  contextOf,
  noActiveTenant,
  type Requirement,
  type SaasContext,
} from "./context.js";
import { lazySetup, type SetupArgs } from "./env.js";
import { badRequest, HttpError, type ApiEvent } from "./http.js";

/** What a Hono app behind API Gateway is given, with `@hono/aws-lambda`. */
export interface SaasBindings {
  event: LambdaEvent;
  lambdaContext?: LambdaContext;
}

export interface SaasEnv {
  Bindings: SaasBindings;
  Variables: { saas: SaasContext };
}

export interface SaasAppOptions extends SetupArgs {
  /** Built-in routes to leave out, on top of the ones the component turned off. */
  disabled?: BuiltInRoute[];
}

/**
 * The built-in routes as a Hono app. Mount it in your own to serve both
 * from one function:
 *
 * ```ts
 * const app = new Hono().route("/", saasApp()).get("/projects", ...);
 * export const handler = handle(app);
 * ```
 *
 * Each route reads the caller from the token API Gateway checked, and
 * checks what they can do against the store.
 */
export function saasApp(options: SaasAppOptions = {}) {
  const setup = lazySetup(options);
  const app = new Hono<SaasEnv>();
  app.onError(onError);

  const routes: Record<
    BuiltInRoute,
    (c: Context<SaasEnv>) => Promise<Response>
  > = {
    "GET /me": async (c) =>
      c.json(await rules(c).me(who(c), c.var.saas.auth.tenantId)),
    "PATCH /me": async (c) =>
      c.json(await rules(c).updateMe(who(c), await body(c))),
    "PUT /me/tenant": async (c) =>
      c.json(await rules(c).switchTenant(who(c), (await body(c)).tenantId)),
    "GET /tenants": async (c) => c.json(await rules(c).tenantsOf(who(c))),
    "POST /tenants": async (c) =>
      c.json(await rules(c).createTenant(who(c), await body(c)), 201),

    "GET /tenant": async (c) =>
      c.json(await rules(c).getTenant(who(c), tenantOf(c))),
    "PATCH /tenant": async (c) =>
      c.json(await rules(c).updateTenant(who(c), tenantOf(c), await body(c))),
    "DELETE /tenant": async (c) => {
      await rules(c).deleteTenant(who(c), tenantOf(c));
      return c.body(null, 204);
    },

    "GET /tenant/members": async (c) =>
      c.json(await rules(c).members(who(c), tenantOf(c), page(c))),
    "POST /tenant/members": async (c) =>
      c.json(await rules(c).addMember(who(c), tenantOf(c), await body(c)), 201),
    "PATCH /tenant/members/{userId}": async (c) =>
      c.json(
        await rules(c).changeRole(
          who(c),
          tenantOf(c),
          param(c, "userId"),
          await body(c),
        ),
      ),
    "DELETE /tenant/members/{userId}": async (c) => {
      await rules(c).removeMember(who(c), tenantOf(c), param(c, "userId"));
      return c.body(null, 204);
    },

    "GET /tenant/invitations": async (c) =>
      c.json(await rules(c).invitations(who(c), tenantOf(c))),
    "POST /tenant/invitations": async (c) =>
      c.json(await rules(c).invite(who(c), tenantOf(c), await body(c)), 201),
    "DELETE /tenant/invitations/{email}": async (c) => {
      await rules(c).revokeInvitation(who(c), tenantOf(c), param(c, "email"));
      return c.body(null, 204);
    },

    "GET /admin/users": async (c) =>
      c.json(await rules(c).admin.users(who(c), page(c))),
    "PATCH /admin/users/{userId}": async (c) =>
      c.json(
        await rules(c).admin.updateUser(
          who(c),
          param(c, "userId"),
          await body(c),
        ),
      ),
    "GET /admin/tenants": async (c) =>
      c.json(await rules(c).admin.tenants(who(c), page(c))),
    "PATCH /admin/tenants/{tenantId}": async (c) =>
      c.json(
        await rules(c).admin.updateTenant(
          who(c),
          param(c, "tenantId"),
          await body(c),
        ),
      ),
    "DELETE /admin/tenants/{tenantId}": async (c) => {
      await rules(c).admin.deleteTenant(who(c), param(c, "tenantId"));
      return c.body(null, 204);
    },
  };

  for (const route of ROUTES) {
    const [method, path] = route.split(" ");
    app.on(
      method,
      path.replace(/\{(\w+)\}/g, ":$1"),
      async (c, next) => {
        const { config } = setup();
        if (
          config.disabled.includes(route) ||
          options.disabled?.includes(route)
        )
          return c.json(
            { error: { code: "not_found", message: "There's no such route." } },
            404,
          );
        c.set("saas", await contextOf(c.env?.event as ApiEvent, setup));
        await next();
      },
      routes[route],
    );
  }

  return app;
}

/**
 * Middleware for a route of your own: it reads the caller from their token,
 * checks what the route asks for against the store, and puts what it found
 * in `c.var.saas`.
 *
 * ```ts
 * app.post("/projects", authorized({ permission: "projects:write" }), (c) => {
 *   const { tenantId } = c.var.saas.auth;
 * });
 * ```
 */
export function authorized(
  requirement: Requirement = {},
  options: SetupArgs = {},
): MiddlewareHandler<SaasEnv> {
  const setup = lazySetup(options);
  return async (c, next) => {
    c.set(
      "saas",
      await contextOf(c.env?.event as ApiEvent, setup, requirement),
    );
    await next();
  };
}

function onError(error: Error, c: Context) {
  if (error instanceof HttpError) return error.getResponse();
  console.error(error);
  return c.json(
    { error: { code: "internal", message: "Something went wrong." } },
    500,
  );
}

const rules = (c: Context<SaasEnv>) => c.var.saas.tenancy;
const who = (c: Context<SaasEnv>) => c.var.saas.identity;

function tenantOf(c: Context<SaasEnv>) {
  const tenantId = c.var.saas.auth.tenantId;
  if (!tenantId) throw noActiveTenant();
  return tenantId;
}

function param(c: Context<SaasEnv>, name: string) {
  const value = c.req.param(name);
  if (!value) throw badRequest(`The path needs a "${name}".`);
  return value;
}

async function body(c: Context<SaasEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest("The body isn't valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw badRequest("The body has to be a JSON object.");
  return value as Record<string, unknown>;
}

function page(c: Context<SaasEnv>) {
  const limit = c.req.query("limit");
  const parsed = limit === undefined ? undefined : Number(limit);
  if (
    parsed !== undefined &&
    (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
  )
    throw badRequest(`"limit" has to be a whole number from 1 to 100.`);
  return {
    cursor: c.req.query("cursor") || undefined,
    limit: parsed,
    search: c.req.query("search") || undefined,
  };
}
