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
- **Each line has its own commands.** SST 4's leaves out `migrate` (and its `--codemod`), `eject`, `target`, `build-server`, and `sst dev` for a plain Pulumi program, and keeps the rest of 4.25.0's.

## What SST 4's line needs from the engine (contract 0)

1. **`$cli` in SST 4's shape**: `{command, dev, paths{home,root,work,platform}, state{version}}`. The version map is each `sst:sst:Version` record's version, and 1 for any other of SST's resources, by name. It's read in `getCompletedEvent`, as each resource is read and before the event is published: read after it, it raced `sst dev`'s server encoding the event.
2. **No `sst/components` modules** for the globals.
3. **Reports from SST 4's output names**: `_metadata` with a handler, `_dev`, `_task`, `_tunnel` and `_hint`, for the SST app's own state. `pkg/pulumidev` keeps reading `_sst`.
4. **The RPC serves SST 4's provider resources**: `Resource.Run`, `Resource.Aws.*`, `Resource.Cloudflare.*` and `Resource.Vercel.DnsRecord`. It also serves `Provider.Aws` with `Bootstrap` and `Appsync`, in place of the SST app's own calls (no `Move`).
5. **The stage refusals the other way round**: a stage on SST 5's components is refused (but not a diff), and so is a move. A stage with the tombstone is refused once its lock is taken, which then releases it and drops the update.
6. **Install**: SST 4's `config.d.ts` (`./src/global.d.ts`, `./src/config`), no `.sst/tsconfig.json`, and no refusal of a provider's other major version.
7. Everything else needed nothing: the home, state and locks, function builds, the bridge, the transports, the server.

## Before the engine goes into `main`

- **`main`'s Go changes since the branch's base have to come in first.** The branch's merge base with `main` is `7c8a2d529`. Since then `main` has three commits that change the engine: #262 (`5dc360c7c`, the runtime checks a handler's path in `sst dev`'s deploy), #267 (`8818b87e9`, partly Go: `sst dev` says what's wrong with an empty or badly quoted command, where it panicked) and #269 (`8647face8`, `pkg/js` doesn't put the provider globals in files under `node_modules`). Together that's 14 Go files and about 277 lines. Unless `main` is merged into this branch (or into `v5`, then into this branch) before the engine replaces `main`'s, those fixes are lost. Doing the merge is the maintainer's call.
- **A release note for #267** when it ships: a `Service` no longer makes a `DevCommand` for a container with no `dev.command`. So the next deploy of an app with such a container deletes those `DevCommand` components. They're components only, with nothing in the cloud.

## Known differences of SST 4's line on this engine

- **`sst dev`'s stub isn't byte for byte 4.25.0's.**
  - 4.25.0's release stub was built with Go 1.26.10 on CI's Linux, and can't be reproduced on a Mac, even from the `v4.25.0` tag with the same Go.
  - With the same Go and dependencies, the engine's stub differs from one built from 4.25.0's source too: the bridge's packages changed on `v5` (`cmd/sst/mosaic/aws/bridge`: its connection, and how a closed channel is handled).
  - Deployed stages are untouched. A stage run with `sst dev` gets a new stub object, and its functions pointed at it, on its first `sst dev` with a release built on this engine, as happens with any 4.x release whose CI Go or bridge code changes.
  - Making it the same would mean keeping the stub's packages as `main`'s, which isn't worth it.
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
