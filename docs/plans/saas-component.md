# The SaaS component: plan and status

Branch `v5-saas`, started 2026-10-18. Last updated 2026-10-18.

## Goal

One component that sets up what most SaaS apps build first: sign-up and sign-in, users, tenants (workspaces), roles in them, and platform admins. It should take one line to start with, and every piece of it should still be yours to change, down to the storage.

It's `Saas` in the package `@sst-community/saas`, in `packages/saas` until it moves to a repo of its own. The package's own guide is its [README](../../packages/saas/README.md).

## Decisions

| Date | Decision |
| --- | --- |
| 2026-10-18 | **A package component, not `sst.aws.v5.Saas`.** `aws/v5/` holds ports of 4.x components, and `v5-components.test.ts` checks each one has an original. The component ships handler code and a data model, so it needs its own versions. It's also the first real use of [goal 3](v5-goals.md#3-anyone-can-write-a-component-and-share-it-as-a-package). |
| 2026-10-18 | **It lives in `packages/saas` on a branch for now**, with npm and a lockfile of its own, like the adapters there. It builds and tests against the published `sst` package (`@sst-community/sst@5.0.0-alpha.2`), as a repo of its own would. Its type is `sst-community:saas:Saas`. |
| 2026-10-18 | **Three DynamoDB tables**, users, tenants and memberships. Everything reaches them through a `Store` interface, so another database is another `Store`. `storage: "custom"` creates no tables, for a store of the app's own. A Postgres store, for RDS or Aurora or a database the app already has, comes later. |
| 2026-10-18 | **Few runtime dependencies**: `@aws-sdk/client-dynamodb`, `hono` and `@hono/aws-lambda`. Hono has no dependencies of its own. Items are converted by hand rather than with `@aws-sdk/util-dynamodb`, and the event types are declared in the package rather than taken from `@types/aws-lambda`. `hono/aws-lambda` is deprecated and goes in Hono 5, so the adapter is `@hono/aws-lambda`, which takes Hono 4.13.9 and 5. |
| 2026-10-18 | **The built-in routes are a Hono app, in one function, behind two proxy routes**: `ANY {path}/{proxy+}`, open to anyone signed in, and `ANY {path}/admin/{proxy+}`, which needs the `platform/admin` scope. That's six resources where a gateway route for each of the 17 would be about fifty. The app can be mounted in an app of your own (`saasApp()`). A route on the same path takes a built-in one's place at the API, and `routes: { X: false }` turns one off. |
| 2026-10-18 | **Every route checks the store.** The token says who's calling and which tenant they're in, but whether they can do something is read from the memberships, so a change of role counts at once. The scopes in the access token are a first check at the API, for `/admin` and for routes added with a `permission`. |
| 2026-10-18 | **The current tenant is in the token.** The pre token generation trigger (version 2 of its event) adds `tenant_id`, `tenant_role` and `platform_admin` to both tokens, and a scope for each permission of the role to the access token. It's kept on the user (`activeTenantId`), so `PUT /me/tenant` and a token refresh switch it. |
| 2026-10-18 | **Roles are lists of permissions**, configurable, with `"*"` for every permission. `ownerRole` is what a tenant's creator gets, and a tenant always keeps one. `defaultRole` is what a member is added with. A member can only give, change or remove a role whose permissions they all have. |
| 2026-10-18 | **A platform admin is a flag on the user record**, not a Cognito group, so it goes wherever the store goes. |
| 2026-10-18 | **No invitations yet.** A member is added by email or user id, once they've signed up. Only a verified email is kept. |
| 2026-10-18 | **No admin UI in the component.** It would bring a frontend framework and a build, which the dependency rule is there to avoid; a site to host it on, and the sites aren't ported to v5 yet; and a sign-in flow of its own. It's also what people would most want to change. The `/admin` routes are what one would be built on, as a package of its own or an example. |
| 2026-10-18 | **Changing it, from light to heavy:** args; `transform`, `existing` and `nodes` on every part; a `handlers` file made with `createHandlers()` (hooks, claims of your own, a store of your own); `routes` turned off or replaced; `link` for the functions. |
| 2026-10-18 | **The user pool signs in by email, on the Essentials tier.** Claims and scopes in the access token need Essentials or Plus. |

## Status

**Done (2026-10-18), not committed:** the component, the runtime, the shipped handlers, the README, and 75 tests: 32 of the tenancy rules on the in-memory store, 20 of the Hono app, `route()` and the triggers, 15 of the component under `mock()`, and 8 of the DynamoDB store against a fake client. `tsc` is clean, and the shipped handlers bundle with esbuild (565 KB minified, most of it the AWS SDK) and load.

**Fixed on `v5` on the way** (`e53329841`): a part that's a component, looked up by id, lost its parent and was looked up twice. See the [log](v5-progress.md). The package still works around it, as it builds against `5.0.0-alpha.2`.

**Not deployed yet.** Nothing here has run in AWS. See [Not verified](#not-verified).

## Design

### Parts

| Part | What it is |
| --- | --- |
| `userPool` | `v5.CognitoUserPool`, with the two triggers |
| `client` | `many(v5.CognitoUserPoolClient)`, one for each name in `clients`, `Web` by default |
| `api` | `v5.ApiGatewayV2`, with a JWT authorizer whose audiences are the clients |
| `users`, `tenants`, `memberships` | `optional(v5.Dynamo)`, not created for `"custom"` storage |
| `apiFunction`, `postConfirmation`, `preTokenGeneration` | `v5.Function` |
| `triggerPermission` | `many(lambda.Permission)`, only for a user pool passed in `existing` |

The functions are linked to the tables, not to the component: a part that waits for its own component is never created. `saas.route()` does the same for routes of the app's own. A function outside the component can link it, and gets `SAAS_CONFIG` and access to the tables.

What the functions are told is one JSON value in `SAAS_CONFIG`: where the store is, the roles, the tenant settings, the path and the routes turned off.

### Records

| Record | Key | Fields |
| --- | --- | --- |
| User | `id`, the user's `sub` | `email` (verified, lowercase), `name`, `activeTenantId`, `platformAdmin`, `metadata` |
| Tenant | `id`, a UUID | `name`, `personal`, `createdBy`, `metadata` |
| Membership | `tenantId`, `userId` | `role` |

Each has `createdAt` and `updatedAt`. `metadata` is for the app's own fields, and only platform admins and the app's code change it. Creating a user with their personal tenant is one transaction, and so is creating a tenant with its owner. A user created twice, as the two triggers can do at once, is created once.

### A Postgres store

The same `Store` interface, on three tables:

```sql
create table users (id text primary key, email text, name text, active_tenant_id text,
  platform_admin boolean not null default false, metadata jsonb,
  created_at timestamptz not null, updated_at timestamptz not null);
create index users_email on users (email);
create table tenants (id text primary key, name text not null, personal boolean not null default false,
  created_by text not null, metadata jsonb, created_at timestamptz not null, updated_at timestamptz not null);
create table memberships (tenant_id text references tenants on delete cascade, user_id text references users,
  role text not null, created_at timestamptz not null, updated_at timestamptz not null,
  primary key (tenant_id, user_id));
create index memberships_user on memberships (user_id);
```

Two ways to reach it, to choose between when it's built:

- **The RDS Data API**, for Aurora: `@aws-sdk/client-rds-data`, no driver and no VPC for the functions. It only works with Aurora.
- **`pg` through RDS Proxy**: any Postgres, but the functions go in the VPC, and `pg` is one more dependency.

On the component's side it's one more value of `storage`, like `{ postgres: db }`, taking a V5 `Postgres` or `Aurora`. The tables aren't created, the database is linked, and `SAAS_CONFIG` says where it is. Creating the schema is part of the work: a migration the store runs, or a `Command` part.

## Found on the way

- **The package guide doesn't say a package's repo has to pin `google-protobuf`.** `@pulumi/pulumi` brings in 3.21.4, and with it every resource `mock()` registers fails with `c.g is not a function`. The SST repo pins 3.21.2 with `overrides`, and so does this package. [Write a Package Component](../../www/src/content/docs/docs/write-a-package-component.mdx) should say so, or `sst` should take care of it.
- **`build` is only in `app.graph()`, not in `app.resources`**, though `RecordedResource` documents it for both.
- **Hono's Lambda adapter moved** to `@hono/aws-lambda`. `hono/aws-lambda` goes in Hono 5.

## Not verified

All of it needs a deploy. In the lab account, on a stage of its own:

- That a version 2 pre token generation trigger's `scopesToAdd` reaches the access token of a sign-in with SRP, not only with the hosted UI, and that the API's scope check sees them.
- That `tenant_id`, `tenant_role` and `platform_admin` can be added to the access token.
- That API Gateway answers a CORS preflight on the proxy routes before the JWT authorizer.
- That the user pool is created on the Essentials tier, and both triggers answer within 5 seconds, in a deploy and in `sst dev`.
- That the app's build finds the shipped handlers with `createRequire()`, and bundles the package's dependencies.
- The DynamoDB store against real tables: the transactions, the conditions, and the indexes.
- A user pool and an API passed in `existing`.

## Next

1. Deploy it in the lab and check the list above.
2. Commit it on `v5-saas`.
3. Then, in some order: invitations (a pending membership by email, taken up when that email is verified, and an event for the app to send the email); the Postgres store; events on a bus as well as the hooks; a template for package repos made from this one.

## Open questions

- **The name.** `Saas` and `@sst-community/saas` are working names.
- **One current tenant for each user**, not for each tab. A tenant given with each request would need its own check, as the scopes in the token would be for another tenant.
- **Adding a member by email tells the caller whether that email has signed up.** Fine for most B2B apps. It would go with invitations.
- **The AWS SDK is bundled** into each function. Leaving `@aws-sdk/*` out of the bundle would use the runtime's copy and cut it to a tenth, at the cost of running a version the package wasn't tested with.
- **The first platform admin** is made by hand, with a command in the README. An arg naming them would be easier, and would put an email in the config.
