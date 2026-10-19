import { createRequire } from "node:module";
import {
  all,
  interpolate,
  Output,
  output,
  type ComponentResourceOptions,
} from "@pulumi/pulumi";
import { lambda } from "@pulumi/aws";
import {
  component,
  env,
  many,
  optional,
  type ComponentArgs,
  type LinkDefinition,
} from "sst/components";
import { permission, v5 } from "sst/components/aws";
import {
  CONFIG_ENV,
  DEFAULT_ROLES,
  PLATFORM_ADMIN_SCOPE,
  permissionProblem,
  rolesProblem,
  ROUTES,
  scopesOf,
  type BuiltInRoute,
  type Roles,
  type SaasConfig,
  type StoreConfig,
} from "./config";

const PACKAGE = "@sst-community/saas";

const parts = {
  /**
   * The user pool people sign up and sign in with, by email. Its triggers are
   * the `postConfirmation` and `preTokenGeneration` functions.
   */
  userPool: v5.CognitoUserPool,
  /**
   * The user pool's clients, by name: one called `Web`, unless `clients`
   * names others. The API takes tokens from any of them.
   */
  client: many(v5.CognitoUserPoolClient),
  /** The HTTP API the built-in routes are on, with a JWT authorizer for the user pool. */
  api: v5.ApiGatewayV2,
  /** The users table, keyed by `id`, with an index `byEmail`. Not created when `storage` is `"custom"`. */
  users: optional(v5.Dynamo),
  /** The tenants table, keyed by `id`. Not created when `storage` is `"custom"`. */
  tenants: optional(v5.Dynamo),
  /**
   * The memberships table, keyed by `tenantId` and `userId`, with an index
   * `byUser`. Not created when `storage` is `"custom"`.
   */
  memberships: optional(v5.Dynamo),
  /** The function behind every built-in route. */
  apiFunction: v5.Function,
  /** The trigger that creates a user, and their own tenant, when they confirm their account. */
  postConfirmation: v5.Function,
  /**
   * The trigger that puts the user's tenant, role and permissions in their
   * tokens. It creates the user too, when the other trigger missed them.
   */
  preTokenGeneration: v5.Function,
  /**
   * The permissions that let a user pool you passed in `existing` invoke the
   * two triggers, by trigger. The user pool itself isn't changed: point its
   * triggers at the functions yourself.
   */
  triggerPermission: many(lambda.Permission),
};

// What a route's function can be: a handler, or its args
type RouteHandler = Parameters<v5.ApiGatewayV2["route"]>[1];
type Links = any[];

export interface SaasArgs extends ComponentArgs<typeof parts> {
  /**
   * The roles a member of a tenant can have, and the permissions each one
   * grants. `"*"` grants every permission.
   *
   * The built-in routes check `tenant:read`, `tenant:update`,
   * `tenant:delete`, `members:read` and `members:write`. Name any others your
   * own routes check.
   *
   * A member can only give, change or remove a role whose permissions they
   * all have themselves.
   *
   * @default `{ owner: ["*"], admin: ["tenant:read", "tenant:update", "members:read", "members:write"], member: ["tenant:read", "members:read"] }`
   * @example
   * ```ts
   * {
   *   roles: {
   *     owner: ["*"],
   *     editor: ["tenant:read", "members:read", "projects:write"],
   *     viewer: ["tenant:read", "projects:read"]
   *   },
   *   defaultRole: "viewer"
   * }
   * ```
   */
  roles?: Roles;
  /**
   * The role of whoever creates a tenant. A tenant always keeps at least one
   * member with it.
   * @default `"owner"`
   */
  ownerRole?: string;
  /**
   * The role a member is added with when none is given.
   * @default `"member"`
   */
  defaultRole?: string;
  /**
   * What users can do with tenants of their own.
   */
  tenants?: {
    /**
     * Create a tenant for each user when they sign up, with them as its
     * owner.
     * @default `true`
     */
    personal?: boolean;
    /**
     * Let any user create tenants. When it's off, only platform admins can.
     * @default `true`
     */
    selfServe?: boolean;
  };
  /**
   * Where the built-in routes go on the API, like `/saas`. They're at the
   * root of the API by default. Required with an API you pass in
   * `existing`, so they don't catch its other paths; `"/"` puts them at its
   * root.
   */
  path?: string;
  /**
   * Built-in routes to turn off. To replace one, turn it off and add your
   * own with `route()`. A route you add on the same path takes its place
   * at the API without turning it off.
   *
   * @example
   * ```ts
   * { routes: { "DELETE /tenant": false } }
   * ```
   */
  routes?: { [route in BuiltInRoute]?: false };
  /**
   * The names of the user pool's clients.
   * @default `["Web"]`
   */
  clients?: string[];
  /**
   * The file the three functions run, in place of the package's own. It
   * exports `api`, `postConfirmation` and `preTokenGeneration`, made with
   * `createHandlers()` from `@sst-community/saas/runtime`, which takes
   * hooks, claims of your own and a store of your own.
   *
   * @example
   * ```ts
   * { handlers: "src/saas.ts" }
   * ```
   */
  handlers?: string;
  /**
   * Where users, tenants and memberships are kept. `"dynamo"` creates three
   * tables. `"custom"` creates none: pass your own store to
   * `createHandlers()` in `handlers`, and `link` what it needs.
   * @default `"dynamo"`
   */
  storage?: "dynamo" | "custom";
  /**
   * More to link to the three functions, like what your hooks use.
   */
  link?: Links;
}

export interface SaasRouteArgs {
  /** A permission the caller has to have in the tenant their token is for. */
  permission?: string;
  /** Only platform admins. */
  platformAdmin?: boolean;
}

/**
 * Users, tenants and roles for a SaaS app: a Cognito user pool, an HTTP API
 * that takes its tokens, the tables they're kept in, and the routes and
 * triggers that look after them.
 *
 * A user who signs up gets a tenant of their own. Their tokens say which
 * tenant they're in, their role in it and what it lets them do. They can
 * create tenants, switch between them, and add the people they work with.
 *
 * @example
 * ```ts title="sst.config.ts"
 * const { Saas } = await import("@sst-community/saas");
 *
 * const saas = new Saas("App");
 * saas.route("GET /projects", "src/projects.list", { permission: "projects:read" });
 * ```
 */
export class Saas extends component("sst-community:saas:Saas", parts) {
  private readonly config: Output<string>;
  private readonly links: Links;
  private readonly authorizerId: Output<string>;

  constructor(
    name: string,
    args: SaasArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const roles = plain(args.roles ?? DEFAULT_ROLES, "roles");
    const ownerRole = plain(args.ownerRole ?? "owner", "ownerRole");
    const defaultRole = plain(args.defaultRole ?? "member", "defaultRole");
    const problem = rolesProblem(roles, ownerRole, defaultRole);
    if (problem) throw new Error(`The "${name}" Saas component: ${problem}`);

    const storage = plain(args.storage ?? "dynamo", "storage");
    if (storage === "custom" && !args.handlers)
      throw new Error(
        `The "${name}" Saas component has "custom" storage, so it needs "handlers" that give createHandlers() your store.`,
      );

    const existingApi = this.existingPart("api");
    const path = normalizePath(plain(args.path, "path"), name, !!existingApi);
    const disabled = Object.entries(plain(args.routes ?? {}, "routes"))
      .filter(([, value]) => value === false)
      .map(([route]) => route as BuiltInRoute);
    const unknown = disabled.find((route) => !ROUTES.includes(route));
    if (unknown)
      throw new Error(
        `The "${name}" Saas component has no route "${unknown}". Its routes are: ${ROUTES.join(
          ", ",
        )}.`,
      );

    // The tables
    const tables =
      storage === "dynamo"
        ? {
            users: this.part("users", {
              fields: { id: "string", email: "string" },
              primaryIndex: { hashKey: "id" },
              globalIndexes: { byEmail: { hashKey: "email" } },
            }),
            tenants: this.part("tenants", {
              fields: { id: "string" },
              primaryIndex: { hashKey: "id" },
            }),
            memberships: this.part("memberships", {
              fields: { tenantId: "string", userId: "string" },
              primaryIndex: { hashKey: "tenantId", rangeKey: "userId" },
              globalIndexes: {
                byUser: { hashKey: "userId", rangeKey: "tenantId" },
              },
            }),
          }
        : undefined;

    // What the functions are told
    const store: Output<StoreConfig> = tables
      ? all([
          tables.users.name,
          tables.tenants.name,
          tables.memberships.name,
        ]).apply(([users, tenants, memberships]) => ({
          type: "dynamo" as const,
          tables: { users, tenants, memberships },
        }))
      : output({ type: "custom" as const });
    this.config = store.apply((store) =>
      JSON.stringify({
        store,
        roles,
        ownerRole,
        defaultRole,
        personal: args.tenants?.personal ?? true,
        selfServe: args.tenants?.selfServe ?? true,
        path,
        disabled,
      } satisfies SaasConfig),
    );
    this.links = [
      ...(tables ? [tables.users, tables.tenants, tables.memberships] : []),
      ...(plain(args.link, "link") ?? []),
    ];

    // The functions. Each is given the tables, not this component: a part
    // that waits for its own component is never created.
    const module = handlerModule(args.handlers);
    const fn = (
      key: "apiFunction" | "postConfirmation" | "preTokenGeneration",
      exported: string,
      description: string,
    ) =>
      this.part(key, {
        handler: `${module}.${exported}`,
        description,
        link: this.links,
        environment: { [CONFIG_ENV]: this.config },
      });
    const postConfirmation = fn(
      "postConfirmation",
      "postConfirmation",
      `Creates the users of ${name}`,
    );
    const preTokenGeneration = fn(
      "preTokenGeneration",
      "preTokenGeneration",
      `Puts the tenant in the tokens of ${name}`,
    );
    const apiFunction = fn("apiFunction", "api", `The routes of ${name}`);

    // The user pool. Whether one was passed is read from the args: up to
    // SST 5.0.0-alpha.2, `existingPart()` looks a pool given by its id up a
    // second time (fixed on `v5` in e53329841).
    const existingPool = args.existing?.userPool !== undefined;
    const userPool = this.part(
      "userPool",
      existingPool
        ? {}
        : {
            usernames: ["email"],
            triggers: {
              postConfirmation: postConfirmation.arn,
              preTokenGeneration: preTokenGeneration.arn,
              preTokenGenerationVersion: "v2",
            },
            // What a V2 trigger puts in the access token needs this tier
            transform: { userPool: { userPoolTier: "ESSENTIALS" } },
          },
    );
    if (existingPool)
      for (const [trigger, fn] of [
        ["postConfirmation", postConfirmation],
        ["preTokenGeneration", preTokenGeneration],
      ] as const)
        this.part("triggerPermission", trigger, {
          action: "lambda:InvokeFunction",
          function: fn.arn,
          principal: "cognito-idp.amazonaws.com",
          sourceArn: userPool.arn,
        });

    const clientNames = plain(args.clients ?? ["Web"], "clients");
    if (clientNames.length === 0)
      throw new Error(
        `The "${name}" Saas component needs at least one client.`,
      );
    const clients = clientNames.map((client) =>
      this.part("client", client, { userPool: userPool.id }),
    );

    // The API
    const api = this.part("api", {});
    const issuer = userPool.id.apply(
      (id) => `https://cognito-idp.${id.split("_")[0]}.amazonaws.com/${id}`,
    );
    this.authorizerId = api.addAuthorizer({
      name,
      jwt: { issuer, audiences: clients.map((client) => client.id) },
    }).id;
    // Each route checks the rest itself, against the store
    api.route(`ANY ${path}/{proxy+}`, apiFunction.arn, {
      auth: { jwt: { authorizer: this.authorizerId } },
    });
    api.route(`ANY ${path}/admin/{proxy+}`, apiFunction.arn, {
      auth: {
        jwt: { authorizer: this.authorizerId, scopes: [PLATFORM_ADMIN_SCOPE] },
      },
    });
  }

  /** The URL of the API. */
  public get url() {
    return this.nodes.api.url;
  }

  /** The ID of the user pool. */
  public get userPoolId() {
    return this.nodes.userPool.id;
  }

  /** The ID of the first client. */
  public get clientId() {
    return Object.values(this.nodes.client)[0].id;
  }

  /** The ID of the API's JWT authorizer, for routes you add to the API yourself. */
  public get authorizer() {
    return this.authorizerId;
  }

  /**
   * Add a route of your own to the API, behind the same authorizer. Its
   * function is linked to the tables, and can use `route()` or
   * `authorized()` from `@sst-community/saas/runtime` to read the caller and
   * check their permissions.
   *
   * With a `permission`, the API also turns away a token whose role doesn't
   * have it, before the function runs. A permission that's changed since
   * the token was issued is only seen by the function.
   *
   * A route on the path of a built-in one takes its place.
   *
   * @example
   * ```ts
   * saas.route("POST /projects", "src/projects.create", {
   *   permission: "projects:write",
   * });
   * ```
   */
  public route(
    rawRoute: string,
    handler: RouteHandler,
    args: SaasRouteArgs = {},
  ) {
    const problem = args.permission && permissionProblem(args.permission);
    if (problem) throw new Error(`The route "${rawRoute}": ${problem}`);
    this.nodes.api.route(rawRoute, this.withSaas(handler), {
      auth: { jwt: { authorizer: this.authorizerId, scopes: scopesOf(args) } },
    });
    return this;
  }

  /**
   * Linking gives the linked function what the runtime reads, and access to
   * the tables. `Resource.<Name>` has the API's `url`, the `userPoolId` and
   * the `clientId`.
   */
  public link(): LinkDefinition {
    const tables = [
      this.nodes.users,
      this.nodes.tenants,
      this.nodes.memberships,
    ].filter((table) => table !== undefined);
    return {
      properties: {
        url: this.url,
        userPoolId: this.userPoolId,
        clientId: this.clientId,
      },
      include: [
        env({ [CONFIG_ENV]: this.config }),
        ...tables.map((table) =>
          permission({
            actions: ["dynamodb:*"],
            resources: [table.arn, interpolate`${table.arn}/*`],
          }),
        ),
      ],
    };
  }

  // A function of the user's, given what the runtime reads. Its handler or
  // args are added to as they are, so that what the function is doesn't wait
  // on a value only known on deploy.
  private withSaas(handler: RouteHandler): RouteHandler {
    if (
      Output.isInstance(handler) ||
      (typeof handler === "string" && handler.startsWith("arn:")) ||
      (typeof handler !== "string" && typeof handler !== "object")
    )
      return handler;
    const args = (
      typeof handler === "string" ? { handler } : handler
    ) as Extract<Awaited<RouteHandler>, { handler: unknown }>;
    return {
      ...args,
      link: all([this.links, args.link ?? []]).apply(([ours, theirs]) => [
        ...ours,
        ...theirs,
      ]),
      environment: all([this.config, args.environment ?? {}]).apply(
        ([config, environment]) => ({ [CONFIG_ENV]: config, ...environment }),
      ),
    };
  }
}

function plain<T>(value: T, what: string): T {
  if (Output.isInstance(value))
    throw new Error(`"${what}" has to be a plain value, not an output.`);
  return value;
}

// "" for the root, otherwise "/like/this"
function normalizePath(
  path: string | undefined,
  name: string,
  sharedApi: boolean,
) {
  if (path === undefined) {
    if (sharedApi)
      throw new Error(
        `The "${name}" Saas component is given an API in "existing", so it needs a "path" for its routes, like "/saas", or "/" for the API's root.`,
      );
    return "";
  }
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (!trimmed.startsWith("/") || /[{}\s]/.test(trimmed))
    throw new Error(
      `The "${name}" Saas component's "path" has to start with "/", like "/saas".`,
    );
  return trimmed;
}

// The file the functions run, without its extension: the user's, or the
// package's own, wherever the app installed it.
function handlerModule(handlers: string | undefined) {
  if (handlers) return handlers.replace(/\.(m|c)?(t|j)sx?$/, "");
  return createRequire(import.meta.url)
    .resolve(`${PACKAGE}/handlers`)
    .replace(/\.js$/, "");
}
