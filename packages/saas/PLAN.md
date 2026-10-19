# The SaaS component: plan and status

Branch `v5-saas`, started 2026-10-18. Last updated 2026-10-18.

## Goal

One component that sets up what most SaaS apps build first: sign-up and sign-in, users, tenants (workspaces), roles in them, and platform admins. It should take one line to start with, and every piece of it should still be yours to change, down to the storage.

It's `Saas` in the package `@sst-community/saas`, in `packages/saas` until it moves to a repo of its own. The package's own guide is its [README](README.md).

## Decisions

| Date | Decision |
| --- | --- |
| 2026-10-18 | **A package component, not `sst.aws.v5.Saas`.** `aws/v5/` holds ports of 4.x components, and `v5-components.test.ts` checks each one has an original. The component ships handler code and a data model, so it needs its own versions. It's also the first real use of [goal 3](https://github.com/sst-community/sst/blob/v5/docs/plans/v5-goals.md#3-anyone-can-write-a-component-and-share-it-as-a-package). |
| 2026-10-18 | **It lives in `packages/saas` on a branch for now**, with npm and a lockfile of its own, like the adapters there. It builds and tests against the published `sst` package (`@sst-community/sst@5.0.0-alpha.2`), as a repo of its own would. Its type is `sst-community:saas:Saas`. |
| 2026-10-18 | **Three DynamoDB tables**, users, tenants and memberships. Everything reaches them through a `Store` interface, so another database is another `Store`. `storage: "custom"` creates no tables, for a store of the app's own. A Postgres store, for RDS or Aurora or a database the app already has, comes later. |
| 2026-10-18 | **Few runtime dependencies**: `@aws-sdk/client-dynamodb`, `hono` and `@hono/aws-lambda`. Hono has no dependencies of its own. Items are converted by hand rather than with `@aws-sdk/util-dynamodb`, and the event types are declared in the package rather than taken from `@types/aws-lambda`. `hono/aws-lambda` is deprecated and goes in Hono 5, so the adapter is `@hono/aws-lambda`, which takes Hono 4.13.9 and 5. |
| 2026-10-18 | **The built-in routes are a Hono app, in one function, behind proxy routes**: `{path}/{proxy+}`, open to anyone signed in, and `{path}/admin/{proxy+}`, which needs the `platform/admin` scope. The app can be mounted in an app of your own (`saasApp()`). A route on the same path takes a built-in one's place at the API, and `routes: { X: false }` turns one off. |
| 2026-10-18 | **A proxy route for each method, not `ANY`**, changed the same day after the first deploy. An `ANY` route matches a CORS preflight too, so the JWT authorizer turned it away with a 401, and a browser can't call the API from another origin. With a route for GET, POST, PUT, PATCH and DELETE, nothing matches `OPTIONS`, and API Gateway answers the preflight itself without calling the function. The component creates the ten routes itself, all to one integration with one invoke permission: twelve resources, where a gateway route for each of the 17 built-in routes would be about fifty. AWS suggests an `OPTIONS /{proxy+}` route without authorization instead, which would send each preflight to the function. |
| 2026-10-18 | **Every route checks the store.** The token says who's calling and which tenant they're in, but whether they can do something is read from the memberships, so a change of role counts at once. The scopes in the access token are a first check at the API, for `/admin` and for routes added with a `permission`. |
| 2026-10-18 | **The current tenant is in the token.** The pre token generation trigger (version 2 of its event) adds `tenant_id`, `tenant_role` and `platform_admin` to both tokens, and a scope for each permission of the role to the access token. It's kept on the user (`activeTenantId`), so `PUT /me/tenant` and a token refresh switch it. |
| 2026-10-18 | **Roles are lists of permissions**, configurable, with `"*"` for every permission. `ownerRole` is what a tenant's creator gets, and a tenant always keeps one. `defaultRole` is what a member is added with. A member can only give, change or remove a role whose permissions they all have. |
| 2026-10-18 | **A platform admin is a flag on the user record**, not a Cognito group, so it goes wherever the store goes. |
| 2026-10-18 | **No invitations yet.** A member is added by email or user id, once they've signed up. Only a verified email is kept. |
| 2026-10-18 | **No admin UI in the component.** It would bring a frontend framework and a build, which the dependency rule is there to avoid; a site to host it on, and the sites aren't ported to v5 yet; and a sign-in flow of its own. It's also what people would most want to change. The `/admin` routes are what one would be built on, as a package of its own or an example. |
| 2026-10-18 | **Changing it, from light to heavy:** args; `transform`, `existing` and `nodes` on every part; a `handlers` file made with `createHandlers()` (hooks, claims of your own, a store of your own); `routes` turned off or replaced; `link` for the functions. |
| 2026-10-18 | **The user pool signs in by email, on the Essentials tier.** Claims and scopes in the access token need Essentials or Plus. |
| 2026-10-18 | **Email is a foundation, not part of invitations.** Cognito's own sender allows too few emails a day for production, and email MFA and sign-in codes need SES. So `email` sends everything through SES: Cognito's emails, from a custom message trigger, and the app's. |
| 2026-10-18 | **SES by default, with a sender you can replace.** `createHandlers({ email: { send } })` sends the app's emails with another provider. Cognito's always go through SES. |
| 2026-10-18 | **`Email` was ported to V5 first**, so the component takes it as a part, with `transform` and `existing` like any other. It went on `v5` as its own commit (`6328b507d`). |
| 2026-10-18 | **One set of templates for Cognito's emails and the app's**: plain functions that return `{ subject, html, text }`, with no templating library. Built in: `memberAdded`, `roleChanged` and `memberRemoved` on, `welcome` off. A send that fails is logged, and never fails the change it's about. |
| 2026-10-18 | **Invitations are records of their own, in a fourth table**, keyed by `tenantId` and `email`, with an index `byEmail` and a TTL. This goes past the three tables decided at the start, in the same way: a table for each kind of record. Keeping them in the memberships table would have meant a membership whose `userId` is an email, which the Postgres store couldn't hold with a foreign key to users. A tenant's invitations go with it when it's deleted. |
| 2026-10-18 | **An invitation is taken up when the user pool issues tokens to that email, verified**: on sign-up, through the post confirmation trigger, and at every sign-in and refresh, through the pre token generation trigger. That's the same for someone who has signed up already, so the answer to `POST /tenant/invitations` never says whether an email has an account. It costs one query of the index at each token. There's no accepting or declining: signing in is the acceptance, as being added already was. The client can refresh its tokens to join at once. |
| 2026-10-18 | **Taking one up is a transaction**: delete the invitation if it's there, and put the membership if there's none. The two triggers can both try, and the member is added, and told, once. |
| 2026-10-18 | **Someone who signs up through an invitation starts in that tenant**, the most recent one if there are several, even with a personal tenant. Someone who had signed up already stays where they are. |
| 2026-10-18 | **What's in the package, and what the app brings**, asked for by the user: everything packaged is ours to maintain, so it shouldn't be opinionated. The rule: the package does what needs its own data or its own wiring (the user pool and triggers, the records and their rules, invitations, sending email, and finding who to email in a tenant). A decision about the product is left to the app, with a place to plug it in: hooks, `handlers`, `templates`, `layout`, `send`, `store`, `routes`, `transform`. Each thing it ships has one way to replace it, and it doesn't grow a setting where replacing will do. See [What's in the package](#whats-in-the-package). |
| 2026-10-18 | **Branding is a logo and a link color, and the rest is a `layout`.** Those two are what every app changes. A footer, fonts, legal text or dark mode would each be a setting to keep working in every email client, so they're a layout of the app's own, one function that every email goes through, Cognito's too. Templates are given the layout, so one the app replaces still matches. The logo is a URL the app hosts: the component doesn't upload or serve images. |
| 2026-10-18 | **`notify()` finds the people and sends, and nothing more**: users by id, or a tenant's members whose role has a permission, at their verified email, one at a time, reporting who was sent, skipped and failed. What to notify about, preferences, unsubscribing, digests and queues are the app's. |
| 2026-10-18 | **The package is the control plane**, in the terms of AWS's SaaS Lens and SaaS Builder Toolkit: the shared services that run the app as a business (identity, onboarding, tenants, users and roles, invitations, platform admin, the system's emails). The application plane, the product and its data and how that's kept apart by tenant, is the app's. What the package gives the application plane is the tenant context of a request: the tenant in the token, `route()` and `authorized()`, the check against the store. This is the scope rule above, said another way. |
| 2026-10-18 | **The token says who and where; the store says what they can do.** Changed the same day, with the user, from the decision above that put the role and a scope for each permission in the token. Those were out of date for as long as a token lasts, an hour by default; they grew with the roles; and the functions checked the store anyway, so nothing could trust them. Now the trigger adds only `tenant_id`, the user's current tenant from their record, and `platform_admin`, with the `platform/admin` scope for `/admin` at the API. `tenant_id` stays for whatever else only sees the token, like an AppSync resolver or another API. `saas.route()` takes no `permission` any more: the function checks it, with `route()` or `authorized()`. `GET /me` and `GET /tenants` give the role's `permissions`, which the client's `can()` reads. An app that wants the role in the token adds it with the `claims` hook. |
| 2026-10-18 | **A request can name its tenant**, in the `x-tenant-id` header, in place of the token's. It's checked against the store like the token's, so it only says which tenant. Each tab can be in a tenant of its own, and switching in one needs no new tokens; `PUT /me/tenant` still changes the user's current tenant, for every tab and device and for what reads the token. Settles the open question of one tenant for each user, not each tab. The user pool stays on Essentials, as `tenant_id` is in the access token. |
| 2026-10-19 | **Every lookup is by key or on an index, and the lists are paged**, asked for by the user after a review of the lookups. The member list is a page, with a cursor; `notify()` and deleting a tenant read every page. The rule that a tenant keeps an owner reads a local index, `byRole` on the memberships table, two at a time, consistently: a global index can be behind, and could let the last owner go. The admin lists read a keys-only global index, `sorted`, on the users and tenants tables, in the order of email and of name, with a prefix `search`; its keys, `listed` and `sortKey`, are the store's own. Keys only, so that an update leaving the email or name as it was doesn't write to it. One value of `listed` puts every user, and every tenant, in one partition of the index: fine for the writes it gets, sign-ups and renames, well short of a partition's 1,000 a second. The token trigger takes up invitations while it reads the membership, and someone whose tenant is gone is moved to one they've just joined, whatever the index says. |
| 2026-10-19 | **`.js` on the package's relative imports**, with the user. `tsc` writes an import as it's written, and Node won't load `./config` without its extension, so every entry failed with `ERR_MODULE_NOT_FOUND` in plain Node; a bundler, like SST's, Vite or Next, finds it either way, which is why the lab didn't. It's the fork's rule against `.js` turned around for this package, which is published for Node. `test/load.test.ts` loads each entry in `package.json` with plain `node`, so an import without it fails there. The package stays on `moduleResolution: "bundler"`: under `NodeNext`, `component()` and SST's V5 components lose their types, as their `.d.ts` files import each other without `.js`. Adding it there was turned down on `v5` the same day, with the user, as most of those files are upstream's: *Write a Package Component* says to build with `bundler` instead. So the load test, not `tsc`, is what checks the extensions here. |
| 2026-10-18 | **A client for the frontend, `@sst-community/saas/client`**, agreed with the user. It's typed calls for the built-in routes, `SaasError` with the routes' codes, and the token refreshes that a change to the user's tenant needs: `switchTenant()`, `deleteTenant()` and `leave()` refresh, and `refresh()` takes up an invitation at once. It doesn't sign in or keep tokens: the app gives it `token()` and `refresh()` from whatever it signs in with. No UI and no framework bindings. It imports only types and `config.ts`, so it bundles alone, about 1 KB gzipped. |
| 2026-10-18 | **Invitations can be sent to any address, so they're limited**: at most `invitations.limit` waiting in a tenant (100), and the same address no more than once a minute (`429 too_soon`). They expire after `invitations.expiresIn` (7 days). Inviting again replaces the invitation and sends it again. `POST /tenant/members` stays, for adding someone who has signed up, at once. The `invitation` email is on by default, and `memberAdded` isn't sent to someone who took up an invitation. |

## Status

**Done (2026-10-19):** the component, the runtime, the shipped handlers, the README, email, invitations, branding, `notify()`, the client, the tenant in a header, paged and sorted lists, and 156 tests: 54 of the tenancy rules on the in-memory store, 26 of the Hono app, `route()` and the triggers, 22 of the component under `mock()`, 28 of email, 14 of the DynamoDB store against a fake client, and 12 of the client against the Hono app, with tokens from the pre token generation trigger. `tsc` is clean, and the shipped handlers bundle with esbuild (565 KB minified, most of it the AWS SDK) and load.

**Fixed on `v5` on the way** (`e53329841`): a part that's a component, looked up by id, lost its parent and was looked up twice. See the [log](https://github.com/sst-community/sst/blob/v5/docs/plans/v5-progress.md). The package still works around it, as it builds against `5.0.0-alpha.2`.

**Deployed in the lab on 2026-10-18**, twice, and removed. See [Checked in AWS](#checked-in-aws).

**Needs `5.0.0-alpha.3`**, for the V5 `Email` and the fix above. Until it's published, the package is built and tested against `sst` built from `v5`, installed without saving it; the README says how. Its peer dependency already asks for `>=5.0.0-alpha.3`.

## Design

### Parts

| Part | What it is |
| --- | --- |
| `userPool` | `v5.CognitoUserPool`, with the two triggers |
| `client` | `many(v5.CognitoUserPoolClient)`, one for each name in `clients`, `Web` by default |
| `api` | `v5.ApiGatewayV2`, with a JWT authorizer whose audiences are the clients |
| `users`, `tenants`, `memberships`, `invitations` | `optional(v5.Dynamo)`, not created for `"custom"` storage |
| `apiFunction`, `postConfirmation`, `preTokenGeneration` | `v5.Function` |
| `route`, `integration`, `permission` | `many(apigatewayv2.Route)`, one for each method under `{path}` and `{path}/admin`; the one `apigatewayv2.Integration` they send requests to; and the `lambda.Permission` that lets API Gateway invoke `apiFunction` |
| `triggerPermission` | `many(lambda.Permission)`, only for a user pool passed in `existing` |

The functions are linked to the tables, not to the component: a part that waits for its own component is never created. `saas.route()` does the same for routes of the app's own. A function outside the component can link it, and gets `SAAS_CONFIG` and access to the tables.

What the functions are told is one JSON value in `SAAS_CONFIG`: where the store is, the roles, the tenant settings, how invitations work, the path, the routes turned off, and how emails are sent.

### Records

| Record | Key | Fields |
| --- | --- | --- |
| User | `id`, the user's `sub` | `email` (verified, lowercase), `name`, `activeTenantId`, `platformAdmin`, `metadata`. In DynamoDB, also `listed` and `sortKey`, for the `sorted` index |
| Tenant | `id`, a UUID | `name`, `personal`, `createdBy`, `metadata`. In DynamoDB, also `listed` and `sortKey` |
| Membership | `tenantId`, `userId` | `role` |
| Invitation | `tenantId`, `email` (lowercase) | `role`, `invitedBy`, `expiresAt`. In DynamoDB, also `expires`, the same time in seconds, for the TTL |

Each has `createdAt` and `updatedAt`. `metadata` is for the app's own fields, and only platform admins and the app's code change it. Creating a user with their personal tenant is one transaction, and so is creating a tenant with its owner. A user created twice, as the two triggers can do at once, is created once.

### What's in the package

The package is the control plane. The application plane is the app's: its routes, its data, and how it keeps tenants' data apart. Between them, the package gives the application plane the tenant context of each request. Events on a bus, when they come, are how the control plane tells the application plane what changed, which is how AWS's SaaS Builder Toolkit joins the two.

| In the package | Why it's here | Replaced with |
| --- | --- | --- |
| The user pool, its clients and triggers, the API and its authorizer | AWS wiring that has to fit together | `transform`, `existing` |
| Users, tenants, memberships, invitations, and the rules on them | The data model everything else reads | `store`, `routes`, hooks |
| Tokens with the user's current tenant | Needs the records, at sign-in | `claims`, `handlers` |
| Sending email: SES, Cognito's emails, the emails about its own changes | Wired to the user pool and to its own changes | `send`, `templates`, `messages` |
| One plain layout, with a logo and a color | Every app needs its emails to look like it | `layout` |
| `notify()` | Only it knows who's in a tenant, with which role | Your own lookup and `send` |
| A typed client for its routes | It's the API's own shape, and the refreshes it needs | Calling the routes yourself |

Not in the package: which notifications to send, notification settings, unsubscribing, digests, queues, in-app notifications, an admin UI, UI components, billing. Each is the app's, started from the hooks, or from events once there are some.

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
create index memberships_role on memberships (tenant_id, role);
create index users_sorted on users (email, id);
create index tenants_sorted on tenants (lower(name), id);
create table invitations (tenant_id text references tenants on delete cascade, email text,
  role text not null, invited_by text not null, expires_at timestamptz not null,
  created_at timestamptz not null, updated_at timestamptz not null,
  primary key (tenant_id, email));
create index invitations_email on invitations (email);
```

Postgres has no TTL, so expired invitations are left until they're found, or a scheduled `delete ... where expires_at < now()`.

Two ways to reach it, to choose between when it's built:

- **The RDS Data API**, for Aurora: `@aws-sdk/client-rds-data`, no driver and no VPC for the functions. It only works with Aurora.
- **`pg` through RDS Proxy**: any Postgres, but the functions go in the VPC, and `pg` is one more dependency.

On the component's side it's one more value of `storage`, like `{ postgres: db }`, taking a V5 `Postgres` or `Aurora`. The tables aren't created, the database is linked, and `SAAS_CONFIG` says where it is. Creating the schema is part of the work: a migration the store runs, or a `Command` part.

## Found on the way

- **The package guide doesn't say a package's repo has to pin `google-protobuf`.** `@pulumi/pulumi` brings in 3.21.4, and with it every resource `mock()` registers fails with `c.g is not a function`. The SST repo pins 3.21.2 with `overrides`, and so does this package. [Write a Package Component](https://github.com/sst-community/sst/blob/v5/www/src/content/docs/docs/write-a-package-component.mdx) should say so, or `sst` should take care of it.
- **`build` is only in `app.graph()`, not in `app.resources`**, though `RecordedResource` documents it for both.
- **Hono's Lambda adapter moved** to `@hono/aws-lambda`. `hono/aws-lambda` goes in Hono 5.

## Checked in AWS

In the lab account on 2026-10-18, with `sst5` built from `v5` at `e53329841`. The app installed the package from the tarball `npm pack` writes, as it would from npm, and ran on a stage of its own. Everything was removed afterwards, along with the stage's passphrase, state files and sourcemaps.

- **Deploy and diff.** It deployed on the first try (65 resources), and `sst diff` then showed no changes. So did a second diff after the change of routes.
- **The user pool** is on the Essentials tier, signs in by email, and has both triggers, with version 2 of the pre token generation event.
- **Signing up.** A user who signed up and was confirmed was created by the post confirmation trigger, with a tenant of their own and the owner role. Their email was kept once it was verified, on their next sign-in. A user an admin created, which that trigger never sees, was created by the pre token generation trigger.
- **Tokens.** On a sign-in through the user pool's API (`USER_PASSWORD_AUTH`, which goes the same way as SRP), both tokens had `tenant_id`, `tenant_role` and, for a platform admin, `platform_admin`. The access token's `scope` had `tenant/*` for an owner, a scope for each permission of other roles, and `platform/admin`.
- **The API's checks.** It turned away a route of the app's own when the token's role didn't have its permission (`403` from API Gateway), and `/admin` for anyone but a platform admin. The function turned away built-in routes the role didn't allow. When a member was made an admin, their old token could rename the tenant at once, as the function reads the store. The API's own check on a route of the app's let them through only once the token was refreshed.
- **Tenants and members.** Creating a tenant, switching to it with a refresh, adding a member by email, changing their role, and paging the admin lists with a cursor all worked, against real tables.
- **CORS.** With `ANY` routes the preflight got a 401. With a route for each method it gets a 204 with the CORS headers, under `/admin` and on routes of the app's own too.
- **Timing.** The pre token generation trigger took 140 ms on a cold start (257 ms to start) and 55 ms warm; post confirmation 169 ms (416 ms to start). In `sst dev`, the CLI built the shipped handlers from the package in `node_modules` and ran them on the machine: a sign-in took 2 seconds in all, its trigger 181 to 348 ms.

**Email**, in a second deploy with `email` from a lab subdomain, sending only to SES's mailbox simulator. A queue read SES's own events, through an event destination the lab added with `transform: { email: { events } }`.

- The user pool was created once SES had verified the domain, about a minute in, sending through SES from it with the configuration set and the custom message trigger.
- Every email was sent and delivered: from Cognito, the sign-up code, the password reset and an admin-created user's temporary password, with the templates' subjects; from the app, welcome (to the user the pre token generation trigger created), added to a tenant, role changed and removed.
- No function logged an error. The custom message trigger took 2 to 8 ms warm. `sst diff` then showed no changes.
- Cognito sends one email of its own to `success@simulator.amazonses.com` when a user pool is set up with SES.

**Invitations**, in a third deploy the same day, with `sst5` built from `v5` at `6328b507d`, again sending only to the mailbox simulator. The lab confirms sign-ups without a code, so it marked each email verified, as entering the code does.

- The invitations table had its `byEmail` index and the TTL on `expires`, and each item's `expires` was its `expiresAt` in seconds.
- An invitation to someone who had signed up came back the same as one to someone who hadn't. Sending one again at once got a `429`, a role that isn't one and an address that isn't one a `400`, and revoking one, with the email encoded in the path, a `204`, then a `404`.
- Someone who signed up with an invited email was a member once the post confirmation trigger had run, and their first tokens were for that tenant, with the invitation's role.
- Someone who had signed up already joined at their next token refresh, through the pre token generation trigger, and their tokens stayed on the tenant they were in.
- SES sent the invitation to each address, and no "You were added" email to the two who took theirs up.
- No function logged an error. The pre token generation trigger took 10 to 26 ms warm, and 84 ms for the refresh that took up an invitation; post confirmation took 301 ms for the sign-up that took one up and sent a welcome email. `sst diff` then showed no changes.

**The tenant in a header**, in a fourth deploy on 2026-10-19, with the same `sst5`:

- Both tokens had `tenant_id`, and no role or permission scopes: the access token's `scope` was Cognito's own. A platform admin's had `platform_admin` and `platform/admin` once they refreshed, and `/admin` went from `403` at the API to `200`.
- With `x-tenant-id` for another of the user's tenants, `GET /tenant`, `GET /me` and a route of the app's own acted on it, while the token stayed on the user's current one. A header naming a tenant the user wasn't in got a `404 no_tenant`.
- A member made an admin could do what an admin can at their next request, with the same token, and one removed was turned away at their next request.
- CORS: API Gateway answers a preflight with `access-control-allow-headers: *`, as `ApiGatewayV2`'s default `allowHeaders: ["*"]` says. The CORS spec says `*` doesn't cover `Authorization`, which has to be named, but Chrome 153 let a request from another origin through with `Authorization` and `x-tenant-id`. Firefox and Safari weren't tried.

**Paged and sorted lists**, in a fifth deploy the same day:

- The tables had the indexes as designed: `sorted`, keys only, on users and tenants, next to `byEmail` on users, and the local `byRole` on memberships, next to `byUser`.
- `GET /tenant/members?limit=2` gave two members and a cursor, then the third and none.
- The last owner was turned away (`409 last_owner`). Once another member was made an owner, the first could step down in the next request, which the consistent read of `byRole` sees; the new one, then the last, couldn't.
- `GET /admin/users` paged in the order of email, and `search=SUCCESS%2BB` found the one user, in any case. `GET /admin/tenants` was in the order of name, "Acme" before "acme labs", and `search=acme` found both. No record had `listed` or `sortKey` in it; the table's items had both. A renamed tenant was found by its new name in the next request.
- No function logged an error. The pre token generation trigger took 12 to 35 ms warm.

Still not checked: a user pool and an API passed in `existing`, the hosted UI and federated sign-in, an email-address `sender`, DynamoDB removing an expired invitation (it can take a few days), and the AWS SDK's retries under load.

## Next

- **`5.0.0-alpha.3`**, then the package's `sst` dev dependency moves to it and the workaround for the lookup goes.
- **CORS in Firefox and Safari**, with `Authorization` under `allowHeaders: ["*"]`. If either refuses it, `ApiGatewayV2`'s default should name `authorization` as well as `*`, on `v5`.
- **The Postgres store.**
- **Events on a bus**, as well as the hooks.
- **A template for package repos**, made from this one, and the `google-protobuf` pin in the package guide.
- **Its own repo**, once the API has settled.

## Open questions

- **The name.** `Saas` and `@sst-community/saas` are working names.
- **Adding a member by email tells the caller whether that email has signed up.** Invitations don't, so an app that cares can turn `POST /tenant/members` off. Should it be off by default?
- **Nothing tells the one who invited** that their invitation was taken up. An `invitationAccepted` email, off by default, would.
- **No accept or decline** for someone who has signed up already: they join at their next token. An app that wants them to choose would need `GET /me/invitations` and routes to accept and decline.
- **The AWS SDK is bundled** into each function. Leaving `@aws-sdk/*` out of the bundle would use the runtime's copy and cut it to a tenth, at the cost of running a version the package wasn't tested with.
- **The first platform admin** is made by hand, with a command in the README. An arg naming them would be easier, and would put an email in the config.
