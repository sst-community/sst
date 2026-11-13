# SST as a layer on plain Pulumi: progress

The log, newest first. The plan is [plan.md](plan.md).

## 2026-11-12: step 6, the sweep in the lab

The components an app uses most that steps 1 to 5 hadn't deployed, under plain Pulumi, then ejected. Committed as `9cfaedc6c`, with the `Function` fix on `v5` as `d1adf0d2a`, merged here.

**The program** (project `thinsweep`, stack `sw`): a `Router` with a `Bucket` at `/files`, a `Function` at `/api` by its URL (linked to the bucket, with `addEnvironment` giving it the router's URL), a route to a URL at `/ext`, and a `Nextjs` site at its root; a `Queue` with a subscriber; a `Dynamo` table with a stream subscriber; and a `Cron`.

**What changed:**

- **A bundle's handler is known in a new stack's preview** (`aws/function.ts`). A function built elsewhere, like a site's server that OpenNext built, was built again by the CLI with the links' key, which a new stack's preview doesn't know yet, so its handler wasn't known either, and the AWS provider refused the function: "handler and runtime must be set when PackageType is Zip". Plain `pulumi up` previews first, so every first deploy of a site failed. The CLI's build of a bundle gives the handler it's given, so a preview that can't build it takes that. This is a bug on `v5` too: `sst diff` on a new stage, and a deploy that previews first (a stage with checks or a policy pack), so it's fixed there (`d1adf0d2a`) and merged here. The test of a `Nextjs` site in a new stage's preview now has the key unknown too, and checks every function's handler.
- **The eject takes a route's entries out of the state** (`KvRoutesUpdate`), as it does a site's.
- **The eject puts what `addEnvironment` added in the function's environment.** It's in the function in AWS and not in its state, so the first `pulumi up` updates the function in place, to what it already is. The eject says so, and its dry run too.
- **The eject makes the AWS providers SST makes for a region** (`AwsProvider.sst.<region>`, which a server-rendered site's server is made with), with a `regionProvider` function in the module that makes them as SST does: the stack's AWS config, with the region.
- **No origin access control to adopt.** The `Router` makes none of its own: its routes set their origin's access in the key-value store. Adopting SST's `OriginAccessControl` waits for a component that makes one.

**Checked:**

- Before the eject: `pulumi preview` (109 to create, which failed without the `Function` fix), `pulumi up` (109 created). The Next.js page at the root, `/api` with the bucket's name and the router's URL from `addEnvironment`, a file in the bucket at `/files`, `/ext` passing its path to example.com; a message on the queue, an item in the table and the cron, each logged by its function.
- `sst eject --dry-run`, then `sst eject`: 16 secrets put in the config, 33 resources out of the state, one update in place said.
- The program switched to `ejected()`, `sst` uninstalled, `SST_BIN_PATH` unset, SST's plugin moved out of Pulumi's plugins: `pulumi preview --diff` showed `ApiFunction`'s environment gaining `ROUTER_URL` and 76 unchanged; `pulumi up`, 1 updated. Every route answered as before, and the queue's, the table's and the cron's functions ran. Another preview: 77 unchanged.
- `pulumi destroy`, still without SST: 77 deleted. Each of the 35 resources the stack had in the cloud checked directly (functions, roles, buckets, the distribution, the CloudFront function, the key-value store, the cache policy, queues, tables, the rule, log groups): gone; the tagging API lists nothing of the app. The 8 code files and 4 source maps the eject left in the asset bucket, where it said, were deleted by their keys. The shared stub objects are as they were.
- Platform: the `Function`, `Nextjs` and preview tests; the full suite, where three takeover tests that timed out while the lab's Next.js site was building passed when run again. Go: `pkg/eject`'s tests (a route's entries and `addEnvironment` in the fixture), the full suite. The module the lab's state gave typechecked.

## 2026-11-12: step 6, the sweep in the mock

Every SST 5 component's tests, run as Pulumi runs a program, with none of SST's globals. Committed as `d85d01786`, with the path fix on `v5` as `57d26dd4f`, merged here.

**What changed:**

- **`sst/testing`'s `mockPulumi` takes `plain: true`** (`platform/src/testing/mock.ts`): no `$app`, `$cli`, `$dev`, `$util`, `$interpolate`, `$jsonParse` or `$jsonStringify`; the app and the stage are the mock's project and stack; SST's bootstrap is read from its parameter, `/sst/bootstrap`, as the components read it under plain Pulumi, with the answer the CLI's call would get; what only SST's binary does, a function's build, goes to the mock as it goes to `sst dev`'s server; a test that sets `$dev` sets `SST_DEV`, as `sst dev` tells a Pulumi program; and the root is Pulumi's, with a `.sst` that has the platform's files, as the `sst` package has them. It's in the API report: an addition.
- **`SST_TEST_PLAIN=1`** runs the platform's tests that way (`test/helpers/graph.ts`), and skips the takeover cases, which are SST 4's.
- **`StepFunctions` used SST's `$jsonStringify` global** for a state machine's definition, which a plain Pulumi program doesn't have. It uses Pulumi's `jsonStringify` now.
- **An image's `context` and a function's `copyFiles` were joined onto the app's root** (`path.join`), which turns an absolute path into one under the root. They're resolved from it now (`path.resolve`), as `$asset` and the Cloudflare `Worker`'s assets are: a relative path is the same. This is a bug on `v5` too, under SST's CLI, for an absolute path, so it's fixed there (`57d26dd4f`, with a test of a `Task` whose context is outside the app's folder) and merged here.

**Checked:** `SST_TEST_PLAIN=1` over `test/components/v5` (78 files): 1267 passed, 2355 skipped (the takeover cases), 161 failed, each read. Of those, all but five are tests written for SST's CLI: SST 4's components in a takeover, a move, `sst refresh`, or a test that reads or sets `$cli`, `$util` or `$app` itself. Of the five, four pass on their own (a `Cluster` test and three of Cloudflare's, after an SST 4 test in the same file failed halfway), and one is a `MicroVm` test that reads `$dev` as the docs' example does. The normal suite: `tsc`, 112 files, 4248 tests; the API reports.

**Found, not fixed:** the components' docs write their examples with SST's globals (`$dev`, `$app.stage`), which a plain Pulumi program doesn't have.

## 2026-11-12: step 5, the eject

`sst eject`, in a Pulumi program that uses SST's components, writes them as Pulumi's own resources from the stack's state, and takes SST's own resources out of the state. In the lab, a program with a linked `Function` with a URL, a `Bucket` and a `StaticSite`, ejected, with SST's package, binary and plugin then gone, previewed and deployed with nothing changed, answered as before, was switched to its own build of the function, and destroyed clean. Committed as `5f0a66a9d`.

**What changed:**

- **`pkg/eject`**, and the command in `cmd/sst/eject.go`. It reads the stack's export twice: as it is, for the copy it saves and the state it imports, and with its secrets shown, for the module. The secrets aren't written anywhere but the stack's config.
- **The module, `sst-ejected.ts`**, [as designed](plan.md#5-the-eject):
  - each of SST's components is a `pulumi.ComponentResource` of the same type and name, and nested ones keep their parent;
  - each part is Pulumi's own class for its type, with the state's inputs, but for what the provider filled in itself: what it lists under `__defaults`, `tagsAll`, and a `region` that's its provider's;
  - a value that's an output of a resource the input depends on is a reference (`role: apiRole.arn`, `logGroup: apiLogGroup.name`), also as the start of a value (`` pulumi.interpolate`${filesBucket.arn}/*` ``), and in a string that's JSON, which is written as the value it's made from when `JSON.stringify` gives the same string back (`pulumi.jsonStringify({...}, undefined, 2)`);
  - the options the state keeps go with each part: `parent`, `dependsOn` (what it depends on that no reference already says), `deletedWith`, `protect`, `retainOnDelete`, `ignoreChanges`, `replaceOnChanges`, `additionalSecretOutputs`, custom timeouts. A provider of the program's own is an argument of `ejected()`;
  - the declarations are grouped by component, each after what it refers to;
  - `ejected()` returns each component's parts by the names SST gave them, a nested component as one of its parent's (`parts.Web.cdn.distribution`);
  - it throws on a stack other than the one it's from.
- **The build is a file of its own, `sst-ejected-build.ts`**, not part of the module as the plan had it, so the program needs esbuild only once a function is switched to it. Each Node.js function in the module has a comment that says how.
- **The state changes with one `pulumi stack import`**, in place of the plan's `pulumi state delete`s, so the change lands whole or not at all. It takes out SST's own resources (`BucketFiles`, `KvKeys`, `DistributionInvalidation`, `DistributionDeploymentWaiter` for now) and SST's provider, a function's code object and source maps, the link records and the links' key, and a default provider nothing else uses, with every reference to them. The records and the key were to leave at the next `pulumi up`; taken out with the rest, the first preview shows nothing at all. The state is read once more before the import, and a change since stops it.
- **What it refuses**, before it writes anything: a stack `sst dev` deployed last, a stack with operations Pulumi didn't finish or a resource waiting to be deleted or replaced, one of SST's own resources not in the list above, a part with a file as an input, a provider an SST component made (`AwsProvider.sst.<region>` included), a component in a component of the program's, and the options it doesn't write yet (`replaceWith`, replacement triggers, hooks, views). If it stops after writing the module, it takes out what it wrote.
- **`--dry-run`** prints the module and what would leave the state, and changes nothing.
- **A component with nothing in it leaves the state too**, like a `DevCommand`, which only tells `sst dev` what to run. Found on the maintainer's sample program after the lab run, which had none; in the tests.
- **No origin access control to adopt yet.** The `StaticSite` has none: its CloudFront function sets the bucket as the origin, with access control settings of its own. SST's `OriginAccessControl` is the `Router`'s; its name has a random ending SST's state doesn't keep, so adopting it needs a read of the cloud. It's refused for now.

**Checked:**

- Go: `pkg/eject`'s tests (a fixture state with a linked function, a bucket, a program's provider and SST's own resources: the module, the secrets, what leaves, the refusals, the state edit, the JSON round trip), and the full suite. The module the lab's state gave typechecked with `tsc --strict`.
- In the lab, project `thineject`, stack `ej`, on Pulumi's local backend, with SST's tags in `aws:defaultTags`:
  - `pulumi up` with SST's components: 34 created.
  - `sst eject --dry-run`, then `sst eject`: 2 secrets put in the config (the function's environment and code key), 12 resources out of the state.
  - The program switched to `ejected()`, `sst` uninstalled, `SST_BIN_PATH` unset: `pulumi preview --diff` showed 23 unchanged and nothing else, not even the components' outputs. `pulumi up`, 23 unchanged. The function and the site answered as before.
  - SST's plugin moved out of Pulumi's plugins for the rest of the run.
  - The function switched to `nodeBuild` and given its bucket in its environment, the handler reading `process.env` in place of `Resource`: 1 updated, and it answered `v2` with the bucket. Another preview and a refresh preview: 23 unchanged.
  - `pulumi destroy`: 23 deleted. The function, role, buckets, distribution, CloudFront function, key-value store and log group checked one by one: gone; the tagging API lists nothing of the app. Left, by design: the function's last code object and its source map in the asset bucket, which were deleted by their keys. The shared stub objects are as they were.

**Not checked:** a program with more of SST's components than these, a provider of the program's in a real run (the fixture has one), and going back with the saved state.

## 2026-11-12: step 4, goals 2 and 3 for what's built

The typed links in `sst dev`, SST's tags by the stack's config, and `VisibleError` without a stack trace under Pulumi. Committed as `d0a4281d7`.

**What changed:**

- **`sst dev` writes `sst-env.d.ts` for a program that imports SST's components**, after each deploy, from the components' link records, with the generator an SST app's deploy uses (`pkg/types`). A program without SST's components gets no file. A plain `pulumi up` writes none: no CLI runs.
- **SST's tags are the stack's config**, [as decided](plan.md#decisions): the two `pulumi config set --path 'aws:defaultTags.tags["sst:app"]' ...` lines are in the plan's step 4. No code.
- **A `VisibleError` is marked as Pulumi's `RunError` when SST's CLI isn't running the program** (`platform/src/components/error.ts`), and Pulumi prints such an error's message alone. Under SST's CLI it's as it was, for the CLI's own parsing. None of the dynamic providers still in the platform reaches `VisibleError`, so the code they keep in the state is unchanged.

**Checked:**

- Platform: a `VisibleError` is a `RunError` without SST's globals, and isn't with them; `tsc`, the full suite (112 files, 4248 tests). Go: `pkg/pulumidev`'s tests.
- In the lab, the step 3 program on a stack `devlab` with `sst:dev: true` and SST's tags in `aws:defaultTags`:
  - `LAB_BAD=1 pulumi preview` (a `DevCommand` with no command) showed `error: The "Bad" DevCommand has no "dev.command". ...` and no stack trace.
  - `sst dev --mode=basic` wrote `sst-env.d.ts` with `Api` and `Files`. The handler typechecked against it once the lab's `tsconfig.json`, which lists its files one by one, listed it too (one with no `files` list includes it); `Resource.Filez` failed with "Did you mean 'Files'?".
  - The function and the bucket had `sst:app: thinlab` and `sst:stage: devlab` in AWS.
  - Destroyed (18), nothing left: no function, role, bucket, log group or source map, and the shared stub objects as they were.

**Not checked:** a move of a stack between SST's CLI and Pulumi with the tags in its config. Step 1 found the tags the only difference between the two, so with them set nothing should be updated, but no stack was moved.

## 2026-11-12: step 3, `sst dev` on SST's components

Under `sst dev`, a Pulumi program's SST components do what they do in an SST app: a `Function` runs on this machine, and a `DevCommand` runs with its links, with no `sst.dev.yaml`. A plain `pulumi up` deploys the real code again. Committed as `b74b7e1df`.

**What changed:**

- **The context reads `sst dev`.** Under plain Pulumi, `context()` is in dev when `SST_DEV` is `true` and `SST_SERVER` is set, both of which `sst dev` gives `pulumi up` (`platform/src/components/context.ts`). Then the command is `deploy`, and the platform's folder is the copy `sst dev` puts in `.sst/platform`, which has the stubs the package leaves out.
- **The stub's region.** `sst dev` gives `pulumi up` `SST_AWS_REGION`, its own AWS provider's region, which SST's `Function` and `Task` give their stubs, as an SST app's CLI does (`pkg/pulumidev/deploy.go`).
- **The link records under plain Pulumi.** `link.ts` sets up the link records (`sst:sst:LinkRef`) and the check of the top-level components' names as it loads, when SST's CLI isn't running the program and a Pulumi stack is, as SST's entry (`platform/src/auto/run.ts`) does under the CLI. A plain `pulumi up` writes them too, so a stack has the same records either way; the stacks of steps 1 and 2 would gain them on their next deploy, records only.
- **`sst dev` reads the components' records** from the stack's export: functions, dev commands, hints, tasks, tunnels and links, through `project.AddRecords`, which an SST app's state is now read with too (`pkg/project/completed.go`). A record that holds a secret is read from `pulumi stack export --show-secrets`, and only that record is kept; other secrets in the state stay hidden. A dev command named both in `sst.dev.yaml` and by a `DevCommand` is an error. The functions SST's components run here are listed under "On this machine" with the file's.
- **`sst.dev.yaml` is optional for a program that imports SST's components.** The scan of the program's imports that `sst dev` watches (`scanProgram`) also says whether it imports `sst/components` or one of its groups. A program without them still needs the file, and is still offered one.
- **`sst/pulumi`'s transform tells `sst dev` when a function is made inside one of SST's components** (`PulumiDev.Function`'s `component`, from the nearest ancestor whose type starts `sst:`). Then the component decides: a pattern doesn't take it, and a name the file gives it exactly is an error naming the component.

**Checked:**

- Go: `TestCompletedReadsComponentRecords` (a `Function`'s, a `DevCommand`'s and two links' records, a secret in a record and in a link read from the export in the clear, once, a resource's own secret not read, the dev command's environment with the links, a name in both), `TestCompletedReadsRecordsWithoutSecrets` (no clear read without a secret in a record), `TestCompletedRecordsShownFails`, `TestDevFileWithComponents`, `TestScanFindsComponents` (a group, the core, through a file of the program's, `sst/pulumi` alone, Pulumi's own) and `TestFunctionInComponent` (a pattern and an exact name). `TestUsesNoneOfSSTsState` allows `AddRecords` and `LinkRefType`. The full suite passed.
- `sst/pulumi`: a function in SST's component, directly and in a component of its, tells `sst dev`, and one in the program's own component doesn't (32 tests).
- Platform: the context in dev, and neither variable alone; `tsc`, the full suite (112 files, 4247 tests), the API reports unchanged.
- In the lab, a program with a `Bucket`, a `Function` linked to it and a `DevCommand` linked to it, no `sst.dev.yaml`, on a stack `devlab` with `sst:dev: true`, and the branch's CLI, package and plugin:
  - `sst dev --mode=basic` deployed it, listing `Api (functions/api.handler)` under "On this machine". The URL answered from this machine (`platform: darwin`) with `Resource.Files.name`. A change to the handler answered at once, rebuilt, with no deploy.
  - The state had the link records (`FilesLinkRef`, `ApiLinkRef`), which the UI doesn't list. `SST_CHILD=Worker sst dev` ran the dev command with `SST_RESOURCE_Files` and `SST_RESOURCE_App`.
  - A plain `pulumi up` then deployed the real code (`platform: linux`), with `Resource.Files.name` in Lambda, and took the stub's shared code object out of the state, which keeps it in the bucket: the same object as SST 5's own stub code, which other stages use.
  - `pulumi destroy` deleted all 19. Nothing left: no function, role, bucket or log group, and the source map SST keeps on delete was deleted. The stack was removed from the scratch backend.

**Not checked:** a `Task` and a `Vpc` bastion's tunnel in `sst dev` on a Pulumi program, Cloudflare's `Worker`, and `sst.dev.yaml` beside SST's components in the lab (in the tests only).

## 2026-11-12: the components' lookups follow their provider, on `v5`

The lookups found below were fixed on `v5`, as framework fixes are, the maintainer's choice ("Fix on v5 now"): `754dbde82`, then `v5` merged into `v5-pulumi-dev` (`bbe23c72f`) and this branch (`0aa256062`). Pushed with a mock-level test (`60992bfca`), whose CI run failed in the docs build: `iamEdit`'s new options are of a Pulumi type the docs generator didn't render. Fixed on `v5` (`516933d6c`, pushed, CI passed) and merged into both branches. Each of the components' lookups has its component as `parent`, `iamEdit` takes options, and `test/components/lookups.test.ts` fails on a lookup given none. The merge's one conflict, `Function`'s region and bootstrap, keeps both: `{ parent: this }` and `bootstrap.forRegion(region, self)`.

**Checked on the merged branch:** `tsc`, the platform suite (4236 tests), the API reports and the Go suite. In the lab, the case that failed before: a `Function` given `providers: { aws: Lab }`, with `addEnvironment`, in a stack with no AWS config and no AWS credentials, profile or region in the environment. It deployed; the state has no default AWS provider at all, only `Lab` and the SST provider `sst-Lab` with its profile and region; the function answered with the variable SST's resource added. Destroyed, and nothing left (the source map SST keeps was deleted).

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
