# SST as a layer on plain Pulumi

**Started 2026-11-12**, on the branch `v5-thin-layer`, from `v5-pulumi-dev`. What's settled is under [Decisions](#decisions). What's been done is in [progress.md](progress.md).

## Goal

In the maintainer's words: "turning sst into a thin dx convience layer on top of pulumi but plain pulumi still works", so that someone who wants to can "remove sst all together".

As tests:

1. **Plain Pulumi deploys SST's components.** A Pulumi program that imports `sst/components/aws` previews, deploys, refreshes and destroys with `pulumi` alone, on any Pulumi backend, with no `sst` command running.
2. **SST's CLI adds, and isn't needed.** `sst dev`, the typed links, secrets, `sst diff` and the moves are SST's. The program runs without them.
3. **The same program gives the same resources either way.** Run by SST or by Pulumi, a component registers the same URNs and the same physical names, so a stack can go from one to the other without a replace. Where a function's code is kept is the one difference, for a program that leaves it to SST's CLI: an SST app keeps it in SST's bootstrap, and a Pulumi program in the `Assets` it declares ([step 8](#8-asset-storage)), so a move updates the functions in place. A program that declares its `Assets` gets the same either way.
4. **Removing SST keeps what's deployed.** With SST's package and CLI gone, `pulumi up` and `pulumi destroy` still work, and there's a way to write the program without SST's components that leaves every resource in the cloud.

## Decisions

| Date | Decision |
| --- | --- |
| 2026-11-12 | **The goal**, above, on a branch of its own from `v5-pulumi-dev`. The maintainer: "explore this direction on another branch ultimately turning sst into a thin dx convience layer on top of pulumi but plain pulumi still works". |
| 2026-11-12 | **Step 1 first: a `Function` on plain Pulumi**, before any of SST's own resources. The maintainer said "yes" to it. |
| 2026-11-12 | **The components read the context, and the context reads Pulumi when there's no core.** Asked whether the components need redoing not to depend on the context: no. Each field has an equivalent under Pulumi but `paths.platform`, whose files are a matter of packaging, for step 2. |
| 2026-11-12 | **SST's own resources stay as they are, in the provider the `sst` binary serves, and Pulumi downloads that plugin under plain Pulumi.** Of the three ways in [the pieces](#the-pieces) (4), the maintainer chose this one, as recommended: it's the only one where a stack has the same URNs whether SST or Pulumi runs it ([goal 3](#goal)), and SST 5's stages already have these resources. The cost: each release publishes the plugin's archives, and a stack needs the plugin, which Pulumi downloads, until the eject replaces those resources. [pulumi-dev](../pulumi-dev/plan.md#decisions) turned down a provider of its own because everything SST adds there is for `sst dev` alone; here the provider is already part of what SST 5 deploys. |
| 2026-11-12 | **Step 3 is `sst dev` on SST's components**, over the eject and the smaller gaps (the default tags, `VisibleError`'s stack trace, a linked function's `Resource` checked at runtime): the maintainer chose it, as recommended. Asked whether a Pulumi program should use only Pulumi's own resources instead, the maintainer, told the components are what SST adds on top of the dev loop and the eject is the way out to plain resources, said to continue. |
| 2026-11-12 | **After step 3: step 4 closes goals 2 and 3 for what's built, then a sample program the maintainer tries it with, then the eject.** Offered those three and pushing the two branches, the maintainer chose the first three. |
| 2026-11-12 | **SST's tags under plain Pulumi are the stack's config, not code.** SST's CLI tags an app's AWS resources through the default provider's `defaultTags`, which under plain Pulumi comes from the stack's config, out of the program's reach. Of documenting the config or having the components tag what they create (which still updates every resource on a move, as the tags change place), the maintainer chose the config, as recommended. |
| 2026-11-12 | **The eject writes the program from the stack's state.** Of three ways (from the state; Pulumi's own `pulumi import --generate-code`, whose inputs come from a read of the cloud, so a first `pulumi up` can differ, and whose old entries are left to clear by hand; or an eject written for each component, about 40 to keep in step), the maintainer chose the state, as recommended: it needs no code for each component, and the first `pulumi up` changes nothing. |
| 2026-11-12 | **After the eject a function keeps its last build, with a build to switch to.** Each function points at the code already in the asset bucket, so nothing changes, and for Node.js the eject writes an esbuild build a function is switched to when its code next changes. The maintainer chose it, as recommended, over building in the program from the start (the first `pulumi up` updates the code) and keeping the last build only. |
| 2026-11-12 | **SST's own resources leave the state, and what they made stays.** Each one's delete removes what it made (a site's files, the router's keys and routes, the origin access control), so the eject takes them out of the state rather than out of the program, and SST's plugin isn't needed after it. The origin access control is adopted by Pulumi's own resource. A site's files and the router's routes stay as last deployed. The maintainer chose it, as recommended, over keeping them on SST's plugin. |
| 2026-11-12 | **After step 5: a sweep of SST's components under plain Pulumi**, over moving an SST app to a Pulumi stack, SST's CLI on Pulumi stacks and pushing for review: the maintainer chose it, as recommended, as four components were proven and a real app uses many. |
| 2026-11-12 | **The eject's cases that any program can hit come before the docs page**: several stacks, then SST's components inside a component of the program's. The cases tied to a component (a database's role lookup, the image prune, Cloudflare's and Vercel's resources, SST 4's origin access control) wait for that component's lab check. The maintainer asked whether to handle the other cases first; this was the recommendation. |
| 2026-11-12 | **For several stacks, the eject writes one module from all of them**: what's the same in every stack as it is, a plain value that isn't from each stack's config, a value with a reference in it picked by stack in the code, and what only some stacks have made only on those. The maintainer chose it, as recommended, over a module for each stack (simpler, but near-identical files to keep) and keeping one stack for now. |
| 2026-11-12 | **The eject keeps SST's components as Pulumi components of the same type and name**, so every URN stays and no alias is needed, in place of the aliases to a new parent this plan began with. Proposed with the design, with aliases left for the maintainer to ask for; the maintainer said to continue. |
| 2026-11-13 | **`sst/components` exports `$transform`**, of the two gaps the docs page found (the other: no bootstrap in an account SST's CLI hasn't deployed to). The maintainer chose it, as recommended. |
| 2026-11-13 | **Under plain Pulumi, a program declares where SST's components keep code and images: an `Assets`, and nothing is made for it.** SST's bootstrap is account-level and outside any stack, like `cdk bootstrap`, which Pulumi has no counterpart of: a fresh account needed an `sst` command first (goals 1 and 2), and ejected code was left in a bucket no stack owns (goal 4). Weighed: an `sst bootstrap` command (the same coupling, made explicit), the components making a store in the stack on their own (works, but a resource no code of the program's makes), each component taking a bucket (too many components make functions inside them), uploading code to Lambda directly (50 MB, and the eject has nothing to point at). The maintainer asked whether the command still coupled SST to the project, then for the store to be declared rather than made in the background, with a way to bring one's own, and for SST apps to keep SST's bootstrap. So: `new Assets("Assets")` makes a bucket and an image repository in the stack; `Assets.use({ bucket, repository })` points the components at the program's own, under SST's CLI too; an SST app that declares neither keeps SST's bootstrap; a Pulumi program that declares neither gets an error in its preview with the line to add. Deleted with the stack by default, emptied first. |
| 2026-11-13 | **The eject's last AWS cases next**: the database proxy's role lookup and the MicroVM image prune, which leave the state as a router's routes do, each lab-checked under plain Pulumi with its component. Offered with Cloudflare under plain Pulumi and SST's CLI on Pulumi stacks, the maintainer chose it, as recommended. |

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
6. **Removing SST.** An eject that writes the program with Pulumi's own resources, at the URNs SST's components gave them, so nothing is replaced ([step 5](#5-the-eject)).
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

### 3. `sst dev` on SST's components

Under `sst dev`, a Pulumi program's SST components do what they do in an SST app: a `Function` runs on this machine, and a `DevCommand` runs, with its links. `sst.dev.yaml` keeps naming the program's own functions and dev commands. A plain `pulumi up` still deploys the real code.

- **The context reads `sst dev` from the environment** `sst dev` gives `pulumi up` (`SST_DEV`, `SST_SERVER`): `dev` is true, the command is `deploy`, and the platform's folder is `.sst/platform`, which `sst dev` copies there, with the stubs the package leaves out.
- **The stub's region:** `sst dev` gives `pulumi up` `SST_AWS_REGION`, its own AWS provider's region, as it does for an SST app.
- **The link records** (`sst:sst:LinkRef`), and the check that the top-level components' names are unique, are set up when the components are imported under plain Pulumi, as SST's program entry (`platform/src/auto/run.ts`) sets them up under SST's CLI. A `DevCommand`'s links then reach its environment, and a stack has the same records either way.
- **`sst dev` reads the components' records** from the stack's export, as it does an SST app's: the functions, dev commands, hints and links. A record with a secret in it is read from an export with `--show-secrets`, and nothing else of that export is kept.
- **`sst.dev.yaml` is optional for a program that imports SST's components** (`sst/components` or one of its groups), which `sst dev` finds in the same scan of the program's imports that it watches. A program without them still needs the file, and is still offered one written from a preview.
- **`sst/pulumi`'s transform leaves the functions made inside SST's components to them**: a pattern like `"*"` doesn't take one, and a name the file gives one exactly is an error that says which component makes it.
- **A `Task`'s and a `Vpc` bastion's records** are read as an SST app's are, but neither is checked here: tasks and the tunnel in `sst dev` on a Pulumi program come later, as for [pulumi-dev](../pulumi-dev/plan.md#decisions).

Exit tests, in the lab: `sst dev` on a program with a `Function` linked to a bucket and a `DevCommand` linked to the same bucket. The function answers from the local code, a change to it shows without a deploy, and `Resource.<bucket>` works in it. The dev command's environment has the bucket's link. A plain `pulumi up` afterwards puts the real code back. Destroyed, and nothing left.

### 4. Goals 2 and 3 for what's built

- **The typed links.** `sst dev` writes `sst-env.d.ts` for a Pulumi program after each deploy, from the components' link records, as it does for an SST app, so `Resource.<name>` has its type. A plain `pulumi up` doesn't: no CLI runs.
- **SST's tags**, [as decided](#decisions): a stack that moves between SST's CLI and Pulumi sets `aws:defaultTags` to `sst:app` (the project) and `sst:stage` (the stack), as SST's CLI sets them:

  ```bash
  pulumi config set --path 'aws:defaultTags.tags["sst:app"]' <project>
  pulumi config set --path 'aws:defaultTags.tags["sst:stage"]' <stack>
  ```
- **`VisibleError` without a stack trace under Pulumi**, which prints the message alone for an error it's told is its own (`RunError`), as SST's CLI does for a `VisibleError`. Under SST's CLI nothing changes.

Exit tests: in the lab, after `sst dev`, `sst-env.d.ts` types the bucket's link and the handler typechecks against it; a deploy with the config has SST's two tags on what it creates; a `VisibleError` under `pulumi up` shows its message without a stack trace.

### 5. The eject

`sst eject`, in a Pulumi project, writes the program's SST components as Pulumi's own resources, [as decided](#decisions), and takes SST's own resources out of the stack's state. After it, the program needs neither SST's package nor its binary nor its plugin, and its first `pulumi up` changes nothing in the cloud.

- **What it writes:** a TypeScript module, `sst-ejected.ts`, from `pulumi stack export`:
  - **Each of SST's components is a plain `pulumi.ComponentResource` of the same type and name** (`new pulumi.ComponentResource("sst:aws:Function", "Api")`), and each of its parts the same resource as before, with the component as its parent. So every URN stays as it was, and no alias is needed. The type is only a name: nothing of SST's is loaded. Renaming them later, with aliases, is the program's choice. (The step that began this plan had aliases to a new parent; keeping the parent is simpler and leaves nothing to clean up once every stack has moved.)
  - **Each part's inputs are the ones its state has**, which the last deploy gave it, so a `pulumi up` sees no difference. A value that is another ejected resource's output becomes a reference to it (`role.arn`), in the state's order, which is the order they depend on each other. The options the state keeps go with it: `protect`, `retainOnDelete`, `ignoreChanges`, `deletedWith`, custom timeouts, its explicit dependencies. (The state doesn't keep `deleteBeforeReplace`.)
  - **A secret input** is read from `pulumi stack export --show-secrets`, written into the stack's config as a secret, and read with `config.requireSecret`. None is written into the code.
  - **A provider**: the stack's default provider needs nothing. A provider of the program's own is taken by the module's function as an argument, by name.
  - **What the module returns**: each component's parts, by the names SST gave them, for the program to use where it used the component's outputs (`api.url` becomes the URL part's `functionUrl`). The program's own code is the developer's to change: the eject says which components to replace.
- **The code**, [as decided](#decisions): a function keeps the code object it has in the asset bucket (`s3Bucket`, `s3Key`), and the object, with its source maps, leaves the state, so nothing deletes it. For Node.js, `sst-ejected-build.ts` has a build with esbuild a function is switched to, which bundles its handler and gives it the archive. It's a file of its own, so the program needs esbuild only once a function is switched.
- **SST's own resources**, [as decided](#decisions): the file sync, the invalidation, the CDN's waiter, the router's keys and routes, `addEnvironment`'s update, the image prune and the role lookup leave the state, and so does SST's provider, with one `pulumi stack import` of the state without them, so the change lands whole or not at all. The origin access control is written as `aws.cloudfront.OriginAccessControl`, adopted by its id (`import`). The link records (`sst:sst:LinkRef`) and the links' key (`LambdaEncryptionKey`, in the code's environment already) are left out of the program and leave the state with the rest: they have nothing in the cloud.
- **In this order**, so no deploy can delete what SST's own resources made: the stack's state is saved to a file beside the program, then the module is written and the config set, then SST's own resources leave the state. `sst eject` changes nothing in the cloud.
- **First:** a `Function` with a link and a URL, and a `StaticSite`, the components the steps before checked.

Exit tests, in the lab: a program with a linked `Function` and a `StaticSite`, deployed by `pulumi up`; `sst eject`; the program switched to the module, and SST's package taken out of `node_modules` with no `SST_BIN_PATH`; `pulumi preview` shows nothing to create, update or replace in the cloud (the components' records leaving the state aside); `pulumi up`; the function and the site answer as before; the function switched to the esbuild build and deployed, answering; `pulumi destroy`, and nothing left.

Built for those, and passed ([progress](progress.md)). The `StaticSite` has no origin access control: its CloudFront function sets the bucket as its origin, with access control settings of its own. Left for later, each refused with a message until then:

- **SST's origin access control** (`OriginAccessControl`). SST's state doesn't keep its name, which has a random ending, so adopting it needs a read of the cloud with the provider's credentials. Neither the `StaticSite` nor the `Router` makes one ([step 6](#6-the-sweep)).
- **SST's other own resources** (Cloudflare's and Vercel's; the image prune and the role lookup came in [step 9](#9-the-ejects-last-aws-cases)). (The `Router`'s routes, `addEnvironment` and the providers SST makes for a region came in [step 6](#6-the-sweep); several stacks and a component of SST's in a component of the program's in [step 7](#7-the-ejects-other-cases).)

### 6. The sweep

Every one of SST 5's components under plain Pulumi, [as decided](#decisions), in two parts:

- **In the mock.** `sst/testing`'s `mockPulumi` takes `plain: true`, which runs a program as Pulumi does: none of SST's globals, the app and the stage as Pulumi's project and stack, SST's bootstrap read from its parameter, and the program's root as Pulumi gives it. With `SST_TEST_PLAIN=1`, the platform's component tests run that way, but for the takeover cases, which are SST 4's and only ran under SST's CLI. What fails is a component's tie to SST's CLI, or a test that's written for the CLI (a move, `sst refresh`, or a test that sets `$cli` itself).
- **In the lab**, the components an app uses most that steps 1 to 5 didn't deploy: a `Router` with routes to a function and a bucket, a `Queue` with a subscriber, a `Dynamo` table with a stream subscriber, a `Cron`, and `Nextjs`, deployed by `pulumi up` and called, then ejected where the eject handles them.

Then the eject is extended to what the lab finds it refuses: first the `Router`'s origin access control and routes, and `addEnvironment`.

Done ([progress](progress.md)). The `Router` turned out to have no origin access control of its own: its routes set their origin's access in the key-value store, as the `StaticSite` does, so adopting SST's `OriginAccessControl` (which needs a read of the cloud for its name) waits for a component that makes one. The eject now takes a route's entries out of the state, puts what `addEnvironment` added in the function's environment (an update in place to what the function already has), and makes the AWS providers SST makes for a region (`AwsProvider.sst.<region>`, which a server-rendered site's server uses) as SST does, from the stack's AWS config.

### 7. The eject's other cases

[As decided](#decisions), what any program can hit first:

- **Several stacks.** `sst eject` reads every stack of the project and writes one module. What it makes is lined up across the stacks by URN, which is the same in each but for the stack's name. A value the same in every stack is written as it is; a plain value that isn't, like a resource's name, is read from each stack's config (`config.require("ApiFunction.name")`), where the eject puts it; a value with a reference in it that isn't the same is picked by stack (`byStack({ dev: () => role.arn, prod: () => "arn:..." })`); and what only some stacks have is made only on those (`onStack("prod") ? new ... : undefined`). A stack with none of SST's components is left out, and the module throws on a stack it has no values for. Each stack's state is saved, edited and imported on its own; if one fails, those imported before are put back.
- **SST's components inside a component of the program's.** Their URNs have the program's component in them, so the module makes them with it as their parent. It's in the program's code, so `ejected()` is given it, as it's given a provider of the program's: `ejected({ providers: { east }, parents: { shop } })`. The eject says what it takes.

### 8. Asset storage

[As decided](#decisions): SST's components keep a function's code, its source maps, a MicroVM's code and container images in the store the program declares, and SST's bootstrap stays an SST app's default.

- **`Assets`** (`sst:aws:Assets`, in `sst/components/aws`): a bucket, emptied when it's deleted, and an image repository, deleted with its images. It's deleted with the stack: `protect` reaches its parts as Pulumi passes it, and `retainOnDelete`, which Pulumi doesn't pass from a component to its parts, is passed by the component itself.
- **`Assets.use({ bucket, repository })`** points the components at a bucket and repository the program has, from its own stack or another. Either one alone, for a program with only functions or only images.
- **Declared first.** A store is declared before the components that upload: one declared after one of them is an error that says so, so which store a component uses never depends on when a value resolves.
- **One for each region.** A component uses the store in its region, so a function given a provider of its own for the default's region uses the default's. Two stores in a region: the one with the component's provider.
- **Under SST's CLI**, a component uses a declared store for its region, and SST's bootstrap otherwise. **Under plain Pulumi**, a component with no store for its region is an error in the preview, which says what to add.
- **Kept on delete only in SST's bootstrap.** A function's source maps and the dev stub's code are kept when they're deleted because other stages share SST's bucket. In a store of the program's they're deleted, so `pulumi destroy` can delete a bucket without `forceDestroy`.
- **The eject** writes `Assets` as it writes SST's other components, and a function's code location as a reference to the bucket.

Exit tests: the plain-mode tests with a store; tests of `Assets`, `Assets.use` under both, the order, the region, and what's kept on delete. In the lab, in a region SST's CLI has never deployed to: a Pulumi program with `Assets` and a linked `Function` deploys with `pulumi up`, answers, and is ejected and previewed without SST with nothing to change; destroyed, and nothing is left in the region.

### 9. The eject's last AWS cases

[As decided](#decisions): `RdsRoleLookup`, a proxy's wait for the role RDS gives it (`Postgres`, `Mysql`, `Aurora`), and `MicrovmImagePrune`, the deletion of a MicroVM image's old versions after each build (`MicroVm`), make nothing in the cloud and delete nothing when they're deleted, so the eject takes them out of the state with the rest of SST's own resources. After it nothing prunes the image's versions, of which it keeps up to 50; the eject says so.

Exit tests: in the lab, under plain Pulumi, a `MicroVm`, and a `Postgres` with a proxy in a `Vpc`, each deployed with `pulumi up`, ejected, previewed and deployed without SST with nothing to change, and destroyed with nothing left.

### Later

SST's CLI on Pulumi stacks, other languages. Steps 1 and 2 also found ([progress](progress.md)): every provider of a group to install, and runtimes other than Node.js. Step 5 left the eject of the components [listed there](#5-the-eject).

## Open questions

1. ~~What happens in an account with no bootstrap (3).~~ Decided 2026-11-13: a Pulumi program declares its store ([step 8](#8-asset-storage)).
2. Whether SST's CLI deploys Pulumi stacks too (7).

## Status

| Step | Status |
| --- | --- |
| Plan | Started 2026-11-12 |
| 1. A `Function` on plain Pulumi | Done 2026-11-12, lab-checked, committed (`fd905e16a`) |
| 2. A `StaticSite` on plain Pulumi | Done 2026-11-12, lab-checked, committed (`28c2ed12e`) |
| SST's provider takes the program's AWS setup | Done 2026-11-12, lab-checked, committed (`18f36ce79`) |
| The components' lookups follow their provider | Fixed on `v5` (`754dbde82`), merged here (`0aa256062`), lab-checked |
| 3. `sst dev` on SST's components | Done 2026-11-12, lab-checked, committed (`b74b7e1df`) |
| 4. Goals 2 and 3 for what's built | Done 2026-11-12, lab-checked, committed (`d0a4281d7`) |
| The maintainer's sample program at step 4 | Done 2026-11-12: a `Bucket`, a linked `Function` and a `DevCommand`, nothing deployed |
| 5. The eject | Done 2026-11-12 for a linked `Function`, a `Bucket` and a `StaticSite`, lab-checked, committed (`5f0a66a9d`) |
| 7. The eject's other cases | Several stacks: done 2026-11-13, lab-checked, committed (`447d04e92`). Components inside the program's: done 2026-11-13, lab-checked, committed (`aece8b61c`) |
| The docs page | Written 2026-11-13: "Components in Pulumi" (`www/src/content/docs/docs/components-in-pulumi.mdx`) |
| `$transform` for a Pulumi program | Done 2026-11-13: exported from `sst/components` |
| 8. Asset storage | Done 2026-11-13, lab-checked in a region SST's CLI never deployed to |
| 9. The eject's last AWS cases | Done 2026-11-13, lab-checked (`MicroVm`, `Postgres` with a proxy) |
| 6. The sweep | Done 2026-11-12. In the mock: committed (`d85d01786`; the path fix on `v5`, `57d26dd4f`). In the lab: lab-checked, committed (`9cfaedc6c`; the `Function` fix on `v5`, `d1adf0d2a`) |
