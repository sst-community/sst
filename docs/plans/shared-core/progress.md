# One engine for SST 4's and SST 5's components: progress

The log, newest first. The plan is [plan.md](plan.md).

## 2026-11-13: the reviews' fixes

Two independent reviews of #272's last ten commits, one for compatibility with SST 4.25.0 and one for the architecture. The maintainer chose to fix all seven of what they found, to keep provider booleans and numbers with a release note, and to read `app()` on SST 4's line as 4.25.0 did.

- **`release.yml` builds the SDK** before the Go tests on `main`, as `check.yml` does and `v5`'s release already did. Without it a release tag on `main` would have failed its Go tests.
- **The manifest's `contract` is required.** A manifest without it was read as contract 0, so a merge that dropped the key from `v5`'s `platform/package.json` would have run SST 5's components as SST 4's. `ContractFor` refuses it now, and `PlatformManifest.Speaks` is what the tests gate on.
- **SST 4's line skips a newer `_sst` record**, with a warning in the log, and reads the component by SST 4's names, as 4.25.0 did. It stopped every command on the stage before.
- **One handler check** (`engine` only: `v5` gets #262's check with its next merge of `main`). `Collection.ValidateHandler` picks the runtime as the build does, so a function with its own `bundle` built by `sst.runtime`'s commands isn't checked as Node.js, and `sst dev`'s `AddTarget` uses it too.
- **The SDK's Pulumi peers take any version**, on both lines, so an app that pins an older `@pulumi/pulumi` installs without npm's `ERESOLVE`. `sst/pulumi` says so under `sst pulumi dev` if it's older than 3.115.
- **`app()` on SST 4's line loads the providers' modules** the app's files import, as 4.25.0 did (`Contract.LoadsProvidersForApp`, `js.EvalOptions.LoadProviders`). SST 5's line leaves them out, as before. `TestBuildReadingAppLoadsProviders` has both. A namespace import of a left-out module reads as empty there (`aws.defaultRegion` is `undefined`), rather than throwing "only loaded in run()".
- **#272's description** lists the rest of what changes for an SST 4 user, with the release notes: provider booleans and numbers, a daily update check, `sst dev`'s server on loopback with a token, `sst diff` creating no passphrase, the missing-state refusal, `sst add` within the components' major, the workers that start again after a change, and `lock5` on a team that still runs 4.25.0.
- **Checked**: both lines' Go suites (46 packages on `engine`, 45 on `v5`), `-race` on the changed packages, and the SDK's build and tests on both lines.

## 2026-11-13: `sst pulumi dev` on SST 4's line

- **The CLI**: `sst pulumi dev` has no contract of its own any more, and the Pulumi project's discovery isn't gated on the platform's contract. A test runs it on contract 0.
- **SST 4's `sst` package** ships `sst/pulumi`, `schema/sst.dev.json` and `sst/pulumi`'s tests, the same files as SST 5's, with `@pulumi/pulumi` and `@pulumi/aws` as optional peers, and the versions SST 4's platform has as dev dependencies. `TestSchemaMatchesDevFile` runs on both builds now.
- **Main's docs** have "Use with Pulumi", SST 5's page with SST 4's package to install, and SST 5's components in a Pulumi program sent to SST 5's docs.
- **In the lab**, with an SST 4 CLI and SST 4's package packed from `engine`, on a plain TypeScript program with a role, a Lambda function and its URL, on a local backend: `sst pulumi dev` deployed the stub, the function answered from its local source and again after each edit, the dev command ran, a plain `pulumi up` put the deployed code back and took SST's dev policy off, and `pulumi destroy` left only the function's log group, deleted.

## 2026-11-13: shared platform files, and SST 5's report on SST 4's line

- **Nine platform files are shared**, of the 15 top-level component files both platforms have: the eight that were already the same, and `error.ts`, whose one dependency on SST 5's `context.ts` is written out in it. `shared.test.ts` lists them and fails on an import of a file that isn't one of them; with `error.ts` as it was, it named `./context.js`. `error.ts` on SST 4's line now keeps an error's message as it's written: Pulumi added the property it was serializing to it.
- **`pkg/sst4` reads a component's `_sst` record** with the engine's reader (`project.ReadReport`, exported for it), over SST 4's output names when a component has both, and stops on a record from a newer contract, as SST 5's line does. `TestReadSST5Record` fails on the read before. SST 4's recorded states read as before.
- **End to end**, with no cloud: an SST 4 app with a local home and one plain Pulumi component that writes `_sst`. A CLI from before showed no hint after its deploy; one with the change showed it, and its `sst dev` ran the component's pane.
- **Checked**: both lines' Go tests of the contract packages under `-race`; SST 4's platform (41 files, 418 tests) and `tsc`; SST 5's platform (123 files, 4322 tests) and its API reports, unchanged.

## 2026-11-13: one stub, and custom runtimes for SST 4

- **How close the lines are.** Measured against `engine`: the Go engine differs from `v5`'s only by `main`'s ports (#262, #267, #269's test) and one test's gate, which `v5` gets with its next merge of `main`. What's SST 4's alone is `pkg/sst4`. The one piece of the engine left on the platform side was the `sst dev` stub's entry point, with a copy on each line that had drifted (SST 5's has #212's HTTP transport). The local runtimes' shims (`functions/nodejs-runtime`, `python-runtime`, `nodejs-bridge`) are on the platform side too, but the same on both lines.
- **The stub moved into the engine**, at `cmd/bridge/`. Both lines now build a byte-identical stub. On SST 4's line, the HTTP transport is never taken, as no stage has a target.
- **Custom runtimes on SST 4.** `sst.runtime` and SST 4's `Function` taking one. A runtime and injections given as they are are checked at construction, and through outputs as they resolve. For a runtime's name, the build input is the same as before. Tests are in `platform/test/components/function-runtime.test.ts` on `main`. Main's docs get the "Custom Runtimes" page, and on both lines the generator links the `Runtime` type to it, not to a component page that doesn't exist.
- **.NET through `sst.runtime`**, for the users who asked for .NET (#264): a sample app on SST 4's line, in the lab.
  - Two functions on Lambda's `dotnet10`: an executable that starts Lambda's runtime client itself (handler `Hello`), and a class library as AWS's templates write one (handler `Api::Api.Function::Handler`).
  - Both deployed and answered, and one read its linked bucket by decrypting its links in C#.
  - In `sst dev` both ran on this machine with `dotnet`. The class library has a one-line `Main` that hosts it with `Amazon.Lambda.RuntimeSupport`'s `RuntimeSupportInitializer`, as Lambda's .NET runtime does; Lambda never calls it.
  - An edit rebuilt each once, as `watch` only takes top-level files (`dotnet` writes `.cs` files under `obj/`).
  - Removed and cleaned up. The Custom Runtimes page has a .NET section from it on both lines.
- **A fix in #262's port**: `sst dev`'s `AddTarget` checked a handler as the Lambda runtime's name would build it, even for a function its own commands build, whose handler may not exist before they run. Now it doesn't (`pkg/server/runtime`'s test).

## 2026-11-13: no targets on SST 4's line

- **The lab passed on `engine`**, and it's draft PR #272 onto `main`, whose CI passed.
- **A target was still open to SST 4's line.** The engine reads `targets` from `app()` whatever the platform. So an SST 4 app that wrote it, which SST 4's types don't declare, would have had its stage run on an emulator nobody has tried SST 4's components on, without `sst target stop` or `reset`.
- **The contract says now** (`RefuseTarget`). SST 4's refuses a stage with a target before anything runs: "The "local" stage has a target in app(), and SST 4's components deploy only to the cloud. Targets come with SST 5." SST 5's refuses none. `TestStageTarget` and `pkg/sst4`'s `TestRefuseTarget` pin it.

## 2026-11-13: checkpoint B, the shared resources' guard and each line's commands

- **A project without a contract stops at once** (the review's one change to A). SST 4's stored provider code takes a call the RPC doesn't serve as done, so a remove run without a contract would drop a site's files, routes or DNS records from the state and leave them in the cloud. The engine reads the contract only through `speaks()`, which panics, saying a `Project` is made with `project.New`. `New` is the only place one gets a contract. `pkg/server`'s test of SST 4's stored provider code makes its project with `New`, and runs on a platform that speaks SST 5's contract.
- **The resources SST 4's line shares with SST 5's are held to what SST 4 sends** (`pkg/sst4/shared_test.go`). Each entry SST 4 left in the lab's states for bucket files, the distribution's waiter and invalidation, and KV keys and routes (21 in all) is checked. Its inputs, and its outputs as an update's `olds` and a delete's `outs`, go through SST 5's structs and back, and every field they had comes back with its value. A field renamed in a struct fails it (checked with `namespace` and a file's `hash`). The MicroVM image's prune isn't in the recordings: its fields are pinned to what SST 4's component sends.
- **Each line has its own commands.** A command says the least contract it needs (`cli.Command.Contract`): `migrate` (with `--codemod`), `eject`, `target` and `build-server` need SST 5's. The CLI keeps the commands its platform's contract has. On SST 4's, `sst dev` finds no plain Pulumi program, and a `Pulumi.yaml` given with `--config` is taken as SST 4.25.0 took it. A test lists both lines' commands: SST 4's are 4.25.0's but `cert`.
- **Left where they are**: the move's marker, `keepMarker` and the tombstone at the end of a run. They're SST 5's, and do nothing on a stage SST 4's line runs on.
- **Checked**:
  - Both builds' whole Go suites (45 packages each). `-race` on `pkg/project`, `pkg/sst4`, `pkg/server`, `cmd/sst` and `cmd/sst/cli` on both. The SST 4 build's CLI says its platform speaks contract 0.
  - New files under `cmd/sst` are ignored by `.gitignore` (`sst`), so they're added with `-f`. A copy of the changes that lists untracked files misses them, as the SST 4 copy did at checkpoint A: its `cmd/sst` contract test hadn't run there until now.
  - `tcell-term`'s `TestAnywhere` fails under `-race` at `v5-thin-layer`'s tip too, before any of this: a race of its own.

## 2026-11-13: the PR's branch, and `sst dev`'s start

- **`v5` holds the thin layer and the engine**: local `v5` was moved forward to this branch. Pushing it is the maintainer's call.
- **`engine`** is the branch for the pull request onto `main`: `main` with the engine and nothing else of SST 5's.
  - Its `cmd`, `pkg` and `internal` are this branch's, with `main`'s Go changes since `7c8a2d529` ported onto them.
  - **#262** (handlers checked in `sst dev`'s deploy) is ported, and the command runtime of `sst.runtime` checks nothing, as its build command says what a handler is.
  - **#267's Go part** is ported.
  - **#269 is superseded**: a global reaches a file through esbuild's `define`, under a name of the CLI's, so a dependency's own top-level `postgresql` (sql-formatter's) never clashes. `TestBuildDependencyDeclaringAGlobalsName` pins it.
  - `TestSchemaMatchesDevFile` skips on SST 4's platform, whose SDK has no `sst.dev.json`.
  - Beside the engine, `main` gets the manifest, a CI step that builds the SDK before the Go tests (the runtimes' tests import it), and the Console docs without "Local logs", as on `v5`.
- **The lab on `engine`'s SST 4 CLI**, against a CLI built from `main`, found one bug of the engine's, in `sst dev`'s start.
  - `sst dev --mode=basic` exited about 250 ms in, deploying nothing, twice in about six runs.
  - The UI asks for sst dev's events once the server is ready, and sst dev registered its routes in a goroutine, so the first ask could get a 404. `Stream` took that as the end of the events, and the UI ended the CLI.
  - The routes are registered before the server serves now (`dev.Register`), and `Stream` waits for sst dev as `Deploy` did.
  - `TestStreamWaitsForSSTDev` fails on the code before: the stream closed at once. `TestRegisterAddsTheRoutesAtOnce` pins the order.
  - `main` has the same shapes, so it was there in 4.x too, unseen.

## 2026-11-13: the lab, SST 4.25.0 against the engine's SST 4 CLI

The other session ran it, as it did for the POC. SST 4.25.0 deployed each stage first. Then came 4.25.0's own diff, the engine's diff and deploy, and 4.25.0's diff after.

- **Serverless**: no changes in any of the three diffs, and the engine's deploy changed nothing.
- **Websites**: the same 22 changes in all three, the server-rendered sites' usual rebuilds, and the engine's deploy changed only those.
- **Cloudflare with its sites**: the same 26 changes in all three, which are 4.25.0's own settling on a second deploy and the sites' rebuilds.
- **Containers**: these differed, but not because of the engine. The SST 4 copy had `main`'s platform at `8818b87e9`, where #267 stops a `Service` making a `DevCommand` for a container with no `dev.command`. So the engine deleted two that 4.25.0 keeps. The same engine with 4.25.0's own platform (and the contract-0 manifest) diffed as 4.25.0 does, and 4.25.0's diff after its deploy had no changes.
- **Everything else**: every route, worker, service and data store answered as under SST 4. `sst dev` ran on the serverless and Cloudflare stages, without the POC's crash. The engine removed every stage, including SST 4's 28 resources the RPC serves on the websites' stage (25 through the shared ones). Every lock was released.
- **Findings for the plan**:
  - `main`'s Go changes since the branch's base have to come in before the engine replaces `main`'s ([plan](plan.md#before-the-engine-goes-into-main)).
  - #267 needs a release note.
  - The dev stub isn't byte for byte 4.25.0's, and the POC's lab hadn't shown that: its `sst dev` used the `.sst/platform` 4.25.0 left, as both CLIs were labelled 4.25.0. It's recorded under [known differences](plan.md#known-differences-of-sst-4s-line-on-this-engine).
- **Seen once**:
  - 4.25.0's own first deploy can exit 0 while its log says "✕ Failed" when several stages start at once, which is 4.25.0's own behaviour.
  - One `sst dev` with the engine stopped about 2 ms after starting Pulumi, exited 0 and left an empty log. It didn't happen again, and its cause wasn't found.
- Everything the lab made is removed and cleaned up.

## 2026-11-13: checkpoint C, the SST 4 CLI for the lab

- Built from the SST 4 copy as 4.25.0, labelled `sst-community-core4` (`sst version` prints `sst 4.25.0 (sst-community-core4)`).
- Its command tree (`sst introspect`: commands, subcommands, flags, arguments, hidden) is `main`'s at `8818b87e9`, built as 4.25.0 with the same platform, but for `sst cert`.
- Handed to the other session, which runs the lab against 4.25.0 as it did for the POC.

## 2026-11-13: checkpoint A, the contract, `pkg/sst4` and the manifest

- **The contract** (`pkg/project/contract.go`): `Begin`, `Read`, `Locked`, `Refuse`, `Define`, `RegisterRPC` and `HoldsProviderMajors`. Each place in the engine that spoke SST 5's contract makes one call to it. `programContract` (`program_contract.go`) is SST 5's, with what the engine did before: the move's start, `_sst`, the refusal of a stage SST 4 deployed, `$cli` with the stage's state, `Provider.Aws` and `Move`.
- **What the contract keeps of the state for itself** (SST 4's versions) is read by `Read`, inside `getCompletedEvent`, as each resource is read and before the event is published. It travels as `CompleteEvent.Contract` to `StageState.Contract`, and isn't sent. A test reads it with a contract that writes the event as SST 4's does, while another goroutine encodes it. Under `-race` it passes, and a read moved after the publish fails it.
- **The lock**: `Lock` takes it, then asks the contract, and on a refusal releases it and drops the update. The tombstone stays, as `Unlock` with nothing known of the run leaves it.
- **`pkg/sst4`**, SST 4's contract:
  - `$cli` in SST 4's shape, with the versions;
  - reports from SST 4's output names;
  - a move refused before anything is read, and a stage on SST 5's components refused but for a diff;
  - a stage with the tombstone refused once it's locked;
  - no hold on a provider's major version;
  - its RPC. Six of its resources are SST 5's own types, given the stage's AWS setup as SST 4 gave it (bucket files, the distribution's waiter and invalidation, KV keys and routes, the MicroVM image prune). The rest are `main`'s copies, with its tests, and `SST_BUILD_CONCURRENCY_SITE` is the package's own.
  - It registers itself as it loads, and `cmd/sst` imports it, so SST 5's build carries it too. The POC's tests run against it directly, with the three states SST 4 left in the lab.
- **The manifest**: `sst` in `platform/package.json`, read through `platform.PackageJson()` into `js.PackageJson`, so neither platform's `platform.go` changes. `New` reads it and fails, saying why, when this CLI doesn't speak the contract it declares. It gives the type files (`writeTypes`), the modules for the globals, `app()`'s build and the packages' check (`programGlobals`, `platformModules`), and the tsconfig's paths. A platform with no modules has no `.sst/tsconfig.json`. `js.PlatformModules` is gone: the esbuild plugin takes the modules from the build.
- **Tests that read SST 5's components** (the provider's and the eject's contract tests, the groups' test) skip, saying why, when the build's platform declares another contract. `pkg/project`'s tests of the program contract give their projects SST 5's manifest and contract (`sst5`), so they run on either build.
- **`RegisterRPC` takes the server's context**, so SST 4's resources stop with the server, as they did on `main`. A project `New` didn't make has no contract and serves none.
- **Checked** that `sst upgrade` and the daily update check stay in the CLI's major version (`npm.NewestInMajor`, which leaves out pre-releases for a release), so a 4.x CLI is offered only 4.x.
- **Checked**:
  - Two builds, each with the whole Go suite (`go test -vet=all ./...`, 45 packages) and `-race` on `pkg/project`. One is this branch, with SST 5's platform. The other is a throwaway copy with `main`'s `platform/` and its manifest (contract 0), its `dist/` built without Docker.
  - SST 5's platform: `tsc`, the platform suite (122 files, 4313 tests) and the API reports, unchanged.
  - The tests run in a worktree need the SDK built (`bun run build:sdk`): the worker runtime's fixture imports `sst/resource/cloudflare` from it.
