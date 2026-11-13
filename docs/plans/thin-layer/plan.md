# SST as a layer on plain Pulumi

**Started 2026-11-12**, on the branch `v5-thin-layer`, from `v5-pulumi-dev`. What's settled is under [Decisions](#decisions). What's been done is in [progress.md](progress.md).

## Goal

In the maintainer's words: "turning sst into a thin dx convience layer on top of pulumi but plain pulumi still works", so that someone who wants to can "remove sst all together".

As tests:

1. **Plain Pulumi deploys SST's components.** A Pulumi program that imports `sst/components/aws` previews, deploys, refreshes and destroys with `pulumi` alone, on any Pulumi backend, with no `sst` command running.
2. **SST's CLI adds, and isn't needed.** `sst dev`, the typed links, secrets, `sst diff` and the moves are SST's. The program runs without them.
3. **The same program gives the same resources either way.** Run by SST or by Pulumi, a component registers the same URNs and the same physical names, so a stack can go from one to the other without a replace.
4. **Removing SST keeps what's deployed.** With SST's package and CLI gone, `pulumi up` and `pulumi destroy` still work, and there's a way to write the program without SST's components that leaves every resource in the cloud.

## Decisions

| Date | Decision |
| --- | --- |
| 2026-11-12 | **The goal**, above, on a branch of its own from `v5-pulumi-dev`. The maintainer: "explore this direction on another branch ultimately turning sst into a thin dx convience layer on top of pulumi but plain pulumi still works". |
| 2026-11-12 | **Step 1 first: a `Function` on plain Pulumi**, before any of SST's own resources. The maintainer said "yes" to it. |
| 2026-11-12 | **The components read the context, and the context reads Pulumi when there's no core.** Asked whether the components need redoing not to depend on the context: no. Each field has an equivalent under Pulumi but `paths.platform`, whose files are a matter of packaging, for step 2. |
| 2026-11-12 | **SST's own resources stay as they are, in the provider the `sst` binary serves, and Pulumi downloads that plugin under plain Pulumi.** Of the three ways in [the pieces](#the-pieces) (4), the maintainer chose this one, as recommended: it's the only one where a stack has the same URNs whether SST or Pulumi runs it ([goal 3](#goal)), and SST 5's stages already have these resources. The cost: each release publishes the plugin's archives, and a stack needs the plugin, which Pulumi downloads, until the eject replaces those resources. [pulumi-dev](../pulumi-dev/plan.md#decisions) turned down a provider of its own because everything SST adds there is for `sst dev` alone; here the provider is already part of what SST 5 deploys. |

## Where it starts

- **The branch it's from**, `sst dev` for plain Pulumi programs ([pulumi-dev](../pulumi-dev/plan.md)): SST runs the dev loop and Pulumi does everything else. This takes the same idea to SST's components.
- **SST 5's components are Pulumi components already.** `Component` (`platform/src/components/component.ts`) extends Pulumi's `ComponentResource`. `sst:aws:Function` is a type string like any other. A part's parent is its component, and its URN is made by Pulumi (`createUrn` in `@pulumi/pulumi`). Whoever registers the same types and names gets the same URNs.
- **Under SST's CLI, Pulumi's project is the app and its stack is the stage** (`pkg/project/run.go`), so `pulumi.getProject()` and `pulumi.getStack()` give the same names either way.
- **The `sst` npm package has the components** (`sst/components`, `sst/components/aws` and the other groups), and installs the `sst` binary for the platform it's on (`sdk/js/bin/sst.mjs`).

## What ties a component to SST's CLI

Read from the code on 2026-11-12.

| Tie | Where | What for |
| --- | --- | --- |
| `context()`, which reads `$app`, `$cli` and `$dev` | `components/contract.ts` | The app, the stage, the command, `sst dev` and the paths. A few files still read the globals directly: `naming.ts` (physical names), `link.ts`, `component.ts` (an asset's path), `check.ts`, `move.ts`, and the sites' bases. |
| `Runtime.Build`, over the RPC | `aws/helpers/function-code.ts`, `aws/web-function.ts`, `cloudflare/worker.ts` | A function's build, in Go (`pkg/runtime`). |
| `Provider.Aws.Bootstrap` | `aws/helpers/bootstrap.ts` | The asset bucket and the ECR repository, from SST's bootstrap of the account. |
| `Runtime.AddTarget`, `Dev.Stub` | `aws/function.ts`, `cloudflare/worker.ts`, `contract.ts` | `sst dev` only. |
| `Move.Part`, `Move.Merged` | `move.ts` | `sst migrate` only. |
| SST's own resources, served by the `sst` binary as a Pulumi provider, which Pulumi finds through the work folder's `Pulumi.yaml` (`pkg/project/pulumi_yaml.go`) | `aws/resources/`, `cloudflare/resources/`, `vercel/resources/` | A site's files and invalidation (`StaticSite`, the server-rendered sites), a router's routes (`Router`, and a `Function` or site on one), the CDN's waiter, a function's `addEnvironment`, the MicroVM image prune, the RDS role lookup, the origin access control, Cloudflare's and Vercel's DNS records, a Worker's URL and placement. |
| Records in the state: `sst:sst:LinkRef`, `sst:sst:Versions`, `sst:sst:Moved` | `link.ts`, the core | Links, and the moves. |
| The home | `pkg/project` | A stage's state, passphrase and lock, in SST's own place, not a Pulumi backend. |

## The pieces

Each tie, and what plain Pulumi would use instead. Where there's more than one way, it's for the maintainer to choose.

1. **The context.** Without SST's globals, `context()` reads Pulumi: the app from `getProject()`, the stage from `getStack()`, the root from `getRootDirectory()`, `sst dev` from the stack's config (`sst:dev`, as [pulumi-dev](../pulumi-dev/plan.md) has it), and the command from whether it's a preview. The files that read the globals directly read `context()` instead.
2. **Builds.** The build is Go (`pkg/runtime`) and needs nothing of an app's home. Under plain Pulumi, the program starts the `sst` binary the package installed, which serves the build for that run and puts nothing in the state. Building in Node instead would be a second build to keep in step with the Go one, and for Node.js only.
3. **The asset bucket.** The same bootstrap lookup as SST's, through the same binary, so both ways upload to the same bucket under the same keys. To choose: whether an account with no bootstrap is bootstrapped, as `sst deploy` does, or refused with "run `sst bootstrap`". A bucket the program creates was weighed: its name would differ from SST's, and so would a function's code key between the two ways.
4. **SST's own resources.** The hard one. 5.0 decided they're a provider the `sst` binary serves ([2026-11-01](../v5-rewrite/plan.md#decisions)). Pulumi needs the plugin of every provider in a stack's state for `pulumi up` and `pulumi destroy`, which is why [pulumi-dev](../pulumi-dev/plan.md#decisions) turned down a provider of its own. The ways:
   - **A plugin Pulumi installs itself.** The `sst` package names its provider, with where to download it, and Pulumi fetches it as it does any third party's. Plain Pulumi works. The state needs the plugin as long as it has those resources, as it needs AWS's, so removing SST means keeping the plugin, or the eject (6) replacing them.
   - **Pulumi's own resources where they'd do**, such as each of a site's files as an S3 object. Nothing to keep after SST, but a site's thousands of files become thousands of entries in the state, and deploys get slower, which is what SST's `BucketFiles` was made to avoid.
   - **Dynamic providers**, in the program's language. No plugin, but Pulumi keeps their code in the state, which needs the same packages installed to delete them, and there are none for Python or Go.

   The first step doesn't need it: a `Function` without a router or `addEnvironment` uses none of them.
5. **Linking, secrets and `sst dev`.** A link is IAM statements and environment, which the component writes already. `sst-env.d.ts` stays SST's, written from the stack's outputs. `sst.Secret` is still to read. For `sst dev`, the components already report their functions (`_sst`), which `sst dev` on a Pulumi program could read in place of `sst.dev.yaml`. Later.
6. **Removing SST.** An eject that writes the program with Pulumi's own resources, each aliased to where SST's component had it (`aliases: [{ parent }]`), so nothing is replaced. Later: what it has to do depends on 4.
7. **SST's CLI on a Pulumi stack.** `sst dev` runs a Pulumi program already. To choose: whether `sst deploy`, `sst diff` and the rest do too, or Pulumi keeps those.
8. **Apps SST deployed.** Their state is in SST's home, under 5.0's one hard rule. With the names above, their URNs would match a Pulumi stack named after the stage in a project named after the app, so `pulumi stack import` might carry one across, but how the secrets are encrypted is still to check. Not in the first steps.

## Steps

### 1. A `Function` on plain Pulumi

A plain Pulumi program in TypeScript creates a Node.js `Function` from `sst/components/aws`, with no VPC, router or `addEnvironment`:

- `context()` falls back to Pulumi (1), and the files that read the globals go through it.
- The build goes through the `sst` binary, started by the program (2).
- The asset bucket comes from the bootstrap (3).

Exit tests, in the lab:

- `pulumi up` alone deploys it, and calling it works. A second `pulumi preview` shows no changes.
- The same function in an SST app named after the Pulumi project, on a stage named after the stack, has the same URNs and physical names, compared from both states.
- `pulumi destroy` alone removes it, and nothing of it is left.
- SST apps work as before: the Go and platform suites, and one `sst deploy` in the lab.

### 2. A component with SST's own resources

`StaticSite` (its files, the invalidation, the CDN's waiter), with SST's provider as a plugin Pulumi downloads, and the deploy-time files `paths.platform` names shipped in the package. A site with its own domain, the origin access control and the router's routes weren't in it.

### Later

`sst dev` reading the components' reports, the eject, SST's CLI on Pulumi stacks, other languages. Steps 1 and 2 also found ([progress](progress.md)): SST's default tags, which plain Pulumi doesn't set; `VisibleError`'s stack trace under Pulumi; every provider of a group to install; and runtimes other than Node.js.

## Open questions

1. What happens in an account with no bootstrap (3). Step 1 refuses it with a message, for now.
2. Whether SST's CLI deploys Pulumi stacks too (7).

## Status

| Step | Status |
| --- | --- |
| Plan | Started 2026-11-12 |
| 1. A `Function` on plain Pulumi | Done 2026-11-12, lab-checked, committed (`fd905e16a`) |
| 2. A `StaticSite` on plain Pulumi | Done 2026-11-12, lab-checked, committed (`28c2ed12e`) |
| SST's provider takes the program's AWS setup | Done 2026-11-12, lab-checked, committed (`18f36ce79`) |
| The components' lookups follow their provider | Fixed on `v5` (`754dbde82`), merged here (`0aa256062`), lab-checked |
