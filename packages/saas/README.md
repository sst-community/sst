# @sst-community/saas

Users, tenants and roles for a SaaS app on AWS, as one SST component.

```ts title="sst.config.ts"
const { Saas } = await import("@sst-community/saas");

const saas = new Saas("App");
saas.route("GET /projects", "src/projects.list", { permission: "projects:read" });
```

That gives you:

- a **Cognito user pool**, signed in to by email, and a client for your web app;
- an **HTTP API** with a JWT authorizer for the user pool, and the built-in routes on it;
- **three DynamoDB tables**: users, tenants and memberships;
- a **post confirmation trigger** that creates each user, with a tenant of their own;
- a **pre token generation trigger** that puts the user's current tenant, their role in it and what it lets them do in their tokens.

A user signs up and gets their own tenant. They can create more, switch between them, and add the people they work with. A platform admin can see and change every user and tenant.

It needs SST version 5 (`sst@npm:@sst-community/sst@^5.0.0-0`).

---

## How it works

### Signing up

When someone confirms their account, the post confirmation trigger creates their user record. With `tenants.personal` on (the default), it also creates a tenant for them with the owner role and makes it their current one. The pre token generation trigger creates the record too, when it finds none, so a user that the first trigger missed still gets one.

### What's in a token

Every token the user pool issues has these claims, in both the ID token and the access token:

| Claim | What it is |
| --- | --- |
| `tenant_id` | The tenant the token is for: the user's current one. |
| `tenant_role` | The user's role in it. |
| `platform_admin` | `"true"` for a platform admin. Not there otherwise. |

The access token also has a **scope for each permission** of the role, like `tenant/members:write`, or `tenant/*` for a role with every permission, and `platform/admin` for a platform admin. The API checks these before a function runs.

Send the **access token** to the API. The ID token has the claims but not the scopes.

### Switching tenants

`PUT /me/tenant` with `{ "tenantId": "..." }` changes the user's current tenant. Then the client refreshes its tokens, and the new ones are for that tenant. The current tenant is kept on the user, so it's the same in every tab and on every device.

### Roles and permissions

A role is a list of permissions. `"*"` is every permission.

```ts
new Saas("App", {
  roles: {
    owner: ["*"],
    editor: ["tenant:read", "members:read", "projects:write"],
    viewer: ["tenant:read", "projects:read"],
  },
  ownerRole: "owner", // whoever creates a tenant gets this
  defaultRole: "viewer", // a member is added with this when no role is given
});
```

The built-in routes check five permissions: `tenant:read`, `tenant:update`, `tenant:delete`, `members:read` and `members:write`. Name any others your own routes check. The defaults are:

| Role | Permissions |
| --- | --- |
| `owner` | `*` |
| `admin` | `tenant:read`, `tenant:update`, `members:read`, `members:write` |
| `member` | `tenant:read`, `members:read` |

The rules:

- A member can give, change or take away a role only if they have every one of its permissions themselves. An admin can't make someone an owner, or remove one.
- A tenant always keeps at least one member with the owner role.
- Anyone can leave a tenant, unless they're its last owner.
- A personal tenant can't be deleted, except by a platform admin.
- A platform admin can do anything in any tenant, and switch into one they're not a member of.

**Every route checks the store, not just the token.** If a role changed after a token was issued, the function sees the change straight away. The API's scope check only sees it once the token is refreshed.

---

## The built-in routes

They're under `path`, which is the root of the API unless you set one. API Gateway sends them all to one function, which runs a [Hono](https://hono.dev) app.

| Route | Who | Body |
| --- | --- | --- |
| `GET /me` | Anyone signed in | |
| `PATCH /me` | Anyone signed in | `{ name }` |
| `PUT /me/tenant` | A member of the tenant | `{ tenantId }` |
| `GET /tenants` | Anyone signed in: their tenants, with their role in each | |
| `POST /tenants` | Anyone signed in, or only platform admins when `tenants.selfServe` is off | `{ name }` |
| `GET /tenant` | `tenant:read` | |
| `PATCH /tenant` | `tenant:update` | `{ name }` |
| `DELETE /tenant` | `tenant:delete` | |
| `GET /tenant/members` | `members:read` | |
| `POST /tenant/members` | `members:write` | `{ email }` or `{ userId }`, and `role` |
| `PATCH /tenant/members/{userId}` | `members:write` | `{ role }` |
| `DELETE /tenant/members/{userId}` | `members:write`, or the member themselves | |
| `GET /admin/users` | Platform admins | `?limit=&cursor=` |
| `PATCH /admin/users/{userId}` | Platform admins | `{ name, platformAdmin, metadata }` |
| `GET /admin/tenants` | Platform admins | `?limit=&cursor=` |
| `PATCH /admin/tenants/{tenantId}` | Platform admins | `{ name, metadata }` |
| `DELETE /admin/tenants/{tenantId}` | Platform admins | |

The `/tenant` routes act on the tenant the token is for. An error comes back as `{ "error": { "code", "message" } }`. The codes your client might match on: `no_active_tenant`, `no_tenant`, `no_user`, `no_member`, `member_exists`, `last_owner`, `personal_tenant`.

There are no invitations yet. `POST /tenant/members` adds someone who has already signed up, found by email or user id. Only a verified email is kept, so only a verified email finds anyone. It also tells the caller whether an email has signed up.

---

## Your own routes

### On the API, with `route()`

```ts title="sst.config.ts"
saas.route("POST /projects", "src/projects.create", { permission: "projects:write" });
saas.route("GET /reports", { handler: "src/reports.handler", memory: "1 GB" }, {
  platformAdmin: true,
});
```

The route is behind the same authorizer. The API turns away a token without the permission's scope. The function is linked to the tables, and told what the runtime needs.

In the function, `route()` reads the caller and checks the permission against the store:

```ts title="src/projects.ts"
import { route, badRequest } from "@sst-community/saas/runtime";

export const create = route(
  async (event, { auth, access, store }) => {
    // auth.tenantId is the tenant, access.role is the caller's role in it
    return { tenant: auth.tenantId };
  },
  { permission: "projects:write" },
);
```

Return a value to answer with it as JSON, nothing for a `204`, or a result of your own. Throw an `HttpError`, like `badRequest("...")`, to answer with it.

A route on the same method and path as a built-in one takes its place at the API. To take a built-in route out without replacing it, turn it off:

```ts
new Saas("App", { routes: { "DELETE /tenant": false } });
```

### In one Hono app with the built-in routes

The built-in routes are a Hono app, `saasApp()`, so your routes and theirs can share one function. `authorized()` checks a route of yours:

```ts title="src/api.ts"
import { Hono } from "hono";
import { handle } from "@hono/aws-lambda";
import { saasApp, authorized, type SaasEnv } from "@sst-community/saas/runtime";

const app = new Hono<SaasEnv>()
  .route("/", saasApp())
  .get("/projects", authorized({ permission: "projects:read" }), (c) =>
    c.json({ tenant: c.var.saas.auth.tenantId }),
  );

export const handler = handle(app);
```

Then point the component's API function at it, with `transform: { apiFunction: { handler: "src/api.handler" } }`. Mount `saasApp()` at the component's `path`: `"/"` here, as it has none. Every path on the API reaches this function, so your routes need no gateway routes of their own.

### Anywhere else

Link the component, and `route()`, `authorized()` and the store work in that function too:

```ts
new sst.aws.v5.Function("Worker", { handler: "src/worker.handler", link: [saas] });
```

> **Note:** don't link `saas` to a route you add with `saas.nodes.api.route()`. That function is inside the component, so it would wait for itself and never be created. Use `saas.route()`, which links the tables instead.

---

## Changing what it does

From the lightest change to the heaviest.

### Args

`roles`, `ownerRole`, `defaultRole`, `tenants.personal`, `tenants.selfServe`, `path`, `routes`, `clients`, `link`. See [Roles and permissions](#roles-and-permissions).

### `transform`, `existing` and `nodes`

Every resource is a part, so each one can be changed, swapped for one you have, or read:

```ts
const saas = new Saas("App", {
  clients: ["Web", "Mobile"],
  transform: {
    apiFunction: { memory: "512 MB" },
    users: { transform: { table: { pointInTimeRecovery: { enabled: true } } } },
    userPool: { mfa: "optional", softwareToken: true },
    client: (args, opts, name, id) => {
      if (id === "Mobile") args.callbackUrls = ["myapp://callback"];
    },
  },
});

saas.nodes.api; // the ApiGatewayV2
saas.nodes.users.nodes.table; // the aws.dynamodb.Table
```

| Part | What it is |
| --- | --- |
| `userPool` | The `CognitoUserPool` |
| `client` | A `CognitoUserPoolClient` for each name in `clients` |
| `api` | The `ApiGatewayV2` |
| `users`, `tenants`, `memberships` | The `Dynamo` tables |
| `apiFunction` | The function behind the built-in routes |
| `postConfirmation`, `preTokenGeneration` | The triggers |
| `triggerPermission` | Created only for a user pool passed in `existing` |

**An API you already have.** Pass a V5 `ApiGatewayV2` and give a `path`, so the built-in routes don't catch every path on it:

```ts
new Saas("App", { existing: { api: myApi }, path: "/saas" });
```

**A user pool you already have.** Pass its id. The component doesn't change the pool. It creates the two triggers and lets the pool invoke them, and you point the pool's triggers at `saas.nodes.postConfirmation` and `saas.nodes.preTokenGeneration` where the pool is managed. Use version 2 of the pre token generation event, on the Essentials or Plus tier, for the access token to get the scopes. On version 1, only the ID token gets the claims.

**Tables you already have.** Pass their names, as `existing: { users: "..." }`. They need the keys and indexes described under [Storage](#storage).

### Hooks, claims and a store of your own: `handlers`

Write the three functions yourself with `createHandlers()`, and give the component the file:

```ts title="src/saas.ts"
import { createHandlers } from "@sst-community/saas/runtime";

export const { api, postConfirmation, preTokenGeneration } = createHandlers({
  hooks: {
    tenantCreated: async ({ tenant, by }) => {
      // create the Stripe customer, seed data, ...
    },
    memberAdded: async ({ membership }) => {},
  },
  // More claims for both tokens. Keep it to a read or two: Cognito gives the trigger 5 seconds.
  claims: async ({ user, tenantId, store }) => {
    const tenant = tenantId ? await store.getTenant(tenantId) : undefined;
    return { plan: String(tenant?.metadata?.plan ?? "free") };
  },
  personalTenantName: (user) => `${user.name ?? "My"} workspace`,
});
```

```ts title="sst.config.ts"
new Saas("App", { handlers: "src/saas.ts", link: [stripeKey] });
```

The hooks are `userCreated`, `tenantCreated`, `tenantDeleted`, `memberAdded`, `memberChanged` and `memberRemoved`. Each runs after its change is made. A hook that throws fails the request, but the change stays made. If `userCreated` throws, the sign-up fails.

`tenancy()` is the set of rules the routes use, and it's yours to call too: `tenancy({ store, config }).addMember(...)` checks exactly what the route checks.

---

## Storage

The built-in code reaches storage only through a `Store`, an interface of about twenty methods in `@sst-community/saas/runtime`. `storage: "dynamo"` (the default) creates three tables:

| Table | Key | Index |
| --- | --- | --- |
| users | `id` | `byEmail`: `email` |
| tenants | `id` | |
| memberships | `tenantId`, `userId` | `byUser`: `userId`, `tenantId` |

To keep the records somewhere else, write a `Store` for it, pass it to `createHandlers({ store })`, and set `storage: "custom"` so no tables are created. `link` the component to whatever your store needs. A Postgres store, for RDS or Aurora, is planned, so you can give the component a database you already have.

`memoryStore()` keeps everything in memory, for your tests.

User and tenant records have a `metadata` object for your own fields, like a plan. Only platform admins and your code can change it.

---

## Platform admins

A platform admin is a user with `platformAdmin: true` on their record. To make the first one, set it in the users table:

```bash
aws dynamodb update-item --table-name <users table> \
  --key '{"id":{"S":"<their user id>"}}' \
  --update-expression "SET platformAdmin = :t" \
  --expression-attribute-values '{":t":{"BOOL":true}}'
```

After that, a platform admin can make others with `PATCH /admin/users/{userId}`. The flag is in the user's next tokens.

There's no admin UI. The `/admin` routes are what one would be built on.

---

## Things to know

- **Access tokens with scopes need the Essentials tier** of Cognito, which costs more per monthly active user than Lite. The component sets it on the user pool it creates. On Lite, a version 1 trigger can only add claims to the ID token.
- **Cognito gives a trigger 5 seconds.** The pre token generation trigger does two reads for most sign-ins. A `claims` hook adds to that. In `sst dev` the triggers run on your machine, so a slow first build can make a sign-in fail. Try again once it's built.
- **A token is as it was when it was issued.** The routes check the store, but a scope check at the API uses the token. Keep access tokens short-lived if that matters.
- **Removal.** The tables and the user pool hold your data. Set the app's `removal` to `"retain"` for production stages, as with any SST app.

---

## Working on this package

It lives in the sst-community repo for now, in `packages/saas`, and uses npm with its own lockfile.

```bash
npm install
npm test        # builds, then runs vitest
npm run typecheck
```

The component is tested with `mock()` from `sst/testing`, and the runtime against `memoryStore()` and a fake DynamoDB client. `package.json` pins `google-protobuf` to `3.21.2` through `overrides`, as the SST repo does: with 3.21.4, which `@pulumi/pulumi` gets otherwise, every resource `mock()` registers fails with `c.g is not a function`.

It has three runtime dependencies: `@aws-sdk/client-dynamodb`, `hono` and `@hono/aws-lambda`. Hono has none of its own.
