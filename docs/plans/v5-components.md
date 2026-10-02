# v5 components: plan and status

Branch `v5`, started 2026-09-30. Last updated 2026-10-01.

## Goal

v5 is the fork's own major version. It rebuilds the components on one foundation:

- A component declares every resource it creates as a **part**. From that list every component gives the same three things: `transform` for any resource, `existing` to use a resource you already have, and `nodes` to read any resource.
- **You can write your own components the same way**, with `sst.component()`, from resources of any provider in the app.
- **Switching keeps what's deployed.** Changing `sst.aws.Queue` to `sst.aws.v5.Queue` with the same name keeps the resources.
- **Components can be tested without AWS**, with `mock()`.

The end state (stated 2026-10-01): **the version 4 components are removed.** So every component gets a v5 port, and the fork ends up owning every component. When that happens, `aws/takeover/` is deleted with them.

`main` stays on upstream's 4.x line. `v5` releases as 5.x and does not follow upstream's numbering; its release notes still name the upstream version merged in.

## Decisions

Each of these was settled on the date given. Change one only on purpose, and record it here.

| Date | Decision |
| --- | --- |
| 2026-09-30 | **A v5 component sits next to the one it replaces.** No 4.x component file is edited, so upstream merges into them stay clean and 4.x components behave as before. |
| 2026-09-30 | **One way to define a component:** `extends component(type, parts)`. `Component` has no parts, `PartsComponent` isn't exported, and authors don't call `defer()`. |
| 2026-09-30 | **Design it clean.** A v5 component doesn't have to mirror the original's structure. What only wires resources together (a subscription, a route, an authorizer) becomes parts of the parent. What the user names and links in its own right stays a component. |
| 2026-09-30 | **What takes a component is ported before the component.** Version 4 components recognise a `Vpc`, `Cluster`, `Efs`, `Alb` or `Router` with `instanceof`, and those files can't be edited. So consumers are ported first, each accepting both kinds, and the component itself last. A runtime `Symbol.hasInstance` shim was turned down. |
| 2026-09-30 | **Takeover is kept out of the component.** What moved lives in `aws/takeover/<name>.ts`. The component's own code names no other component's type and sets no aliases. |
| 2026-09-30 | **Fork-owned TypeScript files import without the `.js` extension.** Upstream files keep what they have. |
| 2026-09-30 | **The 4.x `Function` trust policy is reproduced as deployed** (it always trusts the account root). Tightening it would update every role on switch; it's its own change. `sst shell --target` and `sst dev` both assume function roles, so trace that first. |
| 2026-10-01 | **Args that decide what gets created are plain values, not `Input`s**, guarded with `plain()`. To be revisited only if asked. The alternative is to accept either and create the part late, inside `.apply()`, when given an output. |
| 2026-10-01 | **No `V5` suffix.** A v5 component has the original's file name and class name, in `aws/v5/`, used as `sst.aws.v5.Queue`. |
| 2026-10-01 | **A v5 component has the same Pulumi type as the one it replaces** (`sst:aws:Queue`). The deployed component and every same-named child keep their address with no alias, what links a switched component sees no change, `Resource.X.type` stays the same, and there's nothing to undo when 4.x is removed. A `$transform` for either applies to both. |
| 2026-10-01 | **Everything gets ported** (see Goal). |

Against `main`, the only existing files changed under `platform/src` are `component.ts`, `naming.ts`, `index.ts`, `aws/index.ts` and `aws/permission.ts`. `platform/package.json` has one line changed (`sideEffects`). `cmd/sst` is identical to `main`.

## Status

**Ported (19, plus the Cognito client):** `Alb`, `ApiGatewayV2`, `AppSync`, `Aurora`, `Bucket`, `Cluster`, `CognitoUserPool` (with `CognitoUserPoolClient`), `CronV2`, `Dsql`, `Dynamo`, `Efs`, `Function`, `Mysql`, `Postgres`, `Queue`, `Redis`, `Service`, `SnsTopic`, `Task`.

**Not ported yet:**

- The sites: `Nextjs`, `Astro`, `Remix`, `SvelteKit`, `SolidStart`, `Nuxt`, `React`, `Analog`, `TanStackStart`, and `StaticSite`.
- `Vpc`, `Router`, `Cdn`.
- `ApiGatewayV1`, `ApiGatewayWebSocket`, `Auth`, `Bus`, `CognitoIdentityPool`, `Email`, `KinesisStream`, `OpenSearch`, `OpenControl`, `Realtime`, `StepFunctions`, `Vector`, `Workflow`.
- `Cron` (deprecated in 4.x; see Open questions).
- The Cloudflare and Vercel components.

**How it's been checked:**

- 1488 tests under a mock of the deploy engine. Each port runs its takeover cases three ways (as it is, inside another component, with another provider) and has to keep everything the 4.x component deployed, with the same inputs, options, registered outputs, function build inputs and teardown order.
- One run in a real AWS account on 2026-10-01: all 19 deployed with 4.x, switched, and removed. See [the report](v5-aws-test-2026-10-01.md).

**Where things stand (2026-10-01):** everything above is committed and pushed. `git log origin/v5` has the latest.

## Order from here

1. **The sites.** They take a `Vpc` and a `Router`, so they come before both. `ssr-site.ts` creates a `Cron` for its warmer; that becomes parts of the site.
2. **`Vpc`.** Every v5 component that takes a VPC already goes through `AnyVpc`, `isVpc()` and `TakesVpc<>` in `aws/helpers/vpc.ts`. Adding the v5 class there makes all of them take it, and the compiler flags any place that reads something the v5 one lacks.
3. **`Router`**, then the rest.

Before the sites, the docs generator needed to read arg types from helper files. That landed on 2026-10-01 (`3862786d7`).

### Design notes for `Vpc`

- `az`, `nat` and `bastion` are plain.
- Per-zone parts are `many`, keyed `"1"`, `"2"`, so the names match 4.x.
- `nat.ip` becomes `existing.elasticIp`, `nat.ec2.role` becomes `existing.natInstanceRole`, `bastion.instanceProfile` becomes `existing.bastionProfile`.
- The 4.x key `natSecurityGroup` is named `NatInstanceSecurityGroup`.
- The EIP association has an old root-level alias.
- The component registers a `_tunnel` output that the CLI reads (`pkg/project/completed.go`).
- `get` looks everything up by filter, so its parts are created late, with `lookupPart()`.
- **Keep its logical names.** It's almost all resources that are named by a tag, and those get a tag update when a part is renamed.

## Open questions

- **Does deprecated `Cron` get a port?** It's deprecated in favour of `CronV2`. Moving to the v5 `CronV2` replaces an EventBridge rule with a schedule, and nothing stateful. With "everything gets ported" as the goal, this needs an answer either way.
- **Three `Service` behaviours carried over from 4.x**, raised and not changed:
  - `desiredCount` is reset to `scaling.min` on every deploy (no `ignoreChanges`).
  - A service on an `Alb` reports `http://<alb dns>` as its URL even when the `Alb` has a domain.
  - The ECS service is named after the component alone.
- **Things 4.x created without the component's `provider` are replaced on switch when the component has one.** A part is always created with the component's provider, and a provider change replaces the resource. Affected: the alias of a durable function's URL, AppSync's domain association and the function of a Lambda data source, `SnsTopic`'s queue subscribers, and what's added to a component from `Dynamo.get` / `Bucket.get` / `CognitoUserPool.get` given a `provider`. Each is documented in the component's "Switch from" section. Is documenting it enough?
- **`Mysql`'s default version, `8.0.40`, is no longer offered by RDS**, so a `Mysql` with no `version` can't be created, in 4.x or v5. The fix belongs on `main` too. Deployed databases ignore changes to the engine version, so a new default wouldn't touch them.
- **anomalyco/sst#6934 on `main`.** v5 fixes it for `Alb` and `Service` (the load balancer depends on its certificate). The 4.x components in the fork still have it.
- **A proxy credential's `username` is plain only because the secret is named after it.** The weakest case for the plain-args rule.
- **Docs: a renamed function part's code is uploaded again** under its new name on switch. The function is updated in place; the docs only mention the description.
- **A resource whose provider requires a name** (`cloudflare.R2Bucket`) has to be given `name: ""` for SST's naming to fill it in, as upstream's own Cloudflare components do. `this.part()` could do better.
- **Two proposals not built:** test harness conveniences (`resource()`, `names()`, default AWS answers), and a report of what a 4.x component creates, to port from.
- **Releasing 5.x.** `release.yml` publishes any pushed `vX.Y.Z` tag, from any branch, to npm as `latest`. That has to be sorted out before a 5.x tag is pushed. `check.yml` and `docs.yml` only run for `main`.
- **Merging `main` into `v5`** conflicts on the root `README.md`, which is rewritten here.

## Not verified

- `sst dev` with v5 components.
- `get` and `existing` against real AWS, and a custom `provider`.
- Creating the databases fresh with v5 (in the AWS test they were created by 4.x and taken over).
- `CognitoUserPool` and `AppSync` custom domains, and a multi-region `Dsql`.
- How the SST Console treats v5 functions. It presumably finds functions by type, which is now the same.
- The app-wide transformations `auto/run.ts` adds (`removal: "retain"`) aren't applied under the mock.
