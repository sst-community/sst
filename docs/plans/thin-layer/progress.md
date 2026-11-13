# SST as a layer on plain Pulumi: progress

The log, newest first. The plan is [plan.md](plan.md).

## 2026-11-12: step 1, a `Function` on plain Pulumi

A plain Pulumi program in TypeScript, with `import { Function } from "sst/components/aws"` and nothing of SST's CLI running, previews, deploys and destroys SST's `Function`. Not committed.

**What changed:**

- **The context reads Pulumi when there's no core.** `context()` moved to `platform/src/components/context.ts`, a module that imports none of the components (`contract.ts` exports it as before), so the base classes can read it without an import cycle. Under SST's CLI it reads `$app`, `$cli` and `$dev`, as before. Without them (`underCore()` is false), it reads the app from `getProject()`, the stage from `getStack()` and the root from `getRootDirectory()`. Its other fields: `home: "pulumi"` (new in the type, and in `api/sst-components.api.md`), `command` is `diff` in a preview and `deploy` otherwise, `dev: false` and `contract: 0`. The files that read the globals directly now read `context()`: `naming.ts` (physical names), `link.ts`, `component.ts` (`$asset`), the sites' bases, `router-code.ts` and `site-builder.ts`. `move.ts` and `check.ts` already checked for `$cli`.
- **Builds go through the `sst` binary.** `callBinary()` (`components/rpc/binary.ts`) calls `SST_SERVER` under SST's CLI and in `sst dev` for a Pulumi program. Otherwise, on the first build, it starts `sst build-server` from the binary's package, as `bin/sst.mjs` finds it, or from `SST_BIN_PATH`. The command is hidden, in `cmd/sst/build_server.go`. It serves `Runtime.Build` alone, under a token, on loopback (`pkg/server/build.go`, `ServeBuilds`). It prints its address, logs to `.sst/log/build-server.log`, and stops when the program exits. `rpc.call` is unchanged, as SST's dynamic providers store its code in the state. `pkg/server/runtime` takes a `Builder` (the config path and the runtimes) in place of a whole `project.Program`. The function, `WebFunction` and Cloudflare's `Worker` build with it.
- **The asset bucket comes from SST's bootstrap.** Under plain Pulumi, `bootstrap.forRegion` reads `/sst/bootstrap` from SSM through the AWS provider of the component that uploads, so it needs no credentials of its own, and uploads where SST's CLI does. An account with no bootstrap in the region is refused, with a message: for now, until [the open question](plan.md#open-questions) on it is decided. `Function`, `MicroVm` and the container images pass their component.

**Checked:**

- Go: `TestServeBuilds` (the address, no route without the token, a real Node.js build into `.sst/artifacts`, `Provider.Aws.Bootstrap` not served, a stop when its input closes). The full suite with `-vet=all` passed (42 packages).
- Platform: a test of the context without SST's globals, and of a name made from it. The full suite passed (110 files, 4234 tests), and so did `tsc` and the API reports, with `home`'s new value in the report.
- In the lab, a program named `thinlab` on the stack `lab`, with a local backend, Pulumi 3.215.0, `@pulumi/pulumi` 3.270.0, `@pulumi/aws` 7.54.0, the `sst` package packed from the branch, and the branch's CLI as `SST_BIN_PATH`:
  - `pulumi up` alone created 11 resources. The URL answered 200, and a second preview had 11 unchanged.
  - The same function in an SST app named `thinlab`, deployed with `sst deploy --stage lab` by the branch's CLI, had the same 11 URNs. Inputs differed only in what's generated: names' random suffixes, the permissions' statement ids, the encrypted environment, and the code's key, whose hash covers `resource.enc`, encrypted with each deployment's own key. Both functions had the same runtime, handler, architecture, memory, timeout and environment keys. The one real difference: SST's CLI gives the AWS provider default tags (`sst:app`, `sst:stage`), and plain Pulumi doesn't.
  - `pulumi destroy` with the `sst` package taken out of `node_modules` and no `SST_BIN_PATH` deleted all 11.
  - With no binary package and no `SST_BIN_PATH`, the run fails with the message saying which package to install. With a stand-in `sst-darwin-arm64` package, it finds the binary.
  - No build server was left running after any run.
  - Removed: the SST app with `sst remove`. Cleaned up: its 39 state versions and markers, its passphrase, and both deployments' source maps (SST keeps them on delete). The audit found nothing of `thinlab` in Lambda, IAM, CloudWatch Logs, the asset bucket or the state bucket.

**Learned, for the next steps:**

- **Tags.** A stack that goes from SST's CLI to plain Pulumi, or back, gets an in-place update of every resource's tags, unless its `aws:defaultTags` config sets `sst:app` and `sst:stage` as SST's CLI does. That's a line in the docs, or a default under plain Pulumi.
- **Errors.** Pulumi prints a stack trace after SST's `VisibleError`, which SST's CLI shows as written. Pulumi prints only the message for its own `RunError`.
- **Providers.** `sst/components/aws` imports every provider its components use, so a program installs `@pulumi/command`, `@pulumi/docker-build`, `@pulumi/random` and `@pulumi/tls` beside `@pulumi/aws`, used or not. That's [5.0's choice](../v5-rewrite/plan.md#decisions) of 2026-11-04 for packages too.
- **ESM.** The package's components are ES modules. A TypeScript program needs `"module": "nodenext"` (or an ESM program), and Node 22.12 or newer to load them from CommonJS.
- **`sst dev`.** `dev` is false under plain Pulumi, so a component's functions don't run on the machine through the component itself. Under `sst dev` for a Pulumi program, `sst.dev.yaml` and the transform still apply to the Lambda function inside it, but that wasn't tried.
- **Only Node.js.** Python and Go builds, and container builds, weren't tried. The Python runtime reads files from `.sst/platform`, which a Pulumi project doesn't have outside `sst dev`.
