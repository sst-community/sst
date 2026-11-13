# SST as a layer on plain Pulumi: progress

The log, newest first. The plan is [plan.md](plan.md).

## 2026-11-12: SST's provider takes the AWS setup of the program's

Under plain Pulumi, SST's provider reaches the account the program's AWS provider does, set up the same way. Not committed.

**What changed:**

- **SST's own AWS resources get an SST provider for their AWS provider.** `withAwsPlugin(opts)` (`platform/src/components/plugin.ts`), on the AWS resources and `getHostedZone`, gives each the SST provider made for the AWS provider its component uses (`parent.getProvider("aws::")`), once for each. For the stack's default AWS provider, it's named `sst` and its config is the stack's `aws:profile`, `aws:region` and the roles in `aws:assumeRoles` or `aws:assumeRole`, as `sst dev` reads them for a Pulumi program. A secret one, or a role with an external ID, is refused, as there. For an explicit `aws.Provider`, it's named `sst-<name>`, with that provider's `profile` and `region`; its roles aren't among its outputs. Cloudflare's and Vercel's resources keep the default provider (`withPlugin`). Under SST's CLI, nothing changes.
- **The provider reads its AWS setup from its config.** `Configure` reads `awsProfile`, `awsRegion` and `awsAssumeRoles` from an explicit provider's inputs or a default provider's `sst:` config (`pkg/provider`), and the first resource that needs AWS makes its setup from them with `LoadAwsConfig`, as the CLI makes its own: a profile that's named wins over keys in the environment. With none, it's the environment's, as under SST's CLI. It names no credentials, so the state keeps none. This is the 5.0 decision of 2026-11-01 ("from the environment the core gives Pulumi, never from its config") for SST's CLI; a program with no CLI has no environment from a core to give.

**Checked:**

- Go: `TestConfigureAws` (an explicit provider's inputs, a default provider's stack config with `sst:dev` beside it, none, roles it can't read) and `TestEnvAwsFromSettings` (the config's profile wins over `AWS_PROFILE` and the shell's keys, and gives its region, the config's region over the profile's, none falls back to the environment). The full suite passed.
- Platform: `tsc`, the full suite (110 files, 4234 tests), the API reports unchanged.
- In the lab, with no AWS credentials, profile or region in the environment, and a scratch AWS config with a profile `thinlab` whose `credential_process` asks `aws-sso` for the lab's credentials:
  - **The stack's config:** the `StaticSite` program with `aws:profile thinlab` and `aws:region us-west-2` deployed (16 resources, the SST provider `sst` among them, with `awsProfile: thinlab`, `awsRegion: us-west-2`), answered 200, previewed with no changes, and destroyed.
  - **An explicit provider:** a `Function` in a component of the program's with `providers: { aws: Lab }` (`profile: thinlab`, `region: us-west-2`), and `addEnvironment`, while the stack's default provider was `us-east-1`. The SST provider `sst-Lab` took `us-west-2`, `FunctionEnvironmentUpdate` ran on it, and the function answered with the variable it added. Destroyed.
  - Nothing left: the audit by id found no distribution, bucket, function, role, log group, CloudFront function or key-value store, and the one source map SST keeps on delete was deleted.

**Found, in SST 5's components, not this branch's:** lookups that don't follow the component's AWS provider. `Function` looks up its region, partition and account with the component's `opts` (`getRegionOutput({}, opts)`), as do `Bucket`'s distribution ARN, the Step Functions `Map` and the API Gateway account helper, where the other components pass `{ parent: this }`; a lookup reads `provider` or `parent`, not a component's `providers`. So a `Function` given `providers: { aws }` for another region looks up the default provider's region, and SST's bootstrap there, under SST's CLI too. And about 23 `iam.getPolicyDocument` calls pass neither. Under SST's CLI the default provider is always set up and the documents are made locally, so they work; under plain Pulumi, a program whose only AWS provider is an explicit one fails on the first. The lab's explicit-provider check gave the default provider credentials for this reason.

## 2026-11-12: step 2, a `StaticSite` on plain Pulumi

A plain Pulumi program with `new StaticSite("Web", { path: "web" })` from `sst/components/aws` deploys with `pulumi up` alone. SST's own resources (`BucketFiles`, `KvKeys`, `DistributionInvalidation`, `DistributionDeploymentWaiter`) run on SST's provider as a plugin Pulumi downloads, [as decided](plan.md#decisions). Not committed.

**What changed:**

- **SST's own resources name their plugin.** Each of the 13 resource classes, and the `sst:aws:getHostedZone` function, is registered with `withPlugin(opts)` (`platform/src/components/plugin.ts`). Under SST's CLI that's the options as given, so a stage's state is unchanged. Under plain Pulumi it adds the `sst` package's version and `pluginDownloadURL: github://api.github.com/sst-community/sst`, which Pulumi reads as `https://github.com/sst-community/sst/releases/download/v<version>/pulumi-resource-sst-v<version>-<os>-<arch>.tar.gz`. The stack's provider is then `pulumi:providers:sst::default_<version>_github_/api.github.com/sst-community/sst`, which keeps both. The provider's `DiffConfig` never asks for a replace, so a change of version, or of the provider between SST's CLI and Pulumi, replaces nothing.
- **The release has the plugin.** `.goreleaser.yml` builds the CLI a second time as `pulumi-resource-sst` and archives it, binary only, under the name Pulumi looks for, Windows included. `release.ts` leaves those binaries out of the npm packages. `MAINTAINING.md` says so, and how to run a plain Pulumi program on a dev build.
- **The package has what a deploy reads from the platform's folder.** `sdk/js/scripts/platform.ts` copies the warmer, the edge signer, the empty function, the React and Remix server wrappers and Cloudflare's static-site Worker into the package's `platform/` (about 730 KB), and stops the pack if a component reads a folder there that's on neither its list nor the `sst dev` stubs'. Under plain Pulumi, `context().paths.platform` is the package's `platform/`. `sstPackage()` (`components/sst-package.ts`) finds the package for both this and the binary.

**Checked:**

- Platform: `tsc`, the full suite (110 files, 4234 tests) and the API reports, unchanged. SDK: `bun test` (31 tests).
- goreleaser 2's `check`, and a snapshot release of a copy of the config for macOS and Windows on x64 and arm64, written to a scratch folder: each `pulumi-resource-sst-v<version>-<os>-<arch>.tar.gz` holds only the binary (`.exe` on Windows), and `release.ts`'s filter keeps the same four npm platform packages.
- In the lab, a program named `thinsite` on the stack `lab`, with the branch's CLI installed as plugin `sst` 0.0.0 (`pulumi plugin install --file`):
  - `pulumi up` alone created 15 resources in 5 minutes, most of it the CDN's waiter. The site answered 200 with its page, and a second preview had 15 unchanged.
  - **Removing SST:** with the plugin taken out of Pulumi's cache, the `sst` package out of `node_modules` and no `SST_BIN_PATH`, `pulumi destroy` downloaded the plugin from the URL in the state and deleted all 15. The URL was pointed at a local server with a release-named archive, by Pulumi's `PULUMI_PLUGIN_DOWNLOAD_URL_OVERRIDES`, as no release has the archives yet.
  - The audit found nothing left: no distribution, bucket, CloudFront function or key-value store. A plain Pulumi stack has nothing in SST's home.

**Learned, for the next steps:**

- **SST's provider takes its AWS setup from the environment.** Under SST's CLI the core gives it the stage's credentials, profile, region and roles. Under plain Pulumi it has only the shell's: `AWS_PROFILE`, `AWS_REGION` or the default chain, not the stack's `aws:profile` or `aws:region`. A stack whose AWS provider is set up only in its config could have SST's provider in another account or none; the calls it makes name the stack's own buckets and distributions, so that fails rather than writing elsewhere, but it's to fix before this is used.
- **A dev build's plugin has no version**, so Pulumi warns. A release's has.
- **Releases before this one have no plugin**, so a plain Pulumi program needs an `sst` package from a release after it.

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
