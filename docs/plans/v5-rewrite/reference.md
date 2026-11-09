# The 5.0 rewrite: reference

SST as it is, read from the code on `v5` on 2026-10-31 for [the plan](plan.md): what the plan was decided on, with where each fact comes from. [goals.md](goals.md) is what 5.0 holds to.

## What v5 taught

Read from [v5-progress.md](../v5-progress.md), [v5-port-notes.md](../v5-port-notes.md), [the AWS report](../v5-aws-test-2026-10-01.md), the sharing plans and the policies experiment.

### What worked

- **Parts** (`parts-component.ts`, `parts.ts`, `transform.ts`, `naming.ts`). One declared list gives every component `transform`, `existing`, `nodes` and its names. `Function` was the test of whether the framework holds, and it did. 21 components and the Cognito client are ported.
- **Takeover maps** (`takeover.ts`, `aws/takeover/`). In AWS on 2026-10-01, the serverless switch kept every resource's id, 73 under new names, and containers and databases kept all 238. A file on EFS kept its contents.
- **The three-way takeover check** (`pulumi.takeoverCases`, `test/helpers/graph.ts`). It compares addresses through aliases, inputs, deploy options, outputs, what a function is built from, and teardown order. It caught a missing `_live` output, notifications that would have been recreated, an ordering regression, and on each merge of `main`, 4.x fixes a port didn't have.
- **`mock()`** (`platform/src/testing`). Works under vitest and `bun test`, and in a package's repo with no `sst.config.ts`.
- **Packages, with SST as the host.** A package imports `sst/components` and its providers by name, and the bundler maps them to the app's `.sst/platform`, so there's one copy of each (`pkg/js/js.go`, `pkg/project/run.go`). npm, pnpm and bun apps each deployed one, and one ran in `sst dev`.
- **The peer-dependency check** (`pkg/project/packages.go`). A deploy checks each package's peers on `sst` and on providers against the CLI and the app, and says what to run.
- **Docs from the source.** `transform`, `existing` and `nodes` are written from the parts, and each "Switch from" section's standard notes from the generator.

### What fought back

- **The mock passed what AWS caught.** `"sideEffects": false` let esbuild drop every takeover map from a real build. Links were written under the wrong key. A function part that linked its own component waited on itself and was never created, with no error.
- **The 4.x code couldn't be touched.** `Function`'s build and zip logic was copied into `aws/helpers/function-code.ts`. Shared resources go through 4.x private statics. 4.x components check `instanceof`, so they refuse a V5 `Efs` or `Alb`, and consumers had to be ported first.
- **The CLI reads components by name.** `_task`, `_dev` and `_tunnel` are outputs `pkg/project/completed.go` looks for. A component type with two parts crashed the CLI after a deploy.
- **Pulumi's limits.**
  - A preview skips an `apply` with unknown inputs, so a 4.x function built inside one shows as deleted in `sst diff` (v5 goal 6, still unmet for 4.x).
  - A lookup can't take an alias, so `CognitoUserPool.get` is dropped from the state and looked up again.
  - A part created with the component's `provider` replaces what 4.x created without it.
  - `Component` passes `{}` to Pulumi (`super(type, name, {}, …)`), so Pulumi's transforms can't see a component's args.
  - An unknown value in a preview makes Pulumi drop a policy check silently.
- **Packages are fiddly to set up.** A package needs `moduleResolution: "bundler"`, `skipLibCheck`, and `google-protobuf` pinned to `3.21.2`. A group pulls in all of its providers.
- **A second copy of every component.** The 4.x AWS components are 55,414 lines in 96 files. The 21 ports are 13,977 more, and every merge of `main` has to be carried into both ([v5-core-set.md](../v5-core-set.md)).

### What it means for 5.0

- Keep parts, takeover maps (as state maps), `mock()`, packages, the peer-dependency check and generated docs.
- Test against what AWS really had, not only against the mock.
- Declare what the core and a component expect of each other, instead of matching names.
- Keep one copy of each component, and build on 4.x's identity, not its code.

### How the V5 components lean on 4.x

- 22 of the 23 files in `aws/v5/` import 4.x files, and 21 build their args on the 4.x args (`V5Args<Original…Args>`). There are 124 references to `Original…` names.
- 10 take either kind of `Vpc` (`AnyVpc`, `isVpc()`, `TakesVpc<>`), and others either kind of `Cluster`, `Efs` or `Alb`.
- 11 calls to `notAnOption()` handle option shapes the 4.x component took.
- `helpers/function-code.ts` is a copy of the 4.x `Function`'s build and zip code.
- The docs generator follows a V5 component's args back to the 4.x file for their docs.

## Today's home

- **AWS:**
  - **Bootstrap** is the SSM parameter `/sst/bootstrap`, JSON with a `version`. Its steps only ever add: the buckets `sst-asset-<id>` and `sst-state-<id>` (versioned), the ECR repository `sst-asset`, and a policy that requires TLS (`provider/aws.go`). It's per region, and the home uses the app's region.
  - **Keys:** `<kind>/<app>/<stage>.json` in the state bucket. The kinds are `app` (the checkpoint), `lock`, `secret`, `update`, `snapshot` and `eventlog`, and `summary`, which older CLIs wrote and retention and purge still clean up. With `state.compress`, objects are gzipped; reads accept both.
  - **The passphrase** is the SecureString `/sst/passphrase/<app>/<stage>`, created once with `Overwrite: false`, from `SST_PASSPHRASE` or 32 random bytes.
  - **Secrets** are one object per stage, AES-256-GCM with the passphrase as the key, plus `_fallback` for every stage.
  - **Credentials** are resolved by the home: profiles, `assumeRoles`, and `us-east-1` when no region is set. The program gets the bootstrap data through the RPC (`Provider.Aws.Bootstrap`).
  - **Retention and purge** (`state.retention`, `state.purge`) delete old history and old object versions, and on a remove that leaves nothing, the passphrase.
- **Cloudflare:** the R2 bucket `sst-state`, keys `<kind>/<app>/<stage>` with no `.json`, and the passphrase as an object.
- **Local:** files under the user's config folder, `sst/state/<kind>/<app>/<stage>.json`, and the passphrase as a file.
- **Outside the state:** the shared AppSync Event API named `sst`, or the stage's own, found or created with the SDK, and deleted with it on `sst remove` (`provider/aws_appsync.go`, `run.go`).
- **The interface.** `Home` (`provider/provider.go`) gets, puts and removes data by kind, app and stage, and keeps the passphrase. `Lock`, the secrets' encryption and the history are functions around it.

**The lock is a read, then a write.** It's `{created, updateID, runID, command, ignore}` at `lock/<app>/<stage>.json`. `provider.Lock` reads it, and writes it if it's empty, so two deploys that start at the same moment can both take it. Every command that changes anything takes it; `diff` doesn't. A lock that's there refuses every CLI since v3.0.43, with the message "Concurrent update detected, run `sst unlock --stage=<stage>` to delete lock file and retry."

## Today's program

- **Pulumi is run as a command**, not through the Automation API, in `.sst/pulumi/<updateID>/` with a file backend. SST writes only `Pulumi.yaml` (`name: <app>`, `runtime: nodejs`). The stack is `organization/<app>/<stage>`, and the passphrase is given as `PULUMI_CONFIG_PASSPHRASE`. There's no stack config file, so the passphrase's salt is only in the checkpoint.
- **Pulumi 3.270.0**, the CLI and `@pulumi/pulumi` at the same version, with `PULUMI_HOME` in SST's own folder and ambient plugins ignored.
- **Provider settings** from the config are passed as `--config`, after the AWS home adds `defaultTags` `sst:app` and `sst:stage` and the region, and moves `profile` to the environment. The default provider's address includes its version, so the versions in `.sst/provider-lock.json` and the platform's pins decide whether it changes.
- **The environment:** the user's, the home's credentials as `SST_AWS_*`, each secret as `SST_SECRET_<name>`, `NODE_OPTIONS`, and `SST_SERVER`, the RPC the program calls back into.
- **In, through globals.** `$app` (the config's `app()` as the CLI read it), `$cli` (the command, dev or not, paths, and the component versions read from `sst:sst:Version` outputs in the state), `$dev`, the `sst` global, and a global for each provider, defined with esbuild (`pkg/project/run.go`). SST's components read `$app`, `$dev` and `$cli` 226 times, in 80 files.
- **Out, through output names the CLI looks for:** `_dev`, `_task`, `_tunnel`, `_hint` and `_metadata` (`pkg/project/completed.go`, `cmd/sst/mosaic`), and the `version` of each `sst:sst:Version`.
- **Calls back to the CLI in the middle of a deploy**, over the RPC (`pkg/server`, JSON-RPC 1.0 over HTTP): `Runtime.Build`, `Runtime.AddTarget` (each function's build input), `Provider.Aws.Bootstrap` and `Provider.Aws.Appsync`, and the methods of SST's provider resources.
- **What SST applies to every resource:** `retainOnDelete` from `removal`, imported resources ignoring `tags`, a physical name with a random suffix that's then in `ignoreChanges`, a `Name` tag for the types named by one, and the `_protect` output (`auto/run.ts`, `component.ts`, `naming.ts`).
- **Processes:** a deploy runs Node for the config, Node for the program, and, when there are provider resources, a Node process Pulumi starts to run them.

## The `sst dev` path

- **One invocation:** Lambda's runtime API, the stub (Go, in Lambda), AppSync, the CLI (Go), then the language's worker over local HTTP, and back the same way. No Node process is on the path until the function itself.
- **How long:** 0.33 s at the median for a caller, over 40 calls in AWS ([v5-progress.md](../v5-progress.md)).
- **`bridge.Conn`** (`cmd/sst/mosaic/aws/bridge/bridge.go`) is two methods, `Publish` and `Subscribe`. Nothing says what a transport does about order, copies, loss, a channel with no subscriber, or closing. AppSync's closes every subscription when it shuts down, and #212's keeps them open.
- **The bridge does the rest:** it cuts messages into packets, puts them back in order, drops copies, and asks again for what's lost (`bridge.go`, `resend.go`).
- **The stub** (`platform/functions/bridge/`) is a Go binary, so it starts fast in any Lambda runtime.
- **What `sst dev` deploys differently:** the stub's code in place of the function's, shared by every function in a region and kept on delete; the stub's environment; permission to reach AppSync; a trust policy that lets the CLI take the role; and the `_live` output.
- **Tests:** the `bridge` package has fake connections that lose, shuffle, delay and fail packets (`lossyAppSync`, `shuffled`, `slowConn`, `failingConn`), and `cmd/sst/mosaic/aws/harness_test.go` runs the real dispatch loop against a fake AppSync and a fake stub. Each fake replaces the transport rather than testing one, and the stub's own loop isn't run by any test.

## The Console's local connection, removed

5.0's `sst dev` takes no connection from the SST Console, and `sst cert` is gone ([decided](plan.md#decisions) 2026-10-31). This is what it did, and what bringing it back takes.

**What it did.** The code is in `58ab248f3` (`cmd/sst/mosaic/socket/socket.go`, `cmd/sst/cert.go`, `pkg/global/mkcert.go`), and the commit after it removed it.

- `sst dev` served a websocket at `/socket` on its local server. The Console, which SST runs at console.sst.dev, connected to it from the browser, on the ports 4.x's `sst dev` takes first: 13557, and 14557 over TLS.
- When the Console connected, `sst dev` sent `cli.dev`, with the app and the stage, and then every invocation it had kept. After that it sent each invocation as it happened (`invocation`): its input, output, errors, logs and report. The Console sent `log.cleared` to drop the ones it had shown.
- `sst cert` used [mkcert](https://github.com/FiloSottile/mkcert) to install a root certificate the machine trusts, and made a certificate for `localhost` and `127.0.0.1` with it. When that certificate existed, `sst dev` served the same routes over TLS on the port 1,000 up. Safari and Brave need that to let the Console's page connect.
- In Gitpod, the Gitpod Local Companion app tunnelled the port to the browser.

**What the Console used it for**, from its docs (the docs page's sections went with the code):

- **Local logs:** the invocations of `sst dev`'s functions, live.
- **Telling a personal stage apart:** a workspace over the free tier can still open its personal stages "if you have `sst dev` running locally. Otherwise the Console won't be able to detect that it's a personal stage." Without the connection, that likely ends for 5.0 apps.

**Why it went.** Every route of 5.0's server is under a token, on a port the system picks ([safety rules](plan.md#safety-rules)). A page from another site can't know either one, so the Console can't connect. The TLS proxy was dropped, so `sst cert` was left installing a trusted root certificate for nothing.

**Bringing it back** takes more than a revert, so as not to undo the safety rule:

- Revert the commit that removed it, which brings back the code, `sst cert` and the docs page's sections.
- The Console has to get the token from the developer. One way: `sst dev` prints, or opens, a Console link with the port and the token in the URL's fragment, which the browser doesn't send to the Console's server. The Console then connects to `ws://127.0.0.1:<port>/<token>/socket`. That needs a change to the Console, which SST runs, not the fork.
- The socket takes only the Console's origin.
- For Safari and Brave, the TLS listener is on `127.0.0.1` only, under the same token.
- `sst dev` keeps no invocations while no Console is connected. The old code kept them until the Console cleared them.
- Take `main`'s bound on what it keeps, from sst-community/sst#238 (2026-11-08): only the most recent calls, error details counted, `cmd/sst/mosaic/socket/store.go` with its tests. The merge of `main` into `v5` on 2026-11-09 left it out, as the package isn't here.

## SST's provider resources

**Why they're resources at all.** A Pulumi resource runs at the right point in a deploy, runs only when its inputs change, and is cleaned up on remove. Its state is also its memory: `BucketFiles` keeps the list of files it uploaded, so the next deploy can delete the ones that are gone. Pulumi's providers had no resource for these jobs, and a dynamic provider was the quickest way to write one in TypeScript.

**Their code is in the state.** A resource made with `rpc.Provider` stores its provider's serialized code as an input, `__provider`. If that code changes, every one of them is updated: files are uploaded again, an invalidation runs. Nothing is replaced. Their work is done in Go, in `pkg/server/resource/`; Node is only the way there.

| Kind | Resources | In the cloud | How it moves in 5.0 |
| --- | --- | --- | --- |
| Lookups and waits | `HostedZoneLookup`, `RdsRoleLookup` (waits for the RDS role to exist), `DistributionDeploymentWaiter` | Nothing | The old entry leaves the state. The hosted zone lookup becomes a function of the new provider, not a resource. `RdsRoleLookup` and the waiter stay resources, so they still run at the right time: in a new account the RDS role doesn't exist until the database is created, so a preview couldn't look for it. |
| Actions on a change | `DistributionInvalidation`, `FunctionEnvironmentUpdate`, `MicrovmImagePrune` | Nothing kept | The old entry leaves the state. The new resource runs once when it's created: one invalidation, one write of the environment, one prune. |
| Content they wrote | `BucketFiles` (a site's files), `KvKeys` and `KvRoutesUpdate` (a router's routes), `WorkerScript` and `WorkerAssets` (a Cloudflare worker), the Cloudflare and Vercel `DnsRecord`, and Cloudflare's `WorkerUrl` and `WorkerPlacement` (a Worker's settings, in TypeScript) | Yes | Released. The new resource writes the same content again: uploads overwrite, a route already in the list is kept, a setting is set again, and the DNS record already accepts "already exists". `WorkerScript` and `WorkerAssets` no longer have a component that creates them, and go with SST 4's code. |
| An object with an id | `OriginAccessControl` | A CloudFront origin access control | Released, and adopted: the new resource takes the existing one by its id, since its create would make a second one. While the stage moves, the core gives the program the ids of SST 4's, by name (`move.Adoptable`), and the part imports its own; `--check` refuses one that isn't. |
| Data | `VectorTable` | A table holding the app's embeddings | Released, and adopted. Its create already accepts a table that exists, so the rows stay. `Vector` is left out of 5.0, so nothing creates it now. |
| No longer used | `FunctionCodeUpdater`, `OriginAccessIdentity`, `Run` | Nothing, or an old identity | SST stopped creating them in v3.1.18, v3.0.43 and v3.6.41. Their code goes, and an old entry is released like the rest. An origin access identity in a stage untouched since 2024 is left in the account rather than deleted. |

Deleting the old ones carelessly would remove a site's files (`BucketFiles` deletes them), a router's routes (`KvKeys` purges them) or a Cloudflare worker (`WorkerScript` deletes it).

## What runs in Node

**Has to stay in Node, or in JavaScript:**

- **The config and the Pulumi program**, with every component. Pulumi's TypeScript SDK runs in Node, and the config is the app's own TypeScript.
- **The function worker in `sst dev`** (`nodejs-runtime`) **and esbuild plugins** (`plugin.mjs`). They run the app's own code.
- **What AWS or Cloudflare only runs as JavaScript:** the CloudFront router functions (`cf-*-router-worker`), the Lambda@Edge signer (`oac-edge-signer`, since Lambda@Edge takes only Node or Python), the React and Remix servers, and Cloudflare workers.
- **Editing the config:** `sst add` (`src/ast/add.mjs`), and the codemod. TypeScript source is best rewritten with TypeScript's own tools.
- **The small handlers SST deploys** (`ssr-warmer`; `vector-handler` went with the `Vector`, which 5.0 leaves out). Rewriting them would change deployed code for nothing a user notices.

**Could move to Go:**

- **SST's provider resources**, above.
- **Zipping and hashing.** The program zips each function with `archiver` (`helpers/function-code.ts`), and a site lists and hashes every file in turn (`static-site.ts`, `ssr-site.ts`). Go already builds the functions and uploads the files, so it could zip and hash them in the same pass, in parallel, and `archiver` and `glob` would leave what an app installs. But the zips and hashes are inputs in the state: unless Go's output is identical, every function's code is uploaded once more, and each site runs one invalidation, in place. Not timed yet.

**What a Node process costs:** Node itself starts in about 20 ms. Loading the S3 and SSM clients takes about 170 ms warm and 400 ms cold.

## Linking today

- **Types are made after every run, from the values in the state** (`pkg/project/run.go`, `pkg/types/typescript/typescript.go`). The generator writes each value's shape: a string becomes `string`, a number `number`.
- **One `sst-env.d.ts` at the root holds every link in the app.** Every folder with a `package.json` gets a file that points to it, so `Resource` shows every resource everywhere.
- **At run time,** a deployed function reads the encrypted file (`SST_KEY`, `SST_KEY_FILE`), and a process on the developer's machine `SST_RESOURCE_<Name>` and `SST_RESOURCES_JSON` (`sdk/js/src/resource/node.ts`, `pkg/project/env.go`). SST's JavaScript, Python, Go and Rust SDKs all read the encrypted file, `SST_RESOURCE_<Name>` and `SST_RESOURCES_JSON`. Since SST's #6830 the CLI writes `SST_RESOURCES_JSON` in place of the others on Windows, which makes variable names upper case (corrected 2026-11-04: this said only the JavaScript SDK read it). SST publishes the Python, Go and Rust SDKs, not the fork.

What goes wrong, from SST's issues:

- Every package sees every resource. A function can name one it isn't linked to: it compiles, then throws "not linked" (#5520, #5519).
- Types come from values, so a function's name is a `string`, not its name (#6000). Before the first deploy there are no types at all, so a fresh clone or CI fails its type check.
- `sst remove` empties the types (#5926, #6907), two apps in one repo write over each other's (#6228), and paths break on Windows (#5833, #6825).

## PR #212, mapped

[#212](https://github.com/sst-community/sst/pull/212) by rogueturnip: `sst dev --floci`, 6,490 lines added across 69 files. 418 of them changed 32 files that were already there; the rest is new code, tests, scripts, docs and examples. Grouped by the place to plug in that was missing:

| What it had to change | Why | Where it goes in 5.0 |
| --- | --- | --- |
| `mosaic/aws/aws.go`, `mosaic/aws/bridge/bridge.go`, the stub, `cmd/sst/mosaic.go` | No way to choose how the stub reaches `sst dev` | `transport`: its HTTP transport becomes a built-in one |
| `pkg/project/project.go`, `run.go`, `env.go`, `provider/aws.go`, `provider/local.go`, `pkg/server/` | No way to choose where calls go: credentials, endpoints, region, the home | `target`, with its own home |
| `mosaic/aws/function.go`, `cmd/sst/shell.go` | No hook for the environment of a worker or a child process | `Target.Env`, applied by the core |
| The 4.x `function.ts`, `helpers/bootstrap.ts`, `helpers/provider.ts`, two provider resources, `component.ts`, `auto/run.ts` | No way to change what `sst dev` deploys, or to check a program before it deploys | `Transport.Stub`, and a `check` in the Floci package |
| `cmd/sst/main.go`, `cli/cli.go`, `cli/project.go`, `mosaic/errors/errors.go` | No way to add a command or a flag | The core's commands for a stage's target: start, stop, reset |

**What's reused:**

- `cmd/sst/mosaic/aws/local/local.go`: a token-authenticated HTTP transport behind `bridge.Conn`.
- `pkg/project/provider/floci.go`: static credentials, a fixed endpoint, and an HTTP client that only reaches that endpoint.
- `FlociEnvironment`: takes the developer's `AWS_*` variables, profile files and proxies out of every process on a Floci stage.
- `platform/src/floci/check.ts` and `profile.ts`: an allowlist of resource types, their inputs and invokes, enforced with Pulumi's `registerResourceTransform` and `registerInvokeTransform`.
- Its fix to `pkg/project/run.go` for `true`/`false` and number provider settings ([below](#found-while-planning)).

Its review findings, and the rule in 5.0 that prevents each, are in the plan's [Safety rules](plan.md#safety-rules).

## Why there's no host in 5.0

The plan once had a long-lived Node process for package code. It was dropped because:

- **Nothing would have run in it.** AppSync stays in Go, #212's transport and restricted client go into the core, the allowlist runs in the program, a Floci target is settings, and Ruby and .NET fit a runtime made of commands. Nobody has asked for a home or a command.
- **It would slow every command.** A home in TypeScript would add 0.2 to 0.4 s to each command that touches state ([what a Node process costs](#what-runs-in-node)). The Go home costs nothing.
- **#212 didn't need a process.** What it lacked was places to choose and hooks.

What else was weighed, for when one is needed:

- **Go plugins.** Go's `plugin` package doesn't work on Windows, and needs the exact toolchain the CLI was built with. Plugins as separate binaries, as Pulumi's and Terraform's providers are, mean an author builds and ships one for every platform, in Go.
- **WebAssembly inside the Go binary.** The strongest sandbox, and no second process. But TypeScript compiled to it runs in a small JavaScript engine without Node's APIs, so most npm packages don't run: no AWS SDK, no Docker client.
- **A JavaScript engine embedded in Go** (goja, QuickJS): the same problem.

| Runtime | For | Against |
| --- | --- | --- |
| **Node** | Already required: it runs the config and the Pulumi program. Every npm package works. | Its permission model covers files and child processes, not the network or environment variables (as of Node 24). |
| **Deno** | Runs npm packages. Its permissions cover the network, environment variables, files and child processes, host by host and name by name. | A second runtime for SST to download and keep up. Its Node compatibility has to hold for every package an extension uses. |
| **Bun** | SST already downloads it, for installs. Starts fast. | No permission model. |

## Found while planning

- **A `true`/`false` or number provider setting is dropped without a message.** `pkg/project/run.go` passes only maps, lists and strings to Pulumi as `--config`, on `main` and on `v5`. #212 fixes it for every app, because Floci needed the `skip*` flags. 5.0 takes the fix with #212, in step 3.
