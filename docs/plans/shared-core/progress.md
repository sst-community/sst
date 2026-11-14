# One engine for SST 4's and SST 5's components: progress

The log, newest first. The plan is [plan.md](plan.md).

## 2026-11-13: checkpoint B, the shared resources' guard and each line's commands

- **A project without a contract stops at once** (the review's one change to A). SST 4's stored provider code takes a call the RPC doesn't serve as done, so a remove run without a contract would drop a site's files, routes or DNS records from the state and leave them in the cloud. The engine reads the contract only through `speaks()`, which panics, saying a `Project` is made with `project.New`. `New` is the only place one gets a contract. `pkg/server`'s test of SST 4's stored provider code makes its project with `New`, and runs on a platform that speaks SST 5's contract.
- **The resources SST 4's line shares with SST 5's are held to what SST 4 sends** (`pkg/sst4/shared_test.go`). Each entry SST 4 left in the lab's states for bucket files, the distribution's waiter and invalidation, and KV keys and routes (21 in all) is checked. Its inputs, and its outputs as an update's `olds` and a delete's `outs`, go through SST 5's structs and back, and every field they had comes back with its value. A field renamed in a struct fails it (checked with `namespace` and a file's `hash`). The MicroVM image's prune isn't in the recordings: its fields are pinned to what SST 4's component sends.
- **Each line has its own commands.** A command says the least contract it needs (`cli.Command.Contract`): `migrate` (with `--codemod`), `eject`, `target` and `build-server` need SST 5's. The CLI keeps the commands its platform's contract has. On SST 4's, `sst dev` finds no plain Pulumi program, and a `Pulumi.yaml` given with `--config` is taken as SST 4.25.0 took it. A test lists both lines' commands: SST 4's are 4.25.0's but `cert`.
- **Left where they are**: the move's marker, `keepMarker` and the tombstone at the end of a run. They're SST 5's, and do nothing on a stage SST 4's line runs on.
- **Checked**:
  - Both builds' whole Go suites (45 packages each). `-race` on `pkg/project`, `pkg/sst4`, `pkg/server`, `cmd/sst` and `cmd/sst/cli` on both. The SST 4 build's CLI says its platform speaks contract 0.
  - New files under `cmd/sst` are ignored by `.gitignore` (`sst`), so they're added with `-f`. A copy of the changes that lists untracked files misses them, as the SST 4 copy did at checkpoint A: its `cmd/sst` contract test hadn't run there until now.
  - `tcell-term`'s `TestAnywhere` fails under `-race` at `v5-thin-layer`'s tip too, before any of this: a race of its own.

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
