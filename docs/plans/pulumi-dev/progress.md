# SST's dev loop for Pulumi programs: progress

What's been done on [the plan](plan.md), newest first.

## 2026-11-13: on SST 4's line

- `sst pulumi dev` is on both lines ([decision](plan.md#decisions)): the CLI's contract gate for a Pulumi project is gone, and SST 4's `sst` package ships `sst/pulumi` and `schema/sst.dev.json`. Checked in the lab with an SST 4 CLI and package: the stub deployed, the function answered from its local source and after each edit, a dev command ran, and a plain `pulumi up` put the deployed code back ([shared-core's progress](../shared-core/progress.md)).

## 2026-11-13: `sst pulumi dev`

- **The dev loop for a Pulumi project is `sst pulumi dev`** ([decision](plan.md#decisions)), a `pulumi` command with `dev` under it, on SST 5's line as the Pulumi path was. Its flags are `sst dev`'s: `--mode`, `--policy`, and `--stage` and `--config` as before.
- **`sst dev` runs an SST app alone.** In a Pulumi project, with `--config` naming a `Pulumi.yaml` too, it stops with `ErrCommand`, which says to run `sst pulumi dev`, as every other command does.
- **`sst pulumi dev` finds the nearest `Pulumi.yaml`**, in an SST app's folder too, as it's asked for by name, and takes a `--config` that names a `Pulumi.yaml` alone.
- **The dev loop's panes run its own command again** (`Cli.DevCommand`): `sst pulumi dev` with `SST_CHILD`, where they ran `sst dev`, which would now find no Pulumi project.
- **What it says, and the docs, say `sst pulumi dev`**: `pkg/pulumidev`'s messages, `sst/pulumi`, the dev file's schema, the platform's notes on a program Pulumi runs, the example and the two docs pages. Where they compare with an SST app, they say `sst dev`.

## 2026-11-12: no download of SST's own Pulumi for a Pulumi program

The maintainer asked what happens when a Pulumi project's Pulumi differs from the one SST ships, and chose to skip the downloads ([decisions](plan.md#decisions)).

**Built:** a Pulumi program runs the `pulumi` on the `PATH`, and SST's own `pulumi` and `bun` are only an SST app's, yet `sst` installed both at start for every command. `cmd/sst/main.go` skips them when `Cli.IsPulumiProgram` finds one, as `Discover` would but without making an SST app's `.sst`.

**Checked:** a test of what it finds (a Pulumi project, an SST app with a Pulumi project in it, `--config`, neither) and that it makes no `.sst`; and `sst dev` in the lab copy with an empty `HOME`, which went straight to "No Pulumi stack is selected" and installed nothing.

## 2026-11-12: an independent review of steps 8 to 10, and its fixes

The maintainer asked for one ("yes do an independent review"). Two reviewers, each with the code and the spec and none of this log: one on SST's own code changed by the split (an SST app must behave as at HEAD), one on the Pulumi path, the SDK's transform, the schema, the example and the docs. Each finding was checked against the code before it was fixed.

**SST's own code:**

- **A dev command with a role lost `AWS_PROFILE` in an SST app too.** The pane dropped the profile whenever a role's credentials came with it, and SST's own sites give their dev servers a role, so a site's dev server would have run as its role instead of the developer's profile. Now `project.DevAws` has `Only`, which only the Pulumi path sets, and the pane drops the profile only then (`EnvResponse.Inherit`).
- **On Windows the temp log was left behind.** The split moved its removal ahead of `configureLog`, which moves the crash output off it; `logTo` now sets up the log before it's removed, as at HEAD.
- **An SST app that couldn't be used fell through to a Pulumi project up from it,** when its `.sst` couldn't be made. The Pulumi project is looked for only when there's no `sst.config.ts`.
- **The pane's lookup wasn't escaped,** so a project path with `&` or `#`, or a dev command's name with a space, wasn't found. Fixed with `QueryEscape`; the server already decoded it.

**The Pulumi path:**

- **Every secret in the state was decrypted** after each deploy, with `stack export --show-secrets`, against the docs and the plan's step 9. The state is now read encrypted, and only a secret output a dev command's environment names is read in the clear, once, with `pulumi stack output <name> --show-secrets`.
- **A secret `aws:` setting was passed over,** as `pulumi config --json` gives a secret no value, and an external ID set with `--secret` makes all of `aws:assumeRoles` secret: the CLI would have reached another account than the program's. It's refused with a message.
- **Rust functions couldn't run:** the Rust runtime takes another handler form and finds its crate from the folder the CLI runs in. Not having been tried, Rust is refused for a Pulumi program and taken out of the docs and the schema, for now.
- **The transform returned `opts`,** which makes Pulumi rebuild a resource's options from the part a transform sees (dropping `hideDiffs` and `pluginChecksums`). It returns only `props` now, which keeps them as they are, in `@pulumi/pulumi` 3.115 as in 3.270.
- **`"*"` could fail a deploy** when two functions' ids clashed with other handlers, with a message that named neither. One a pattern matches stays in the cloud with why; one named exactly fails with both names.
- **`sideEffects: false`** let a bundler drop `import "sst/pulumi"`; now only its module is marked as having them (checked with esbuild).
- Smaller: the role error named the removed `sst.trust()`; an absolute command `directory` is refused; a backend `pulumi` can't reach says so, not "no stack is selected"; the docs on `dev`, secrets and secret `aws:` settings.

**Kept as is:** `dev.Env` now gives the server's own error text, which is clearer. The new CLI files are under a git-ignored path and need `git add -f` (noted for the commit).

**Checked:** the full Go suite (42 packages, with vet), the race detector on the changed packages, the SDK's 10 tests and its typecheck. In the lab, on a copy of the example's, on a new stack `review`: a deploy under the new transform; the API on this machine as its role; a dev command given a secret output got it in the clear and kept the developer's profile; one with a role, with `AWS_PROFILE` set to a profile that doesn't exist, ran as its role; the secret's value is in no file `sst dev` wrote. Destroyed and removed after, with the API's log group.

## 2026-11-12: an SST app's `sst dev`, after steps 9 and 10

The maintainer asked whether SST 5 apps still work without changes and without `sst.dev.yaml`, then "Do it. Test it".

**Checked:** the step 8 test app (a `Bucket`, a linked `Function` with a URL, and a `DevCommand` with a link, an environment variable and a role), with a CLI and SDK built from the branch as it is now, on a new stage, `sstcheck`. `sst dev` deployed it without a word about a dev file, and printed the app's own hint; the live function answered with the linked bucket's name; a change to its code answered on the next call, with no deploy; the dev command (`SST_CHILD=SplitDev`) got its environment, its link and the app, and ran as its role. `sst remove`, then the bucket it keeps (empty), the passphrase and the stage's 44 state versions and markers were deleted; no function, role or log group of it is left. The shared dev stub code in the asset bucket stays, as other stages use it.

## 2026-11-12: help with the dev file, item 4: recipes

**Written:** a "Recipes" section in `docs/use-with-pulumi`: a bundle for each function (esbuild in the program, one `"*"` pattern, source maps for the written file), a folder of JavaScript or Python (the handler is the folder and the function's handler; Python needs uv and a `pyproject.toml`, as an SST app's does), Go (`provided.al2023` with `runtime: go`, the `main` package's folder), functions in a component (by the function's own name, not the component's), and a monorepo (paths from `Pulumi.yaml`, a folder up; the schema's path; `--config` from the root).

**Fixed on the way:** the Go runtime finds `go.mod` from the handler as the folder `sst dev` runs in sees it, so `sst dev --config infra/Pulumi.yaml` from a repository's root couldn't build a Go function. The transform's answer now gives Go's handler in full (`buildHandler`); Node.js and Python already find theirs from the project's folder. And the written file guesses a Go function deployed from an archive's `bootstrap` by its build's folder, where it said it couldn't find the code.

**Checked:** the page renders on the docs server. The bundle and pattern recipes are what the lab ran (the example's build and the patterns check); the Python, Go, component and monorepo recipes follow the runtimes' and the transform's code and the Go tests, and haven't been run in the lab.

## 2026-11-12: help with the dev file, items 1 to 3

The maintainer asked what else could help with the dev file, "this will be the biggest pain point", and chose four helps, in order ([step 10](plan.md#10-help-with-the-dev-file)). The first three are built.

**Built:**

- **Mistakes caught before the deploy, with a suggestion.** Each read of `sst.dev.yaml` (as `sst dev` starts and on each change) checks that each function named exactly has its source: for its runtime when the file gives one, and otherwise for Node.js, Python, or a path, as the runtime is known only when the program makes the function. As the program makes it, the transform's answer checks again for the function's own runtime. A pattern's handlers are checked per function, as before. "Did you mean" (`pkg/pulumidev/suggest.go`: a few edits away, case aside, or the only name that holds it, as `Web` and `WebHandler`) is added to a field the file doesn't take (each level checks its own fields now, so a command's are suggested from a command's), a handler's path (folder by folder), a function the program didn't make, a missing output and a missing role.
- **`On this machine`** after each deploy, each function with its handler, beside `In the cloud`; both lists stop at 20 and count the rest. The deploy's hints print sorted, so the two keep their order.
- **`sst dev` writes the file** (`pkg/pulumidev/write.go`). With none, in a terminal, it offers to write one from a preview of the stack, shows it, and asks whether to start with it. Two changes from the plan: the preview is read from Pulumi's event log, as `preview --json` has no stack outputs; and it runs as `sst dev` deploys, with `SST_DEV` and a stand-in server that answers "nothing runs here", so the program's dev branch is what's read. A folder of source gives a handler exactly; a build's handler is guessed from its source map (beside it, named in it, or inline), else from the one source named like the build, and marked `# check it`; when unsure it's commented out with why; a container image, code written in the program or in S3, and a runtime `sst dev` doesn't run are listed as staying in the cloud. Go functions are guessed from a folder of Go named like the build. The outputs and roles end the file as comments. What it writes is read back as `sst dev` reads it before it's saved.

**Checked:** the Pulumi package's tests (suggestions, the source check for each form and runtime, the written file for each kind of function, an empty program, the schema's path in a monorepo, YAML quoting, the list's cap, and the CLI's field lists held to its reader by the schema test), and the full Go suite (41 packages, with vet). In the lab, on a copy of the example's, on a stack `shape`: a misspelt handler stopped `sst dev` before anything deployed, with "did you mean functions/api.handler?"; a deploy with a function the program didn't make, a misspelt role and a misspelt output failed with "did you mean" for each; fixing the file deployed again by itself and said `In the cloud: Cron (no functions/Cron.handler)` and `On this machine: Api (functions/api.handler)`; a call to the API ran on this machine. Without the file, `sst dev` wrote one from a preview, before and after a deploy (unchanged resources carry their inputs too): `Api` guessed from `./dist/api`, `Cron` left in the cloud as code written in the program, and the stack's three outputs and two roles. Destroyed and removed after, with the API's log group; the two roles left in the account are another of the maintainer's stacks'.

## 2026-11-12: a schema for `sst.dev.yaml`

The maintainer asked whether it should be YAML, TypeScript or both, and said "yes" to YAML with a schema ([decision](plan.md#decisions)).

**Built:** `sdk/js/schema/sst.dev.json`, a JSON Schema (draft 7) of the file, with each field's description from the docs, shipped in the `sst` package (`files`). An environment value can be a number, a boolean or empty, as the CLI reads them as text. The example's and the lab folder's file start with the YAML language server's comment, and the docs say how to point it at the schema.

**Checked:** `TestSchemaMatchesDevFile` compares the schema's fields with the CLI's reader, the top level, a command and a function, and their required fields; a field added to the schema alone failed it. Ajv validated the example's and the lab folder's files, patterns and a number as an environment value, and refused a misspelt field in a command, a command without one, a misspelt top-level field and a function with a field it doesn't take. `npm pack` includes the schema.

## 2026-11-12: patterns for functions

The maintainer asked whether the file and the program's names have to be kept in step by hand, "specifically for function names that could get long", then for "an include all option", and said "yes" to patterns ([decision](plan.md#decisions)).

**Built:** a name in `functions` can have `*` and `?`, and a handler `{name}`, the function's name. A function's own name wins, then the first pattern that matches in the file's order. What a pattern matches but `sst dev` can't run stays in the cloud and is listed under the deploy's "Complete", with why: no source at its handler (a Node.js or Python handler's file, a Go or Rust handler's path), a container image, or a runtime `sst dev` doesn't run. A name given exactly still fails the deploy for those, and a pattern that matches nothing isn't an error. A function the file names that the program didn't make now lists the ones it made. The example's and the lab folder's `sst.dev.yaml` show `"*"` in a comment.

**Checked:** the Pulumi package's tests (the order, `?`, `{name}` and a misspelt placeholder, a name given twice, the source for each runtime, what `"*"` leaves in the cloud and why, and that a pattern matching nothing is no error), and in the lab, with a second function the lab copy adds: `"A*"` ran `Api` on this machine, `"*"` matched `Cron`, found no source and left it as its code, and the deploy said `In the cloud: Cron (no functions/Cron.handler)`. Destroyed and removed after, with the log group of its function; another stack's function in the account was left alone.

## 2026-11-12: one import and a dev file

Asked whether it could be less invasive in the IaC, the maintainer chose one import and a file of its own ("do it then the tunnel"; then "we will do tunnel later") ([step 9](plan.md#9-one-import-and-a-dev-file)).

**Built:** `sst/pulumi` registers one transform for the whole stack under `sst dev` (`pulumi.runtime.registerResourceTransform`), which asks `sst dev` about each function and role, over the Pulumi program's own RPC service, `PulumiDev` (`pkg/pulumidev/rpc.go`). `sst.dev.yaml` (`pkg/pulumidev/devfile.go`) names the functions, by their name in the program with their source handler, and the dev commands, whose environment takes `${output}` and whose role is the program's, by name, or an ARN. Dev commands leave the state: the `sst:pulumi:DevCommand` component, its record and the shared fixture are gone, and only the stack's outputs and roles are read from it. `Dev.Live` left `pkg/server`, whose contract is `Dev.Stub` alone again, and `pkg/project`'s state reader is as it was before this work. `live()`, `devCommand()` and `trust()` are gone from the library, as nothing was released.

**Its errors:** no file (with an example), a field it doesn't know (by line, in the file's words, not the CLI's types), a function without a handler, a command without a command, two names with one id, a container image function, a runtime it doesn't know, a function the file names that a deploy that went through never made, listing the ones it made, a role a command runs as that the program made before it imported `sst/pulumi`, and an output or role a command names that the stack doesn't have, which leaves that command out.

**Checked:** the Go suite (41 packages), the library's 10 tests (the transform registered once on import in dev, and none outside it; the stub; a function the file doesn't name; an image; SnapStart; a role a command runs as, and one it doesn't), and the Pulumi package's tests for the file, `${output}`, the RPC, a command's directory and the state's outputs and roles. In the lab, on a new stack, all seven exit tests again: the refusals, with no file and a misspelt field too; the secret; a code change with no deploy; Postgres from the file; a preview of a stack that hadn't opted in; the function as its role and `Report` as `Reporter`, named in the file, whose trust only that role got; the frontend with the output's URL; and a plain `pulumi up` and `pulumi destroy` without `sst`, the state with no `sst:` type at any point. Renaming the function in the file deployed again, put its code back, removed its stub policy and said which functions the program made; naming it again made it the stub again. Removed after, with the log group Lambda made, and audited.

## 2026-11-12: the full split

The maintainer asked whether the work mixed SST's code and Pulumi's in the same files, and chose the full split ("lets do 2"): `sst dev`'s machinery depends on `project.Program`, with an SST app and a Pulumi program as its two implementations ([step 8](plan.md#8-the-full-split)).

**Built:** the interface (`pkg/project/dev.go`); the Pulumi program as `pkg/pulumidev` (`program.go`, `deploy.go`); SST's own RPC calls, `Provider.Aws` and `Move`, registered by the SST app (`pkg/project/rpc.go`), and `Dev.Live` only for a program that implements `server.LiveProgram`; `EnvFor`'s role and environment as `project.AssumeDevRole` and `project.AddDevEnv`, so each program keeps its own rule; and the CLI's Pulumi handling in `cmd/sst/cli/pulumi.go`, with `InitDev` for `sst dev`. `Project` has no Pulumi field or branch, and `initProject`, `Run`, `GetCompleted`, `NeedsInstall` and `LoadHome` are as they were before this work. The types both use stay in `pkg/project` ([decision](plan.md#decisions)), and `TestUsesNoneOfSSTsState` keeps the Pulumi package to the contract's types and the dev loop's helpers: checked by planting an import of SST's state, a call of `project.New` and of the provider's `Bootstrap`, which it named, each.

**Fixed on the way:** `--stage acme/shop/dev` given to a second `sst dev <command>` kept the organization in the stage, so it didn't find the server; and `--config infra/Pulumi.yaml` with another command than `dev` reached SST's config reader. Both have tests.

**Checked:** the full Go suite (41 packages) and the library's 14 tests. In the lab, with a CLI built from the split, on a new stack and a local file backend, all seven exit tests again: the opt-in refusals and `sst deploy`'s message; the stack's secret in the function; a code change answering with no deploy; the live function counting visits in Postgres from the dev command, and a preview of a stack that hadn't opted in planning the database, the site and the real function; the function as its role, reading one bucket and refused the other, and `Report` as its role; the frontend's dev server with the API's URL and no site in the stack; a change to the program updating the function in place, still the stub; and a plain `pulumi up` with no `sst` on the `PATH` putting the code back and leaving nothing of SST's, then `pulumi destroy`. And SST's own `sst dev`, as its machinery changed, on a small SST app of the lab's on a stage of its own: deployed, its log in `.sst/log/sst.log`, the live function reading its link, a code change with no deploy, and its dev command with its environment, link and role's credentials. Removed after; the stage's state, history, locks and passphrase deleted, and its bucket, which SST keeps on remove by default; the function's log group deleted; nothing left of either check.

## 2026-11-12: the independent review, and its fixes

An independent review read the branch fresh. Its findings, and what was done:

1. **The CLI's AWS access could reach another account than the program's**: `AWS_PROFILE` won over the stack's `aws:profile`, the reverse of Pulumi's provider, and `aws:assumeRoles` was ignored. The CLI now sets up its access from the stack's `aws:profile`, `aws:region` and `aws:assumeRoles` as they are (`AwsProvider.LoadFrom`); a role with an external ID is refused, as it isn't supported yet.
2. **A dev command whose role couldn't be taken ran with the developer's credentials**, and with `AWS_PROFILE` set, the AWS SDKs used the profile over the role's credentials anyway. In a Pulumi project the role is now tried for half a minute (a `trust` made by the same deploy takes IAM a few seconds), then the command doesn't run, and says why: `dev.Env` now passes on what `sst dev` answered. `AWS_PROFILE` and `AWS_DEFAULT_PROFILE` are taken out of a command's environment when it has a role's credentials, for SST apps too. An SST app's dev command still runs with the developer's credentials when its role can't be taken, as before.
3. **A stack in an organization other than the default** wasn't found: the selected stack is now read fully qualified, `--stage` takes one, and SST knows it by its name alone.
4. **Two developers in one account with a stack of the same name** share the stubs' channel. Left as it is, as SST's stages are, and the docs say to give each developer a stack of their own.
5. **A `Pulumi.yaml` inside an SST app's folder took over every command there.** Discovery now follows the plan: only `sst dev`, and only with no `sst.config.ts` up from the folder, or with `--config`.
6. **`.env` files changed what `pulumi up` deployed.** The CLI puts back the environment it started with before it runs `pulumi`, and doesn't read the project's `.env`.
7. **Secrets were shown in the clear**: the stack's secret outputs in the UI, and every secret in the state served to the dev commands. Only the `_sst` records are read in the clear now.
8. **A container image function would be replaced**, failing with an explicit name, and SnapStart broke the stub's runtime: `live` refuses an image function and drops SnapStart.
9. **Files outside the project's folder never deployed again**, nor rebuilt a function: `sst dev` in a Pulumi project watches its repository, and a file reached through a linked folder is matched by both its paths.
10. **Two `sst dev` runs in one project shared an event log**: it's one for each stack now.
11. **A function's name could make paths outside `.sst/artifacts`**: its id keeps letters, numbers, hyphens and underscores. Two functions can share an id with the same handler, as both then run the same code with their own environment and role; the plan said otherwise and was corrected.
12. **Each dev command's environment ran `pulumi stack export`**: it's read only when the last deploy's state isn't known, for SST apps too, which changes nothing they're given: the state read was used only then.
13. **`trust` threw on a policy with one statement as an object**: fixed.
14. **The docs** now say to ignore `.sst/`, that a passphrase stack needs `PULUMI_CONFIG_PASSPHRASE`, that `SST_STAGE` names the stack, how the CLI's AWS access is set up, and that `sst.config.ts` comes first.

**Checked in the lab again** on a new stack, with the fixes, removed and audited after (the log group Lambda made deleted, nothing else left): the stack found by its fully qualified name and shown as `dev`; the live function as its role, reading one bucket and refused the other; the `Report` dev command as its role on the first deploy, whose `trust` came with it, and again with a made-up `AWS_PROFILE` in its environment; and, after the `trust` was taken out and IAM caught up, the command refused to run, after half a minute of trying, saying it couldn't take the role and why. That message first came out as "Unexpected error": `dev.Env` now gives what `sst dev` answered as a readable error. The frontend's dev server had the API's URL.

Checked: the Go tests for each (an export with secrets in inputs and outputs, a fully qualified stack, the stack's AWS settings, ids, the watch root, discovery in each case, putting the environment back) and the library's (an image function, SnapStart, one statement).

## 2026-11-12: built, and checked in the lab

**Built:** a Pulumi project for `sst dev` (`pkg/project/pulumi.go`), the RPC call `Dev.Live` (`pkg/server/contract.go`), `sst/pulumi` (`sdk/js/src/pulumi/index.ts`), the example `examples/pulumi-dev`, and the docs page `docs/use-with-pulumi`. The CLI's AWS provider can now load without SST's bootstrap (`AwsProvider.Load`), and the state reader reads a deployment from anywhere (`completedFrom`), which a Pulumi project gives it from `pulumi stack export --show-secrets`. The maintainer asked midway that it can "ship it with pulumi support only without sst state support": the Pulumi path touches none of SST's state ([decision](plan.md#decisions)).

**Checked without the cloud:** the Go tests for the project (Pulumi.yaml, the program's entry, the stack's opt-in against a fake `pulumi`, an export with secrets, errors from events, the event log read as it's written, the program's files for a redeploy, a workspace package followed through its link), and the full Go suite and `go vet`. `sst/pulumi`'s bun tests under Pulumi's mocks: inside and outside `sst dev`, the stub's props, the RPC call, the role policy made from inside the transform, `trust`, and the dev command's record, which is `testdata/pulumi/dev-command-v1.json`, the file the CLI's test reads too.

**Checked in the lab**, on the lab account, with the example copied to a scratch folder, a local file backend, Pulumi 3.270.0 and a CLI built from the branch. The copy's Postgres was on another port, as one was already running on 5432, and a `LAB_NO_RDS` switch kept the plain `pulumi up` from creating a database. All seven exit tests passed:

1. The stack's secret config reached the program and the function. `sst dev` refused the stack before it opted in, with the command to opt in, and `sst deploy` said to use `pulumi`.
2. A change to the function's code answered the next call, built again on this machine, with no deploy.
3. The live function wrote to and counted from Postgres in a container, run by the dev command as its pane would run it; the container went with the pane. A preview of a stack that hadn't opted in planned the RDS instance, the site and the real function, and nothing of SST.
4. The local code ran as the function's role (`whoami`), read the bucket the role may read and was refused the other. The `Report` dev command ran as its role (session `sst-dev`), taken through the `trust` transform, with that role's access.
5. The frontend's dev server served the API's URL from the stack, and the dev stack had no site.
6. A change to `index.ts` deployed again by itself: the function updated in place, still the stub, and still answered locally.
7. A plain `pulumi up`, with no SST in the environment, updated the function in place (not replaced) back to its code and handler, deleted the three dev commands and the stub's role policy, took the `trust` statement out of the role, and created the site. The state had no `sst:` type. `pulumi destroy` with no `sst` on the `PATH` removed all 15 resources.

**Found by the lab and fixed:** `--event-log` is a flag pulumi takes only with `PULUMI_DEBUG_COMMANDS=true`, as SST's own runs set it; the library read `sst dev`'s address when it called rather than when it loaded (found by its test); with Pulumi's default `moduleResolution: "node"`, TypeScript couldn't find `sst/pulumi`'s types, now under `typesVersions`; and the example's RDS instance needed `identifierPrefix`, as RDS takes lowercase identifiers only.

**Type resolution of `sst/pulumi`:** it resolves under `node10`, `nodenext` and `bundler`. A CommonJS program under `node16` gets TypeScript's TS1479 for any ES module, which the whole `sst` package already does; the docs say which settings work.

**Cleaned up:** both stacks removed; the function, both roles and the three buckets checked gone; the log group Lambda made for the function deleted; no new AppSync Event API (the shared `sst` one, from 2024, was used); no container left.

## 2026-11-12: the plan

The maintainer asked whether live Lambda and dev commands could be made to work with plain Pulumi, then for a branch to test it "because if it works I dont want to wait until 5.x", without "a bunch of revisions". A custom Pulumi provider was weighed at their ask and left out ([decision](plan.md#decisions)). The shape was weighed again from scratch when they said the recommended way was good "only if it is the best way to do this, not just because its the way we do it today": the local side stayed `sst dev`, and the program side changed from a wrapper component to transforms, which keep each function's URN.
