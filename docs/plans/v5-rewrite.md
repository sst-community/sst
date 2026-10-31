# The 5.0 rewrite: new components on a core with places to plug in

**A draft, 2026-10-31.** On the branch `v5-rewrite`, from `v5`. What's settled is under [Decisions](#decisions); the rest of the plan is still open to change.

It builds on two plans that are on the branch `v5-community-packages`, not on `v5` yet: [v5-community-packages.md](v5-community-packages.md), and the draft [v5-core-set.md](v5-core-set.md), which sorts the components into tiers by how much they're used. The links work once that branch is merged.

## Goal

v5 set out to make one thing easier, in the maintainer's words: "basically allowing an easier way to build custom components for both sst authors and external users that can be packages." It's a proof of concept, to see whether that's viable. So far it is: SST's own components and an app's are built the same way, with `sst.component()`, and a component can be shared as a package (see [What v5 taught](#what-v5-taught)).

The rewrite is what 5.0 becomes: "a major rewrite to mature the product". It does three things:

- **It gives the core typed places to plug in**: homes, runtimes, the `sst dev` transport, emulator targets and checks. SST's own built-ins move behind them, in Go, and pass the same tests an outside one would.
- **It replaces the 4.x components with one set of new ones**, built the v5 way.
- **It moves an app across in one checked step.**

A package extends SST the way it can extend it with a component now: with components, checks, and target and runtime settings that the core carries out. Package code that has to run inside the CLI itself waits for a 5.x release, when an extension needs it.

Users may have to move their components to new ones. The one hard rule: "as long as the state file works the same way, at the end of the day that's really the most important because it dictates what's created and removed." That's [the state contract](#the-state-contract), and every step below is gated on it.

**Why now.** [#212](https://github.com/sst-community/sst/pull/212) by rogueturnip adds `sst dev --floci`, local AWS emulation: 6,500 lines across 69 files. It had to touch the core almost everywhere, because SST has nowhere to plug such a thing in. In the rewrite, Floci, LocalStack and the like are packages: a target the core runs, and a check.

## Not goals

- **Replacing Pulumi.** The state is a Pulumi checkpoint, and Pulumi decides what's created and removed. The rewrite keeps Pulumi as its engine and its state format.
- **Going back.** Moving an app back to 4.x after it has moved is best effort, as it is for v5 ([v5-goals.md](v5-goals.md#not-goals)).
- **Running 4.x components in 5.0.** An app stays on 4.x until every component it uses has a 5.0 form, then moves in one step.
- **Rewriting code that already does its job.** SST's built-ins (the homes, the runtimes, the AppSync transport), the event bus, the UI and the code that drives Pulumi move behind the new interfaces as they are, in Go.
- **A host for package code, in 5.0** ([No host in 5.0](#no-host-in-50)), **and permission grants** ([Safety rules](#safety-rules)).
- **Changes on `main` for the rewrite.** What the rewrite needs is done on `v5-rewrite`.
- **New clouds.** A GCP home or an Azure target can come later.
- **Merging SST's releases into the new line.** The code won't match SST's any more. [v5-core-set.md](v5-core-set.md) found SST has mostly gone quiet: one commit on its `dev` branch in the 90 days to 2026-10-22. Fixes from SST are ported by hand, as for the V5 components.

## Decisions

Change one only on purpose, and record it here with its date.

| Date | Decision |
| --- | --- |
| 2026-10-31 | **The rewrite is 5.0**, called "the 5.0 rewrite" for now. v5's alphas were its proof of concept, so users move once, not twice. What the alphas promised (the `sst.aws.v5.X` names, their list of breaking changes) is revisited by this plan. It's built on the branch `v5-rewrite`, from `v5`. |
| 2026-10-31 | **4.x on `main` keeps going alongside**, as the line an app stays on until it moves. Nothing for the rewrite is done on `main`. |
| 2026-10-31 | **5.0 doesn't run 4.x components.** An app stays on 4.x until every component it uses has a 5.0 form, then moves in one step. Earlier the same day the plan had them ship with 5.0 as a frozen package. That was dropped to keep 4.x's shims out of the core: its globals, the output names the CLI looks for, the RPC for old resources, and apps that mix the two kinds of component. |
| 2026-10-31 | **Package code is TypeScript, for now.** Other languages may come later. |
| 2026-10-31 | **Cloudflare is in scope**: its home, its runtime, `sst dev` for workers, and its most used components, after the AWS ones. A Cloudflare account is used as a lab, like the AWS one. |
| 2026-10-31 | **As few lab apps as cover the cases.** Nothing stays deployed: an app is removed and cleaned up after each check, unless it's checked again shortly after. |
| 2026-10-31 | **The RPC the program calls back into is redone in the rewrite**, not fixed separately on `main` (see [Safety rules](#safety-rules)). |
| 2026-10-31 | **No timeline.** Getting it right matters more than when. |
| 2026-10-31 | **The Floci package is owned outside the core**, probably by rogueturnip, who wrote #212. |
| 2026-10-31 | **No host for package code in 5.0.** The places to plug in are Go interfaces in the core, and SST's built-ins stay in Go behind them. A host comes in a 5.x release, when a package needs to run code in the CLI. Taken after an independent review of this plan (see [No host in 5.0](#no-host-in-50)). |
| 2026-10-31 | **No permission grants.** Packages are trusted like any other dependency. The core keeps the rules that need no grant. |
| 2026-10-31 | **The v5 alphas stop.** New components start from the V5 ones where that helps. The codemod renames `sst.aws.v5.X` to `sst.aws.X`, which keeps the state, since the type is the same. |
| 2026-10-31 | **New components keep the 4.x args** unless a reason is written down, so docs, examples and snippets keep working, and the codemod covers every rename. |
| 2026-10-31 | **5.0.0 ships with the Pulumi and provider versions of the 4.x it's built from.** A bump comes in a later release, so a move changes nothing it doesn't have to. |
| 2026-10-31 | **Step 2's result is released as a pre-release that only runs `sst diff`**, so real apps check the new core, not only the lab. |

## The state contract

Pulumi decides creates and deletes by each resource's URN: its type, its name and the chain of parents above it. For an app that moves to the rewrite, "the state works the same way" means five things.

| Part | What it means | How it's checked |
| --- | --- | --- |
| **Same identity** | Every resource in the cloud keeps its id. Its inputs change only in place. | `sst migrate --check` fails on any replace. After a real deploy, the states before and after are compared by type and cloud id (today's `compare-state.py` from the lab, brought into the CLI). |
| **Mapped, not recreated** | A resource whose URN changes, because a component was restructured, is mapped from its old address to its new one. | Each new component ships a state map. `--check` fails on any create or delete that isn't listed. A listed one must have nothing in the cloud behind it (a component, a wrapper, a `DevCommand`), or be released, so it leaves the state without a delete. |
| **Data is never replaced or deleted** | Buckets, tables, databases, caches, file systems, user pools, queues, log groups, and the secrets and passwords a database or cache uses, as in [v5 goal 2](v5-goals.md#2-moving-to-v5-never-loses-data). Also the table a `Vector` creates in its database. | `--check` fails when one of those is deleted, replaced, or changed in a field that replaces or empties it, listed or not. A `Vector`'s `dimension` is such a field: in 4.x, changing it drops the table and creates it again (`VectorTable.Update`). In the lab, data is written before the move and read after. |
| **The home stays compatible** | The rewrite reads and locks state the old one wrote: the same bootstrap, the same keys, the same passphrase, the same secrets encryption and the same lock (see [today's home and program](#todays-home-and-program)). | Step 2's tests: before a move, each version is refused while the other holds the lock, no second passphrase is created, and after a deploy the home holds only what a 4.x deploy writes. |
| **Deployed code keeps working** | A function reads its links from `SST_RESOURCE_<Name>` and `SST_RESOURCES_JSON`, or from the encrypted `resource.enc` with `SST_KEY` (`sdk/js/src/resource/node.ts`). SST's own Python, Go and Rust SDKs read the same, and the fork doesn't publish those. | The rewrite keeps writing them, as [Linking](#linking) says. A change to what a function reads is an in-place update that `--check` lists. In the lab, each runtime's function reads its links after the move. |

**The lock today is a read, then a write.** `provider.Lock` reads `lock/<app>/<stage>.json`, and writes it if it's empty. Nothing makes that atomic, so two deploys that start at the same moment can both take it. `diff` takes no lock at all. Until a stage moves, the rewrite keeps the same key and format, so 4.x and the rewrite refuse each other, and it writes the lock with a conditional put where the store has one (S3 does). Then two new CLIs can't both take it. Between 4.x and the rewrite, the race stays what it is today.

**A home that finds no state isn't trusted.** If the home finds no checkpoint for a stage that has a passphrase or update history, the core refuses to deploy. Otherwise a home that read the wrong place would create everything again, then write over the real checkpoint.

**SST's own provider resources keep their code in the state.** A resource made with `rpc.Provider` (`BucketFiles`, `KvKeys`, a CloudFront invalidation, and 12 more) stores its provider's serialized code as an input, `__provider`. If that code changes, every one of them is updated: files are uploaded again, an invalidation runs. That's allowed, since nothing is replaced, but `--check` lists them so it's no surprise. Moving them into the `sst` binary ends it (see [What runs in Node](#what-runs-in-node-and-what-moves-to-go)).

**After a move.** Once a stage has moved, its state has the new addresses. A 4.x CLI deploying the old config to it would see them as resources to delete, and create the old ones again. Nothing goes on `main` to stop that, so the move does it in the home:

- **It leaves a lock at the old key for good**, a tombstone, and the rewrite takes its own lock under a new key from then on. Every CLI since v3.0.43 refuses to deploy, remove or refresh a stage that's locked (`provider.Lock`). Their message says to run `sst unlock`, which deletes the tombstone. So it stops CI on an old branch, not a person who unlocks, and the migration guide says plainly not to.
- **It writes a marker into the state**, which tells the rewrite the stage has moved. The rewrite refuses to deploy a stage that hasn't: on it, only `sst migrate`, `sst diff` and commands that only read run.

### State maps

v5's takeover maps (`platform/src/components/takeover.ts`, and the rulebook's "Taking over what 4.x deployed") already say which old resource each new part takes over, and turn that into Pulumi aliases. The rewrite makes them a general tool:

- **A state map is data**, shipped with the component: for each part, the old addresses it can take over, what a move changes in place (`changed`), and what leaves the state with nothing behind it (`unclaimed`). That's the shape of a v5 takeover case today.
- **The core applies it, not the component.** v5 already keeps takeover out of the component's code. The rewrite goes one further: the core turns a map into aliases while a stage moves, and stops once the marker says it has. A component's code never carries its old layout.
- **Release, for what can't move.** A resource whose type or provider changes can't be carried to a new address: Pulumi would replace it. Where deleting the old one would remove something in the cloud, a site's files or a router's routes, the map releases it instead. The move takes it out of the state without calling its delete, and the new resource writes the same thing again.
- **`--check` reads the same map.** What the map says will change or be released is what the check allows. Nothing else. A delete the map doesn't release fails it.

Aliases, rather than editing the state file directly, because they're how Pulumi itself carries a resource to a new address, the preview shows exactly what they do, and v5 has run them in AWS: on 2026-10-01, 73 resources kept their ids under new names ([the report](v5-aws-test-2026-10-01.md)).

### Recorded states

The first AWS run found three bugs that every test under the mock had passed ([the report](v5-aws-test-2026-10-01.md#what-it-found)). The mock compares a 4.x component it ran itself with the V5 one. It never sees what 4.x really deployed.

So step 1 records real states: apps deployed with the latest 4.x in the lab, and their states exported. They're what every later check runs against:

- **In the repo, scrubbed.** An exported state has account ids and ARNs, and the repo is public. The account id, and anything else a scrub list names, is replaced with a fixed fake value before a state is committed, and a test fails when something that looks like an account id is left. The raw exports stay with the maintainers.
- **The takeover suites run against them.** Today a suite deploys the 4.x component under the mock and compares. With a recorded state, the "before" side is what AWS really had. The "after" side is still the mock, which is why step 4 also deploys.
- **A preview can replay one.** A preview reads the state, not the cloud, so a recorded state may be previewed again later without the app deployed, as long as the app looks nothing up in AWS. Step 1 checks whether that holds. If it does, most re-checks need no deploy, and no 45-minute database teardown.

## What v5 taught

Read from [v5-progress.md](v5-progress.md), [v5-port-notes.md](v5-port-notes.md), [the AWS report](v5-aws-test-2026-10-01.md), the sharing plans and the policies experiment.

### What worked

- **Parts** (`parts-component.ts`, `parts.ts`, `transform.ts`, `naming.ts`). One declared list gives every component `transform`, `existing`, `nodes` and its names. `Function` was the test of whether the framework holds, and it did. 21 components and the Cognito client are ported.
- **Takeover maps** (`takeover.ts`, `aws/takeover/`). In AWS, the serverless switch kept every resource's id, 73 under new names, and containers and databases kept all 238. A file on EFS kept its contents.
- **The three-way takeover check** (`pulumi.takeoverCases`, `test/helpers/graph.ts`). It compares addresses through aliases, inputs, deploy options, outputs, what a function is built from, and teardown order. It caught a missing `_live` output, notifications that would have been recreated, an ordering regression, and on each merge of `main`, 4.x fixes a port didn't have.
- **`mock()`** (`platform/src/testing`). Works under vitest and `bun test`, and in a package's repo with no `sst.config.ts`.
- **Packages, with SST as the host.** A package imports `sst/components` and its providers by name, and the bundler maps them to the app's `.sst/platform`, so there's one copy of each (`pkg/js/js.go`, `pkg/project/run.go`). npm, pnpm and bun apps each deployed one, and one ran in `sst dev`.
- **The peer-dependency check** (`pkg/project/packages.go`). A deploy checks each package's peers on `sst` and on providers against the CLI and the app, and says what to run.
- **Docs from the source.** `transform`, `existing` and `nodes` are written from the parts, and each "Switch from" section's standard notes from the generator.

### What fought back

- **The mock passed what AWS caught.** `"sideEffects": false` let esbuild drop every takeover map from a real build. Links were written under the wrong key. A function part that linked its own component waited on itself and was never created, with no error.
- **The 4.x code couldn't be touched.** `Function`'s build and zip logic was copied into `aws/helpers/function-code.ts`. Shared resources go through 4.x private statics. 4.x components check `instanceof`, so they refuse a V5 `Efs` or `Alb`, and consumers had to be ported first.
- **The CLI reads components by name.** `_task`, `_dev` and `_tunnel` are outputs `pkg/project/completed.go` looks for. A component type with two parts crashed the CLI after a deploy. Nothing declares what the CLI and a component expect of each other.
- **Pulumi's limits.**
  - A preview skips an `apply` with unknown inputs, so a 4.x function built inside one shows as deleted in `sst diff` (v5 goal 6, still unmet for 4.x).
  - A lookup can't take an alias, so `CognitoUserPool.get` is dropped from the state and looked up again.
  - A part created with the component's `provider` replaces what 4.x created without it.
  - `Component` passes `{}` to Pulumi (`super(type, name, {}, …)`), so Pulumi's transforms can't see a component's args.
  - An unknown value in a preview makes Pulumi drop a policy check silently.
- **Packages are fiddly to set up.** A package needs `moduleResolution: "bundler"`, `skipLibCheck`, and `google-protobuf` pinned to `3.21.2`. A group pulls in all of its providers.
- **A second copy of every component.** The 4.x AWS components are 55,414 lines in 96 files. The 21 ports are 13,977 more, and every merge of `main` has to be carried into both ([v5-core-set.md](v5-core-set.md)).

### What it means for the rewrite

- Keep parts, takeover maps (as state maps), `mock()`, packages, the peer-dependency check and generated docs. They're the model for the other places to plug in.
- Test against what AWS really had, not only against the mock (recorded states).
- Write down what the core and a component expect of each other (outputs the CLI reads, what a function is built from), instead of matching names.
- Don't keep two copies. A component exists once, in its new form.

## The architecture

### The core

A Go binary, as today. It owns what must hold for every app:

- **Loading the config** and running the Pulumi program.
- **The deploy loop**: preview, deploy, remove, refresh, and `sst diff`.
- **State and locks.** The home stores them, but the core decides when the lock is taken and released, and when state is read and written.
- **The event bus** (`pkg/bus`) and the UI (`cmd/sst/mosaic`).
- **The places to plug in**, with SST's built-ins behind them, and a test suite for each.
- **The [safety rules](#safety-rules).**
- **Moving an app**: `sst migrate`, the state maps, the marker and the tombstone.

### Places to plug in

Each is a typed, versioned interface in the core. The sketches are the shape, not the final API.

| Kind | What it provides | Built-in today | Who provides one in 5.0 |
| --- | --- | --- | --- |
| `component` | resources, as parts | the components | SST, apps and packages |
| `check` | validation, in the program and of the preview | none | SST, apps and packages |
| `target` | where cloud calls go | the real cloud | SST, and packages as settings the core carries out |
| `runtime` | build, run in `sst dev`, which files to watch, the types of what's linked | node, python, go, rust, worker (`pkg/runtime/`) | SST, and packages as commands ([v5-community-packages.md](v5-community-packages.md) step 4) |
| `home` | where state, locks and secrets are stored, and bootstrap | aws, cloudflare, local (`pkg/project/provider/`) | SST |
| `transport` | how a deployed stub reaches `sst dev` | AppSync | SST: AppSync, and #212's HTTP |
| `command` | an `sst <x>` subcommand | none | Waits for a host, in 5.x |

Components stay as v5 has them: `sst.component(type, parts)`. In the core:

```go
// SST's built-ins implement these, and each passes its kind's suite.

// Stores bytes by key. The core does the lock, the encryption and the history.
type Home interface {
	Bootstrap(ctx context.Context) error
	Get(ctx context.Context, key Key) ([]byte, error)
	Put(ctx context.Context, key Key, data []byte, opts PutOptions) error // IfAbsent, for the lock
	Remove(ctx context.Context, key Key) error
	List(ctx context.Context, prefix Key) ([]Key, error)
	Passphrase(ctx context.Context, app, stage string) (string, error)
	CreatePassphrase(ctx context.Context, app, stage, value string) error // never overwrites
}

// As pkg/runtime's interface is today, plus the types of what's linked.
type Runtime interface {
	Match(runtime string) bool
	Build(ctx context.Context, input *BuildInput) (*BuildOutput, error)
	Run(ctx context.Context, input *RunInput) (Worker, error) // in sst dev, against the CLI's runtime API
	ShouldRebuild(functionID, path string) bool
	ShouldRunEagerly() bool
	Types(ctx context.Context, links LinkTypes) error
}

// How the stub in the cloud reaches sst dev.
type Transport interface {
	Ensure(ctx context.Context) error     // what it needs outside the state, like the AppSync Event API
	Stub(ctx context.Context) StubSettings // the wire protocol, environment and permissions
	Connect(ctx context.Context) (bridge.Conn, error)
	Remove(ctx context.Context) error // on sst remove
}

// Where the providers send their calls.
type Target interface {
	Providers(ctx context.Context) ProviderSettings // endpoints, region, credentials
	Env(ctx context.Context) map[string]string      // for the program, the workers and sst shell
	Home() Home                                     // a target's stages never use the real home
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
}
```

What a package writes:

```ts
// A target: settings, which the core carries out
export const floci = sst.target({
  image: "floci/floci:2.3.0",
  ports: [4566],
  dockerSocket: true, // the core says so when it starts it
  endpoint: "http://127.0.0.1:4566",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  region: "us-east-1",
});

// A runtime: commands, as v5-community-packages.md step 4 plans
export const ruby = sst.runtime({
  match: "ruby",
  build: { command: "bundle install --deployment", output: "." },
  dev: { command: "ruby dev.rb" },
  watch: ["**/*.rb", "Gemfile.lock"],
});

// A check: runs in the program
export const allowlist = sst.check({
  resource(r) {}, // r.type, r.name, r.props, r.component
  invoke(i) {}, // i.token, i.args
});
```

An app names a stage's target in `app()`, as `targets: { local: floci }`, and a function's runtime in its args.

Notes on each:

- **A package gives settings, not CLI code.** A target or a runtime from a package is settings, and a check runs in the program, so nothing from a package runs in the CLI in 5.0. `app()` already reaches the core as JSON, and a function's build input already reaches it through the RPC, so neither needs anything new to get there.
- **A home only stores bytes.** That's how `pkg/project/provider` works today: a `Home` gets, puts and removes data by kind, app and stage, and `Lock`, the secrets' encryption (AES-GCM, keyed by the passphrase) and the history are functions around it. Keeping it so means a home can't change the layout, the lock or the encryption. They're the core's, and the state contract holds for every home. The AWS home also resolves credentials (profiles, `assumeRoles`, `us-east-1` by default), gives the program its bootstrap data, and prunes old object versions. That stays in it, in Go.
- **A runtime only builds and runs.** The shared work stays in the core, as `runtime.Collection` does it now: bundles, copied files, and the links encrypted into `resource.enc`.
- **The stub stays in the core.** The deployed stub (`platform/functions/bridge/`) is a Go binary, and it has to start fast in any Lambda runtime. So it speaks a fixed set of wire protocols, AppSync Events today and #212's token-authenticated HTTP, and a transport picks one and gives it its endpoint and permissions.
- **A transport only delivers packets.** `bridge.Conn` is two methods, `Publish` and `Subscribe`, and nothing says what a transport does about order, copies, loss, a channel with no subscriber, or closing. AppSync's closes every subscription when it shuts down, and #212's keeps them open. The interface writes that contract down. The bridge keeps doing the rest, as it does now: it cuts messages into packets, puts them back in order, drops copies, and asks again for what's lost (`bridge.go`, `resend.go`).
- **Some of what a transport needs isn't in the state.** The AppSync Event API is found or created with the SDK, not Pulumi, and a stage's own API is deleted with the SDK on `sst remove` (`provider/aws_appsync.go`, `run.go`). Hence `Ensure` and `Remove`.
- **Checks build on what's there.** `--policy` already passes a Pulumi policy pack to the deploy, and the [policies experiment](policies-experiment.md) built rules into one, each finding named by its component and part. #212's allowlist used Pulumi's transforms instead, which also see invokes. A check takes both, and the policies experiment's rules package becomes a check package.
- **A check sees a component's args through SST, not Pulumi.** `Component` passes `{}` to Pulumi, so a Pulumi transform sees no args. Passing them would record every component's args in the state, which is a change to every stage and could store secrets. So the core gives a check the args from SST's own hook (`ComponentTransforms` in `component.ts` is where they are today), and a resource's inputs from Pulumi's `registerResourceTransform`, as #212's allowlist does.
- **What the core reads from a component is declared.** `_task`, `_dev`, `_tunnel`, what a function is built from, and the shape of what it links become a typed part of the component contract, not output names the CLI looks for.

### What #212 needed, and where it goes now

#212 changed 32 files that were already there, with 418 lines. Grouped by the place to plug in that was missing:

| What it had to change | Why | Where it goes |
| --- | --- | --- |
| `mosaic/aws/aws.go`, `mosaic/aws/bridge/bridge.go`, the stub, `cmd/sst/mosaic.go` | No way to choose how the stub reaches `sst dev` | `transport`: its HTTP transport becomes a built-in one |
| `pkg/project/project.go`, `run.go`, `env.go`, `provider/aws.go`, `provider/local.go`, `pkg/server/` | No way to choose where calls go: credentials, endpoints, region, the home | `target`, with its own home |
| `mosaic/aws/function.go`, `cmd/sst/shell.go` | No hook for the environment of a worker or a child process | `Target.Env`, applied by the core |
| The 4.x `function.ts`, `helpers/bootstrap.ts`, `helpers/provider.ts`, two provider resources, `component.ts`, `auto/run.ts` | No way to change what `sst dev` deploys, or to check a program before it deploys | `Transport.Stub`, and a `check` in the Floci package |
| `cmd/sst/main.go`, `cli/cli.go`, `cli/project.go`, `mosaic/errors/errors.go` | No way to add a command or a flag | The core's commands for a stage's target: start, stop, reset. A `command` kind waits for a host. |

With these, the Floci package is a target and a check. The core keeps the transport and the isolation.

### No host in 5.0

5.0 has no process for package code. The plan had one, a long-lived Node process, until an independent review on 2026-10-31 found:

- **Nothing would have run in it.** In the plan's own end state, AppSync stayed in Go, #212's transport and restricted client went into the core, the allowlist ran in the program, a Floci target was settings, and Ruby and .NET fit a runtime made of commands. Nobody has asked for a home or a command.
- **It would have slowed every command.** A home in TypeScript would add 0.2 to 0.4 s to each command that touches state: loading the S3 and SSM clients takes about 170 ms warm and 400 ms cold, and Node itself about 20 ms. The Go home costs nothing.
- **#212 didn't need a process.** Its changes to files that were already there were 418 lines. What it lacked was places to choose and hooks.

**When one is needed**, for package code that has to run in the CLI (a home for another cloud, a command), it comes in a 5.x release, as a JavaScript runtime in its own process talking to the core over a versioned protocol. Go plugins (no Windows, and the exact toolchain the CLI was built with), WebAssembly, and a JavaScript engine embedded in Go (no npm packages to speak of) were ruled out. Node is already required; Deno has permissions that cover the network. Which one is decided then.

### What runs in Node, and what moves to Go

Read from the code on `v5` on 2026-10-31.

**Stays in Node, or in JavaScript:**

- **The config and the Pulumi program**, with every component. Pulumi's TypeScript SDK runs in Node, and the config is the app's own TypeScript.
- **The function worker in `sst dev`** (`nodejs-runtime`) **and esbuild plugins** (`plugin.mjs`). They run the app's own code.
- **What AWS or Cloudflare only runs as JavaScript**: the CloudFront router functions (`cf-*-router-worker`), the Lambda@Edge signer (`oac-edge-signer`, since Lambda@Edge takes only Node or Python), the React and Remix servers, and Cloudflare workers.
- **Editing the config**: `sst add` (`src/ast/add.mjs`), and step 5's codemod. TypeScript source is best rewritten with TypeScript's own tools.
- **The small handlers SST deploys** (`ssr-warmer`, `vector-handler`). Rewriting them would change deployed code for nothing a user notices.

**Moves to Go:**

- **SST's own provider resources, if step 4's first gate passes.** The 15 `rpc.Provider` types (`BucketFiles`, `KvKeys`, `WorkerScript`, the CloudFront invalidation and the rest) already do their work in Go, in `pkg/server/resource/`. Node is only the way there. The program writes a closure into the state, Pulumi starts a Node process to run it on every deploy and every redeploy in `sst dev`, and that calls the CLI back over the RPC. As a provider in the `sst` binary:
  - that Node process goes;
  - their code leaves the state;
  - they get a real diff (none has one today, so Pulumi compares inputs);
  - the RPC shrinks to what the program needs.

  Their type and provider change, so each moves according to what it does, [below](#how-each-provider-resource-moves). Every old one is released in the move, so the rewrite never runs their old code. If releasing and adopting `BucketFiles` and `KvKeys` doesn't pass cleanly in step 4, they stay as they are for 5.0 and move later.
- **Zipping and hashing, if it's a real cost.** The program zips each function with `archiver` (`helpers/function-code.ts`), and a site lists and hashes every file in turn (`static-site.ts`, `ssr-site.ts`). Go already builds the functions and uploads the files. It could zip and hash them in the same pass, in parallel, and `archiver` and `glob` would leave what an app installs. But the zips and hashes are inputs in the state. Unless Go's output is identical, every function's code is uploaded once more, and each site runs one invalidation, in place. So it's timed on a large site first, and done only if it's slow.

#### How each provider resource moves

**Why they're resources at all.** A Pulumi resource runs at the right point in a deploy, runs only when its inputs change, and is cleaned up on remove. Its state is also its memory: `BucketFiles` keeps the list of files it uploaded, so the next deploy can delete the ones that are gone. Pulumi's providers had no resource for these jobs, and a dynamic provider was the quickest way to write one in TypeScript. Storing its code in the state comes with that. SST never reads it.

| Kind | Resources | In the cloud | How it moves |
| --- | --- | --- | --- |
| Lookups and waits | `HostedZoneLookup`, `RdsRoleLookup` (waits for the RDS role to exist), `DistributionDeploymentWaiter` | Nothing | The old entry leaves the state. The lookups become functions of the new provider, not resources. The waiter stays a resource, so it still runs at the right time. |
| Actions on a change | `DistributionInvalidation`, `FunctionEnvironmentUpdate`, `MicrovmImagePrune` | Nothing kept | The old entry leaves the state. The new resource runs once when it's created: one invalidation, one write of the environment, one prune. |
| Content they wrote | `BucketFiles` (a site's files), `KvKeys` and `KvRoutesUpdate` (a router's routes), `WorkerScript` and `WorkerAssets` (a Cloudflare worker), the Cloudflare and Vercel `DnsRecord` | Yes | Released. The new resource writes the same content again: uploads overwrite, and the DNS record already accepts "already exists". |
| An object with an id | `OriginAccessControl` | A CloudFront origin access control | Released, and adopted: the new resource takes the existing one by its id, since its create would make a second one. |
| Data | `VectorTable` | A table holding the app's embeddings | Released, and adopted. Its create already accepts a table that exists, so the rows stay. |
| No longer used | `FunctionCodeUpdater`, `OriginAccessIdentity`, `Run` | Nothing, or an old identity | SST stopped creating them in v3.1.18, v3.0.43 and v3.6.41. Their code goes. An old entry is released like the rest. An origin access identity in a stage untouched since 2024 is left in the account rather than deleted. |

### Linking

**Today:**

- **Types are made after every run, from the values in the state** (`pkg/project/run.go`, `pkg/types/typescript/typescript.go`). The generator writes each value's shape: a string becomes `string`, a number `number`.
- **One `sst-env.d.ts` at the root holds every link in the app.** Every folder with a `package.json` gets a file that points to it, so `Resource` shows every resource everywhere.
- **At run time**, a function reads the variables and the file the state contract names.

**What goes wrong,** from SST's issues:

- Every package sees every resource. A function can name one it isn't linked to: it compiles, then throws "not linked" (SST's #5520, #5519).
- Types come from values, so a function's name is a `string`, not its name (#6000). Before the first deploy there are no types at all, so a fresh clone or CI fails its type check.
- `sst remove` empties the types (#5926, #6907), two apps in one repo write over each other's (#6228), and paths break on Windows (#5833, #6825).

**In the rewrite:**

1. **`Resource.MyBucket.name` stays.** How code reads a resource isn't the problem.
2. **Types come from the components, not from deployed values.** A component declares the shape of what it links, as part of what it declares to the core, and the generator writes `MyBucket: Linked<"sst.aws.Bucket">`. Types are there after `sst install`, with no deploy, they're exact, and nothing a deploy or a remove does can empty them.
3. **Each package gets only its own links**: what's linked to the functions and sites in it. A package with no links gets no file. Naming a resource that isn't linked fails the type check, in the right place.
4. **The link format is written down,** as one documented shape: small values in an environment variable, larger ones and secrets in the encrypted file. Any language reads it in a few lines. The fork publishes its own readers for Python, Go and Rust, and each runtime writes its language's types through `Runtime.Types`.
5. **Today's variables keep being written** while SST's SDKs are in use. A change to the format updates each function once, in place.

Not taken:

- **Types for each function.** They'd need a wrapper around every handler, which changes how every handler is written. Packages get most of the benefit.
- **Reading values at run time**, from SSM say. Slower cold starts, more permissions, and a new way to fail. Values stay baked in when a function deploys.
- **Types in `node_modules`**, as Prisma did for years. Prisma now asks for an output folder in the project, after `node_modules` broke under pnpm and in monorepos.

### Safety rules

The rules that hold for every app live in the core, where nothing a package does can weaken them. They need no grants:

- **Listeners are the core's, on loopback, with a token.** That includes the RPC the program calls back into (`pkg/server`), which also offers only the methods the program uses.
- **Containers are started by the core**, with their ports on `127.0.0.1` only. A target that needs the Docker socket says so in its settings, and the core says so when it starts it.
- **On a target's stage, nothing gets the developer's credentials.** The program, the workers in `sst dev` and `sst shell` get the target's. The developer's `AWS_*` variables, profile files and proxies are taken out, as #212 does (`FlociEnvironment`).
- **A stage that uses a target is bound to it in the config**, and to the target's own home. `sst remove --stage local` finds the target in the config, not in a flag or an environment variable, so forgetting one can't remove the real stage.
- **A home that finds no state for a stage with history is refused** (see [the state contract](#the-state-contract)).

**Packages are trusted like any other dependency.** A package's components run in the Pulumi program with the deploy's credentials, and npm runs its install scripts. So 5.0 makes no promise to contain a package. It promises the rules above hold for every app.

These are #212's review findings, prevented by the core, not by each package getting them right:

| Found in #212's review | Prevented by |
| --- | --- |
| Floci 2.3.0's web console is on by default, on every interface, with no login. | Containers publish ports on loopback only. |
| The bridge listened on `0.0.0.0`. | Listeners are the core's, on loopback, with a token. |
| A local `sst remove` needed an env prefix, so forgetting it would remove the real AWS stage. | A target's stage is bound to its target and home in the config. |
| The Docker-socket trust wasn't documented for users. | The target's settings say it needs the socket, and the core says so when it starts it. |
| The allowlist was pinned to Floci 2.3.0 and AWS provider 7.48.0, and a 35-minute Docker CI ran on most PRs. | The allowlist ships in the Floci package, which pins and tests what it supports in its own CI. |

### One authoring model

Components, checks, targets and runtimes are written the same way, and v5 already has most of it for components:

- **Typed**: `sst/components`, with `sst.target`, `sst.runtime` and `sst.check` beside `sst.component`.
- **Tested without the cloud**: `mock()` for components and checks, and each kind's suite for targets and runtimes.
- **Published as npm packages**, found by keyword, as [v5-community-packages.md](v5-community-packages.md) step 3 plans for components.
- **Version-checked** on deploy, as `pkg/project/packages.go` checks peer dependencies.
- **Documented from the source.**
- **Easy to set up.** A package shouldn't need `moduleResolution: "bundler"`, `skipLibCheck` or a pinned `google-protobuf`, and a group shouldn't pull in every provider. Each is fixed in step 3, or the reason it can't be is written down.

### A test suite for each

Each place to plug in has a suite. SST's built-ins pass it first, and a package's target or runtime runs it in its own CI.

- **home**: two clients race for the lock and one wins. A stale lock is reported. A checkpoint round trip is byte for byte. The passphrase stays the same. A home that finds no state for a stage with history refuses. Built-in homes also read a recorded state 4.x wrote.
- **runtime**: builds a fixture function, which then answers on a fake runtime API. A change to a watched file rebuilds it. A build error is reported. Its types match what's linked.
- **transport**: the pieces are there, not the suite. The `bridge` package's tests have fake connections that lose, shuffle, delay and fail packets (`lossyAppSync`, `shuffled`, `slowConn`, `failingConn`), and `cmd/sst/mosaic/aws/harness_test.go` runs the real dispatch loop against a fake AppSync and a fake stub. But each fake replaces the transport rather than testing one, and the stub's own loop isn't run by any test. The suite takes a transport and runs one set of behaviors against it: loss, reordering, copies, a full subscriber, reconnecting, large payloads, many invocations at once, and the time it adds. The fakes become wrappers around the transport under test.
- **target**: on its stage, the program, the workers and `sst shell` have none of the developer's `AWS_*` variables and can't read a planted credentials file. Every provider endpoint is the target's: a run behind a proxy that fails any other host passes. Its stage can't reach the real home.
- **check**: findings on fixture programs. An unknown value in a preview is reported, not dropped.

## What carries over from v5

| From v5 | Where it is | In the rewrite |
| --- | --- | --- |
| `component()` and parts | `parts-component.ts`, `parts.ts`, `transform.ts`, `args.ts` | As it is. |
| Takeover maps | `takeover.ts`, `aws/takeover/` | State maps, applied by the core. |
| The takeover check | `test/helpers/graph.ts` | Runs against recorded states as well as the mock. The core of `sst migrate --check`. |
| `mock()` | `platform/src/testing/` | As it is, and for checks too. |
| Packages, SST as the host | `pkg/js/js.go`, `pkg/project/run.go`, `install.go`, `tsconfig.go` | Packages with targets, runtimes and checks load the same way. |
| The peer-dependency check | `pkg/project/packages.go` | Checks those packages too. |
| Generated docs | `www/generate.ts` | Pages for targets, runtimes and checks as well. |
| The V5 components | `aws/v5/` | Where the new components start, where that helps (step 4). The alphas stop. |
| The `sst dev` harness | `cmd/sst/mosaic/aws/harness_test.go`, `bridge` tests | The pieces of the transport suite. |
| The template package | `examples/component-package/` (on `v5-community-packages`) | A template for a target package next to it. |
| The goals | [v5-goals.md](v5-goals.md) | Goals 1, 2 and 6 become the state contract. Goal 3 (anyone can write a component and share it) widens to checks, targets and runtimes. Goal 4 (installing changes nothing) doesn't carry over: an app stays on 4.x until it moves, and moving is one checked step. |

## The user's migration path

1. **Stay on 4.x until every component you use has a 5.0 form.** The migration guide lists them.
2. **Upgrade the CLI.** On a stage that hasn't moved, only `sst migrate`, `sst diff` and commands that only read run.
3. **Rewrite the config.** `sst migrate --codemod` makes the changes that are mechanical: `sst.aws.v5.X` to `sst.aws.X`, and the few renamed args. It lists what it couldn't do.
4. **Check.** `sst migrate --check --stage dev` previews the move with the state maps. It passes with nothing created or deleted beyond what the maps list as having nothing in the cloud or release, and nothing that holds data replaced. It shows what will update in place.
5. **Move.** `sst migrate --stage dev` takes the lock, saves a copy of the state in the home, deploys with the maps, and leaves the marker and the tombstone.
6. **Confirm.** `sst diff` shows nothing to create or destroy.

Stage by stage, a dev stage first and production last. A stage deployed by `sst dev` has stubs in place of functions, so `--check` covers that shape too. If a move goes wrong, the saved copy can be restored with the 4.x CLI before any other deploy. The guide says how, and step 5 tests it.

## Steps

Each step has an exit test. A step that fails its test stops the plan until it's thought through again.

### 0. Write down what v5 taught

[What v5 taught](#what-v5-taught), above.

**Exit:** the maintainer has read it and nothing is missing.

### 1. A record of today's state, from real deploys

Deploy as few apps as cover the cases, with the latest 4.x (v4.23.1 now), and export their states:

- **The v5 lab app**, with what it lacks added: a `Vpc` with NAT and a bastion, a `Router`, and a `Nextjs` site behind it. Its groups are deployed one at a time.
- **The same app's serverless group, deployed by `sst dev`**, for `Function`'s dev stubs.
- **One Cloudflare app**: a `Worker`, a `Bucket`, a `Kv` and an `Astro` site. It can wait until step 4 reaches the Cloudflare components.

Every Core component of [v5-core-set.md](v5-core-set.md) has to be in one of them. One that isn't is added to the lab app, not given an app of its own.

For each: deploy, call what's deployed, check `sst diff` shows no changes (an app that doesn't settle on 4.x can't be a baseline), export the state, scrub it, commit the scrubbed copy. Then try replaying a preview from it with the app removed.

**Nothing stays deployed.** An app is removed as soon as it's recorded, unless the next check that needs it comes shortly after. After every removal, the lab audit runs, and anything SST left behind for the app is deleted and checked gone. A later step that needs a live stage deploys it again. If a recorded state can be replayed, most later checks need no deploy at all.

**Exit:** every app deployed, settled and recorded. The scrubbed states are in the repo with the scrub test. Everything is removed, and the lab audit shows nothing left. We know whether a recorded state can be replayed.

### 2. The first proof that it's viable

Today's CLI, with its homes behind the new `Home` interface, reads an existing home, takes the lock, and previews an unchanged 4.x app with zero diff. If that works, the rest is building.

- **The state and lock code moves behind `Home`**, in Go, as it is, plus the conditional put and the guard for a home that finds no state.
- **The 4.x components run unchanged, as a test of the core.** 5.0 doesn't ship them. Here they keep the core's changes apart from the components', so a diff points at one or the other.
- **That test copy gets 4.x's preview fix.** A 4.x function built inside an `apply` shows as deleted in `sst diff` (v5 goal 6), so without the fix no app that has one can show zero diff. The fix changes only the preview, not what's deployed.
- **A pre-release that only runs `sst diff`**, so real apps check the core, not only the lab. `diff` takes no lock and writes no state.

**Exit:**

- `sst diff` from the new core shows no changes for every recorded app, deployed again or replayed, as step 1 found. Not even the provider entries, since the platform is the same.
- During a deploy by the new core, a 4.x deploy of the same stage is refused, and the other way round. Two new cores started at the same moment: one gets the lock.
- No new passphrase is created. After a deploy, the home holds the same kinds of objects a 4.x deploy writes, and nothing else.
- After a deploy by the new core, the 4.x CLI's `sst diff` shows no changes.
- A home pointed at the wrong place, for a stage with history, refuses to deploy.
- What the new core gives the program matches [today's](#todays-home-and-program), item by item, with a test for each that can have one.
- The diff-only pre-release is out, and no app that ran it shows a change the lab can't explain.

### 3. Places to plug in, and Floci on them

- **The interfaces, in Go, with SST's built-ins behind them as they are**: the three homes, the five runtimes, the AppSync transport, and the real cloud as a target. A suite for each, which the built-ins pass.
- **`sst.target`, `sst.runtime` and `sst.check` for packages**, and a stage's target in `app()`.
- **The safety rules**, the RPC's included: loopback, a token, and only the methods the program uses.
- **Package setup fixed**: `bundler`, `skipLibCheck`, the protobuf pin, and a group that pulls in every provider.
- **#212 on them**, with rogueturnip:
  - into the core: its HTTP transport behind `bridge.Conn` (`cmd/sst/mosaic/aws/local/local.go`), its client that only reaches one endpoint (`pkg/project/provider/floci.go`), and its environment stripping. Its fix for `true`/`false` and number provider settings comes with it.
  - into a Floci package, in a repo of its own: its target settings, and its allowlist (`platform/src/floci/check.ts`, `profile.ts`) as a check. It runs on the 4.x components the core still runs as a test, and moves to the new ones in step 4.

**Exit:** the built-ins pass their suites, and a deploy still shows no diff, as in step 2. A Floci stage runs an app in `sst dev` and can't reach the real stage or home. Each of #212's review findings is closed by a core rule. The Floci package passes the target suite in its own CI.

### 4. New components

Starting from the V5 ones where that helps, for the Core tier of [v5-core-set.md](v5-core-set.md). Then Cloudflare's most used components, `Worker`, `Bucket`, `Kv` and `Astro`, after the AWS ones. The draft `v5-core-set.md` still keeps the Cloudflare components as 4.x, and has to be brought in line. A component keeps the 4.x args unless a reason is written down.

- **`sst migrate --check` first.** It's the gate for every component.
- **The hard ones next, as a gate**: `Function` with its dev stubs, `Nextjs` with `Router`, and `Vpc`, and releasing and adopting `BucketFiles` and `KvKeys`. If a component can't move without replacing a resource, stop: that answers a viability question the wrong way, and the design changes before anything else is ported. If the release doesn't pass cleanly, SST's provider resources stay as they are for 5.0.
- **Then the rest of Core, then Cloudflare's.**
- **SST's own provider resources move into the `sst` binary**, if the gate passed, alongside the components that create them, each as [its kind](#how-each-provider-resource-moves) says.
- **Zipping and hashing are timed** on a large site, and moved to Go only if they're slow.
- **The Floci package moves to the new components.**

**Exit, for each component:** its state map passes `--check` against every recorded state it's in. Then a real deploy in the lab, compared by cloud id, keeps every resource.

**Exit, for the provider resources:** after the move, the site serves the same files, the router has the same routes and the worker runs the same script, and the old entries have left the state without a delete.

### 5. Moving an app

- **Each Kept and Community component of [v5-core-set.md](v5-core-set.md) gets a decision first**: ported, left to a package, or dropped with what to use instead.
- **The codemod, `sst migrate` for a whole app, the marker and the tombstone**, and the refusal on a stage that hasn't moved.
- **A migration guide** that lists which components have a 5.0 form, and says plainly: don't run `sst unlock` on a stage that has moved.
- **The core stops running 4.x components**, and what it kept for them goes: their globals, the output names, and the RPC methods only they call.

**Exit:** every recorded app goes through the user's path in the lab: codemod, check, move, and `sst diff` shows nothing to create or destroy. Compared by cloud id, every resource is kept, and data written before is read after. A 4.x CLI is refused on a moved stage. The saved copy is restored with the 4.x CLI once, and works. Then the same for an app in daily use, on a stage of its own. When this passes, `v5-rewrite` is merged into `v5`, and 5.0.0 can be released from there.

### 6. After 5.0

- **More targets and runtimes as packages**, when someone needs them: LocalStack, Ruby, .NET.
- **A host for package code**, in a 5.x release, when a package needs to run code in the CLI ([No host in 5.0](#no-host-in-50)).
- **SST's provider resources into the `sst` binary**, if they didn't make 5.0.

Each comes when it's needed, with its own exit test.

## Viability questions

| Question | How it's answered |
| --- | --- |
| Can a new core drive existing state with zero diff? | Step 2: every recorded app shows no changes, the lock holds both ways, 4.x reads what the new core wrote, and real apps run the diff-only pre-release. |
| Can the worst components be restructured with a verified state map: `Function` with its dev stubs, `Nextjs` with `Router`, `Vpc`? | Step 4 does these three first. Each passes `--check` against the recorded states, then a real deploy compared by cloud id. `Vpc` is the one to watch: most of its resources are named by a `Name` tag, so a renamed part means a tag update, which is allowed, and nothing else. |
| Can a package plug in without running code in the CLI? | Step 3: Floci, as a target's settings and a check, with the core doing the rest. |
| Can the fork's maintainers carry it? | See below. |

**Carrying it with a small team.** Their time is small, so the plan leans on machines for safety and on scope for size:

- **The recorded states and `--check` turn "did we break anyone's state" into a test.** A pull request that changes a component runs its state map against real recorded states in CI, with no AWS. Nobody has to remember what 4.x deployed.
- **The lab runs once per step and per release**, not per pull request.
- **No component is kept in two copies.** 5.0 has only the new ones, and 4.x stays on `main`.
- **Fewer moving parts.** No host, no protocol and no grants in 5.0, and the built-ins stay the Go that works today.
- **Packages move work out.** Floci and whatever comes after it are maintained by the people who need them, in their own repos, with their own CI.
- **Each step stands alone.** Steps 1 and 2 are useful even if the rest waits: the recorded states and the diff-only pre-release test the core against real apps.

## Risks

- **The rewrite never ships.** Each step has an exit test and a result that's useful on its own. Step 2 is small on purpose.
- **Apps wait for components.** An app that uses a component with no 5.0 form stays on 4.x. Step 5 decides each one before 5.0.
- **A person can still unlock a moved stage.** The tombstone stops a 4.x CLI in CI, but its message says to run `sst unlock`. The guide says plainly not to.
- **The mock misses real bugs.** Recorded states fix the "before" side. The "after" side still needs a lab deploy for each component and each release.
- **Provider versions move.** 5.0.0 ships with the versions of the 4.x it's built from, so a move changes no provider. A later bump changes the default provider's address, which `sst diff` shows as the provider being replaced, and a docker-build update can rebuild every image once (see `MAINTAINING.md`). Release notes say so.
- **Pulumi changes underneath.** The rewrite pins Pulumi as 4.x does. Pulumi's own checkpoint format is outside this plan's control. A Pulumi bump is tested as `MAINTAINING.md` says.
- **Packages aren't contained.** The safety rules hold for every app, but a package runs with the deploy's credentials. The docs say so: install packages you trust.
- **Scrubbing misses something.** The scrub test looks for account ids, and a maintainer reads each scrubbed state before it's committed.
- **SST's fixes stop arriving for free.** The new components don't match SST's files, so a fix from SST is ported by hand. SST is mostly quiet now, so there's little to port.
- **A release leaves something behind.** A released resource is no longer tracked. If the new one doesn't take over exactly what the old one wrote (the same files, the same keys), the rest stays in the cloud. Each provider resource's tests check that it does.
- **The places to plug in turn out wrong.** SST's own built-ins go behind them first, and Floci in step 3, before anyone else builds on them. They're versioned so a second version can follow.

## Open questions

1. **How long does `main` get fixes after 5.0.0?** Users stay on 4.x until their components have a 5.0 form, so they need to know. Proposed: a date set when 5.0.0 is released, at least six months out, in its release notes.
2. **What happens to each Kept and Community component?** Ported, left to a package, or dropped with what to use instead. Settled in [v5-core-set.md](v5-core-set.md) before step 5.

## Today's home and program

What step 2 checks the new core against, read from the code on `v5` on 2026-10-31. The home half stays for good. The program half goes with the 4.x components in step 5.

### The home

- **AWS:**
  - **Bootstrap** is the SSM parameter `/sst/bootstrap`, JSON with a `version`. Its steps only ever add: the buckets `sst-asset-<id>` and `sst-state-<id>` (versioned), the ECR repository `sst-asset`, a policy that requires TLS (`provider/aws.go`). It's per region, and the home uses the app's region.
  - **Keys:** `<kind>/<app>/<stage>.json` in the state bucket. The kinds are `app` (the checkpoint), `lock`, `secret`, `update`, `snapshot` and `eventlog`, and `summary`, which older CLIs wrote and retention and purge still clean up. With `state.compress`, objects are gzipped; reads accept both.
  - **The passphrase** is the SecureString `/sst/passphrase/<app>/<stage>`, created once with `Overwrite: false`, from `SST_PASSPHRASE` or 32 random bytes.
  - **Secrets** are one object per stage, AES-256-GCM with the passphrase as the key, plus `_fallback` for every stage.
  - **The lock** is `{created, updateID, runID, command, ignore}`. A lock left behind needs `sst unlock`.
  - **Retention and purge** (`state.retention`, `state.purge`) delete old history and old versions, and on a remove that leaves nothing, the passphrase.
  - **Credentials** are resolved by the home: profiles, `assumeRoles`, and `us-east-1` when no region is set. The program gets the bootstrap data through the RPC (`Provider.Aws.Bootstrap`).
- **Cloudflare:** the R2 bucket `sst-state`, keys `<kind>/<app>/<stage>` with no `.json`, and the passphrase as an object.
- **Local:** files under the user's config folder, `sst/state/<kind>/<app>/<stage>.json`, and the passphrase as a file.
- **Outside the state:** the shared AppSync Event API named `sst`, or the stage's own, found or created with the SDK.

### The program

- **Pulumi is run as a command**, not through the Automation API, in `.sst/pulumi/<updateID>/` with a file backend. SST writes only `Pulumi.yaml` (`name: <app>`, `runtime: nodejs`). The stack is `organization/<app>/<stage>`, and the passphrase is given as `PULUMI_CONFIG_PASSPHRASE`. There's no stack config file, so the passphrase's salt is only in the checkpoint.
- **Pulumi 3.267.0**, the CLI and `@pulumi/pulumi` at the same version, with `PULUMI_HOME` in SST's own folder and ambient plugins ignored.
- **Provider settings** from the config are passed as `--config`, after the AWS home adds `defaultTags` `sst:app` and `sst:stage` and the region, and moves `profile` to the environment. The default provider's address includes its version, so the versions in `.sst/provider-lock.json` and the platform's pins decide whether it changes.
- **The environment:** the user's, the home's credentials as `SST_AWS_*`, each secret as `SST_SECRET_<name>`, `NODE_OPTIONS`, and `SST_SERVER`, the RPC the program calls back into.
- **What's defined in the program:** `$app` (the config's `app()` as the CLI read it), `$cli` (the command, dev or not, paths, and the component versions read from `sst:sst:Version` outputs in the state), `$dev`, the `sst` global, and a global for each provider.
- **What SST applies to every resource:** `retainOnDelete` from `removal`, imported resources ignoring `tags`, a physical name with a random suffix that's then in `ignoreChanges`, a `Name` tag for the types named by one, and the `_protect` output (`auto/run.ts`, `component.ts`, `naming.ts`).
- **What the CLI reads back:** outputs named `_dev`, `_task`, `_tunnel`, `_hint` and `_metadata` (`pkg/project/completed.go`, `cmd/sst/mosaic`), the `version` of each `sst:sst:Version`, and every function's build input, which the program sends with `Runtime.AddTarget`.

## Found while planning

- **A `true`/`false` or number provider setting is dropped without a message.** `pkg/project/run.go` passes only maps, lists and strings to Pulumi as `--config`, on `main` and on `v5`. #212 fixes it for every app, because Floci needed the `skip*` flags, and the rewrite takes the fix with #212 in step 3.

## Status

| Step | Status |
| --- | --- |
| The plan | A draft. Decisions taken 2026-10-31, and revised the same day after an independent review. |
| 0. What v5 taught | Written in this plan, 2026-10-31. |
| 1. A record of today's state | Not started. Needs AWS. |
| 2. The first proof | Not started. |
| 3. Places to plug in, and Floci | Not started. |
| 4. New components | Not started. |
| 5. Moving an app | Not started. |
| 6. After 5.0 | When needed. |
