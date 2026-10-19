# v5 components: plan and status

Branch `v5`, started 2026-09-30. Last updated 2026-10-18.

## Goal

**What v5 holds to is in [v5-goals.md](v5-goals.md):** six goals, how each is checked, and where it stands. Every change is held to them.

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
| 2026-09-30 | **A v5 component sits next to the one it replaces.** No 4.x component file is edited, so upstream merges into them stay clean and 4.x components behave as before. Narrowed on 2026-10-09, below. |
| 2026-09-30 | **One way to define a component:** `extends component(type, parts)`. `Component` has no parts, `PartsComponent` isn't exported, and authors don't call `defer()`. |
| 2026-09-30 | **Design it clean.** A v5 component doesn't have to mirror the original's structure. What only wires resources together (a subscription, a route, an authorizer) becomes parts of the parent. What the user names and links in its own right stays a component. |
| 2026-09-30 | **What takes a component is ported before the component.** Version 4 components recognise a `Vpc`, `Cluster`, `Efs`, `Alb` or `Router` with `instanceof`, and those files can't be edited. So consumers are ported first, each accepting both kinds, and the component itself last. A runtime `Symbol.hasInstance` shim was turned down. |
| 2026-09-30 | **Takeover is kept out of the component.** What moved lives in `aws/takeover/<name>.ts`. The component's own code names no other component's type and sets no aliases. |
| 2026-09-30 | **Fork-owned TypeScript files import without the `.js` extension.** Upstream files keep what they have. |
| 2026-10-09 | **v5 diverges from SST.** Keeping SST's code as it is, so merges stay clean, is no longer a constraint. A 4.x component file can be edited where it changes nothing for an app that uses it: its config reads the same and its state doesn't change, as with imports, what a file reads when it loads, and types. New behavior still goes in the V5 component. V5 components haven't been released, so they can still change in any way. |
| 2026-09-30 | **The 4.x `Function` trust policy is reproduced as deployed** (it always trusted the account root). Tightening it would update every role on switch; it's its own change. Changed 2026-10-12: `main` fixed 4.x to trust the root only in `sst dev` (#95), and the port does the same. |
| 2026-10-01 | **Args that decide what gets created are plain values, not `Input`s**, guarded with `plain()`. To be revisited only if asked. The alternative is to accept either and create the part late, inside `.apply()`, when given an output. |
| 2026-10-01 | **No `V5` suffix.** A v5 component has the original's file name and class name, in `aws/v5/`, used as `sst.aws.v5.Queue`. |
| 2026-10-01 | **A v5 component has the same Pulumi type as the one it replaces** (`sst:aws:Queue`). The deployed component and every same-named child keep their address with no alias, what links a switched component sees no change, `Resource.X.type` stays the same, and there's nothing to undo when 4.x is removed. A `$transform` for either applies to both. |
| 2026-10-01 | **Everything gets ported** (see Goal). |
| 2026-10-12 | **Components are shared as npm packages, with SST as the host.** The CLI keeps installing SST, Pulumi and the providers in `.sst/platform`, and a package gets the app's copies when it deploys. A package imports `sst/components` (or a group, like `sst/components/aws`) and its providers, and lists them as peer dependencies. Its repo builds and tests against the `sst` npm package. An app without a `package.json` lists packages in its config, under `packages`. Installing the providers in the app's `package.json` was tried on `v5-sharing-deps` and not taken. See [v5-sharing-host.md](v5-sharing-host.md). |
| 2026-10-12 | **A provider version in the config has to be in the major version SST's components are built for** (before 1.0, the minor version). An older one was already refused. |
| 2026-10-12 | **A component's type has three parts**, `<package>:<module>:<Name>`. `component()` refuses two. |
| 2026-10-12 | **A provider a package needs is added by the app**, with `sst add`, as the deploy says. A provider's settings are in the config, so `sst install` doesn't write it there. |
| 2026-10-12 | **One `sst` package.** It carries SST's components for a package's repo too. esbuild, archiver and glob come with it in an app's production install, which add little next to the CLI's binary. |
| 2026-10-14 | **Database versions stay optional, and a default names a major version only**: `Mysql` `"8.0"` (it was `"8.0.40"`, which RDS stopped offering), `Postgres` `"17"`. RDS fills in its current minor version, so a default can't stop being offered, and a database deployed without `version` keeps what it has. Making `version` required, as SST's own list for its next major version has it ([anomalyco/sst#6588](https://github.com/anomalyco/sst/issues/6588)), was turned down: a switched database would need exactly the version it runs, or the deploy tries to change it. |
| 2026-10-14 | **`Function` keeps a default `runtime`.** Requiring it would end the handler string every subscriber takes (`queue.subscribe("src/sub.handler")`). The docs say a release can move the default, and says so in its notes. |
| 2026-10-13 | **5.x ships as pre-releases until 5.0.0**, tagged on `v5` as `v5.0.0-alpha.N`, to npm under the `next-experimental` tag. Only `v5`'s `release.yml` handles them, so `main`'s release path doesn't change. A 5.x tag without a suffix stops in `release.yml`. See "Pre-releases of v5" in `MAINTAINING.md`. |
| 2026-10-19 | **SST's files keep importing without `.js`, and a package component builds with `moduleResolution: "bundler"`**, as *Write a Package Component* says. SST's `.d.ts` files import each other without extensions, so under `NodeNext` `component()` and the V5 components lose their types. Adding `.js` to the source was turned down: 955 imports in 182 files, most of the files upstream's, so every SST release that touches one of those lines would conflict. Adding it when the types are built, with a `NodeNext` check of the output, is left for when a package needs `NodeNext`. A package's code that Node loads without a bundler still needs `.js` on its own imports. |

Since 2026-10-09 a 4.x file can change, so `git diff --stat main -- platform/src cmd/sst` lists what differs from `main`.

## Status

**Ported (21, plus the Cognito client):** `Alb`, `ApiGatewayV2`, `AppSync`, `Aurora`, `Bucket`, `Bus`, `Cluster`, `CognitoUserPool` (with `CognitoUserPoolClient`), `CronV2`, `Dsql`, `Dynamo`, `Efs`, `Email`, `Function`, `Mysql`, `Postgres`, `Queue`, `Redis`, `Service`, `SnsTopic`, `Task`.

**Not ported yet:**

- The sites: `Nextjs`, `Astro`, `Remix`, `SvelteKit`, `SolidStart`, `Nuxt`, `React`, `Analog`, `TanStackStart`, and `StaticSite`.
- `Vpc`, `Router`, `Cdn`.
- `MicroVm`, new in 4.x on 2026-10-10.
- `ApiGatewayV1`, `ApiGatewayWebSocket`, `Auth`, `CognitoIdentityPool`, `KinesisStream`, `OpenSearch`, `OpenControl`, `Realtime`, `StepFunctions`, `Vector`, `Workflow`.
- `Cron` (deprecated in 4.x; see Open questions).
- The Cloudflare and Vercel components.

**How it's been checked:**

- 1,712 tests under a mock of the deploy engine (2026-10-18). Each port runs its takeover cases three ways (as it is, inside another component, with another provider) and has to keep everything the 4.x component deployed, with the same inputs, options, registered outputs, function build inputs and teardown order.
- One run in a real AWS account on 2026-10-01: all 19 deployed with 4.x, switched, and removed. See [the report](v5-aws-test-2026-10-01.md).

**Where things stand (2026-10-01):** everything above is committed and pushed. `git log origin/v5` has the latest.

**Sharing components (2026-10-12):** on `v5`, from the branches `v5-sharing` and `v5-sharing-host`. See [v5-sharing-host.md](v5-sharing-host.md).

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
- **`Aurora`'s MySQL default is a full version, `3.08.0`**, written into the engine version as `8.0.mysql_aurora.3.08.0`. RDS still offers it (2026-10-14), but it will stop, as it did `Mysql`'s `8.0.40`. A major-version default like `Mysql`'s `"8.0"` needs the engine version written differently, and whether RDS takes `8.0` for an Aurora MySQL cluster isn't checked.
- **A proxy credential's `username` is plain only because the secret is named after it.** The weakest case for the plain-args rule.
- **Docs: a renamed function part's code is uploaded again** under its new name on switch. The function is updated in place; the docs only mention the description.
- **4.x's `functionBuilder` creates a function inside an `apply` on its args**, so when they hold a value that's unknown until the deploy, `sst diff` shows the function as deleted, and the deploy then updates it. A 4.x app showed this on 2026-10-13 (`v5-progress.md`). v5's `functionPart` no longer does (2026-10-14). Fixing 4.x is a change for `main`.
- **A resource whose provider requires a name** (`cloudflare.R2Bucket`) has to be given `name: ""` for SST's naming to fill it in, as upstream's own Cloudflare components do. `this.part()` could do better.
- **Two proposals not built:** test harness conveniences (`resource()`, `names()`, default AWS answers), and a report of what a 4.x component creates, to port from.
- **v5's docs aren't published.** `docs.yml` builds `main` only, so the v5 component pages and the component guides are only in the repo, and release notes link to them there. One way, not taken yet: build both branches into one site, with v5 under `/sst/v5/`. (`check.yml` runs for `v5` since 2026-10-14.)
- **Merging `main` into `v5`** conflicts on the root `README.md`, which is rewritten here.
- **What a V5 component is called once 4.x is removed.** If `sst.aws.v5.Queue` becomes `sst.aws.Queue` again, every app renames its components once more. Nothing deployed changes, as the type is the same. A command that rewrites a config could do that rename then, with the changes the "Switch from" sections list; it was left for 5.0.0 (2026-10-15).

## Not verified

- Switching a V5 component back to its 4.x one. The aliases that kept its resources on the way in aren't in the 4.x component, so a renamed resource would be created again under its old name. [Migrate From v4](../../www/src/content/docs/docs/migrate-from-v4.mdx) says to check `sst diff` first.
- `sst dev` with a `Service` or `Task`. Live functions were run on 2026-10-01 and work. On 2026-10-13, a 4.x app's dev stage went from a 4.x CLI to `sst5 dev` and back.
- `get` and `existing` against real AWS, and a custom `provider`.
- A shipped handler that imports a library from the package's `dependencies`, deployed.
- Creating the databases fresh with v5 (in the AWS test they were created by 4.x and taken over).
- `CognitoUserPool` and `AppSync` custom domains, and a multi-region `Dsql`.
- How the SST Console treats v5 functions. It presumably finds functions by type, which is now the same.
- The app-wide transformations `auto/run.ts` adds (`removal: "retain"`) aren't applied under the mock.
