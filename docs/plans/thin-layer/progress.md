# SST as a layer on plain Pulumi: progress

The log, newest first. The plan is [plan.md](plan.md).

## 2026-11-13: the restructure the review proposed

[As decided](plan.md#decisions), after the fixes: what the review of the layers found, moved and tied together, with no change to what's deployed, its URNs or its state.

- **What the TypeScript and Go sides agree on is tested.** `pkg/provider/contract_test.go`: the types of SST's own resources the components make (`*/resources/*.ts`) are the ones the provider serves, the config keys `plugin.ts` writes are the ones it reads (a key spelled differently on one side made SST's provider fall back to the environment's credentials without a word), and the plugin is downloaded from the repo SST releases from. `pkg/eject/contract_test.go`: each of those types is one the eject takes out of a state, makes something in the place of, or refuses with a reason (`refusedResources`, which the error now gives).
- **The plain-mode sweep reaches SST's provider.** It ran without an `sst` package, so SST's own resources never got SST's provider, and one registered without it passed every test. Under `SST_TEST_PLAIN=1` a vitest setup file (`test/setup.ts`, `vitest.config.ts`) stands in for the package, and settling (`test/helpers/graph.ts`) fails a test whose own resource has no SST provider. Checked by taking it off `KvKeys`: the router's tests failed with the message. The sweep's failures are the same 189 as without it.
- **One Pulumi CLI package**, `internal/pulumicli`, for `sst dev`'s Pulumi programs (`pkg/pulumidev`) and the eject: finding `pulumi`, running it, its first line of error, and reading `Pulumi.yaml`. The three ways a secret is read from an export stay three, as they differ on purpose: the eject keeps numbers exact and reads one level at a time, `sst dev` reads a whole value and fails on a secret it can't show, and an SST app's state has Pulumi's own type. `pkg/eject/boundary_test.go` holds the eject to SST's `internal/` packages, as `pkg/pulumidev` is held off an SST app's state.
- **The eject by concern.** `module.go` (1188 lines) is three files: `plan.go` (what it's given and works out, and `Build`), `classify.go` (all it knows of SST: its types, the names SST's TypeScript makes, what each becomes) and `generate.go` (the module's code from a state, which knows no SST type). Moved with a tool that moves declarations whole, and checked line for line.
- **Every build is given the platform's folder.** `Builder` has `PathPlatformDir()`, which every program has, in place of an interface found by a type assertion, and the Python build reads its default Dockerfile from the build's platform folder. The package ships `dist/dockerfiles`, and its check of what the components read from the platform's folder reads the Go builds' too. A function run in `sst dev` reads `.sst/platform`, where the CLI copies it for both kinds of program.
- **One JSON-RPC client.** `rpc.call` takes the server, and the build client (`rpc/binary.ts`) uses it in place of a copy.
- **A plain run's setup is a module of its own**, `plain.ts`, which `sst/components` and each group import, in place of a line at the end of `link.ts`.
- **Vercel's token** falls back to `VERCEL_API_TOKEN` in `pkg/provider` (`envVercel`), as Cloudflare's credentials do, not in the resource, and `vercelSettings` is in `vercel.go`.
- **Two tests from the fixes** didn't typecheck (an `afterEach` that returned a value): fixed.

**Left as they are, as the review said:** `plugin.ts`'s three clouds in one file, `move.ts` and `check.ts` reading `$cli` (SST's CLI's alone), the eject's TypeScript written from Go strings, where `ServeBuilds` lives, and `sst/testing`'s mock doing both modes.

**Checked:** each contract test against a change to one side (a config key spelled differently fails the provider's); `tsc`; the Go suite; the platform suite (120 files; 30 of them failed while the machine's load stood at 20 to 28 from other work, and passed when run again, 1669 tests); the plain-mode sweep, as above; the API reports, unchanged. The package's check of the Go builds' platform folders runs when it's next packed.

## 2026-11-13: an independent review, and its fixes

[As decided](plan.md#decisions), three reviewers read the branch's own changes (against `v5-pulumi-dev` with `v5` merged in) with the code and the plan alone: one the eject and the rest of the Go, one the components, one the layers. Each finding was checked against the code before it was fixed; none was wrong. The layers' findings are the restructure, to come.

**The eject** (`pkg/eject`):

- **Part of a secret could be written in the code.** A secret that starts with an output of what it depends on, then `/` or `:`, was written as `` pulumi.interpolate`${role.arn}/...` ``, the rest of the secret as text. In a secret, only an exact match is a reference now; anything else goes in the stack's config.
- **A path in the project was resolved from where the program runs**, which is the folder of the project's `main`, like `src/`, as Pulumi runs it. A Worker's copied build was then looked for in `src/`. It's `path.join(pulumi.getRootDirectory(), ...)` now, as the components' context reads the root.
- **A config key with a second `:`**, from an object's key in a value each stack has its own of, like a policy's `aws:SourceAccount`, which Pulumi refuses: `:` is `_` in the key now.
- **A value ending in a newline lost it**, as `pulumi config set` takes one off what it reads: such a string is set as JSON and read with `requireObject`, as is a string read as an object because another stack's value is of another kind (which was set as text and read as JSON before).
- **Two stacks of one name**, in two organizations, shared their backups' names and their `Pulumi.<name>.yaml`: refused now.
- **A function's environment that's a secret as a whole** lost what `addEnvironment` added, and an addition that's one secret was written in the clear when the function's own variables weren't secret: both stay secret, with everything in them.
- **A plain value was set without `--plaintext`**, so Pulumi refused one that looks like a secret.
- **An object with no `source`**, written from text, crashed the eject.
- **A stack whose import failed wasn't put back**, though a timed-out import can land; it's put back from its backup now, and the error says when a stack couldn't be.
- **A Worker's build is hashed again as it's copied**, so one built since the eject read it isn't copied.
- **A dependency on the program's own provider or component** was written as one the module makes, which would have failed as a circle.

**The components:**

- **A `Service` or `Task` that runs an image it's given needed `Assets`** under plain Pulumi, and stopped one being declared after it: which store a component uses is found when it's first used now (`assetStore`), and a container whose image is a string doesn't ask.
- **The providers SST makes for a region (`useProvider`) didn't take the stack's roles**, so SST's provider for one, like the certificate's in `us-east-1`, ran with the credentials the roles are taken with: such a provider's SST provider has the stack's setup in its region now (`madeFromStack`).
- **The dev stub's code in a store from `Assets.use()`**, which other stacks can share, was deleted with a stack: it's kept, as in SST's bootstrap. A store knows whether the stack makes it (`owned`).
- **What a run shares was kept for the next run in the same process**, as the Automation API runs an inline program: `perRun` starts again for a new stack of Pulumi's, and the stores are kept by run. An inline program still doesn't get the link records or the check of names, which are set up as the components load, outside any stack.
- **A project or stack name SST's CLI wouldn't take**, like `feature_x`, went into the names of what's made, which AWS refuses for a bucket: the names are held to SST's rule under plain Pulumi, with an error that says so.
- **A Vercel team given by its slug** was sent as its ID: a slug is sent as `slug` now.
- **Two stores in one region** gave every dev function the first one's stub code: an error now. **A Worker's migration tag** was looked for in the first 1000 scripts: in all of them now.

**Checked:** each new test fails on the code before (the eject's against it with `go test -overlay`, the components' with the files before put back for the run): `edge_test.go` (8 cases), `run_test.go` (`Run` with a `pulumi` that answers for two stacks and fails an import: `--plaintext` and `--secret`, the stack put back), the Vercel team, `perRun`, the names, `Assets` (a service with a given image, a store from `Assets.use()` shared), the region providers' roles, the scripts' lookup. `tsc`; the platform suite (120 files, 4302 tests); the Go suite; the API reports, unchanged. With `SST_TEST_PLAIN=1`, against the commit before: the same 189 failing tests (SST 4's takeovers and the tests written for SST's CLI), 10 more passing, and the four errors of containers with no store gone.

**Not checked:** the error for two stores of the dev stub's code in one region, which only `sst dev` reaches; in the lab, the eject of a project whose `main` is in a folder, and a `Service` with an image it's given and no `Assets`, which the restructure's lab run is to cover.

## 2026-11-13: step 11, `sst.Secret` in a Pulumi program

First, [open question 2](plan.md#open-questions): SST's CLI on Pulumi stacks. Offered all of SST's commands on a Pulumi stack, each running the developer's own `pulumi` on the stack's own backend and keeping nothing of SST's, only the ones Pulumi has nothing like (`shell`, `tunnel`, `secret`), or keeping only `sst dev` and `sst eject`, the maintainer chose keeping them ([decisions](plan.md#decisions)). Then an `sst.Secret` in a Pulumi program, which only found `SST_SECRET_<name>` in the environment, and nothing sets it there.

**What changed:**

- **`Secret`** (`components/secret.ts`): with no core, its value is `new pulumi.Config().getSecret(name)`, the stack's config under the project's name, then its placeholder. The environment isn't read then. Under SST's CLI, nothing changed. `SecretMissingError` says `pulumi config set --secret <name> <value>` with no core, and `sst secret set` under SST's CLI, as before. Its docs say where a Pulumi program's value is.
- **The docs page**: the Secrets section and the table use `Secret`, from `sst/components`, and `pulumi config set --secret`, in place of a `Linkable` over the stack's config. There's no fallback for every stack.

**Found:** a preview that fails on a `Secret` with no value shows two `PromiseRejectionHandledWarning`s from Node before the error. The code before this change shows the same: it's how an error in an output another output reads comes out under plain Pulumi. Left as it is.

**Checked:** `tsc`; the platform suite (117 files, 4292 tests), with `secret.test.ts` (a Pulumi program: the config, the placeholder, the config over it, no read of the environment, the link, the error) and `secret-cli.test.ts` (an SST app: the environment, not the config, the error); the API reports, unchanged; the components' docs generated. A real `pulumi up` (Pulumi 3.270.0, a local backend, no cloud credentials) of a program with the package packed from this branch, `StripeKey` with no placeholder and `PlanName` with one: the preview failed with the message; after `pulumi config set --secret StripeKey ...` (kept as `thinsecret:StripeKey`, encrypted), the deploy gave the value, the link's value and the placeholder as outputs, all secret, with no copy of the value in the state's export; destroyed and removed.

**Not checked:** a `Secret` under `sst dev` on a Pulumi program, which reads the stack's config the same way, as no core runs it; a function reading `Resource.StripeKey.value` in the cloud, whose link is a link like any other.

## 2026-11-13: step 10, Cloudflare under plain Pulumi

SST's Cloudflare components deploy, refresh and destroy under plain Pulumi, with the token in the stack's config alone, and the eject takes Cloudflare's and Vercel's own resources out of the state, [as decided](plan.md#decisions). The eject now refuses only SST's origin access control.

**What changed:**

- **The account** (`cloudflare/helpers/account.ts`): `defaultAccountId(parent)`. Under SST's CLI it's `CLOUDFLARE_DEFAULT_ACCOUNT_ID`, as the CLI sets it. Under plain Pulumi, the variable when it's set, and otherwise the first account `getAccounts` lists through the component's Cloudflare provider, as the CLI picks it, once for each provider in a run; none, or a failed list, is an error that names the variable and `accountId`. Every SST 5 component and SST's own resources use it; `DEFAULT_ACCOUNT_ID`, in the API, is as it was.
- **SST's provider for Cloudflare and Vercel** (`plugin.ts`): `withCloudflarePlugin` and `withVercelPlugin`, as `withAwsPlugin`. Under plain Pulumi, SST's own resources get an SST provider for the component's provider (`sst-cloudflare` and `sst-vercel` for the stack's, `sst-<name>` for one of the program's), whose config has its token, as a secret: an explicit provider's `apiToken` (or `apiKey` and `email`), or the stack's `cloudflare:apiToken` or `vercel:apiToken`. `pkg/provider` reads them in `Configure`, ahead of the environment. Vercel's record takes `vercel:team`, or an explicit provider's `team`, where SST's CLI reads `VERCEL_TEAM_ID`.
- **A Worker's migrations** read the script's migration tag with `getWorkersScripts` through the Worker's provider, under SST's CLI too, in place of a request with the environment's credentials.
- **A Worker's build** (`pkg/runtime/worker`) reads its `unenv` config from the build's platform folder (`BuildInput.Platform()`), which the build server is given by the program (`SST_PLATFORM_DIR`, the package's `platform/`). The package depends on `unenv` and `@cloudflare/unenv-preset`, which the config imports (`sdk/js/scripts/platform.ts`).
- **The eject** (`pkg/eject`): Cloudflare's and Vercel's DNS records leave the state ("SST's never deletes one"). A Worker's URL leaves it, and the module makes Pulumi's `cloudflare.WorkersScriptSubdomain` in its place, listed among what the first `pulumi up` sets to what it is. A Worker's placement leaves it and stays until the script's next upload, which the eject says. Each Worker's last build, in `.sst/`, is copied to `sst-ejected-workers/<script>.js` once its hash matches the state's, and the module (`path.resolve(...)`) and each script's `contentFile` in the state point at the copy, so nothing changes. A path under the project's folder is written from it. The eject refuses when the folder is there already, and takes it out again with the rest when it stops.
- **The docs page** has Cloudflare's setup, the Workers' code, and the placement under what the eject leaves.

**Found in the lab:**

- **A Worker's build needed the platform's `.sst/platform`**, which a Pulumi program doesn't have: fixed above. Python's runtime still reads `.sst/platform`, as noted before.
- **Pulumi's Cloudflare provider can't set a Worker's placement.** An update of a script with `placement` fails: 6.15 sends an upload Cloudflare refuses ("Could not read content for part 'metadata'"), and 6.24.0, the newest, can't serialize the placement's `targets`, which is read-only in both, so it can't be given. Checked on a script of its own too, with nothing of SST's. This is why SST has `WorkerPlacement`.
- **Cloudflare resets a script's placement on every upload without one**, and SST's `WorkerPlacement` was set again only when the etag, the hash of the code, changed. A deploy that changed only the environment left the placement at Cloudflare's default, under SST's CLI too. Fixed on `v5` (`ff384d74e`): it also takes the script's `modifiedOn`. A Worker's `workers.dev` URL isn't reset by an upload.
- **A Worker with migrations updates its script on the deploy after the one that applies them**, which drops them: the recorded takeover shows the same under SST's CLI. Left as it is.
- **The static site's router script is built to a path that has the platform's absolute path inside it** (`.sst/artifacts/<name>-src/<package's platform>/...`). It works, and the eject copies it.

**Checked:** `tsc`; the platform suite (115 files, with the plain-mode setup tests); the Go suite; the API reports (unchanged on this branch; on `v5`, an addition to `WorkerPlacementArgs`). With `SST_TEST_PLAIN=1`, the Cloudflare tests against the commit before: one more failure, the takeover of SST 4's `Hyperdrive`, whose fixture reads the account from the environment where the lookup now runs; a move only happens under SST's CLI. In the lab, the maintainer's Cloudflare account, project `thincf`, under plain Pulumi, the token in the stack's config and no Cloudflare variable in the environment, so the account was looked up:

- the lab app's Cloudflare group (`Kv`, `D1`, `Ai`, `RateLimit`, a Durable Object, a `Workflow`, a `Queue` with a subscriber, a `Cron`, a `Worker` with a URL, placement, migrations and every link, and a `StaticSite`): 42 created; every route answered, the queue's consumer and the cron ran; the token wasn't in the state's export but as ciphertext; every account id was the account's; the placement was `smart`;
- a deploy that dropped the applied migration, then 42 unchanged;
- `sst eject`: 19 out of the state, 5 builds copied; then `index.ts` on `ejected()`, `sst` uninstalled, a Pulumi home without SST's plugin and `.sst/` moved away: the preview made the 5 URLs and changed nothing else; deployed, and every route answered;
- the copied API Worker's code changed and deployed: its URL stayed on;
- the placement on the script, on 6.15 and on 6.24.0 (the program's provider bumped in the lab alone): refused, as above;
- the fix: a Worker deployed with SST's package, its environment changed and deployed again, its placement still `smart`;
- each stack destroyed (28 and 7) and removed; the account has no Worker, namespace, database, queue, workflow or Durable Object left.

**Not checked:** `Bucket` and `Hyperdrive` (no R2 or database), the sites with a server, a Cloudflare DNS record (the account has no zone) and Vercel's (no account), all in the tests only; a Worker in `sst dev` on a Pulumi program.

## 2026-11-13: step 9, the eject's last AWS cases

The eject takes a database proxy's role lookup and a MicroVM image's pruning out of the state, [as decided](plan.md#decisions). With them, the only own resources of SST's it refuses are Cloudflare's and Vercel's.

**What changed** (`pkg/eject`): `sst:aws:RdsRoleLookup` ("a wait for the role RDS gives a proxy, which is there now") and `sst:aws:MicrovmImagePrune` (which says nothing deletes the image's old versions after the eject, and an image keeps up to 50) are among SST's own resources that leave the state. The code a MicroVM's image was built from is said to be the image's, not a function's. The refusal test uses SST's origin access control, still refused. The docs page lists both among what leaves the state.

**Checked:** Go, `pkg/eject`'s tests (a proxy that waited on the lookup, kept without it; a MicroVM's prune and code). In the lab, `us-west-2`, under plain Pulumi, with a Pulumi home holding every plugin but SST's for the runs without SST (APFS clones; Pulumi doesn't follow a symlinked plugin folder):

- **`MicroVm`** (project `thinmicrovm`, stack `mv`): `Assets` without a repository and a `MicroVm` from a Dockerfile on `node:24-alpine` from AWS's public registry. `pulumi up`: 12 created, the image built in 174 s. `sst eject`: 4 out of the state (the prune, the code, the link record, SST's provider). Without SST: `pulumi preview --diff` and `pulumi up`, 8 unchanged. `pulumi destroy`: 8 deleted; the bucket, the log group (`/aws/lambda-microvms/...`) and both roles checked directly, gone; `lambda-microvms list-microvm-images` lists none; nothing tagged. The stack removed. The image's id in the state is `missing ID`, as the AWS provider has it for that resource.
- **`Postgres` with a proxy** (project `thinpg`, stack `pg`), in a `Vpc` without NAT, with no `Assets` as nothing is uploaded: `pulumi up`, 33 created in 9 minutes, the proxy `available`. `sst eject`: 1 secret in the config, 4 out of the state (the role lookup, two link records, SST's provider); the password as Pulumi's own `random.RandomPassword`. Without SST: `pulumi preview --diff` and `pulumi up`, 29 unchanged. The proxy's target became `AVAILABLE` (it was `PENDING_PROXY_CAPACITY` for its first minutes), so the proxy reached the database with the secret. `pulumi destroy`: 29 deleted in 9 minutes; the VPC, instance, proxy, subnet and parameter groups, secret (deleted at once: no recovery window), role and Cloud Map namespace checked directly, gone; no snapshot; the tagging API's two entries (a subnet, a security group) checked directly, gone. Left, as an RDS proxy leaves it: its log group `/aws/rds/proxy/<proxy>`, empty, deleted by its name. The stack removed; the account back to 4 VPCs.

## 2026-11-13: step 8, asset storage

SST's components keep code and images in the store the program declares, [as decided](plan.md#decisions). In the lab, in a region SST's CLI had never deployed to, a program with `Assets` deployed with Pulumi alone, was ejected, ran without SST, and was destroyed with nothing left.

**What changed:**

- **`Assets`** (`aws/assets.ts`, `sst:aws:Assets`): a bucket (`forceDestroy`) and an image repository (`forceDelete`, left out with `repository: false`), which it declares as the program's store for its region. It passes `retainOnDelete` to its parts, which Pulumi doesn't; `protect` reaches them as Pulumi passes it. **`Assets.use({ bucket, repository })`** declares a bucket and repository of the program's, for the region of the provider it's given. ECR repositories have a naming rule now. `Assets` is in the codemod's list of `sst.aws`'s exports, and in `v5-components.test.ts`'s list of components SST 4 didn't have.
- **The lookup** (`aws/helpers/bootstrap.ts`, `assetStore()`): a component that keeps code or images asks for it when it's created, after which a store declared is an error ("comes after"), so which store it uses never depends on when a value resolves. The store is the one declared for the component's region, the one with its provider when two are; under SST's CLI, SST's bootstrap when none is; under plain Pulumi, an error that says what to add. The bucket and the repository are found when they're used, so a service with an image it's given needs no store, and each depends only on its own resource: a code object depends on the bucket, not the repository (the lab's first deploy had both). `Function`, the image helper behind `Service` and `Task`, and `MicroVm` use it. Under plain Pulumi, `bootstrap.forRegion` no longer reads `/sst/bootstrap`, and the mock no longer answers it.
- **What's kept on delete:** the dev stub's code only in SST's bootstrap. A function's source maps stay in SST's bootstrap under SST's CLI whatever the store, where SST's Console reads them, kept on delete as before; under plain Pulumi they're in the store, deleted with the function.
- **The eject** tells a source map from code by its key, not by whether it was kept; says when a build stays in the stack's own bucket, which goes with it; and refers to a value a resource it takes out of the state carried, so a function's `s3Bucket` is `assetsBucket.bucket`. An output named as the end of the input's name (`s3Bucket`, `bucket`) is preferred to the id.
- **The tests:** the mock forgets the declared stores on each reset; the platform's plain-mode helper declares the mock's bootstrap as the store. `assets.test.ts` (plain: the parts, `repository: false`, the options, a function's code and source maps, `Assets.use`, no store, the order, the region, a store without a bucket) and `assets-cli.test.ts` (SST's bootstrap unchanged, `Assets.use` with the source maps in SST's bootstrap, an image in the app's repository, the bootstrap in a region with no store). `TestBuildWritesTheProgramsAssets` in `pkg/eject`.
- **The docs page:** `Assets` in the setup and the table; the eject's leftovers; the bootstrap limit gone.

**Checked:** `tsc`; the platform suite (114 files, 4270 tests, with the codemod's list); the Go suite; the API reports (an addition, with the parts' internal names renumbered); the components' docs generate, with a page for `Assets`, and the docs site builds (188 pages). After the last change to the lookup, the suite again: 4 `Nextjs` and `Nuxt` takeover tests timed out while the docs site built beside it, and passed on their own (149). With `SST_TEST_PLAIN=1`, over `test/components/v5`, against the commit before: one new failure, a takeover test that expects the dev stub's code to be kept on delete, which a program's own store doesn't; 19 more pass (the new tests). Two task tests whose provider is in another region now fail as a program would be told, with no store there; they failed before too, on `$cli`.

**In the lab**, project `thinassets`, stack `as`, in `us-east-2`, which had no `/sst/bootstrap` (the account's policies allow it, unlike `us-west-1` and `ca-central-1`), with a `Bucket` and a `Function` linked to it with a URL:

- Without `Assets`, `pulumi preview` stopped with the message that says to add `new Assets("Assets")`, and no stack trace.
- With `new Assets("Assets")`, `pulumi up`: 21 created. The function answered with its bucket. The code and its source map were in the program's bucket, not kept on delete; `/sst/bootstrap` still wasn't in the region. Another preview: 21 unchanged; another `pulumi up`, with each field depending on its own resource: 21 unchanged.
- `sst eject`: 2 secrets in the config, 6 resources out of the state (the code and the source map said to stay in the stack's bucket until it's deleted). The module made `Assets` as SST's other components, with the bucket and the repository, and the function's `s3Bucket` was `assetsBucket.bucket`.
- The program switched to `ejected()`, `sst` uninstalled, `SST_BIN_PATH` unset, SST's plugin moved out: `pulumi preview --diff`, 16 unchanged; `pulumi up`, 16 unchanged; the function answered.
- `pulumi destroy`: 16 deleted. Both buckets (404), the function, the repository, the log group and the role, checked directly: gone; the tagging API lists nothing of the app; `/sst/bootstrap` still not in the region. Nothing was left in any bucket, as the code was in the program's own. The stack removed, SST's plugin put back.

## 2026-11-13: `$transform` for a Pulumi program

`sst/components` exports `$transform`, the maintainer's choice of the two gaps the docs page found, as recommended. Under SST's CLI it's a global; a Pulumi program had no way to reach it, and Pulumi's own transforms can't change a component's args, which SST's components read before they register anything.

**What changed:** `core.ts` exports `$transform` from `component.ts`, the module SST's CLI takes the global from, so a program's components share its registry. It has a doc comment now, which the API report shows (`api/sst-components.api.md`, an addition). The docs page's table imports it, and it's out of the page's limits.

**Checked:** a test registers a transform through `sst/components` on a component, which takes it (`component.test.ts`, also with `SST_TEST_PLAIN=1`); `tsc`, the full suite, the API reports; the components' docs generate unchanged.

## 2026-11-13: the docs page

"Components in Pulumi" (`www/src/content/docs/docs/components-in-pulumi.mdx`, in the sidebar after "Use with Pulumi", which links to it), [as decided](plan.md#decisions), in place of rewriting the components' docs:

- **Set up:** the install, with the four providers `sst/components/aws` loads beside AWS's; `nodenext`; what a deploy needs (the binary, SST's plugin, SST's bootstrap, AWS credentials as the program's provider has them); SST's tags by the stack's config.
- **From SST's docs:** a table from each of SST's globals and `sst.aws.X` to its import or Pulumi's own (`$app.stage` is `pulumi.getStack()`, `$dev` is `context().dev`), with a secret as stack config linked by a `Linkable` in place of `sst.Secret`, and `protect` in place of `removal`.
- **`sst dev`** on SST's components, and `sst-env.d.ts`.
- **`sst eject`:** what it writes and takes out, switching the program, the module, several stacks, `ejected()`'s argument, the functions' code and `nodeBuild()`, going back, what it leaves and what it refuses.
- **Limits**, among them two gaps found while writing it: an account SST's CLI hasn't deployed to has no bootstrap, so an SST app has to have deployed to the region once; and `$transform` had no import for a Pulumi program (exported since, above).

**Checked:** the page's examples typecheck against the branch's package (`tsc --strict`, `nodenext`); the docs site builds.

## 2026-11-13: step 7, SST's components inside the program's own component

The eject no longer refuses one of SST's components that's in a component of the program's: the module makes it with that component as its parent, which `ejected()` is given. Committed as `aece8b61c`.

**What changed** (`pkg/eject`): a resource of the program's that one of SST's components is in is given to `ejected()` under `parents`, by its name, as a provider of the program's is under `providers`; both are now in one argument, `ejected({ providers: { east }, parents: { shop } })`, and the module refers to them as `program.providers.east` and `program.parents.shop`. The eject says what `ejected()` takes, and the dry run too. A test has a `Queue` in the program's `Shop`.

**Checked:** Go, `pkg/eject`'s tests and the full suite. In the lab, project `thinnested`, stack `dev`: a component of the program's, `Shop` (`acme:index:Shop`), with a `Bucket` and a `Function` linked to it in it. `pulumi up`: 17 created, and the function answered. `sst eject`: `ejected()` takes `parents.shop`. The program then made its `Shop` with nothing in it and gave it to `ejected()`; with `sst` uninstalled, `SST_BIN_PATH` unset and SST's plugin moved out, `pulumi preview --diff`: 14 unchanged; `pulumi up`: 14 unchanged, and the function answered. `pulumi destroy`: 14 deleted; the function, role, bucket and log group checked directly, gone; the tagging API lists nothing; the 2 build files deleted; the stack removed.

## 2026-11-13: step 7, the eject for several stacks

`sst eject` writes one module for every stack of the project, [as decided](plan.md#decisions). Committed as `447d04e92`.

**What changed** (`pkg/eject`):

- **Each stack is read as before** (`module.go`): what the eject does with each resource, and each thing the module makes as that stack has it, its inputs written with the stack's references. A secret stays the stack's own value until the merge.
- **The merge** (`merge.go`) lines up what the module makes across the stacks by its URN without the stack and project, and merges each one's inputs and options value by value: the same in every stack, as it is; a plain value or a secret that isn't, from each stack's config under `sst-ejected`, with the right `config.require…` for its kind (`get…` where only some stacks have it); otherwise, picked by stack with `byStack`. Options are never read from the config. What only some stacks have is made with `onStack(...)`, and referred to with a `!`, only where it's made. One stack is the same as before, but that the module reads its secrets through `config`.
- **The command** lists the project's stacks (`pulumi stack ls --json`), refuses `--stage`, saves each stack's state, puts each one's values in its config, and imports each one's state; if an import fails, the stacks imported before get their saved state back. What it says groups what each stack takes out, and says when it's the same as the stack before.
- **Tests**: a second stack made from the fixture (its own names, a role given as an ARN, and a queue only it has), with the module, each stack's settings and what each takes out; and a stack with nothing of SST's, left out.

**Checked:** Go, `pkg/eject`'s tests and the full suite. In the lab, project `thinstacks` with stacks `dev` and `prod`: a `Bucket` and a `Function` linked to it in both, and in `prod` a `Queue` with a subscriber, which the function links to too.

- `pulumi up`: 18 created in `dev`, 28 in `prod`; each function answered with its stack's bucket.
- `sst eject --dry-run`, then `sst eject`: 6 values in `dev`'s config (2 secret), 8 in `prod`'s (4 secret); 6 and 9 resources out of the states. The module typechecked: the names from the config, the queue's parts with `onStack("prod")`, and the role's policy statements by stack, as `prod`'s refer to the queue.
- The program switched to `ejected()`, `sst` uninstalled, `SST_BIN_PATH` unset, SST's plugin moved out: `pulumi preview --diff` showed 13 unchanged in `dev` and 20 in `prod`, nothing else; `pulumi up` the same. Both functions answered, and `prod`'s queue subscriber ran.
- `pulumi destroy`: 13 and 20 deleted. The 13 functions, roles, buckets, queues, event source mappings and log groups checked directly: gone; the tagging API lists nothing of the app. The 6 build files left in the asset bucket deleted by their keys; the shared stub objects as they were. Both stacks removed.

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
