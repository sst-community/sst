# One engine for SST 4's and SST 5's components

**Started 2026-11-13**, on the local branch `v5-shared-core`, from `v5-thin-layer` (`f354c6889`). What's been done is in [progress.md](progress.md).

## Goal

The maintainer: "it would be convenient that both v5 and v4 work on the same core with the only difference being their components", and "a v4 app should have 0 changes to it between sst core of v4 and the new one".

So there is one Go engine (`cmd/`, `pkg/`, `internal/`, `go.mod`) and two platforms: SST 5's `platform/` on `v5`, and SST 4's on `main`. A CLI built with SST 4's platform behaves, for an SST 4 app, as SST 4.25.0 does: the same diff, deploy, `sst dev` and remove.

## Decided

- **The engine goes into `main`** once it's ready ("once its ready well bring the engine into main"). `main` takes the shared engine and keeps its own SST 4 `platform/`, and `v5` keeps SST 5's. Engine changes then reach `v5` through the usual merges of `main` into `v5`. So the engine depends on nothing only SST 5's platform has, and `main`'s `platform/` gains only its manifest. How and when it's merged is the maintainer's call.
- **A proof of concept came first** (another session, not committed). A flag checked in eleven places ran SST 4.25.0's lab stages (serverless, sites, Cloudflare with sites, containers) with SST 4's platform. Its diff listed exactly 4.25.0's own diff each time. Its deploy changed only that, and 4.25.0's diff after it was the same. `sst dev` worked with a byte-identical stub, and the POC removed everything. This is the same change in the shape below.
- **The program contract is a versioned strategy inside `Project`**, not on `project.Program`. Contract 0 is SST 4's components and contract 1 is SST 5's (`_sst`). `Project` picks it from what the platform declares, and each call site in the engine makes one call to it, with no check of the line.
- **All of contract 0 is one package, `pkg/sst4`**, which can be deleted when SST 4's support ends. It registers itself with `pkg/project` as it loads, and `cmd/sst` imports it. `pkg/project` never imports it, and the boundaries of `pkg/pulumidev` and `pkg/eject` don't allow it. SST 5's build carries it too.
- **A platform says what it is in a manifest**: `sst` in `platform/package.json`. It gives the contract's version, the type files an app's `config.d.ts` imports, and the modules an app imports from the platform (`sst/components` and its groups). It replaces the layouts `install.go`, `tsconfig.go` and `programGlobals` had hard-coded. A platform that declares a contract this CLI doesn't have fails as the project loads, with a message.
- **The helper resources both lines have, byte for byte, are shared**: SST 4's line registers SST 5's own types for them on its RPC. SST 4's copies stay only where the behaviour differs.
- **Each line has its own commands.** SST 4's leaves out `migrate` (and its `--codemod`), `eject`, `target` and `build-server`, and keeps the rest of 4.25.0's.
- **Both lines run a plain Pulumi project with `sst pulumi dev`** (2026-11-13: the maintainer asked to finish SST 4's support for it, in the same PR). It runs none of either line's components: the program's own functions, through `sst/pulumi` and `sst.dev.yaml`, which SST 4's `sst` package now ships too, the same files as SST 5's. SST 5's components in a Pulumi program stay SST 5's, and such a program installs SST 5's package, whose CLI takes over. On both lines, every other command in a Pulumi project says to run `sst pulumi dev`, where SST 4's said there was no `sst.config.ts`.
- **The `sst dev` stub is the engine's** (2026-11-13, the maintainer chose to do it in the PR). Its entry point moved from each platform's `functions/bridge/` to `cmd/bridge/`, and both platforms' builds take it from there, so both lines deploy the same stub.
- **A few platform files are shared too** (2026-11-13, the maintainer's choice), byte for byte, as the engine is: `cpu`, `dns`, `duration`, `error`, `esbuild`, `input`, `path`, `runtime` and `size` under `platform/src/components/`. `platform/test/components/shared.test.ts`, itself the same on both lines, lists them and checks each imports only another of them or a package. They're changed on `main` and reach `v5` by merge, as the engine does. `error.ts` became SST 5's, with its one check of whether the CLI runs the program written out in place of `context.ts`'s. The rest differ for a reason: `link`, `linkable` and `secret` support plain Pulumi programs on SST 5's line, and the components' base is each line's own.
- **SST 4's line reads SST 5's report too** (2026-11-13, the maintainer's choice). A component that writes its `_sst` output, like a plain Pulumi component of a package, reports to `sst dev` the same way on either line; one with both kinds is read by its record. The docs say how on both lines (main's Components page, `v5`'s "Write a Package Component").
- **SST 4 gets custom runtimes** (2026-11-13, in the same PR, the maintainer's choice). `sst.runtime(...)` on SST 4's `Function` is SST 5's API, with `runtime.ts` the same file on both lines, so a stage that moves keeps it. The engine needed nothing; SST 4's `Function` passes the runtime's commands with its build, as SST 5's does. It's the one SST 4 feature the shared engine brought so far; packages stay SST 5's.

## What SST 4's line needs from the engine (contract 0)

1. **`$cli` in SST 4's shape**: `{command, dev, paths{home,root,work,platform}, state{version}}`. The version map is each `sst:sst:Version` record's version, and 1 for any other of SST's resources, by name. It's read in `getCompletedEvent`, as each resource is read and before the event is published: read after it, it raced `sst dev`'s server encoding the event.
2. **No `sst/components` modules** for the globals.
3. **Reports from SST 4's output names**: `_metadata` with a handler, `_dev`, `_task`, `_tunnel` and `_hint`, for the SST app's own state. `pkg/pulumidev` keeps reading `_sst`. A component's `_sst` record is read too, over the names; one from a newer contract is skipped with a warning.
4. **The RPC serves SST 4's provider resources**: `Resource.Run`, `Resource.Aws.*`, `Resource.Cloudflare.*` and `Resource.Vercel.DnsRecord`. It also serves `Provider.Aws` with `Bootstrap` and `Appsync`, in place of the SST app's own calls (no `Move`).
5. **The stage refusals the other way round**: a stage on SST 5's components is refused (but not a diff), and so is a move. A stage with the tombstone is refused once its lock is taken, which then releases it and drops the update.
6. **Install**: SST 4's `config.d.ts` (`./src/global.d.ts`, `./src/config`), no `.sst/tsconfig.json`, and no refusal of a provider's other major version. Reading `app()` loads the providers' modules the app's files import, as 4.25.0 did.
7. **No targets.** A stage the app gives a target in `app()` is refused before anything runs, saying targets come with SST 5. The engine reads `targets` whatever the platform, SST 4's components were never run on one, and SST 4's CLI has no `sst target`. Left alone, it would deploy the stage somewhere untested. The maintainer chose to switch them off "for now" (2026-11-13).
8. Everything else needed nothing: the home, state and locks, function builds, the bridge, the transports, the server.

## Before the engine goes into `main`

- **`main`'s Go changes since the branch's base have to come in first.** The branch's merge base with `main` is `7c8a2d529`. Since then `main` has three commits that change the engine: #262 (`5dc360c7c`, the runtime checks a handler's path in `sst dev`'s deploy), #267 (`8818b87e9`, partly Go: `sst dev` says what's wrong with an empty or badly quoted command, where it panicked) and #269 (`8647face8`, `pkg/js` doesn't put the provider globals in files under `node_modules`). Together that's 14 Go files and about 277 lines. Unless `main` is merged into this branch (or into `v5`, then into this branch) before the engine replaces `main`'s, those fixes are lost. Doing the merge is the maintainer's call.
- **A release note for #267** when it ships: a `Service` no longer makes a `DevCommand` for a container with no `dev.command`. So the next deploy of an app with such a container deletes those `DevCommand` components. They're components only, with nothing in the cloud.

## Known differences of SST 4's line on this engine

- **`sst dev`'s stub isn't byte for byte 4.25.0's.**
  - 4.25.0's release stub was built with Go 1.26.10 on CI's Linux, and can't be reproduced on a Mac, even from the `v4.25.0` tag with the same Go.
  - With the same Go and dependencies, the engine's stub differs from one built from 4.25.0's source too: the bridge's packages changed on `v5` (`cmd/sst/mosaic/aws/bridge`: its connection, and how a closed channel is handled), and the stub is now the engine's own (`cmd/bridge/`), the same one SST 5 deploys.
  - Deployed stages are untouched. A stage run with `sst dev` gets a new stub object, and its functions pointed at it, on its first `sst dev` with a release built on this engine, as happens with any 4.x release whose CI Go or bridge code changes.
  - Making it the same would mean keeping the stub's packages as `main`'s, which isn't worth it.
- **A stage named in `targets` in `app()` is refused** ([above](#what-sst-4s-line-needs-from-the-engine-contract-0)). SST 4.25.0 never read `targets`, so it deployed such a stage to the cloud. Only an app that wrote a key SST 4's types don't declare can meet it, and refusing is the safer of the two.
- **What else an SST 4 user sees** is in #272's description, with its release notes: provider settings that are booleans or numbers reach the provider (4.25.0 dropped them), a daily update check, `sst dev`'s server on loopback with a token, `sst diff` creating no passphrase, a refused deploy of a stage whose state is missing, `sst add` within the major the components are built for, the workers that start again after a change, and a crashed run's second lock (`lock5`), which 4.25.0's `sst unlock` doesn't clear.
- **`sst cert` and the Console's local connection** are gone. The 5.0 rewrite removed them, and they aren't brought back for SST 4. They're the CLI's only, and change nothing an app deploys. The maintainer was told on 2026-11-13; bringing them back would be work of its own.

## Checks

- Two builds, each with the whole Go suite (`go test -vet=all ./...`) and `-race` on `pkg/project`: this branch with SST 5's `platform/`, and a throwaway copy with `main`'s `platform/`, never committed.
- SST 5's platform checks: `tsc`, the platform suite and the API reports.
- The lab is run by the other session, with an SST 4 CLI built from the throwaway copy.

## Checkpoints

- **A**: the contract interface, `pkg/sst4` and the manifest, with both builds' Go suites passing.
- **B**: the shared helper resources, each line's commands, and the tests gated on the declared contract.
- **C**: the SST 4 CLI built for the lab.

## Status

| Step | Status |
| --- | --- |
| Plan | Started 2026-11-13 |
| A. The contract, `pkg/sst4` and the manifest | Done 2026-11-13, both builds' Go suites passing; reviewed and approved, with one change (done in B) |
| B. Shared resources' guard, each line's commands | Done 2026-11-13, both builds' Go suites passing, reviewed and approved. Committed with A (`4490a44f4`, plans `65b2f6286`) |
| C. The SST 4 CLI for the lab | Built 2026-11-13; its commands are `main`'s but `cert`. The lab passed on four stages, run by the other session against 4.25.0, and is cleaned up |
| Into `main` | Waits on `main`'s Go changes being merged in first ([above](#before-the-engine-goes-into-main)), and on the maintainer |
