# @sst-community/saas

Users, tenants and roles for a SaaS app on AWS, as one SST component.

```ts title="sst.config.ts"
const { Saas } = await import("@sst-community/saas");

const saas = new Saas("App");
saas.route("GET /projects", "src/projects.list");
```

That gives you:

- a **Cognito user pool**, signed in to by email, and a client for your web app;
- an **HTTP API** with a JWT authorizer for the user pool, and the built-in routes on it;
- **four DynamoDB tables**: users, tenants, memberships and invitations;
- a **post confirmation trigger** that creates each user, with a tenant of their own;
- a **pre token generation trigger** that puts the user's current tenant in their tokens;
- with `email`, **email through Amazon SES** from your own domain, for Cognito's emails and the app's.

A user signs up and gets their own tenant. They can create more, switch between them, and invite the people they work with by email. A platform admin can see and change every user and tenant.

It's your SaaS app's **control plane**: the services that run the app as a business, one for every tenant. Your product is the **application plane**: its routes, its data, and how it keeps each tenant's data apart. The component gives your routes the tenant a request is for and checks the caller against it, and leaves the rest to you. See [What it doesn't do](#what-it-doesnt-do).

It needs SST version 5, `5.0.0-alpha.3` or later (`sst@npm:@sst-community/sst@^5.0.0-0`).

---

## How it works

### Signing up

When someone confirms their account, the post confirmation trigger creates their user record. With `tenants.personal` on (the default), it also creates a tenant for them with the owner role and makes it their current one. The pre token generation trigger creates the record too, when it finds none, so a user that the first trigger missed still gets one.

### What's in a token

The token says who the user is and which tenant they're in. The store says what they can do. Every token the user pool issues has these claims, in both the ID token and the access token:

| Claim | What it is |
| --- | --- |
| `tenant_id` | The user's current tenant, from their record in the store. |
| `platform_admin` | `"true"` for a platform admin. Not there otherwise. |

A platform admin's access token also has the scope `platform/admin`, which the API checks for `/admin`.

**Their role, and what it lets them do, isn't in the tokens.** A token is good for an hour by default, and a role can change in that time, or the member can be removed. So every route checks the caller's membership and role in the store, for each request. If something that only sees the token needs the role, add it with the `claims` hook in [`handlers`](#hooks-claims-and-a-store-of-your-own-handlers), knowing it's as it was when the token was issued.

Send the **access token** to the API.

### Which tenant a request is for

A request is for the tenant in the `x-tenant-id` header when it has one, and for the one in the token when it doesn't. Either way, the route checks that the caller is a member, so the header only says which tenant: someone who names a tenant they're not in gets a `404`.

- **To switch for good**, `PUT /me/tenant` with `{ "tenantId": "..." }` changes the user's current tenant, kept on their record, and the client refreshes its tokens to get it in them. It's then the same in every tab and on every device, and for whatever else reads the tokens. [The client](#the-client)'s `switchTenant()` does both.
- **For one tab, or at once**, send the header. Each tab can be in a tenant of its own, and switching needs no new tokens. The client's `useTenant()` does this.

Something else that reads the token, like an AppSync resolver, sees the user's current tenant, which can be another tab's. Each tab's requests to this API are for the tab's.

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

**Every route checks the store.** If a role changed, or a member was removed, it counts at their next request, whatever their token says.

**Changing the roles is a deploy**, and every tenant gets the change at once. A member keeps the name of their role in the memberships table, so a role you rename or remove leaves its members with no permissions, and when it's `ownerRole`, leaves their tenants with no owner. The functions log a warning when they find one. To rename a role:

1. Add the new role next to the old one. If it's the owner role, make the new one `ownerRole` too. Deploy.
2. Move the members to it, with `PATCH /tenant/members/{userId}` or a script of your own over the memberships table.
3. Remove the old role, and deploy.

### Invitations

A member with `members:write` invites someone by email, with a role:

```http
POST /tenant/invitations
{ "email": "dan@example.com", "role": "admin" }
```

They join the tenant when they sign up with that email and confirm it. Someone who has signed up already joins the next time the user pool issues them tokens: when they sign in, or when the client refreshes its tokens, which it can do straight away, with `refresh()` in [the client](#the-client). Only a verified email takes up an invitation.

- **The answer is the same whether or not the email has signed up**, so inviting doesn't tell anyone who has an account.
- **Someone who signs up through an invitation starts in that tenant.** They still get a tenant of their own when `tenants.personal` is on.
- **With `email`, the invitation is emailed to them**, from your domain.
- **An invitation expires** after `invitations.expiresIn`, 7 days by default, and DynamoDB removes it.
- **Inviting the same email again** replaces the invitation, with the new role, and sends it again. Not more than once a minute.
- **A tenant can have at most `invitations.limit` waiting**, 100 by default, so it can't send a great many emails from your domain.
- The same role rules apply as for adding a member: a member can only invite with a role whose permissions they all have, and only change or revoke an invitation with such a role.

```ts
new Saas("App", { invitations: { expiresIn: "3 days", limit: 20 } });
```

---

## The built-in routes

They're under `path`, which is the root of the API unless you set one. API Gateway sends them all to one function, which runs a [Hono](https://hono.dev) app. It has a proxy route for each method but `OPTIONS`, so it answers a CORS preflight itself, before the authorizer.

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
| `GET /tenant/members` | `members:read`: a page of them, in the order of their ids | `?limit=&cursor=` |
| `POST /tenant/members` | `members:write` | `{ email }` or `{ userId }`, and `role` |
| `PATCH /tenant/members/{userId}` | `members:write` | `{ role }` |
| `DELETE /tenant/members/{userId}` | `members:write`, or the member themselves | |
| `GET /tenant/invitations` | `members:read`: the invitations waiting | |
| `POST /tenant/invitations` | `members:write` | `{ email, role }` |
| `DELETE /tenant/invitations/{email}` | `members:write` | |
| `GET /admin/users` | Platform admins: in the order of their email, or those whose email starts with `search` | `?search=&limit=&cursor=` |
| `PATCH /admin/users/{userId}` | Platform admins | `{ name, platformAdmin, metadata }` |
| `GET /admin/tenants` | Platform admins: in the order of their name, or those whose name starts with `search` | `?search=&limit=&cursor=` |
| `PATCH /admin/tenants/{tenantId}` | Platform admins | `{ name, metadata }` |
| `DELETE /admin/tenants/{tenantId}` | Platform admins | |

The `/tenant` routes act on the tenant the request is for: the one in the `x-tenant-id` header, or else the one in the token. `GET /me` says which, with the user's role in it and its `permissions`, and `GET /tenants` lists each of the user's tenants with the same. An error comes back as `{ "error": { "code", "message" } }`. The codes your client might match on: `no_active_tenant`, `no_tenant`, `no_user`, `no_member`, `member_exists`, `last_owner`, `personal_tenant`, `no_invitation`, `too_many_invitations`, and `too_soon` (a `429`).

`POST /tenant/members` adds someone who has already signed up, found by email or user id, straight away. Only a verified email is kept, so only a verified email finds anyone. Unlike an invitation, it tells the caller whether an email has signed up: if that matters to you, turn it off with `routes: { "POST /tenant/members": false }` and invite people instead.

---

## The client

`@sst-community/saas/client` calls the built-in routes from your frontend, or any other code. It sends the user's access token with each request, and the tenant the client is in, turns an error into a `SaasError` with its `code`, and refreshes the tokens after a change to the user's current tenant. It uses only `fetch`, and is about 1 KB gzipped.

It doesn't sign anyone in. Give it the access token from whatever does, and a way to refresh it. With Amplify:

```ts title="src/saas.ts"
import { fetchAuthSession } from "aws-amplify/auth";
import { saasClient, SaasError } from "@sst-community/saas/client";

export const saas = saasClient({
  url: import.meta.env.VITE_SAAS_URL, // the component's `url`
  // path: "/saas", // the component's `path`, if it has one
  token: async () => (await fetchAuthSession()).tokens?.accessToken?.toString(),
  refresh: () => fetchAuthSession({ forceRefresh: true }),
});
```

```ts
const { user, tenant, role, permissions } = await saas.me();
const tenants = await saas.tenants(); // with the user's role in each, and its permissions

saas.useTenant(tenants[1].id); // this tab, at once, with no new tokens
await saas.switchTenant(tenants[1].id); // the user's current tenant, everywhere: refreshes the tokens

if (await saas.can("members:write")) showInviteButton();
await saas.invite({ email: "dan@example.com", role: "admin" });
await saas.changeRole(userId, "member");
await saas.leave(); // leaves the tenant the user is in, then refreshes

try {
  await saas.tenant();
} catch (error) {
  if (error instanceof SaasError && error.code === "no_active_tenant") {
    // show the tenant picker
  }
}
```

- **`useTenant(id)`** sends the client's requests for that tenant, in the `x-tenant-id` header, until it's given another, or nothing to go back to the token's. Make a client for each tab, and each is in a tenant of its own. `tenantId()` says which one the client is in.
- **`can(permission)`** says whether the user's role, in the tenant the client is in, has a permission, to show or hide parts of your UI. It asks `GET /me`, and keeps the answer until the client changes something that could change it, or `refresh()`. A role someone else changed shows at the next refresh, and the API checks it at once either way.
- **`refresh()`** gets new tokens. Someone who's signed in takes up an invitation to their email this way, without waiting for their next sign-in: call it when they open your app from the invitation's link.
- **`claims()`** reads the access token: the user's id, their current tenant, whether they're a platform admin, and its scopes. It's read, not checked: the API checks it.
- **`request(method, path, body)`** calls a route of your own on the same API, with the same token. Its path is from the API's root, where `saas.route()` puts routes, not under `path`.
- **`members({ limit, cursor })`** gives a page of members, as `{ items, cursor }`: pass the `cursor` back for the next page.
- **`admin`** has the `/admin` routes, for platform admins. `admin.users({ search: "ann" })` and `admin.tenants({ search: "acme" })` find them by the start of an email or a name.
- `switchTenant()`, `deleteTenant()` and `leave()` refresh the tokens. After `deleteTenant()` or `leave()`, the client is in the user's current tenant again. The rest don't refresh, so after `createTenant()`, switch to it or use it if the user should be in it.

The types, like `User`, `Tenant`, `Member` and `Invitation`, come with it.

---

## Your own routes

### On the API, with `route()`

```ts title="sst.config.ts"
saas.route("POST /projects", "src/projects.create");
saas.route("GET /reports", { handler: "src/reports.handler", memory: "1 GB" }, {
  platformAdmin: true,
});
```

The route is behind the same authorizer. The API checks only that the caller is signed in, or with `platformAdmin`, that they're a platform admin. The function is linked to the tables, and told what the runtime needs.

**Check the permission in the function**: the token doesn't have it, so the API can't. `route()` reads the caller and the tenant the request is for, and checks the permission against the store:

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

Then point the component's API function at it, with `transform: { apiFunction: { handler: "src/api.handler" } }`. Mount `saasApp()` at the component's `path`: `"/"` here, as it has none. Every path on the API reaches this function, so your routes need no gateway routes of their own. They're only checked by the authorizer, though: check permissions with `authorized()`.

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

`roles`, `ownerRole`, `defaultRole`, `tenants.personal`, `tenants.selfServe`, `invitations`, `path`, `routes`, `clients`, `link`, `email`. See [Roles and permissions](#roles-and-permissions), [Invitations](#invitations) and [Email](#email).

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
| `route`, `integration`, `permission` | The API's routes to `apiFunction`, the integration they share, and the permission that lets API Gateway invoke it |
| `users`, `tenants`, `memberships`, `invitations` | The `Dynamo` tables |
| `apiFunction` | The function behind the built-in routes |
| `postConfirmation`, `preTokenGeneration` | The triggers |
| `triggerPermission` | Created only for a user pool passed in `existing` |
| `email` | The `Email` the emails are sent from, with `email` |
| `customMessage` | The trigger that writes Cognito's emails, with `email` |

**An API you already have.** Pass a V5 `ApiGatewayV2` and give a `path`, so the built-in routes don't catch every path on it:

```ts
new Saas("App", { existing: { api: myApi }, path: "/saas" });
```

**A user pool you already have.** Pass its id. The component doesn't change the pool. It creates the two triggers and lets the pool invoke them, and you point the pool's triggers at `saas.nodes.postConfirmation` and `saas.nodes.preTokenGeneration` where the pool is managed. Use version 2 of the pre token generation event, on the Essentials or Plus tier, for the access token to get the claims. On version 1, only the ID token gets them. With `email`, the custom message trigger is created and allowed in the same way, as `saas.nodes.customMessage`. Point the pool's custom message trigger at it, and its email settings at the SES identity, `saas.nodes.email.nodes.identity`.

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

The hooks are `userCreated`, `tenantCreated`, `tenantDeleted`, `memberAdded`, `memberChanged`, `memberRemoved`, `invitationCreated` and `invitationRevoked`. `memberAdded` has the `invitation` when the member took one up, and `by` is then whoever invited them. Each runs after its change is made. A hook that throws fails the request, but the change stays made. If `userCreated` throws, the sign-up fails.

`tenancy()` is the set of rules the routes use, and it's yours to call too: `tenancy({ store, config }).addMember(...)` checks exactly what the route checks.

---

## Email

Without `email`, Cognito sends its own emails, like the sign-up code and a password reset, and allows only a few a day. With it, every email goes through Amazon SES, from your domain:

```ts title="sst.config.ts"
new Saas("App", {
  email: {
    from: "Acme <hello@acme.com>",
    replyTo: "support@acme.com",
    url: "https://app.acme.com", // the emails link here
  },
});
```

What that sets up:

- **An `Email` for the domain of `from`**, `acme.com`, with its DKIM and DMARC records in Route 53 (or another `dns`), so any address on it can send. The first deploy waits for SES to verify the domain, a minute or two. Give `sender: "hello@acme.com"` to verify only the address, by a link SES emails to it, before the user pool can send.
- **The user pool sends Cognito's emails from it**, and a custom message trigger writes them from the same templates as the app's: the sign-up code, a password reset, the temporary password of a user an admin created, a changed email's code and a sign-in code.
- **The app sends its own**, after the change each is about:

| Email | When | Default |
| --- | --- | --- |
| `welcome` | A user signs up | Off |
| `invitation` | Someone is invited to a tenant | On |
| `memberAdded` | Someone is added to a tenant, but not when they take up an invitation | On |
| `roleChanged` | A member's role changes | On |
| `memberRemoved` | Someone else removes a member | On |

```ts
new Saas("App", {
  email: { from: "hello@acme.com", messages: { welcome: true, memberRemoved: false } },
});
```

An invitation goes to the address it's for. Every other email goes to a verified address only. A send that fails is logged, and the change it's about is made all the same.

### Your logo and color

```ts
new Saas("App", {
  email: {
    from: "Acme <hello@acme.com>",
    logo: "https://acme.com/email-logo.png",
    color: "#ff6600", // the links
  },
});
```

Every email shows the logo at the top, 40 pixels high: Cognito's, the app's and yours. Use a PNG or JPEG at a public `https` URL. Most email clients don't show SVG, or an image attached to the email. `logo` takes an output too, like the URL of a file in a `Bucket` of yours.

That's all the branding the component has settings for. For anything more, like a footer, other fonts or a layout of your own, replace the layout.

### Your own layout, templates and provider

Every email is put together by one layout: a function that takes the heading, the paragraphs and a link, and returns the HTML and the text. The templates say what each email says, and the layout how it looks. Replace either, or the sender, in your `handlers` file:

```ts title="src/saas.ts"
import { createHandlers, defaultLayout, escape } from "@sst-community/saas/runtime";

export const { api, customMessage, postConfirmation, preTokenGeneration } =
  createHandlers({
    email: {
      // How every email looks: the built-in ones and yours
      layout: (input) => {
        const { html, text } = defaultLayout(input);
        return {
          html: html + `<p style="color:#6b7280;font-size:12px">Acme Inc, 1 Main St</p>`,
          text: text + "\n\nAcme Inc, 1 Main St",
        };
      },
      // What one says
      templates: {
        memberAdded: ({ tenant, by, layout }) => ({
          subject: `Welcome to ${tenant.name}`,
          ...layout({
            heading: `You're in ${escape(tenant.name)}`,
            html: [`${escape(by.name ?? "Someone")} added you.`],
            text: [`${by.name ?? "Someone"} added you.`],
          }),
        }),
      },
      // To send with another provider, like Resend or Postmark:
      // send: async ({ to, subject, html, text, replyTo }) => { ... },
    },
  });
```

A template is given `layout`, so one you replace still looks like the rest. The heading and paragraphs are HTML: escape what people wrote in them, like a tenant's name. A template for one of Cognito's emails has to include the `code` it's given, a placeholder Cognito fills in, and `adminInvitation` the `username` too. If one leaves it out, or a layout of yours does, Cognito sends its own.

Cognito always sends its emails through SES. A `send` of your own sends the app's.

### Emails of your own, like notifications

`createMailer()` sends from any function that links the component, with the same sender, layout and logo. `notify()` sends to users, or to a tenant's members, at their verified email:

```ts title="src/invoices.ts"
import { createMailer, escape } from "@sst-community/saas/runtime";

const mail = createMailer();

export async function invoiceReady(tenantId: string, month: string, url: string) {
  const result = await mail.notify({
    // Members whose role has the permission. Or { userIds: [...] }
    to: { tenantId, permission: "billing:read" },
    message: (user) => ({
      subject: `Your ${month} invoice is ready`,
      ...mail.layout({
        heading: `Your ${escape(month)} invoice is ready`,
        html: [`Hi ${escape(user.name ?? "there")}, it's ready to view.`],
        text: [`Hi ${user.name ?? "there"}, it's ready to view.`],
        action: { label: "View the invoice", url },
      }),
    }),
  });
  // result.sent, result.skipped (no verified email, or no message), result.failed
}
```

`message` is called for each of them, and can return nothing to leave one out. It sends one at a time and keeps going when one fails. For a large tenant, send from a queue. `mail.send({ to, subject, html, text })` sends to any address.

What to notify people about, when, and whether they want it, is up to your app. See [What it doesn't do](#what-it-doesnt-do).

The `email` part is an `Email` like any other: `transform: { email: { events: [...] } }` sends SES's events to SNS or EventBridge, and `existing: { email }` uses one you already have.

> **Note:** a new AWS account's SES only sends to addresses it has verified, until you [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), once in each region. To try it out without that, sign up with an address of SES's mailbox simulator, like `success+ann@simulator.amazonses.com`: SES accepts what's sent to it, and no one gets it.

---

## Storage

The built-in code reaches storage only through a `Store`, an interface of about twenty-five methods in `@sst-community/saas/runtime`. `storage: "dynamo"` (the default) creates four tables:

| Table | Key | Indexes |
| --- | --- | --- |
| users | `id` | `byEmail`: `email`. `sorted`: `listed`, `sortKey`, keys only |
| tenants | `id` | `sorted`: `listed`, `sortKey`, keys only |
| memberships | `tenantId`, `userId` | `byUser`: `userId`, `tenantId`. `byRole`, local: `tenantId`, `role` |
| invitations | `tenantId`, `email` | `byEmail`: `email`, `tenantId`. A TTL on `expires`, in seconds |

Every lookup the routes and triggers make is a read by key or a query on one of these: none reads a whole table. Each request reads the caller's user and their membership, and each token adds a query for invitations.

- **`sorted`** keeps users in the order of their email and tenants in the order of their name, for the admin lists and their `search`. `listed` and `sortKey` are the store's own attributes, kept on each user and tenant and left out of the records it returns. The index has only the keys, so a change to a user or tenant writes to it only when their email or name changes.
- **`byRole`** is a local index, so the rule that a tenant keeps an owner reads it as it is now. A local index can only be added when a table is created.

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

## What it doesn't do

The component is the control plane. It does what needs its own data or its own wiring: the user pool and its triggers, users, tenants, roles and invitations, and sending email. The application plane is yours: your routes, your tables, and how your data is kept apart by tenant, whether that's `tenantId` in a key, a table for each tenant or an account for each. What's a decision about your product is left to you too, with a place to plug it in:

| Not in the component | Where it goes |
| --- | --- |
| Which notifications to send, notification settings, unsubscribing, digests | Your code, with `notify()` and the hooks |
| Sending in bulk, or later | A queue of yours, whose subscriber calls `notify()` |
| In-app notifications, live updates | Components of your own, started from the hooks |
| How emails look, beyond a logo and a color | A `layout` |
| Signing in, and keeping the tokens | Amplify, or whatever your frontend signs in with: [the client](#the-client) takes its tokens |
| An admin UI, or UI components for the frontend | Your frontend, with the client |
| Billing and plans | Your code: `tenantCreated` and `metadata` |

---

## Things to know

- **Claims in the access token need the Essentials tier** of Cognito, which costs more per monthly active user than Lite. The component sets it on the user pool it creates. On Lite, a version 1 trigger can only add claims to the ID token.
- **Invitations email any address you're given, from your domain.** The limit for each tenant and the minute between sends slow down someone who'd use them to send spam, but with `tenants.selfServe` on, anyone who signs up can create a tenant and invite. If your app is open to anyone, watch SES's bounce and complaint rates, and think about a rate limit in front of the API, like AWS WAF.
- **Cognito gives a trigger 5 seconds.** The pre token generation trigger does three reads for most sign-ins: the user, their membership, and the invitations to their email. A `claims` hook adds to that. In `sst dev` the triggers run on your machine, so a slow first build can make a sign-in fail. Try again once it's built.
- **A global index is a moment behind its table**, well under a second as a rule. A tenant just joined can be missing from `GET /tenants` for that long, a user just signed up from finding by email, and a change from the admin lists and their search. What has to be exact reads the table, or the local `byRole` index: the checks on each request, the last owner, taking up an invitation, and moving someone to a tenant they've just joined.
- **A token is as it was when it was issued.** The routes check the store, so that only matters to what reads the token itself: its tenant, and whether the user is a platform admin, for `/admin` at the API. Keep access tokens short-lived if that matters.
- **Removal.** The tables and the user pool hold your data. Set the app's `removal` to `"retain"` for production stages, as with any SST app.

---

## Working on this package

It lives in the sst-community repo for now, in `packages/saas`, and uses npm with its own lockfile. Everything about it is in this folder, so it can move to a repo of its own as it is. The decisions, the design, what's been checked in AWS and what's next are in [PLAN.md](PLAN.md).

```bash
npm install
npm test        # builds, then runs vitest
npm run typecheck
```

The component is tested with `mock()` from `sst/testing`, and the runtime against `memoryStore()` and a fake DynamoDB client. `package.json` pins `google-protobuf` to `3.21.2` through `overrides`, as the SST repo does: with 3.21.4, which `@pulumi/pulumi` gets otherwise, every resource `mock()` registers fails with `c.g is not a function`.

It has four runtime dependencies: `@aws-sdk/client-dynamodb` and `@aws-sdk/client-sesv2`, `hono` and `@hono/aws-lambda`. Hono has none of its own.

`email` uses the V5 `Email`, which is in SST from `5.0.0-alpha.3`. Until that's published, build `sst` from the SST repo and install it without saving it:

```bash
# in the SST repo, on v5
(cd platform && npx tsc -p tsconfig.types.json && (cd src && find . -name "*.d.ts" -exec sh -c 'mkdir -p "../dist/types/$(dirname "$1")" && cp "$1" "../dist/types/$1"' _ {} \;))
(cd sdk/js && bun -e 'import { copyPlatform } from "./scripts/platform"; await copyPlatform();' && bun run build && npm pack)
# here
npm install --no-save ../../sdk/js/sst-0.0.0.tgz
```
