# SST's dev loop for Pulumi programs

**Started 2026-11-12**, on the branch `v5-pulumi-dev`, from `v5`. What's been done is in [progress.md](progress.md).

## Goal

A team that writes plain Pulumi gets SST's local development without moving to SST. In the maintainer's words, at the end there is:

1. "a way to use the pulumi configs or stacks while still having live reloads of local code for local development"
2. "dev commands so during local development dbs dont have to be spun up in the cloud like local postgres db development for the app"
3. "permissions work as they should"
4. "during local development things like the frontend etc dont have to be deployed to the cloud for quicker feedback"
5. "there might be a few other things too that native pulumi wants to use"

**SST runs the local dev loop, and Pulumi does everything else.** Pulumi keeps the program, the providers, the state and its backend, stacks, config, secrets, ESC, previews, CI and `pulumi destroy`. `sst dev` deploys a dev stack with `pulumi up`, runs its functions on the developer's machine, runs its dev commands, and deploys again when the program changes. The program says what's different in dev. A stack deployed with plain `pulumi up` has nothing of SST in it.

The maintainer doesn't want "a bunch of revisions on this", so the public parts are designed once: what the program writes, what `sst dev` gives the program, and the stack's opt-in.

## Decisions

| Date | Decision |
| --- | --- |
| 2026-11-12 | **The local side is `sst dev`, in the same binary**, run in a folder with a `Pulumi.yaml` and no `sst.config.ts`. On merit, not because it's there: the stub in Lambda and the loop on the machine speak one bridge protocol, which one binary keeps in step; the bridge's fixes land once for both; one npm install gives the CLI and the library. A tool of its own would rebuild the same parts (the Go stub, the transport, the runtimes, the watcher, the multiplexer) and need its own releases. A stub in a Lambda layer, as Lambda Live Debugger does, keeps the deployed code but needs one for each runtime, and gains nothing on a dev stack. |
| 2026-11-12 | **No custom Pulumi provider.** It can't swap a function it doesn't own, so each language would still need code of its own. Pulumi loads the plugin of every provider in a stack's state, so `pulumi up` and `pulumi destroy` would need SST's plugin for good, in CI and after a team stops using SST. And it would need plugin archives on each release, a schema and an SDK for each language. What it would do in Go, `sst dev` already serves over its RPC. If other languages are wanted later, Pulumi's cross-language components are the cheaper way, writing the same records. |
| 2026-11-12 | **The program side is transforms, not a wrapper component.** `transforms: [live("src/api.handler")]` on the user's own `aws.lambda.Function` keeps its typed args and its URN. A wrapper would change every function's URN, so an existing stack would replace its functions unless the user wrote aliases. Transforms also reach the functions a library's components create. |
| 2026-11-12 | **`sst dev` runs `pulumi up`**, with the developer's own `pulumi`, backend and login, as SST's `sst dev` deploys. The program learns it's in dev from the environment, so the next plain `pulumi up` puts the real code back. The maintainer's choice. |
| 2026-11-12 | **A stack opts in, and `sst dev` names it.** `sst dev` refuses a stack whose config doesn't set `sst:dev: true`, and takes the stack from `--stage` or the selected one. CI and production stacks never set it. The maintainer's choice ("Both"). |
| 2026-11-12 | **Everything SST adds is dev-only and needs no plugin.** The stub, the stub's role policy, the records and the dev commands are registered only under `sst dev`, as plain resources and components. A plain `pulumi up` removes them; `pulumi destroy` works without SST installed. |
| 2026-11-12 | **The CLI says what the stub is.** One RPC call, `Dev.Live`, registers a function to run locally and returns its stub: code folder, handler, runtime, architecture, environment and permissions. The library knows nothing about the stub, so a change to it is the CLI's alone, and a library in another language is a few lines. |
| 2026-11-12 | **It can ship on its own, without SST's state.** The maintainer: "design it in a way that we can just ship it with pulumi support only without sst state support if we needed to". A Pulumi project touches no home, passphrase, lock, bootstrap or move: what `sst dev` knows of the stack comes from `pulumi stack export`, in the stack's own backend, and the CLI's AWS provider is loaded without SST's bootstrap (`AwsProvider.Load`), so nothing of SST's is created in the account but the shared Event API every `sst dev` uses. Its code is `pkg/pulumidev` (`pkg/project/pulumi.go` until step 8), `cmd/sst/cli/pulumi.go`, `Dev.Live`, and `sst/pulumi`, which imports nothing of SST's platform. |
| 2026-11-12 | **The full split: `sst dev`'s machinery takes an interface, with an SST app and a Pulumi program as two implementations** ([step 8](#8-the-full-split)). Asked whether the work mixed SST and Pulumi code in the same files: it did, as 11 small Pulumi branches in 7 of SST's files, and `Dev.Live`. Of the two ways offered, Pulumi's code behind one seam inside `Project`, or `sst dev` depending on an interface rather than `*project.Project`, the maintainer chose the second ("lets do 2"), the one a separate binary or project would need. |
| 2026-11-12 | **The types both use stay in `pkg/project`, and the Pulumi package imports them**, settled as step 8 began. `CompleteEvent`, what the dev loop runs on, carries SST's own fields (the moved marker, the components' versions, import diffs), so a package of its own would be neutral in name only, and moving it would touch every file that reads it, the UI's too. What the Pulumi package may use of SST's project code is a short list (the contract's types, `CompletedFrom`, the dev command's environment, the runtimes, the platform's files), and `TestUsesNoneOfSSTsState` holds it to that: none of an app's home, state, passphrase, lock, move or bootstrap. |
| 2026-11-12 | **One import and a dev file, in place of SST's calls in the program** ([step 9](#9-one-import-and-a-dev-file)). Asked whether it could be less invasive in the IaC, and told it was a step of about the split's size that also takes code out, the maintainer said "do it". The program imports `sst/pulumi` once, which registers one transform for the whole stack under `sst dev`. `sst.dev.yaml`, next to `Pulumi.yaml`, names the functions to run locally and the dev commands, whose environment takes the stack's outputs and whose role is a role of the program, by name, which the transform lets the developer's account take. Dev commands leave the state: there's no component and no record, and only the stack's outputs and roles are read from it. A program changes nothing for SST but the import, and what it chooses to deploy only outside `sst dev`. Weighed and left out: no line at all, with `sst dev` swapping the functions through AWS's API after a plain `pulumi up`, as Lambda Live Debugger does, which would leave the state saying something else than what's deployed, so a crashed `sst dev` leaves stubs a plain `pulumi up` doesn't notice. |
| 2026-11-12 | **A function's name in `sst.dev.yaml` can be a pattern, with `{name}` in its handler.** Asked whether the file and the program's names have to be kept in step by hand, then for "an include all option", the maintainer said "yes" to patterns: `"*": functions/{name}.handler` names every function by a convention. A function's own name wins, then the first pattern that matches in the file's order. What a pattern matches but `sst dev` can't run (no source at the handler, an image, a runtime it doesn't run) stays in the cloud and is listed after the deploy, so `"*"` can't fail one; a name the file gives exactly still fails it. Left out: finding the source from the function's code, which is usually a build, so it can't be told from its source. |
| 2026-11-12 | **`sst.dev.yaml` stays YAML, with a JSON Schema.** Asked "is a yaml file the best way to do this or should it be a typescript file? or both?": the file is data, and a TypeScript file couldn't reach the program's values anyway, which are outputs known only in a deploy, so it would read them through the outputs as the YAML does. YAML keeps it to no language, like Pulumi's own files, so a Python or Go program can use it with a transform of its own, and the CLI reads it without running Node. What TypeScript would give, completion and errors as you type, a schema gives: `sst/schema/sst.dev.json`, which the YAML language server takes from a first-line comment. The maintainer said "yes". Both formats would double the docs and tests and need a rule for which wins; an `sst.dev.ts` can come later without breaking the YAML, if logic is ever needed. |
| 2026-11-12 | **Help with the dev file, four ways, in this order** ([step 10](#10-help-with-the-dev-file)). Asked what else could help with it, "this will be the biggest pain point", the maintainer chose all four: "yes we will do them all in that order". |
| 2026-11-12 | **Committed on `v5-pulumi-dev` only**, not merged into `v5` yet. Asked what to do with the work after the review: "Commit on the branch only". The tunnel, Pulumi programs in Python and Rust functions all wait: "We will do some other things first before these". |
| 2026-11-12 | **SST's own `pulumi` and `bun` aren't installed for a Pulumi program**, which runs the `pulumi` on the `PATH` and uses neither: the maintainer chose it after asking what happens when the program's Pulumi differs from the one SST ships. The clearer error for a program on `@pulumi/pulumi` older than 3.115 wasn't chosen. |
| 2026-11-12 | **An SST app's dev command keeps falling back to the developer's credentials** when its role can't be taken; a Pulumi program's refuses to run. Asked whether SST apps should refuse too: "Keep SST apps as they are". |
| 2026-11-12 | **The tunnel comes later**, after the dev file: a function in a VPC whose local code has to reach private resources. The maintainer: "we will do tunnel later". |
| 2026-11-12 | **TypeScript and JavaScript Pulumi programs first.** What the library sends and writes is language-neutral (environment, one RPC call, `_sst` records), so a Python or Go library can follow without changing `sst dev`. |
| 2026-11-12 | **Only `sst dev` works in a Pulumi project.** Every other command says to use `pulumi`. |
| 2026-11-13 | **The command is `sst pulumi dev`**, not `sst dev`. The maintainer: "We should change the name of the command though so it's not confusing with the other SST dev", and chose `sst pulumi dev` alone, with `sst eject` left where it is. `sst dev` runs an SST app alone, and in a Pulumi project says to run `sst pulumi dev`. Asked for by name, `sst pulumi dev` runs the nearest `Pulumi.yaml` up from the folder, in an SST app's folder too, or the one `--config` names. The first decision above, one binary, holds: it's the same CLI. `sst.dev.yaml` and the stack's `sst:dev` keep their names. Renamed before any release had it. |
| 2026-11-13 | **SST 4's line runs it too**, as the shared engine does: the maintainer asked to finish SST 4's support for it, in the engine's PR onto `main`. It runs none of either line's components, so nothing in it is SST 5's: SST 4's `sst` package ships `sst/pulumi` and the dev file's schema, the same files. SST 5's components in a Pulumi program stay SST 5's. |
| 2026-11-13 | **A program on `@pulumi/pulumi` older than 3.118 is refused under `sst pulumi dev`, with a message.** The 2026-11-12 decision didn't take a clearer error, while the `sst` package's peer range kept an older Pulumi out at install. The peers take any version since #272's review, as a range made npm refuse an app that pinned another, so without it such a program fails with `register is not a function`. The error was added without asking, the maintainer was told, and chose to keep it. |

## Design

### What the program writes: `sst/pulumi`

A new entry in the `sst` package, `sdk/js/src/pulumi/index.ts`, with `@pulumi/pulumi` and `@pulumi/aws` as optional peer dependencies of any version (since 2026-11-13: a range made npm refuse an app that pinned another). It needs `@pulumi/pulumi` 3.118.0 or later, the first with `registerStackTransform`; 3.115 to 3.117 have only `xRegisterStackTransform`. It imports nothing of SST's platform. Its types are also under `typesVersions`, so a program with Pulumi's default `moduleResolution: "node"` finds them.

```ts
import * as aws from "@pulumi/aws";
import * as sst from "sst/pulumi";

// A local database in dev, RDS otherwise
const db = sst.dev
  ? { host: "localhost", port: "5432", password: "password" }
  : createDatabase();
sst.devCommand("Postgres", {
  command: "docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:17",
});

// The function runs on this machine in dev, with its own role's credentials
const api = new aws.lambda.Function("Api", {
  runtime: "nodejs22.x",
  role: role.arn,
  code: new pulumi.asset.FileArchive("./dist/api"),
  handler: "index.handler",
  environment: { variables: { DB_HOST: db.host } },
}, { transforms: [sst.live("src/api.handler")] });

// The frontend's dev server in dev, deployed otherwise
if (sst.dev)
  sst.devCommand("Web", { command: "npm run dev", directory: "web", environment: { VITE_API: url.functionUrl } });
else deploySite();
```

- **`sst.dev`**: whether the program runs under `sst dev`. `SST_DEV=true` and `SST_SERVER` are both set.
- **`sst.live(handler, options?)`**: a transform for `aws:lambda/function:Function`. Outside dev it changes nothing. In dev it:
  - calls `Dev.Live` with the function's id (its name), its source handler and runtime;
  - gives the function the stub's code, handler, runtime, architecture, and the stub's environment added to its own;
  - adds an `aws.iam.RolePolicy`, `<name>SstDev`, to the function's role with the stub's permissions;
  - writes nothing else: `sst dev` lists the functions from the `Dev.Live` calls of the deploy. A function's id is its name with anything but letters, numbers, hyphens and underscores made a hyphen, as it names a folder; two functions can share one only with the same handler.
  - refuses a function from a container image, and drops SnapStart, which the stub's runtime doesn't have.
- **`sst.devCommand(name, args)`**: in dev, a component `sst:pulumi:DevCommand` with the `_sst` record `sst dev` reads: `command`, `directory`, `autostart`, `title`, `environment`, and `role`, whose credentials it runs with. Outside dev it registers nothing, and its class isn't exported, so none can be made outside dev. `testdata/pulumi/dev-command-v1.json` is the record: the library's test checks it writes it, and the CLI's that it reads it.
- **`sst.trust()`**: a transform for `aws:iam/role:Role`. In dev it lets the account take the role, so a dev command can run as it.

The local function runs with the deployed function's role, as the stub passes its credentials on: what it can't do in AWS, it can't do locally. Its environment is the deployed function's, so `DB_HOST` above is `localhost` in dev.

### What `sst dev` does in a Pulumi project

- **Finds it:** for `sst dev` only, no `sst.config.ts` up from the folder, and a `Pulumi.yaml` there or above it, with `runtime: nodejs`; or `--config` naming one. An SST app's folder stays the SST app's. Any other command there says to use `pulumi`.
- **The stack:** `--stage`, or `SST_STAGE`, or the stack selected in the project, by its fully qualified name, so one in an organization other than the default is found. SST knows it by its name without the organization. Its config is read once with `pulumi config --json`: `sst:dev` must be `true`; `aws:profile`, `aws:region` and `aws:assumeRoles` set up the CLI's AWS provider as they set up the program's, with the profile winning over `AWS_PROFILE`, then the environment does.
- **The environment:** `pulumi` runs with the shell's, as the CLI started with it: `.env` files aren't read for it.
- **Secrets:** only the `_sst` records are read in the clear. Every other secret in the export, the stack's outputs too, is `[secret]`.
- **A dev command's role:** it's taken, trying for half a minute while IAM catches up with a `trust` made by the same deploy, or the command doesn't run. With the role's credentials, `AWS_PROFILE` is taken out of its environment, as the AWS SDKs would use the profile instead (for SST apps too).
- **The platform:** copied into `.sst/platform` as for an SST app, for the stub and the runtimes' local files.
- **Deploys:** `pulumi up --yes --skip-preview --non-interactive --stack <stack> --event-log <file>` in the project, with `SST_DEV=true` and `SST_SERVER` set, and `PULUMI_DEBUG_COMMANDS=true`, which `--event-log` needs. The developer's own Pulumi home, backend, passphrase and plugins are used as they are. The events feed SST's UI. After it, `pulumi stack export --show-secrets` gives the state, which is read as for an SST app: the `_sst` records give the functions and dev commands.
- **Deploys again** when a file the program imports changes, from esbuild's metafile of the program's entry.
- **Everything after the deploy is SST's:** the transport, the live loop, the dev commands' panes and their credentials.
- **Not in a Pulumi project, for now:** links (`Resource`), tasks, tunnels, Cloudflare workers, `sst shell`.

## Steps

1. **This plan.**
2. **The CLI:** a Pulumi project for `sst dev`, `Dev.Live`, and Go tests.
3. **`sst/pulumi`**, tested with Pulumi's mocks.
4. **An example app**, `examples/pulumi-dev`: an API function, a local Postgres, a Vite frontend, a bucket it may read and one it may not.
5. **The lab check**, on the lab account, its own stack and a local file backend. Removed and cleaned up after.
6. **Docs:** a page on using `sst dev` with Pulumi.
7. **An independent review**, then fixes.
8. **The full split**, below.
9. **One import and a dev file**, below. The tunnel after it.
10. **Help with the dev file**, below.

### 8. The full split

Decided 2026-11-12 and built the same day. Before it, the Pulumi path was a `pulumiProgram` inside `project.Project`, reached by `if p.pulumi != nil` in `LoadHome`, `Run`, `GetCompleted`, `NeedsInstall` and `EnvFor`, and by Pulumi branches in `cmd/sst/cli` (`Discover`, `Stage`, `initProject`). Now:

- **`project.Program` is what `sst dev` runs** (`pkg/project/dev.go`): name, stage, home, providers, transport, target, runtimes, paths, watch, `Run`, `GetCompleted`, `EnvFor` and `RegisterRPC`, what the dev machinery used of `*project.Project` (counted on 2026-11-12: `App()` 15 times, `Runtime` 10, `PathLog` 5, `Provider` 4, `PathConfig` 4, `Transport` and `NoTransport` 2 each, and once each `Target`, `Run`, `ResolvePolicyPackPath`, `PathWatch`, `PathRoot`, `PathPlatformDir`, `GetCompleted`, `EnvFor`), without `*project.App` whole. `cmd/sst/mosaic` and `pkg/server` take it, and the CLI's other commands still take `*project.Project`, which implements it with a few one-line methods.
- **A Pulumi program is `pulumidev.Program`**, in `pkg/pulumidev`: `program.go` (the project, its stack and AWS settings, the dev command's role rule, the live functions) and `deploy.go` (`pulumi up`, its events, the stack's export, the program's files). `Project` has no Pulumi field or branch left.
- **The server registers what every program can call**, `Runtime` and `Dev`, and then the program's own: an SST app's `Provider.Aws` and `Move` (moved from `pkg/server/aws` and `pkg/server/contract.go` to `pkg/project/rpc.go`), and none for a Pulumi program. `Dev.Live` works for a program that implements `server.LiveProgram`; an SST app's components report their functions, so it refuses one.
- **The role rule is the program's**: `project.AssumeDevRole` and `project.AddDevEnv` are the parts of `EnvFor` both use; an SST app's dev command still runs with the developer's credentials when its role can't be taken, and a Pulumi program's tries for half a minute, then doesn't run.
- **The CLI's Pulumi handling is `cmd/sst/cli/pulumi.go`**: `Discover` and `Stage` make one call each, `InitDev` loads either for `sst dev` (and keeps the protected-stage check for an SST app), and `initProject` is SST's alone again. The steps both share, the update check, `SST_STAGE`, the Node.js warning and moving the log to `.sst/log/sst.log`, became `loaded` and `logTo`; the platform's copy became `project.PlatformCurrent` and `project.CopyPlatformTo`.
- **Fixed on the way**: `--stage acme/shop/dev` given to a second `sst dev <command>` named the stage with its organization, so it didn't find the server; and `--config infra/Pulumi.yaml` with another command than `dev` reached SST's config reader.
- **Checks:** the full Go suite and the library's tests; `TestUsesNoneOfSSTsState`, checked to catch an import of `pkg/state`, a call of `project.New` and of the provider's `Bootstrap`; a search of `pkg/project`, `cmd/sst/mosaic` and `pkg/server` for anything of Pulumi's left (only comments naming `pkg/pulumidev`, and the `LiveProgram` check); and the lab's exit tests again, with `sst dev` on an SST app, as its machinery changed: all passed ([progress](progress.md)).

### 9. One import and a dev file

Decided 2026-11-12. Replaces `live()`, `devCommand()` and `trust()` in the program:

```yaml
# sst.dev.yaml, next to Pulumi.yaml
functions:
  Api: functions/api.handler          # or { handler, runtime, streaming }
commands:
  Postgres:
    command: docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:17
  Web:
    command: node dev.mjs
    directory: web
    environment:
      API_URL: ${apiUrl}              # a stack output
  Report:
    command: node scripts/report.mjs
    role: Reporter                    # a role of the program, by name, or an ARN
```

- **The program:** `import "sst/pulumi"` first, which under `sst dev` registers a transform for the whole stack (`pulumi.runtime.registerResourceTransform`). It asks `sst dev` about each function and role as it's registered, by name, so the library knows nothing of the file: a function the file names becomes the stub, and a role a dev command names lets the developer's account take it. `dev`, whether it runs under `sst dev`, is still exported, and is `process.env.SST_DEV === "true"`.
- **The CLI:** reads the file when the program starts and on each deploy (a change to it deploys again), answers the transform over its own RPC service, registered by the Pulumi program (`PulumiDev`), and builds the dev commands from the file after each deploy, with `${output}` from the stack's outputs and a role's ARN from its resource in the state. `Dev.Live` and its types leave `pkg/server`.
- **Errors it names:** a file that doesn't parse or has an unknown field; a function the file names that the deploy never registered, as when `sst/pulumi` is imported after it; an output or a role a dev command names that the stack doesn't have.
- **What goes away:** the `sst:pulumi:DevCommand` component and its record, the shared fixture, reading every resource's secrets, and `CompletedFrom` outside `pkg/project`.
- **Patterns:** `functions` takes `*` and `?` in a name, and `{name}` in a handler; see the decision.
- **The schema:** `sdk/js/schema/sst.dev.json`, shipped in the `sst` package; `TestSchemaMatchesDevFile` fails when it and the CLI's reader have different fields.
- **A command's `directory`** is from the file's folder, wherever `sst dev` is started in the project: the CLI makes it relative to the folder `sst dev` runs in, which is what the panes take.
- **Checks:** Go and library tests, then the exit tests in the lab again.

### 10. Help with the dev file

Decided 2026-11-12; all four done the same day. In this order:

1. **Catch mistakes before the deploy, and suggest fixes.** Check each handler's source when `sst dev` starts and on each read of the file (for a name given exactly; a pattern's are checked per function, as now), so a wrong path isn't found only at the first invocation. Add "did you mean" to the errors that list what exists: a function the program didn't make, an output the stack doesn't have, a role it doesn't have.
2. **Say what's running where after each deploy:** an `On this machine` hint, each function with its handler, beside `In the cloud`.
3. **Write the file:** with no `sst.dev.yaml`, `sst dev` offers to write one, from a plain `pulumi preview --json` (it changes nothing): every function, with its handler found or guessed (a code folder of source gives it exactly; a build folder like `./dist/api` is guessed from a single matching source file or the bundle's source map, with a comment to check it, and left commented out when unsure), and the roles and outputs as comments, for `role:` and `${...}`.
   As built, two changes: the preview is read from Pulumi's event log (`--event-log`, as a deploy's is), because `preview --json` has no stack outputs; and it previews the program as `sst dev` deploys it, with `SST_DEV` set and a stand-in server that answers the transform "nothing runs here", so a program's dev branch is what's read (a branch only outside dev can need config the dev stack doesn't have, like a database password).
4. **Recipes in the docs:** esbuild per function, plain JS or Python folders, Go, functions in a component, a monorepo.

Each with Go tests, a lab check for 1 to 3, and the docs.

### Exit tests (step 5)

1. The stack's config, a secret too, reaches the program; `sst dev` refuses a stack without `sst:dev: true`.
2. A function behind a URL runs on the machine: a code change answers on the next call, with no deploy.
3. A local Postgres from a dev command, which the live function reads and writes. The dev stack has no database; a preview of a stack without `sst:dev` plans one.
4. The live function reads the bucket its role may read and is refused the other; a dev command with `role` runs as that role.
5. The frontend's dev server runs with the API's URL from the stack, and isn't deployed in dev.
6. A change to the program deploys again.
7. A plain `pulumi up` on the dev stack puts the real code back and leaves nothing of SST in the state; `pulumi destroy` with no `sst` on the `PATH` removes the rest.

## Status

| Step | Status |
| --- | --- |
| 1. Plan | Done, 2026-11-12. |
| 2. CLI | Done, 2026-11-12: `pkg/project/pulumi.go` (`pkg/pulumidev` since step 8), `Dev.Live`, the CLI's discovery, stage and command guard, with Go tests. |
| 3. `sst/pulumi` | Done, 2026-11-12, with bun tests under Pulumi's mocks. |
| 4. Example app | Done, 2026-11-12: `examples/pulumi-dev`. |
| 5. Lab check | Done, 2026-11-12: all seven exit tests passed; removed and audited ([progress](progress.md)). |
| 6. Docs | Written, 2026-11-12: `docs/use-with-pulumi`. |
| 7. Review | Done, 2026-11-12: an independent review's 14 findings, 13 fixed and one a docs warning ([progress](progress.md)). |
| 8. The full split | Done, 2026-11-12: built, tested, and the exit tests and an SST app's `sst dev` checked in the lab, removed and audited ([progress](progress.md)). Everything is uncommitted on `v5-pulumi-dev`. |
| 9. One import and a dev file | Done, 2026-11-12: built, tested, and the exit tests checked in the lab in the new form, removed and audited ([progress](progress.md)). Uncommitted. |
| 10. Help with the dev file | Done, 2026-11-12: the source check and "did you mean", `On this machine`, and `sst dev` writing the file, built, tested and checked in the lab; the docs' recipes written, of which the bundle and the patterns are the lab's, and Python, Go, a component and a monorepo are from the code, not run ([progress](progress.md)). Uncommitted. |
| Review of 8 to 10 | Done, 2026-11-12: two independent reviewers; 15 findings checked, 13 fixed (Rust by taking it out for now) and 2 kept as they are; lab-checked ([progress](progress.md)). The docs page installs `@next-experimental`, so it ships with the release that has this. Uncommitted. |
