import { createRequire } from "node:module";
import {
  all,
  interpolate,
  Output,
  output,
  type ComponentResourceOptions,
  type Input,
} from "@pulumi/pulumi";
import { apigatewayv2, lambda } from "@pulumi/aws";
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
  DEFAULT_INVITATIONS,
  DEFAULT_MESSAGES,
  DEFAULT_ROLES,
  MESSAGES,
  PLATFORM_ADMIN_SCOPE,
  rolesProblem,
  ROUTES,
  secondsOf,
  type BuiltInMessage,
  type BuiltInRoute,
  type Duration,
  type EmailConfig,
  type InvitationConfig,
  type Roles,
  type SaasConfig,
  type StoreConfig,
} from "./config";

const PACKAGE = "@sst-community/saas";

// The methods the built-in routes answer. Not `OPTIONS`: see `route`.
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

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
  /**
   * The invitations table, keyed by `tenantId` and `email`, with an index
   * `byEmail`, and a TTL on `expires` that removes an invitation once it
   * has expired. Not created when `storage` is `"custom"`.
   */
  invitations: optional(v5.Dynamo),
  /** The function behind every built-in route. */
  apiFunction: v5.Function,
  /**
   * The API's routes to `apiFunction`, by route key: `{path}/{proxy+}` and
   * `{path}/admin/{proxy+}`, for each method but `OPTIONS`, so that API
   * Gateway answers a CORS preflight itself.
   */
  route: many(apigatewayv2.Route),
  /** What the routes send requests to: `apiFunction`. */
  integration: apigatewayv2.Integration,
  /** Lets API Gateway invoke `apiFunction`. */
  permission: lambda.Permission,
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
  /**
   * What the emails are sent from, when `email` is set: an `Email` for the
   * domain of `email.from`, verified with DNS records. The user pool sends
   * Cognito's emails from it, and the functions the app's.
   */
  email: optional(v5.Email),
  /**
   * The trigger that writes the emails Cognito sends from the same
   * templates as the app's, when `email` is set.
   */
  customMessage: optional(v5.Function),
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
   * How invitations work. A member with `members:write` invites someone by
   * email, and they join the tenant when they sign up, or sign in, with
   * that email.
   */
  invitations?: {
    /**
     * How long an invitation can be taken up for.
     * @default `"7 days"`
     */
    expiresIn?: Duration;
    /**
     * How many invitations a tenant can have waiting at once. It keeps a
     * tenant from sending a great many emails from your domain.
     * @default `100`
     */
    limit?: number;
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
   * Where users, tenants, memberships and invitations are kept. `"dynamo"`
   * creates four tables. `"custom"` creates none: pass your own store to
   * `createHandlers()` in `handlers`, and `link` what it needs.
   * @default `"dynamo"`
   */
  storage?: "dynamo" | "custom";
  /**
   * More to link to the three functions, like what your hooks use.
   */
  link?: Links;
  /**
   * Send email through Amazon SES, from your own domain.
   *
   * Cognito's emails, like the sign-up code and a password reset, are sent
   * from it, from the same templates as the app's. The app sends its own when
   * someone is invited or added to a tenant, their role changes or they're
   * removed.
   * Change what any of them says with `templates` in `createHandlers()`.
   *
   * Without it, the user pool sends Cognito's emails itself, which allows
   * only a few a day, and the app sends none.
   *
   * A new AWS account can only send to addresses it has verified, until you
   * [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
   * for Amazon SES, once in each region.
   *
   * @example
   * ```ts
   * {
   *   email: {
   *     from: "Acme <hello@acme.com>",
   *     url: "https://app.acme.com"
   *   }
   * }
   * ```
   */
  email?: {
    /**
     * Who the emails are from: an address, with a name if you like.
     * @example `"Acme <hello@acme.com>"`
     */
    from: string;
    /**
     * What Amazon SES verifies. By default it's the domain of `from`, so any
     * address on it can send, verified with DNS records. An address is
     * verified by a link SES emails to it, before the user pool can send.
     * @default The domain of `from`
     */
    sender?: string;
    /**
     * The DNS adapter for the domain's records, or `false` to add them
     * yourself.
     * @default `sst.aws.dns`
     */
    dns?: v5.EmailArgs["dns"];
    /** Where replies go. */
    replyTo?: string;
    /**
     * The app's name, in the emails' subjects and text.
     * @default The name in `from`, or the component's name
     */
    name?: string;
    /** Your app's URL, which the emails link to. */
    url?: Input<string>;
    /**
     * The URL of your logo, shown at the top of each email. Use a PNG or
     * JPEG at a public `https` URL: most email clients don't show SVG, or
     * an image that's part of the email. It's shown 40 pixels high.
     *
     * For more than a logo and a color, give `createHandlers()` a `layout`
     * of your own.
     * @example `"https://acme.com/logo.png"`
     */
    logo?: Input<string>;
    /**
     * The color of the links, as a hex color.
     * @default `"#2563eb"`
     */
    color?: string;
    /**
     * The app's own emails, each on or off.
     * @default `{ welcome: false, invitation: true, memberAdded: true, roleChanged: true, memberRemoved: true }`
     */
    messages?: { [message in BuiltInMessage]?: boolean };
  };
}

export interface SaasRouteArgs {
  /**
   * Only platform admins: the API turns away anyone else's token before the
   * function runs.
   */
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
    const invitations = invitationsOf(
      plain(args.invitations ?? {}, "invitations"),
      name,
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
            invitations: this.part("invitations", {
              fields: { tenantId: "string", email: "string" },
              primaryIndex: { hashKey: "tenantId", rangeKey: "email" },
              globalIndexes: {
                byEmail: { hashKey: "email", rangeKey: "tenantId" },
              },
              ttl: "expires",
            }),
          }
        : undefined;

    // What the functions are told
    const store: Output<StoreConfig> = tables
      ? all([
          tables.users.name,
          tables.tenants.name,
          tables.memberships.name,
          tables.invitations.name,
        ]).apply(([users, tenants, memberships, invitations]) => ({
          type: "dynamo" as const,
          tables: { users, tenants, memberships, invitations },
        }))
      : output({ type: "custom" as const });
    // Email
    const mail = this.createEmail(name, args.email);
    this.config = all([store, mail?.config]).apply(([store, email]) =>
      JSON.stringify({
        store,
        roles,
        ownerRole,
        defaultRole,
        personal: args.tenants?.personal ?? true,
        selfServe: args.tenants?.selfServe ?? true,
        path,
        disabled,
        invitations,
        email,
      } satisfies SaasConfig),
    );
    this.links = [
      ...(tables ? Object.values(tables) : []),
      ...(mail ? [mail.email] : []),
      ...(plain(args.link, "link") ?? []),
    ];

    // The functions. Each is given the tables, not this component: a part
    // that waits for its own component is never created.
    const module = handlerModule(args.handlers);
    const fn = (
      key:
        | "apiFunction"
        | "postConfirmation"
        | "preTokenGeneration"
        | "customMessage",
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
    const customMessage =
      mail &&
      fn("customMessage", "customMessage", `Writes the emails of ${name}`);

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
              ...(customMessage && { customMessage: customMessage.arn }),
            },
            transform: {
              userPool: {
                // What a V2 trigger puts in the access token needs this tier
                userPoolTier: "ESSENTIALS",
                ...(mail && { emailConfiguration: mail.userPool }),
              },
            },
          },
    );
    if (existingPool)
      for (const [trigger, fn] of [
        ["postConfirmation", postConfirmation],
        ["preTokenGeneration", preTokenGeneration],
        ...(customMessage ? [["customMessage", customMessage] as const] : []),
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
    // One route for each method, all to one integration. `ANY` would take
    // the CORS preflight too, and the authorizer would turn it away. Each
    // route checks the rest itself, against the store.
    const permission = this.part("permission", {
      action: "lambda:InvokeFunction",
      function: apiFunction.arn,
      principal: "apigateway.amazonaws.com",
      sourceArn: interpolate`${api.nodes.api.executionArn}/*`,
    });
    const integration = this.part(
      "integration",
      {
        apiId: api.nodes.api.id,
        integrationType: "AWS_PROXY",
        integrationUri: apiFunction.arn,
        payloadFormatVersion: "2.0",
      },
      { dependsOn: [permission] },
    );
    for (const [prefix, scopes] of [
      [path, undefined],
      [`${path}/admin`, [PLATFORM_ADMIN_SCOPE]],
    ] as const)
      for (const method of METHODS) {
        const routeKey = `${method} ${prefix}/{proxy+}`;
        this.part("route", routeKey, {
          apiId: api.nodes.api.id,
          routeKey,
          target: interpolate`integrations/${integration.id}`,
          authorizationType: "JWT",
          authorizerId: this.authorizerId,
          authorizationScopes: scopes && [...scopes],
        });
      }
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
   * function is linked to the tables, and uses `route()` or `authorized()`
   * from `@sst-community/saas/runtime` to read the caller and check their
   * permission against the store.
   *
   * The API only checks that the caller is signed in, or is a platform
   * admin with `platformAdmin`. Check the permission in the function: the
   * token doesn't have it.
   *
   * A route on the path of a built-in one takes its place.
   *
   * @example
   * ```ts
   * saas.route("POST /projects", "src/projects.create");
   * ```
   */
  public route(
    rawRoute: string,
    handler: RouteHandler,
    args: SaasRouteArgs = {},
  ) {
    this.nodes.api.route(rawRoute, this.withSaas(handler), {
      auth: {
        jwt: {
          authorizer: this.authorizerId,
          scopes: args.platformAdmin ? [PLATFORM_ADMIN_SCOPE] : undefined,
        },
      },
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
      this.nodes.invitations,
    ].filter((table) => table !== undefined);
    return {
      properties: {
        url: this.url,
        userPoolId: this.userPoolId,
        clientId: this.clientId,
      },
      include: [
        env({ [CONFIG_ENV]: this.config }),
        ...(this.nodes.email?.link().include ?? []),
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
  // What the emails are sent from, and what the user pool and the functions
  // are told of it
  private createEmail(name: string, args: SaasArgs["email"]) {
    if (!args) return undefined;
    plain(args, "email");
    const from = plain(args.from, "email.from");
    const address = addressOf(from, name);
    const sender =
      plain(args.sender, "email.sender") ??
      address.slice(address.indexOf("@") + 1);
    const messages = {
      ...DEFAULT_MESSAGES,
      ...plain(args.messages, "email.messages"),
    };
    const unknown = Object.keys(messages).find(
      (message) => !MESSAGES.includes(message as BuiltInMessage),
    );
    if (unknown)
      throw new Error(
        `The "${name}" Saas component has no email "${unknown}". Its emails are: ${MESSAGES.join(
          ", ",
        )}.`,
      );

    const email = this.part("email", {
      sender,
      ...(args.dns !== undefined && { dns: args.dns }),
    });
    // Cognito won't send from an identity SES hasn't verified yet
    const verification = email.nodes.verification;
    const identityArn = verification
      ? all([email.nodes.identity.arn, verification.id]).apply(([arn]) => arn)
      : email.nodes.identity.arn;
    const appName = args.name ?? displayNameOf(from) ?? name;
    const color = plain(args.color, "email.color");
    if (color !== undefined && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color))
      throw new Error(
        `The "${name}" Saas component's "email.color" has to be a hex color, like "#2563eb".`,
      );
    return {
      email,
      config: all([email.configSet, args.url, args.logo]).apply(
        ([configurationSet, url, logo]): EmailConfig => ({
          from,
          replyTo: args.replyTo,
          configurationSet,
          appName,
          url,
          logo,
          color,
          messages,
        }),
      ),
      userPool: {
        emailSendingAccount: "DEVELOPER",
        sourceArn: identityArn,
        fromEmailAddress: from,
        replyToEmailAddress: args.replyTo,
        configurationSet: email.configSet,
      },
    };
  }

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

function invitationsOf(
  args: NonNullable<SaasArgs["invitations"]>,
  name: string,
): InvitationConfig {
  const expiresIn =
    args.expiresIn === undefined
      ? DEFAULT_INVITATIONS.expiresIn
      : secondsOf(args.expiresIn);
  if (!expiresIn)
    throw new Error(
      `The "${name}" Saas component's "invitations.expiresIn" has to be a number of hours or days, like "7 days".`,
    );
  const limit = args.limit ?? DEFAULT_INVITATIONS.limit;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(
      `The "${name}" Saas component's "invitations.limit" has to be a whole number, 1 or more.`,
    );
  return { expiresIn, limit };
}

// The address in "Acme <hello@acme.com>", or "hello@acme.com" as it is
function addressOf(from: string, name: string) {
  const address = (from.match(/<([^>]+)>\s*$/)?.[1] ?? from).trim();
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(address))
    throw new Error(
      `The "${name}" Saas component's "email.from" has to be an email address, like "Acme <hello@acme.com>".`,
    );
  return address;
}

// The name in "Acme <hello@acme.com>"
function displayNameOf(from: string) {
  return from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1];
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
