# v5 progress log

What landed, in which commit, and what was learned on the way. The plan is in [v5-components.md](v5-components.md); the details of each port are in [v5-port-notes.md](v5-port-notes.md).

Components are named as they are now. Until 2026-10-01 they had a `V5` suffix (`QueueV5` in `aws/queue-v5.ts`, type `sst:aws:QueueV5`), which is why older commit subjects read that way.

## 2026-09-30

### The foundation

| Commit | What |
| --- | --- |
| `8160600c1` | `bun run build:cli` on `v5` writes `dist/sst5`, labelled `sst-community-v5`, next to the stable `dist/sst` built from `main`. |
| `ac09ec21e` | Components are built from declared parts: `component()`, `this.part()`, the markers, `existing`, `nodes`, the takeover registry, deep-merging transforms, naming rules as data. |
| `3796db97e` | `Queue`, `Redis`, `SnsTopic`, `ApiGatewayV2`, `Bucket`, `CognitoUserPool` (with its client) and `AppSync`. |
| `90bf9c04d` | `Function`, the test of whether the framework holds for the hardest component. It did. |
| `7ab67749f` | The docs generator renders v5 pages: `transform`, `existing` and `nodes` from the `parts` declaration, each with the part's doc comment. |
| `29cf0d2ed` | Fork-owned files import without `.js`. |
| `321891279` | Functions inside v5 components are v5 functions, created with `functionPart()`. |
| `2bb7d3b24` | `Dynamo`. |
| `ab664bf0a` | The object form of a part's `transform` is typed the way it merges (`PartialArgs<T>`). |

Where the files are, in `platform/src/components/`:

- `component.ts`: the base class every component extends (naming, `$transform`). Close to `main`.
- `parts-component.ts`: `component()` and the `PartsComponent` class it returns, which holds all the parts logic.
- `parts.ts`: the parts types and markers.
- `transform.ts`: `transform()` (4.x, shallow) and `transformPart()` / `mergeArgs()` (deep).
- `naming-rules.ts` and `naming.ts`: the built-in naming tables as data, and what applies them.
- `args.ts`: `withDefault`, `ifSet`, `plain`, `plainDeep`, `notAnOption`, `Plain<T>`, `withoutDependencies`.
- `takeover.ts` and `aws/takeover/`: the registry, and each component's map.

### The test harness

| Commit | What |
| --- | --- |
| `98715bd69` | URNs are built from the whole chain of parents. Pulumi's mock used only the immediate parent's type, so three levels deep a nested takeover looked like it deleted the function. |
| `13163848e` | `Dynamo` is checked inside another component and with a `provider`. An unknown field type is created as binary again, as 4.x does. |
| `8729f83b6` | The takeover check compares the options that change what a deploy does: `ignoreChanges`, `protect`, `retainOnDelete`, `deleteBeforeReplace`, `replaceOnChanges`, `additionalSecretOutputs` and the provider. Before this a port that dropped `ignoreChanges: ["engineVersion"]` would have passed. |
| `33335e5b1` | `Postgres`. |

Checked in the engine's source (`step_generator.go`): a resource's duplicate aliases are deduped, an alias equal to its own URN is skipped, and an alias that matches nothing is ignored.

`v5` was pushed for the first time at `ab664bf0a`.

## 2026-10-01

### Databases, schedules and tasks

| Commit | What |
| --- | --- |
| `3dd98284b` | `aws/helpers/rds.ts`: what any RDS database needs (storage limit, replicas, proxy credentials, role and args, the stored password). |
| `d05848b71` | `Mysql`. |
| `fb6c459b5` | `Aurora`. The framework gained `lookupPart()`, to look a part up by an id the component works out. |
| `d6ba8cc68` | The harness leaves a resource's own name alone in its own inputs. It had been rewriting a renamed resource's new name to the old one everywhere, which hid a `Name` tag made from the new logical name. |
| `3d4b553b2` | `Dsql`. |
| `bcd32ab62` | Every "Switch from" section says that an object `transform` is merged deeply now. |
| `64e2aa711` | `CronV2`. `functionPart()` takes a `Workflow`. |
| `0d39b487f` | `Task`, with `aws/helpers/fargate.ts`, the v5 form of `aws/fargate.ts`. |

A review of `Aurora`, `Mysql`, `Postgres` and `Dsql` against the originals, constructor by constructor, found that what they deploy matches and found two gaps in the docs of every port:

- **An object `transform` is merged deeply in v5 and was shallow in 4.x.** `transform: { instance: { tags } }` on a database had replaced SST's lookup tags; v5 puts them back, as an in-place tag update.
- **A `$transform` for a component is matched by type.** (Since the same-type change later that day, it applies to both.)

### Six things to make components easier to create

| Commit | What |
| --- | --- |
| `ecd2ebc0f` | `pulumi.takeoverCases({ original, v5, cases })`: each case runs three ways and has to pass its options on. The check also compares what a component registers as outputs. |
| `19d022f9c` | The docs generator and the sidebar find the v5 components by file. |
| `ca44f8f30` | The generator writes the two standard notes into every "Switch from" section, and fails when a v5 page names the original outside it. |
| `9e5ac2c9f` | `named(part, "Name")`: a part whose resource keeps another logical name than its key. |
| `b0fba2c76` | The docs page "Write a Component". What it shows working is tested. |
| `5d5b22b79` | The mock is published as `platform/src/testing`: `mock()` gives an app's test the globals a config has. Verified in a real app with vitest and with `bun test`. |

What the three-way suite turned up, all fixed or documented:

- `Function` didn't register the `_live` output that 4.x writes in `sst dev`.
- Notifications of a bucket from `Bucket.get(..., { parent })` would have been deleted and recreated.
- Things 4.x created without the component's `provider` are replaced on switch when the component has one. A port can't avoid it. See Open questions in the plan.

### Names and types

| Commit | What |
| --- | --- |
| `cf55dc265` | The `V5` suffix is dropped and the components move to `aws/v5/`, exported as `sst.aws.v5`. Where a file uses both, the 4.x one is imported as `Original<Name>`. |
| `7e02f4aec` | A v5 component has the type of the one it replaces. The takeover registry is keyed by class. `cmd/sst` is identical to `main` again. |

Going back from v5 to 4.x keeps the main resource. Tried under the mock, not pinned by a test: `Dynamo` and `Bucket` change nothing, `Queue` recreates its subscriber's resources, `Function` recreates its two URL permissions.

Because `$transform` is matched by type, a v5-only option set by a transform is silently ignored by a 4.x component. So the v5 `Function` takes the 4.x forms of four options itself (`live`, `role`, `logging.logGroup`, `url.route`); the v5 form wins when both are given.

`v5` was pushed at `7e02f4aec`.

### Containers

| Commit | What |
| --- | --- |
| `2b9e3f550` | `Service`. `plainDeep()` is new in `args.ts`. |
| `748e8c45a` | `Cluster`. No takeover map: nothing moved. |
| `6d50d9f03` | `Efs`. |
| `42d56d528` | `Alb`, with `aws/helpers/load-balancer-args.ts`, shared with the `Service`'s own load balancer. |
| `7261c8813` | `networkOf(cluster)` in `helpers/fargate.ts`: one place that reads a cluster's VPC, for `Task` and `Service`. |

A review pass over the four found no deployed difference.

### Shared types, examples, teardown order

| Commit | What |
| --- | --- |
| `3862786d7` | The docs generator reads `aws/helpers/*.ts`, so args several components take are declared once: `FargateArgs` and `ContainerArgs`, `ProxyArgs`. `aws/helpers/vpc.ts` has `AnyVpc`, `isVpc()` and `TakesVpc<>`. Inherited examples are rewritten to v5 names on v5 pages, which let `Queue` drop its re-declared `dlq`. |
| `05ebaa330` | The root `README.md` is rewritten for v5. |
| `64e9108ef` | The takeover check reports `unordered`: each dependency the original has must still be reachable. `needlessOrder` names the ones nothing needs; `pulumi.dependsOn()` is for behaviour tests. |

Teardown order came from upstream issues where `sst remove` fails because AWS won't delete what's still in use:

- anomalyco/sst#6934 (open): the certificate of an `Alb` or `Service`, because the load balancer that holds it has no dependency on it. v5 `Alb` and `Service` now make the load balancer depend on the certificate.
- Older and fixed upstream: #5678 / #5780 / #5931 (Cloud Map service and namespace), #5586 (authorizer and route), #4026 (Postgres subnet group). All hold in v5.

The check caught one regression: the v5 `Service` created its Cloud Map service inside `.apply()` with the plain namespace id, for a VPC given by its ids, so it no longer waited for the namespace. No takeover case had the namespace in the app. Fixed, with a case that has it.

`v5` was pushed at `64e9108ef`. `main` has since been merged in; `origin/v5` is at `a075e1bdb`.

### The first real AWS deploy

See [the report](v5-aws-test-2026-10-01.md). It found three bugs that every test under the mock had passed, and one that isn't v5's.

| Commit | What |
| --- | --- |
| `1d41fe1b8` | `sideEffects` in `platform/package.json` lists `aws/takeover/*.ts`. The bundler was dropping every takeover map from a real build. A test bundles the components the way the CLI does and checks every map is in the output. |
| `fdb71c156` | A function's links are read with `all()`, so each goes into the code under its own name. The mock records what each function is built from, and the takeover check compares it. |
| `4b4ec945f` | A function's build result is passed through the new `withoutDependencies()`, so its code doesn't depend on what's linked, and a function part that links its own component is created. |
| `78c944bb2` | The root `README.md` gains "Your own components, from any provider". Its example is pinned by a test (`component.test.ts`, "the component in the README"). |
| `27e9bfdde` | This folder. |

## 2026-10-09

### `main` merged in, through v4.18.1

`498d42299` brings in v4.17.3 to v4.18.1 and SST v4.17.2, with Pulumi 3.267 and the provider updates. The typecheck passed as merged. Three of `main`'s fixes to 4.x components that have ports failed the takeover check, since the 4.x side now does something the port didn't:

| Commit | What |
| --- | --- |
| `1e5e5e7c1` | `Function`'s URL permissions wait for the URL, as on `main` (6d25598a5). The live description is guarded against `undefined` (9731fd9da). |
| `0bdaf2bd0` | `ApiGatewayV2` with `cors: false` leaves the CORS config out instead of setting `{}` (532d42af1). |
| `b94918c36` | `Alb` and `Service` on `main` now remove the load balancer before its certificate (c15977224), as the ports already did. The "Switch from" notes and the Alb test that said 4.x didn't are gone. |

Checked by hand, since the takeover check can't see them: no docs link in the ports points at sst.dev, and `main`'s WebSocket authorizer and API Gateway account fixes are in code the ports don't use.

## 2026-10-07 to 2026-10-12

### Sharing components as packages

Built on the branches `v5-sharing` and `v5-sharing-host`, and on `v5` since 2026-10-12, which was moved forward to them. The design is in [v5-sharing.md](v5-sharing.md), and the plan it was finished with in [v5-sharing-host.md](v5-sharing-host.md).

First, on `v5-sharing` (2026-10-07):

| Commit | What |
| --- | --- |
| `b477cd845` | `component()` returns a named type, `ComponentClass`, so a package can be compiled to a `.d.ts`. |
| `605f2e3fd` | A package imports `sst/components`, and providers by their own names. Both resolve to the app's copies in `.sst/platform`. |
| `4c85fa12c` | The platform ships compiled types, and `sst install` writes `.sst/tsconfig.json`. |
| `40d01f595` | A deploy checks each package's peer dependencies on `sst` and the providers. |
| `695fff2d7` | "X is not defined" says how to add the provider. |
| `2716839f0` | An app's vitest config gets the platform and providers through `alias`. |
| `2a9b0c36b` | `sst upgrade` and `sst init` stay in the CLI's own major version. |
| `9270952d5` | "Share it" in the component guide. |

Installing the providers in the app's `package.json` was then tried on `v5-sharing-deps` ([the proposal](v5-providers-in-package-json.md)), and not taken. That branch has since been deleted. Then, on `v5-sharing-host` (2026-10-12), with SST as the host:

| Commit | What |
| --- | --- |
| `2ecd2483c` | The plan. |
| `6eca18d4e` | A 4.x component file can change where it changes nothing for an app. |
| `e37a04b30` | The globals' imports go at the end of an app file, so an error's line is right. |
| `24de2a1ee` | SST's declarations name no globals, so a package's repo compiles against them. |
| `5471a11ad` | `sst/components` is the core, and `sst/components/aws`, `/cloudflare` and `/vercel` are the groups. `mock()` gives a test the groups whose providers are installed. |
| `d3522d217` | The `sst` package carries SST's components, compiled, with their types, for a package's repo. |
| `6bd64acd0` | A package's repo builds and tests with ordinary tools, and no `sst.config.ts`. |
| `054e776df` | SST installs `.sst/platform` with bun 1.4.2. 1.2.1 hung on a package whose peer dependencies conflict. |
| `58ea65783` | An app without a `package.json` lists packages in its config, under `packages`. |
| `fd29a89f4` | A provider version in another major version than SST's is refused, and `sst add` picks one in it. |
| `f099af401` | The CLI no longer crashes after a deploy with a component type of two parts. Found by the AWS run. |
| `cbe97c02b` | The run: three apps locally with CLIs from before and after, and a package with a function deployed to AWS and run in `sst dev`. |
| `38447dc77` | A component's type has three parts. `component()` refuses two. |
| `70b321483` | The guide says how a package ships a function's code. |

The AWS run found what the mock can't: the CLI read every resource type in the state as having three parts. The deploy had finished, but the update wasn't marked finished and `outputs.json` wasn't written.

## 2026-10-12

### `main` merged in, through v4.20.0 and after

`435998070` brings in v4.19.0, v4.20.0 and `main` up to `d542ad14b`: MicroVm, ElastiCache Serverless, Bucket EventBridge notifications, and fixes to `Function`, `Bucket` and `sst dev`. `component.ts` conflicted, since v5 keeps the naming rules as data, so `main`'s five new rules went into `naming-rules.ts`. The typecheck passed with one change in the merge: the v5 `Bucket` reads its notification type from 4.x's args, whose `notifications` are optional now.

Three of `main`'s changes to 4.x failed the takeover check, or broke a port where the check can't see:

| Commit | What |
| --- | --- |
| `59715bb72` | `Function`'s role trusts the account root only in `sst dev` (#95). 4.x's check never passed before, so every role trusted it, and the port had reproduced that (decided 2026-09-30, changed now). |
| `2a3aac62b` | A function on a shared `bundle` reads its linked resources from `.sst/<name>/resource.enc`, and its zip keeps only its own folder (#89). The CLI writes the file there now, so a v5 function with a `bundle` would have failed at cold start. The check can't see it: a takeover case with a `bundle` and a test that reads the zip do. |
| `4dd90c8d4` | A `cloudfront` bucket can only be read by distributions in the same account. |

And two features `main` added to components that have ports:

| Commit | What |
| --- | --- |
| `133bde1af` | `Redis` takes `serverless` (#91): a serverless cache, its `default` user and user group, as parts. The cluster's parts are optional now. |
| `c87fb9d75` | `Bucket`'s `notify` takes `eventBridge` (#85). The static `subscribeEventBridge` waits for a v5 `Bus`. |

`MicroVm` is new in 4.x and has no port yet.

### `Bus`, and the bucket's EventBridge subscribers

| Commit | What |
| --- | --- |
| `eff8bf2b0` | `Bus`, with each subscriber's function, permission, rule, target and queue policy as parts of the bus. The static `subscribe` and `subscribeQueue` become `get` and the ordinary methods. |
| `e986c1b0d` | `Bucket.subscribeEventBridge`, which 4.x has as a static since v4.20.0, is a method of the v5 bucket, on the bucket or on `get`. 4.x named each subscription after the bucket's physical name, and the map works it out from `bucket.name`. As a static it would have needed a bus component per bucket, shared by every call. |
| `9e3f1c749` | The root README's example component has a type with three parts, which `component()` asks for since `38447dc77`. Its test had been changed, and the README hadn't. |

### In AWS (2026-10-13)

The lab app, on a stage of its own, in the order the first run used: deployed with 4.x, switched, diffed, deployed with v5, the states compared, what's deployed called, `sst dev`, removed. It had two functions on one bundle, each linked to its own resource, a `cloudfront` bucket, a bucket that publishes to EventBridge with a subscriber, a `Bus` with a function and a queue subscribed, and a serverless `Redis` in a VPC.

- **The switch changed nothing in AWS that matters.** 62 of 65 resources kept their ids. Two subscribers' code was uploaded again under the function's new part name, as a renamed function part's is, and the default bus 4.x looked up left the state. What went from the diff was the 4.x wrappers, which have nothing in AWS behind them.
- **Each function on the shared bundle read its own linked resource**, from `.sst/<name>/resource.enc`, and not the other's: with 4.x, with v5, and in `sst dev`.
- **The `cloudfront` bucket's policy has the `aws:SourceArn` condition** for the account's distributions.
- **An object put in the bucket reached the subscriber** as `Object Created`, with the bucket and the key. An event put on the bus reached the function and the queue.
- **The serverless cache answered `AUTH` and `PING`** over TLS with the password SST made, from a function in the VPC.
- **A deployed role trusts only Lambda. In `sst dev`, the account root too.**
- The stage was removed, and its passphrase, sourcemaps and state files deleted after. The lab's audit lists what it did before, and the tagging API a subnet and a security group that are gone.

### An app's dev stage, to `sst5 dev` and back (2026-10-13)

An app in daily use, on its owner's own stage, run every day in `sst dev` with a 4.x CLI (v4.15.2 with local patches). It uses 4.x components only: 47 functions, an HTTP API with two routes per domain, a REST API in front of SQS, a durable `Workflow`, a Lambda layer, Aurora and Cognito. It was diffed with `sst5 diff --dev`, run in `sst5 dev`, then run again with the 4.x CLI.

- **Both deploys were clean**, in under a minute each, and more than 530 resources weren't touched either way.
  - Going to `sst5` changed what switching CLIs should: every function's code moved to the `sst5` bridge zip, the workflow published a new version, and the providers moved up (aws 7.20.0 to 7.48.0, random, tls).
  - Going back moved them down again. The downgrade, on state the newer provider had written, went through.
- **About 300 calls ran through 20 functions under `sst5 dev`**, with no error from the CLI or the bridge.
- **`sst diff` showed four route functions deleted, and the deploy updated them.**
  - `functionBuilder` creates a route's function inside an `apply` on its args. When the args hold a value that's unknown until the deploy, Pulumi's preview skips the `apply`. The function is never registered, so it shows as a delete, and its permission as replaced.
  - Here the unknowns were the ARN of a layer being replaced and a workflow's new version.
  - This is 4.x's own behaviour, from upstream. v5's `functionPart` builds its function the same way (see the open question in `v5-components.md`).
- **The layer was replaced, because of `sst-env.d.ts`.**
  - Since `b8b333987` (on `main` too), the generated file ends with a newline. SST writes one in every folder with a `package.json`, and the layer zipped such a folder, so its hash changed.
  - The file is written after the deploy, so the change lands one run late. The second run on the other CLI replaces the layer, in either direction.
  - An app moving from upstream to the fork, with a layer or any archive of such a folder, gets one replacement.
- **The 4.x CLI logged `function not found` while it deployed**, for functions called meanwhile: a schedule, a Cognito trigger, the API.
  - Its dev server learns the functions when the deploy finishes, and the lines stopped then.
  - The start-up message from the `sst5` bridge was read, so the two agree on that much.
- Not called under `sst5 dev`: the four routes the diff showed as deleted, and the workflow.

## 2026-10-13

### `sst dev` responses, and the first pre-release

| Commit | What |
| --- | --- |
| `7b026c61c`, `0252dbb7c`, `755cbaa8f` | `sst dev` sends a function's response, error or init error again, five times, three seconds apart, and the bridge drops the copies. Right after a cold start, AppSync accepted some responses and never delivered them. The same change is #102 on `main`. |
| `22f742ccf` | A tag such as `v5.0.0-alpha.1` publishes to npm under `next-experimental` and is a pre-release on GitHub. A 5.x tag without a suffix stops. |
| The commit after it | The notes for `v5.0.0-alpha.1`, and the README says how to install a pre-release. |

## 2026-10-14

### Tightening, and ideas from SST's own list

SST keeps a list of what to change in its next major version, [anomalyco/sst#6588](https://github.com/anomalyco/sst/issues/6588). v5 already does its component-level items in part: plain args, and `CronV2` without `job`. What was taken from it now is in the plan's decisions.

| Commit | What |
| --- | --- |
| `9500d95cb` | `check.yml` runs for `v5`, and runs the platform's tests, which no workflow ran before. Three test files that had never loaded (`alb`, `bucket`, `service-alb`) are brought up to the code. |
| `8ecf02a2f` | A pre-release meets a `version` rule its release meets, so `5.0.0-alpha.2` passes `">= 4"`. `5.0.0-alpha.1` only passed a rule that names a pre-release. |
| `2a5b579ec` | `functionPart()` decides from what was passed, not the values in it, so a function whose args aren't known yet is still in the preview, and `sst diff` no longer shows it as deleted. |
| `a953b539c` | `Mysql` defaults to `"8.0"`, for 4.x and v5. RDS had stopped offering `8.0.40`. |
| The commit after it | This entry, the decisions, and the two breaking changes the `v5.0.0-alpha.1` notes left out. |

Checked in AWS: a v5 `Mysql` without `version` was created with `8.0.46`, and `sst diff` after it showed no changes. The app was removed, and its passphrase and state files deleted.

### `main` merged in, through v4.21.1 and after

The merge brings in v4.21.0, v4.21.1 and `main` up to `6e1c757d6`. Nothing conflicted. #102 was already on v5 as its own commits, and its files came out the same. The typecheck, the platform's tests and the Go tests passed as merged.

| Commit | What |
| --- | --- |
| `1c4073531` | The root tunnel process stops when `sst` dies (#101). |
| `884e27f67` | `Run` takes long output lines, and doesn't hang on one over the limit (#110). |
| `172e16982` | Go Lambdas build without VCS metadata, so a new commit doesn't change them (#109). |
| `a7b7b8ba3`, `cb562da55` | Docs: how a `Router` URL route's timeouts behave (#112), PlanetScale role successors (#111). |
| `6e1c757d6` | A 4.x `Function` given a `role` no longer reads it on every run, only when `nodes.role` is used (#116). |

The merge left the v5 `Function` without #116: it still looked the role up on every run, for 4.x's `role` and for `existing: { role }`. The takeover check couldn't see that, as the lookup is something the V5 component adds, not something the original left. The commit after the merge brings it over: a role passed by its ARN, as 4.x's `role` or in `existing`, is used as it is and only looked up when `nodes.role` is read. One passed by its name, or as an output, is still looked up, by its name even when the output is an ARN (passing an ARN in `existing` had failed the lookup).

### Faster rebuilds in `sst dev`

The same change is #118 on `main`, merged on 2026-10-18.

| Commit | What |
| --- | --- |
| `790a5de75` | Changed files are collected for 100ms, and the functions they affect are built once, at the same time, not one after the other. A redeploy in dev builds its functions the same way. |
| `89789d435` | The esbuild context kept for a function in dev is replaced when its build options change. A change to its `nodejs` config had applied only once the context was evicted or `sst dev` restarted. |
| `171361271` | `nodejs.esbuild` shows how to leave the AWS SDK out of builds in `sst dev`. |

On a benchmark of 16 functions that import a shared module and the AWS SDK, a change to that module took 866ms of builds and takes 329ms; 5 files changed at once took 5 rounds and take one. A file only one function imports gains nothing, and waits the 100ms. Leaving the SDK out in dev takes a function's build from 53ms to 10ms. Checked in `sst dev` on a test app in AWS, since removed.

### A notice when a newer SST is out

Nothing told a user that a newer SST was out. Now, once a day, in the background, the CLI looks for the newest release in its major version, the one `sst upgrade` installs (`pkg/global/update.go`). The UI says so under the header, as an `Info` line like its others: ``SST 5.0.0-alpha.2 is available. Run `sst upgrade` to update.`` A run never waits for the look, so the notice can come from the run after it. In `sst dev` it shows once. Nothing is looked for in CI, or with `SST_SKIP_UPDATE_CHECK=1`, and a dev build never looks. The `upgrade` command's docs say so.

Tried and dropped (2026-10-15): the same notice for the component packages an app uses (it looked a private scoped package up on the public registry, as the CLI doesn't read scoped registries from `.npmrc`), warnings for what's deprecated in the 4.x components, and a note naming the 4.x components an app uses that have a V5 version. Each printed another way, and at another frequency, from the others.

Checked with `sst5 diff` and `sst5 dev` on a test app in AWS, with a build labelled `5.0.0-alpha.0`: the look found `5.0.0-alpha.1` on GitHub, the UI said so, once in dev, and nothing showed with `CI` set. The line as it's worded now was checked through the UI.

## 2026-10-15

### A guide to moving from v4

`www/src/content/docs/docs/migrate-from-v4.mdx`, in the sidebar under How to, and linked from the README. It gathers what was spread over the README, the release notes and the 20 "Switch from" sections: the four things the 5.x CLI reads differently in a config, installing, switching one component at a time, what every V5 component does differently, what a switch can replace, a line per component, and going back. Like the other V5 pages, it's only in the repo until the V5 docs are published.

Switching a component back to 4.x hasn't been tried. A V5 component keeps some resources under new names through aliases, which the 4.x one doesn't have, so they'd be created again under the old names; the guide says to check `sst diff` first. A command that rewrites a config for v5 was considered and left for 5.0.0, when the names are final and every app has to change.

## 2026-10-16

### The goals, written down

[v5-goals.md](v5-goals.md) has six goals, how each is checked, and where each stands:

1. A switch leaves the state as it was, or close to it.
2. Moving to v5 never loses data.
3. Anyone can write a component, and share it.
4. Installing v5 changes nothing until a component is switched.
5. Every resource is yours to change.
6. `sst diff` shows what the deploy will do.

Going back to 4.x isn't a goal. The README lists the goals, and the rulebook's ground rules, its checklist and the pre-release steps in `MAINTAINING.md` point to them. The rulebook now says a resource that holds data is never in a takeover case's `unclaimed`.

Checked against them as they stand:

- **Goal 6 isn't met.** A 4.x component's function can still show as deleted in `sst diff`.
- **Goal 4 hasn't been checked against the latest 4.x.**
- **Goal 2 holds in the takeover suites.** No resource that holds data is expected to go. The `EventBus` in `bucket.test.ts`'s list is the default bus, which 4.x looked up and didn't create.

### Output in CloudWatch in `sst dev`

In `sst dev`, a function's log group only got the stub's own lines. With `SST_DEV_CLOUDWATCH_LOGS=true`, what functions and tasks print locally is printed in their log groups too. It's off by default. The Live page has a Logs section, and the `sst dev` and `Task` docs point to it.

| Commit | What |
| --- | --- |
| `ddf502f4a` | A durable function's stub runs the bridge with its output passed on. |
| `3fa0eaab4` | Function and task output is read past a line over 64 KB (`process.ReadLines`). |
| `428540fce` | `SST_DEV_CLOUDWATCH_LOGS`, for functions and tasks, and its docs. |

- **Functions:** the CLI sends a function's output to its bridge after each reply, as a new message (`MessageLogs`), and marks the reply as having output to follow. The bridge waits for it, up to 2 seconds and never past the invocation's deadline, prints it, then asks Lambda for the next invocation. So each line is in the invocation it belongs to. An error is printed after it, as `ERROR Invoke Error {...}`. Up to 256 KB is sent per invocation.
- **Durable functions and `Workflow`:** their stub ran the bridge with `execFile`, which kept everything the bridge printed in memory and stopped the bridge past 1 MB. It now runs it with its output passed on. That's a fix on its own: their log groups now get the bridge's lines too, as other functions' do.
- **Tasks:** the CLI sends what a task's `dev.command` prints every second, and before the task completes. The `bridge-task` image prints it in order. That module builds against an older, pinned copy of the CLI's bridge package, so it names the message's number itself; a test keeps that number.
- **Lines over 64 KB:** a function's or a task's output was read with a `bufio.Scanner`, which stops at a line over 64 KB. For a function, the worker was then taken for dead while it still ran. `Run`'s `readLines` (#110) is now `process.ReadLines`, used for all three. A line over 1 MB is left out with a note, and the lines after it come through. A task completes when its command exits, and what's left of its output is read for up to a second after (2026-10-18; reading it to its end first kept a task that left a process in the background from completing).

An older bridge or CLI ignores the new message and the new field on a reply, so a mixed pair works as before.

Checked in AWS, with test apps removed after: functions (output, stderr, JSON, an error, a failure to load, output after the reply, the limit), a durable function before and after the stub fix, a `Workflow` using the SDK, a `Task` in ECS with a test build of the `bridge-task` image, and lines of 100 KB from a function and a task. Callers saw no difference: a median of 0.33s with it on and 0.36s off, over 40 calls each. The stub runs about 110ms longer per invocation (363ms against 251ms).

**Task output needs a new `bridge-task` image.** Every version's `sst dev` runs `ghcr.io/sst-community/sst/bridge-task:latest`, and only a release from `main` pushes it. Until then, an older image ignores the output, so this part takes effect through `main`.

## 2026-10-18

### `main` merged in, with the `sst dev` fixes

The merge brings in v4.21.2, v4.21.3 and ten pull requests to `sst dev` merged into `main` the same day. Two of them, #118 and #120, were already on v5 as their own commits. The other eight are rogueturnip's, from #125 (concurrent Live invocations that failed or hung) and #136 (time spent outside the handler).

| Pull request | What |
| --- | --- |
| #128 | A publish to AppSync that's throttled, gets a 5xx or fails to connect is tried again, for up to 10 seconds. |
| #129 | When `sst dev` doesn't answer, an event or direct invoke fails with `SstDevUnavailable`, and an HTTP request gets a 500 that says so. An event source then retries the event instead of counting it as handled. |
| #130 | An invocation is no longer lost when its worker exits on idle as it arrives, a build no longer keeps other functions' bridges from their ping, the ping goes alongside the invocation, and a reply stops being resent once its bridge moves on. Adds a test harness for the function loop. |
| #131 | The invocation logs are closed, and only the newest 100 of each function are kept. |
| #132 | A warning when the account's Lambda concurrency is under 100. |
| #133 | The `dev` docs say when to turn it off, as for an authorizer. |
| #137 | The Node.js worker calls the runtime API with `http.request`. On Node.js 26.7, `fetch` held each call about 300ms. |
| #138 | A bridge message's buffer grows as it's written, instead of 256 KB for each. |
| #118 | Changed files are rebuilt together, at once. |
| #120 | Output in CloudWatch, with two fixes made for the merge: a reply's resends are kept apart from the output's (#130 kept one per worker, so the output's stopped the reply's), and a task completes when its command exits. |

Five files conflicted. `function.go`, its rebuild test, `task.go` and the bridge take `main`'s, which is v5's with the other pull requests and those two fixes. `pkg/flag` keeps `SST_SKIP_UPDATE_CHECK`. The commit after the merge gives the V5 `Function`'s `dev` docs #133's note.

Checked on #125's repro in AWS (an `ApiGatewayV1` route with a Live request authorizer that takes 200ms and a Live handler that takes 300ms), with a CLI built from `main` before the pull requests and one with all ten, on the same stage:

| | Before | After |
| --- | --- | --- |
| 20 requests, a second apart | p50 1.05s, p90 1.23s | p50 1.05s, p90 1.08s |
| 100 at once, warm | 100/100, p50 11.7s, max 15.1s | 100/100, p50 2.3s, max 2.8s |
| 100 at once after 75s idle | 100/100, p50 21.8s, max 22.5s | 100/100, p50 2.1s, max 2.6s |

Also with all ten: 50 at once with a shared file saved 150ms in, all answered by the new build; with `SST_DEV_CLOUDWATCH_LOGS` on, bursts timed the same and every line was in its invocation; with `sst dev` stopped, a direct invoke failed with `SstDevUnavailable` after 16 seconds; the invocation logs held 100 a function. The app was removed, with its passphrase and state files.

Still open: #139 (a function whose build fails waits for Lambda's timeout, as its init error goes to the wrong URL), #135 (workers that exit on their own aren't reaped, and a rebuild drops a running invocation) and #134 (memory in a long session).

### A component part looked up by id stays under its component

`existing` with an id looks a part up with its class's `get`. That call gave the options fourth, as a resource's `get(name, id, state, opts)` takes them. A component's `get(name, id, opts)` takes them third, so a part that's a component, like a `Dynamo` given by its table's name, lost its parent and its provider. It sat at the top of the app, and since `nodes` records a part when it's created under the component, each `existingPart()` or `part()` looked it up again: two components of the same name, which a real deploy refuses. A component's `get` now gets its options third. No V5 component of SST's has a component as a part that can be looked up, so none was affected. It showed up in a package component that has a `CognitoUserPool` and three `Dynamo` tables as parts. Tested in `component.test.ts`, "looks up a component part by id, under the component, once".

### `Email`

The 21st port, ahead of the ones on the plan's order, because a package component needs it: email is what a SaaS app's sign-up, password resets and invitations go through. See the [port notes](v5-port-notes.md#email).

Deployed in the lab with 4.x, a domain sender with DMARC, a custom MAIL FROM domain and two events, one of them `deliveries`. After the switch `sst diff` showed no changes, and the deploy changed nothing in AWS. 19 resources before and after, each with the id it had; the `deliveries` destination moved to its V5 name through the takeover map. A second diff showed no changes. The stage was removed, with its passphrase and state files.

## 2026-10-19

### A package component builds with `bundler`

*Write a Package Component* now says why its `tsconfig.json` has `moduleResolution: "bundler"`, that an app needs it too, and which of a package's code needs `.js` on its imports. Checked with `tsc` against the `sst` package: in a package's repo under `NodeNext`, `component`, `optional` and `many` from `sst/components` are `any`, and `plain` and `v5.Function` don't exist, with nothing to say why while `skipLibCheck` is on. The 4.x components, like `Bucket`, keep their types. In an app, `sst/components` isn't found through the paths in `.sst/tsconfig.json`. With `bundler`, both are typed. See the decision of 2026-10-19 in [v5-components.md](v5-components.md#decisions).

The guide's "Test it" also says to pin `google-protobuf` to `3.21.2` in the package's repo, as SST's `package.json` files do. `@pulumi/pulumi` asks for `^3.21.4`, and with that every resource `mock()` registers fails with `c.g is not a function`. The first package component, `@sst-community/saas`, ran into it.

### `main` merged in again, with four more `sst dev` fixes

The merge brings in four pull requests merged into `main` the same day, for #139, #154, #135 and part of #134. Nothing conflicted: they change only the CLI's Go, which v5 shares with `main`.

| Pull request | What |
| --- | --- |
| #155 | A function whose worker can't start, as when its build fails, fails its invocation at once with an init error, posted to the right URL, instead of at Lambda's timeout. |
| #156 | A second init for a worker that's running, which a bridge sends when its first invocation was handled before its init, is logged at info, not as an error. |
| #157 | A worker runs in a process group of its own, is waited for as it exits, and is stopped without holding up the loop, with what it started. A save leaves a running invocation to finish and then replaces its worker, and starts again only each function's worker invoked last. The others start when they're invoked, with the environment their bridge sent before, without a round trip to it. |
| #158 | A multiplexer pane keeps its last 10,000 lines, and the bridge client remembers a bounded number of finished messages and drops ones that never finish. |

The Go tests pass on the merge, and the CLI builds. #157 was checked on #125's repro in AWS against `main` before it: a save during a burst of 20 requests answered all 20, where `main` failed them with a 502 at the function's timeout, and it started 2 workers, where `main` started 40.

Still open: the rest of #134 (forgetting an environment a while after its worker exits, the Node.js workers' memory, the UI's maps, `sst.log`).

### `main` merged in again, with #159

#159 forgets a Lambda environment's variables and function 15 to 16.5 minutes after its worker stops, as when it exits after a minute without work, isn't started again after a rebuild, or fails to start. An environment invoked after that asks its bridge for them again. Before, `sst dev` kept every environment it had seen for as long as it ran: 12.8 MB after 1,000 environments with 10 KB of variables each. Nothing conflicted, and the Go tests pass on the merge.

Still open in #134: the Node.js workers' memory, the UI's maps and `sst.log`.

### `main` merged in again, with the components' tests in CI

- #140: CI runs the components' tests with `bun run test:platform`, `@sst/platform`'s own `test` script. The ALB and service tests wait for their outputs before checking them; one had passed with a security group id of `undefined_id`.
- #165: the ALB tests' mocks name a resource read with `.get()` after itself. `v5` doesn't give a read a `name` input, so with #140's mocks a referenced load balancer's URL was `http://undefined…` here.
- #141: the 4.x `Mysql` defaults to `"8.0"`, as the V5 one already did.
- #143: the CLI installs `.sst/platform` with bun 1.4.2, which `v5` already had.
- #160 to #162: the AI review uses `deepseek-v4.1-flash-free` on `opencode-ai` 1.19.3 and refreshes OpenCode's model list first.

Three files conflicted. `check.yml` keeps the lines that run it for `v5` and takes `main`'s test command. `mysql.ts`'s doc and `alb.test.ts` take `main`'s. The platform typechecks, its 1,714 tests in 54 files pass, and so do the Go tests for `pkg/global` and `pkg/project`.

### `main` merged in again, with #142

`v5` has had #142's change, `sst upgrade` and `sst init` staying in the CLI's major version, since 2026-10-07. Its review on `main` added:
- reading every page of the GitHub releases, not only the newest 100;
- treating a snapshot build's `0.0.0-<timestamp>` like a dev build, by its major, since npm has a `0.0.0-placeholder.0`;
- not listing the versions for a build that isn't a release;
- the help text and "Already on" line saying it stays in the major.

`pkg/global/upgrade.go`, `pkg/npm/versions.go` and its test conflicted, since both branches had the change. `v5`'s copies were #142 as first opened, so they take `main`'s. The Go tests for `pkg/npm`, `pkg/global`, `pkg/project` and `cmd/sst` pass.

## What the harness can and can't see

It records what's registered with the engine and compares, between a 4.x component and its v5 port: each resource's address (through aliases, as Pulumi resolves them), inputs, deploy options, registered outputs, what a function is built from, and what depends on what.

Things worth knowing when a test surprises you:

- A takeover test also passes when both sides fail the same way and create nothing. Assert on what's created.
- Mock ids and ARNs are made from resource names, so the check rewrites new names to old ones before comparing. A renamed function's code key looks unchanged for that reason; in AWS the code is uploaded again under the new name.
- `useProvider()` registers its provider once per process, so only the first test has it in the graph.
- A mocked Lambda function needs `qualifiedArn`, `invokeArn`, `qualifiedInvokeArn` and `responseStreamingInvokeArn` in `state` when the function publishes versions.
- A secret spreads. The built image's reference is a secret, and reading the volumes from the same output made a task definition's `volumes` a secret. Keep what's read next to a secret in its own output.
- A getter typed `Output<UnwrappedArray<string>>` renders as `string` in the docs. Give it an explicit `Output<string[]>`.
- It never bundles a config, builds a function, or calls AWS. For that, deploy.
