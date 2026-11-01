# The 5.0 rewrite: progress

What's been done on [the plan](plan.md), newest first. Each entry says what was done, what was checked, and what it found. The plan's [status](plan.md#status) has the summary.

## 2026-11-01: step 3, the target suite and the Floci package

The maintainer said to go on to the Floci package. It's to live in a repo of its own, with rogueturnip, so it was drafted outside this repo and not published, for them to take over.

**Done, reviewed, committed (not pushed):**

- **The target suite, `targetSuite(target)` in `sst/testing`**, which a package that exports a target runs in its own CI. It runs the `sst` CLI on an app with one bucket, bound to the target. Its deploy, `sst shell` and remove run with the developer's AWS settings planted around the CLI: keys, a session token, a profile, a region, endpoints, a role, credential and config files, and a proxy that records where it's sent. It checks that the program and `sst shell` get the target's credentials and region and nothing planted, that the program can reach nothing but this machine (the fence refuses it, not just no network), that the bucket is created and removed in the target, that the state is in the target's home, and that nothing went to AWS through the proxy. It cleans up after itself, and keeps a stage's state if the stage couldn't be removed.
- **`context().target`**, in the program contract: the stage's target, when it isn't the real cloud. A package's check can turn itself on for its own target's stages only. `mock()` takes a `target` to bind its stage to one.
- **Pulumi's plugins on a target's stage.** Pulumi downloads a provider's plugin as it runs, which the fence stops. The CLI now installs the ones it doesn't have first, with its own environment, and Pulumi doesn't try. One that can't be installed is left, as the program may not use it; if it does, Pulumi names it. One whose install was stopped partway counts as missing.
- **Found and fixed: `sst diff` of a new stage failed with a V5 `Queue`, `Bucket` or `Dynamo` subscriber.** The takeover map gives the subscriber's 4.x address, made from the queue's or bucket's ARN or the table's name, which a new stage's preview doesn't know. Pulumi fails on an alias it can't resolve. Such an alias is now one that matches nothing, under the resource's own name: nothing can be at an address made from a resource that doesn't exist yet. Known values give the same aliases as before. A deploy that previews first, as one with checks does, failed the same way.
- **The Floci package**, from #212's allowlist: the target settings for Floci 2.3.0, and `flociCheck()`, a check on the V5 `Function`, `Bucket`, `Dynamo` and `Queue` and the AWS resources an app creates, which turns on only on a stage bound to Floci. Its tests: the check under `mock()`, and with Docker, the target suite and a deploy of the four components on Floci with the check on.

**Checked:**

- **Against Floci:** the target suite passed all its checks. The package's deploy of the four components, with a subscriber and the check on, previewed first, deployed, its function answered with its links, and `sst diff` showed no changes. With an SNS topic added, the check stopped the deploy before anything changed. `sst dev` deployed the same app, its stub included, with the check on. With a plugin taken out of Pulumi's cache, the CLI installed it and the suite passed. Nothing was left in Floci or the target's home, and its container was stopped. Nothing of it was in AWS.
- The preview of the three subscribers fails without the alias fix and passes with it, in a test. The platform's 1,835 tests and all Go tests pass.
- **An independent review** found these, each fixed: an internet check that passed on a machine with no network, so the program now has to be refused by the fence itself; the warm-up's failures were ignored; a command that didn't stop on time was never killed; the code that reads the environment was copied from a function's source, which coverage tools rewrite; the state of a stage that couldn't be removed was deleted anyway; `sst` from npm couldn't be run on Windows; more of the developer's AWS variables are planted; a partly installed plugin; a plugin the program doesn't use stopping an offline run; two old addresses of one resource that both weren't known.

**Left:**

- The Floci package needs a repo of its own and SST 5's first pre-release with these, before its CI can run. It's been run on macOS with Docker Desktop, not yet on Linux.
- The suite doesn't run `sst dev`'s workers, and its check that nothing reaches AWS only sees clients that use the proxy they're given.
- A package's handler that imports `sst`'s runtime SDK, like `Resource`, still needs `skipLibCheck`: two of its declarations name `aws-lambda`'s types, which it doesn't install, and one has a type error.
- The first deploy of a stage with checks still shows an error before the run with a preview, as before.

## 2026-11-01: step 3, the package setup

The plan asks that a package need no `moduleResolution: "bundler"`, `skipLibCheck` or pinned `google-protobuf`, and that a group not pull in every provider, or that the reason be written down. Each was tried in a copy of the template package (`examples/component-package` on `v5-community-packages`), with `sst` packed from this branch.

**Done, reviewed, committed (not pushed):**

- **`skipLibCheck`.** Without it, a package's `tsc` found 45 errors in SST's declarations, for two reasons:
  - **TypeScript names a type by its shortest path.** The V5 components' declarations named `OptionalPart`, `ManyPart`, `ComponentClass` and the rest as `import("../..")`, which is the `sst` global's module. That module loads every group, so `sst/components/aws` reached Cloudflare's and Vercel's declarations, and their providers. The global's module is now left out of the build of the declarations, and copied in as its own: it's only re-exports. So they're named through `core`. A test checks that no file of the platform imports it, which would bring it back. The one that did, `aws/helpers/arn.ts`, didn't use it.
  - **`sst.cloudflare.binding()` gave its callers a type with an unbound `T`**, in ten of Cloudflare's components. It couldn't infer `T`, and TypeScript copied its body's `as T` into theirs. It now infers `T` from the binding's `type`, and returns `BindingInclude<T>`.
- **`moduleResolution`.** Under `NodeNext`, SST's declarations needed `.js` on every import: their own files, and paths inside a provider like `@pulumi/aws/ec2/vpc`. The build now adds it (`platform/scripts/types.mjs`), as the 2026-10-19 decision in [v5-components.md](../v5-components.md#decisions) left for when a package needs `NodeNext`. Then it checks `sst/components`, its groups and `sst/testing` under `NodeNext`, without `skipLibCheck`, so a change that breaks either fails the build, in CI too. `bundler` reads the same files.
- **An app under `NodeNext`.** `.sst/tsconfig.json` points each path at a file, with its extension: under `NodeNext`, TypeScript doesn't add one to a path or look in a folder. A provider's path is the types file its `package.json` names. `config.d.ts` imports `config.js`.
- **`google-protobuf`.** No pin is needed. With 3.21.4, the version `@pulumi/pulumi` asks for, the template's tests passed under vitest and `bun test`, against this branch and against `5.0.0-alpha.2`: resources, reads with `get`, existing parts, and provider functions given secrets. The failure the guide described, `c.g is not a function`, didn't happen. Pulumi's community reports it when two copies of `google-protobuf` meet.
- **`$resolve`'s types.** Two of its overloads named `Unwrap` without `util.`, so with `skipLibCheck` their values were `any`.
- **The guide**, *Write a Package Component*, no longer asks for `skipLibCheck`, `bundler` or the pin, for a package or an app.

**Not fixed: a group needs every provider its components use.** A component's declarations are typed with the classes of its parts: a function's `image` is docker-build's `Image`, a database's password random's `RandomPassword`, a site's build command's `Command`, and a VPC's bastion key tls's `PrivateKey`. So a package's repo that imports `sst/components/aws` installs all five providers as dev dependencies, even if it uses none of those parts. Loading them only when a part is made would spare the tests, not `tsc`. An app always has them. What could narrow it is an entry point for each component, which is more API to hold still, and only pays off once 5.0's components each import only what they use; it's for step 4.

**Checked:**

- A packed `sst` in a copy of the template: `tsc` with no errors without `skipLibCheck`, under `bundler` and `NodeNext` (the template's own import then needs its `.js`), and its tests without the pin.
- An app installed by a test CLI from this branch (`sst install`, a local home, nothing deployed): with `NodeNext` and with `bundler`, the config, a local component, and `sst.aws.v5.Function` typed, and mistakes in each caught.
- The platform's `tsc`, its 1,833 tests, and the Go tests of `pkg/project` and `pkg/js`.
- **An independent review** found two gaps, each fixed with a test: a package with no `types` field was pointed at an `index.d.ts` that might not be there, and is now pointed at the first file that is, the declaration beside its `main` among them, or at its folder; and the test of what imports the global's module missed `../index` with no extension.

**Left:** the template on `v5-community-packages` still sets `skipLibCheck` and the pin, and its README says to; they go when it comes to this branch. The declarations' source maps are a few columns off on the lines whose import got its `.js`.

## 2026-11-01: step 3, `sst.check`

The maintainer chose how a check stops a deploy: with a preview first, so a deploy never half-applies ([decision](plan.md#decisions)).

**Done, committed (not pushed):**

- **`sst.check({ name, component, resource, invoke })`** turns a check on for the program: it looks at each component with its args (SST's hook, after `$transform`), each resource with its inputs, and each provider function the program calls (Pulumi's resource and invoke transforms). What it finds stops the program, with the check's name, the resource and how to fix it. A value that isn't known yet in a preview is given as `unknown`, not left out.
- **A preview first.** The program keeps its checks' names with the state (`_checks`, a hidden output, only when it has some), and a deploy of such a stage runs Pulumi's preview first, as `--policy` does. A deploy with no preview whose program turns out to have checks stops in `sst.check()`, before anything is registered, and the CLI runs it again with a preview first.
- **The core shows a finding,** which Pulumi wraps in its message about the resource it stopped, and shows the preview of a deploy as a preview, not as steps taken. Before, a `--policy` deploy did that only for policies.
- **Under `mock()`,** a resource's checks run as it's registered, and what they find is kept in `findings` for a test.

**Checked:** tests of findings, unknown values, components, invokes, the stop without a preview, and the mock; which states preview first; the finding read from Pulumi's message. In the lab, on the Floci stage: a check that finds the table stopped a deploy with nothing created; turned on for a stage whose state had none, it stopped the first run before anything changed, and the run with a preview showed the finding; a check that finds nothing deployed and kept `_checks`; the next deploy previewed first and stopped at the finding. All Go tests, `tsc`, and the platform's 1,830 tests.

**Found and fixed: `sst diff` of a new stage with the V5 `Function` failed:** "handler and runtime must be set". The handler comes from the build, which waits for the links' values and the key, and on a new stage they aren't known in a preview. The provider turns down a Zip function with an unknown handler. The 4.x `Function` creates its Lambda inside an `apply`, which a preview skips, so it never showed. Now, when the build input isn't known in a preview, the preview builds without the links and the key, only to learn the handler, which doesn't depend on them. In the lab, the diff of a new Floci stage planned the function, and after a deploy (handler `bundle.handler`) the diff showed no changes. A new stage doesn't preview first: a deploy whose program has checks stops and runs again with one.

**An independent review** found six problems. Fixed: `sst.check()` turned on after a component was created is turned down, as it wouldn't see it; a secret input reached a check still wrapped, so a check missed it, and is now its value; a finding is kept out of telemetry; under `mock()` a check now gets `unknown` and secrets' values as in a deploy; the function's preview build skips a function with `bundle`, which it would have written into with no key, and runs `hook.postbuild`.

**Left:** a value that isn't known in the preview, or a component created inside an `apply`, is checked during the update, where a finding stops the deploy partway: a check that must not let an unknown value through reports it in the preview. The first, stopped run of a deploy that turns out to have checks shows an error and leaves a failed update in the history before the run with a preview. Invoke checks don't run under `mock()`. A finding also stops `sst refresh`, and each deploy of a stage with checks runs the program twice.

## 2026-11-01: step 3, #212's HTTP transport

The maintainer asked whether to adopt #212's HTTP transport now, rather than wait, and said yes to porting it: without it a target's stage could deploy, but `sst dev`'s functions couldn't reach it.

**Done, committed (not pushed):**

- **#212's server and client, by rogueturnip,** as `httpbus`: sst dev and each stub publish and subscribe over HTTP on this machine, with a token on every request. What's changed is the wording, which named Floci.
- **`transport.HTTP`, a `Transport` behind them:** `Stub` gives the stub sst dev's address as a container reaches it, `host.docker.internal`, and the token; `Connect` starts the server; `Remove` forgets them. The port and token are kept per stage in the working folder, readable only by the developer, so each run gives the stubs the same ones. The server listens on `127.0.0.1`, which Docker Desktop's containers reach; on Linux, also on the Docker bridge's address, only while sst dev runs. #212 listened on every interface.
- **A target's stage uses it,** and the real cloud's uses AppSync as before. The stub picks its connection from its environment, and doesn't pass the token on to the function's code.

**Checked:**

- The transport suite: all ten of its tests pass against it, as AppSync's do, and #212's own tests. The token's checks, its port taken, two processes making its settings at once, and its file's mode.
- **In the lab, `sst dev` on the Floci stage:** Floci's Lambda ran the stub, which reached sst dev over HTTP, and the function ran on this machine and answered. An edit to the handler was picked up on the next invocation. The token isn't in plain text in the state: the function's environment is a secret, as it holds the links' key. sst dev listened on `127.0.0.1` only. `sst remove` removed the stage and the transport's settings. The container Floci started for its registry also published its port on `127.0.0.1` only.
- All Go tests, with the race detector for `sst dev`'s packages, `tsc`, and the platform's 1,822 tests.

## 2026-11-01: step 3, the target

The maintainer said to work through step 3. The target came first: it doesn't wait on #212's transport.

**Done, committed (not pushed):**

- **`pkg/target`:** the `Target` interface: start and stop, the providers, the home, and the environment of what the core starts on the stage. The real cloud is the built-in, `Cloud`, and does what the core did before. `Local` is a target on this machine, from its settings, which the core carries out.
- **A stage is bound to its target in the config,** as `targets: { local: emulator }` in `app()`. A target is a plain object of the type `Target`: `app()` is read before the platform is loaded, so no function from `sst/components` can make one there ([decision](plan.md#decisions)).
- **Its container is the core's:** its ports are published on `127.0.0.1` only, its volumes are Docker volumes of its own, and nothing of the machine's files is given to it but the Docker socket, when its settings say so, which the CLI says when it starts it. A container of that name SST didn't start is left alone. One started with other settings is replaced, and its volumes are kept.
- **The developer's credentials are kept out.** On the stage, the CLI takes the developer's AWS variables out of its own environment and sets the target's, so everything it starts gets them. The program, the workers and `sst shell` lose the developer's proxies too, and get no files to read credentials from. The CLI's own AWS client reaches only the target's endpoint.
- **The program is fenced in:** its proxy answers nothing, for every host but this machine, so a call that isn't the target's fails.
- **Its state is in a home of its own,** a folder under the user's config folder, never the home the app names.
- **A boolean or number provider setting reaches Pulumi**, which it didn't before: #212's fix. An app with one sees it applied.
- On a target's stage there was no transport yet; the next entry adds #212's.

**Checked:**

- Unit tests of the settings' checks, the container's arguments and how it's started, and the environment.
- **In the lab, with Floci 2.3.0, and AWS credentials in the shell:** the CLI started Floci's container, said it's given the Docker socket, and published its port on `127.0.0.1` only. The V5 `Function`, `Bucket`, `Dynamo` and `Queue` deployed to it, with only the endpoint set for the provider, no list of services. The function answered in Floci. `sst diff` showed no changes, and `sst remove` removed it all. The real account had no passphrase, state or resource of the stage. `sst shell` had only the target's credentials, with a planted credentials file, a profile and a proxy in its parent's environment. Behind the fence, Node couldn't reach the internet and reached the target.
- All Go tests, `tsc`, and the platform's 1,822 tests.
- **An independent review** found five gaps, each fixed with a test:
  - What the CLI kept of its environment when it started, which `sst shell --target` and `sst dev`'s panes are given, still had the developer's credentials. It's made the target's now too.
  - Cloudflare's and Vercel's tokens stayed, and the CLI calls some of their APIs for the program, outside the fence. They're taken out with AWS's, and a target's stage turns down those providers, with a message. The home's provider isn't added on a target's stage, as its home is the target's.
  - An app's `endpoints`, proxies or CA bundle for the aws provider could send its calls somewhere else. They're left out, with what picks credentials, and the target's settings go over the rest.
  - An image name that starts with a dash is turned down.
  - `sst dev` stopped at once on a target's stage, with no transport. The HTTP transport fixed it.
- **Left, from the review:** Node reads the proxy variables only in its newer releases (24, and the latest 22), so on an older Node 22 the program's own calls aren't fenced in; Pulumi's plugin download is blocked by the fence, so a plugin has to be installed before; two commands starting a target at once can race on its container; a tag isn't pulled again; nothing stops the container but Docker. The credentials are the target's in each case.
- **For the release notes:** an app with a boolean or number provider setting sees it applied on its next deploy, as an update to the provider.

## 2026-11-01: `main` merged in, with v4.23.1

The maintainer said to close two open items: bring in the fixes `v5-rewrite` was missing, and delete the lab's old state versions.

**Done, committed (not pushed):**

- **`main` merged into `v5-rewrite`:** v4.23.1's `Router` fixes, the type files left alone on `sst remove` (#201), the globals for a project with `.sst` in its path (#206), and the subscriber function names (#214), which came after the release. A build of `v5-rewrite` no longer shows `Router` changes on a stage v4.23.1 deployed, so a test build needs nothing on top.
- **`pkg/js`:** #206 compares the project's `.sst` folder by its real path too. That's kept beside the rewrite's globals, which are imports. #206's tests give the globals as a module now, and the file in `.sst` they check uses the global: an import a `.ts` file doesn't use is dropped, so the test couldn't see one otherwise.
- **#214 renames the function of a 4.x subscriber**, from the subscriber's name with `Function` added to the subscriber's name alone, with an alias to the first. What's inside the function is named after it. So a 4.x stage has them at one address or the other, by the 4.x it last deployed with. The V5 `Bucket`, `Bus`, `Dynamo`, `Queue` and `SnsTopic` take them over at either.
- **The takeover tests check both.** When the original component renamed a resource, each case is also run against its graph as it was before the rename, and the V5 component has to claim the same resources there. What each resource is given is the same both ways, and is checked once.

**Checked:**

- All Go tests, `tsc`, and the platform's 1,822 tests. Without the old address, 20 takeover tests fail; without the new one, the same 20 fail.
- The merged `pkg/js` tests fail without #206's fix: the two that need the globals without it, the two that need `.sst` left alone without the real path.
- **An independent review** found no other place a V5 component claims a 4.x subscriber's function, and that the mock works out inherited aliases as Pulumi does. It found:
  - Two subscribers whose names differ by a `Function` at the end, like `Foo` and `FooFunction`, have the same address, one in each naming. Pulumi takes the first address it finds, so no order is right for both. The later naming is looked for first: 4.x after #214 already fails on such a pair on a stage deployed before it.
  - The mock treats an alias as claiming whatever it matches, where Pulumi takes the first. It matters only for such a pair. Left as it is.
  - 4.x creates a durable function's URL alias (`<name>Durable`) with no parent, so #214's rename replaces it in 4.x, and the V5 `Function` replaces it too. It's a Lambda alias, which holds no data. Left for step 4's look at 4.x.
  - The rulebook still had the old name in an example, and didn't say what the check is. Both fixed.

**The lab:** the old state versions of the October stages `lab`, `ports` and `share` were deleted: 1,131 versions and delete markers, none of them live. The state bucket has nothing of the lab app now, and it has no passphrase or sourcemap left.

## 2026-10-31: step 3, `sst.runtime`

The maintainer said to go on. `sst.runtime` came before the target: it finishes the runtime, and one lab run checks both it and the runtime's `sst dev` changes. The target needs #212's transport, with rogueturnip, and Docker.

**Done, committed (not pushed):**

- **`sst.runtime(settings)`** (`platform/src/components/runtime.ts`, exported with `sst.component`): a runtime made of commands, for a language SST doesn't build in. Its settings are the Lambda runtime its functions deploy with (`lambda`), and the core's command settings: the folder, the build command and its output, the dev command, and the files to watch. It turns down settings with no Lambda runtime or no dev command. It's marked with a key of its own, which an output keeps.
- **The V5 `Function` takes one as its `runtime`**, given as it is or in an output. Its build input carries the commands, so the CLI builds it with them for a deploy and runs it with them in `sst dev`, and it's deployed with the Lambda runtime they name. A function with a runtime name is as it was. What's neither is turned down, and so are `injections` with one, as they're for a Node.js function SST builds.
- **The 4.x `Function` turns down a runtime from `sst.runtime`**, with a message that says why: a `$transform` written for the V5 one runs on it too, as they share a type. It changes nothing for an app that works.
- **A worker's process has a key of its own for each start.** Its address has the start in it, `/lambda/<worker>.<key>/<run>`. What a start that `sst dev` stopped, or that another replaced, sends is left out: it isn't handed an invocation, and its answers, errors and init errors aren't passed on. Ruby's runtime interface client reports being stopped as an init error, which `sst dev` passed on as the function's, so each rebuild failed the next invocation; the lab found it. A worker id or start with a `/` in it is turned down, so one's key can't be another's.

**Checked:**

- In the lab, on a stage of its own, a Ruby function through `sst.runtime`, with Bundler as its build and Ruby's own runtime interface client (`aws_lambda_ric`) as its dev command, beside a Node.js function, both linked to a table:
  - deployed: the CLI ran `bundle install`, zipped the folder, and Lambda's Ruby 3.4 answered, with its links' key and file;
  - in `sst dev`: the function ran on this machine's Ruby through its runtime interface client, what it printed showed, its links' file was in its folder, and the Node.js function answered beside it;
  - two changes to the handler each rebuilt it, and the next invocation answered with the change. Before the fix above, the first one after a change failed;
  - `sst diff --dev` showed no changes; `sst remove` removed it, and the stage was cleaned up after: nothing of it is left.
- A test that a worker stopped by a rebuild, which reports that as an init error, doesn't fail the next invocation or publish an error. It fails without the fix, as the lab did.
- Tests of the V5 `Function` with a runtime made of commands, deployed, in `sst dev` and in an output, and of what it turns down. All Go tests, the platform's 1,796 tests and `tsc`.
- **An independent review** found three problems, each fixed with a test that fails without the fix:
  - A start that was replaced could still ask for an invocation, take one meant for the new one, and answer it. Every request from such a start is left out now, not only its init error.
  - A runtime in an output lost its mark, as Pulumi copies an object by its string keys, and the function failed on it. Its mark is a string key now, and the function reads its runtime through the output.
  - A `$transform` that gives the V5 `Function` a runtime from `sst.runtime` runs on the 4.x one too, which failed on it with no reason given. It says why now.
  - Smaller: the address's own doc; the docs of the folder and the dev command; two cases of a late init error, after the new start is recorded and once the worker is forgotten, have tests.

**Found:**

- A stopped Ruby worker still prints its init error as it exits, so `sst dev` shows it after each change, though it no longer fails anything.
- Quitting `sst dev` with a Ruby worker running wasn't tried; its init error should find the server gone.

**Left:**

- A page for `sst.runtime` in the docs, with the rest of the package API. The generated page of the V5 `Function` links its `Runtime` type to that page already.
- A package with a runtime, like a Ruby one, in a repo of its own, as the community packages plan's step 4 asks; the lab's is the shape it would take.

## 2026-10-31: step 3, the runtime as a place to plug in

The maintainer said yes to the transport's commit, and the runtime came next. The plan draws it from the five built-ins and a runtime made of commands, the one packages will give with `sst.runtime`.

**Done, committed (not pushed):**

- **`runtime.Runtime`** (`pkg/runtime/runtime.go`) is `Match`, `Build`, `Run` and `ShouldRebuild`, and writes down what a runtime has to do: build into the function's folder, with an error in the function's code in the build's errors, not as the runtime failing; build different functions at once, and again into the same folder while a worker runs from it; run a worker against the Lambda runtime API with the environment it's given; a worker's logs end when it exits, and stopping it doesn't wait; and say which files a function uses.
- **`ShouldRunEagerly` is gone.** Python said no to it because a change to shared code rebuilt every function, and the core started a worker again at once for each, a few seconds apiece. Now the core starts again at once only the workers of the three functions invoked last, whatever the runtime, and the rest when they're invoked. Python gets the function in use started ahead of its next invocation, which it didn't before, and a Node.js change to shared code no longer starts a worker for every function either. After a deploy, only those three are built at once; the rest build when they're invoked.
- **The types of what's linked stay out of the runtime**, against the plan's sketch: a site's frontend or a Rails app reads its links too, and isn't a function, so the core goes on making them for the app's languages (`pkg/types`). The plan says so now.
- **A runtime made of commands** (`runtime.Commands`, `pkg/runtime/commands.go`), the core's side of `sst.runtime`. A function's build input carries the settings, and the core picks it for any function that has them. Neither command runs in a shell, as a dev command doesn't.
  - **Where:** the folder the function's code is in, or without one, the handler's folder, with the handler the rest of it. With a folder, the handler is as Lambda takes it, which for .NET isn't a path.
  - **Build:** a command run there, told whether it's for `sst dev` or a deploy and the function's architecture, and the folder it writes. Functions in one folder build one at a time, and one that asks while another builds takes that build. A deploy copies the output into the function's folder, links as what they point to; `sst dev` links each thing in it there, so the files the core adds, like a function's copied files and its links, sit beside it.
  - **Dev:** a command run in the function's folder against the Lambda runtime API, with `AWS_LAMBDA_RUNTIME_API`, `_HANDLER` and `LAMBDA_TASK_ROOT` set as Lambda sets them, and the CLI's `PATH` and `HOME`, which the tools it starts need. `$NAME` in it is expanded from what it's given, as a runtime interface client takes the handler as its argument; any other is left for a shell it starts.
  - **Watch:** globs from the folder, `../` for files outside it. The output, when it's a folder of its own, is left out.
- **The core runs a function with the runtime that built it**, not by its runtime setting again.
- **The runtime suite** (`pkg/runtime/runtimetest`), through `runtime.Collection`, as the core calls it, each runtime with a fixture in its language. It builds the fixture for a deploy, and four functions in one folder at once. It runs a dev build on a stand-in Lambda runtime API, with only what `sst dev` gives a worker, and checks its answer and that what it printed with a variable it was given reaches its logs. A file it uses rebuilds it and one it doesn't doesn't, and once the file changes, the rebuilt function answers with the change. An error in its code is reported as the function's. Node.js, Go, Python, Cloudflare's workers (built only, as `sst dev` runs them through Cloudflare) and the commands runtime run it.
- **Go's and Rust's** runtimes keep each function's folder under a lock of its own, as `sst dev` asks which functions use a file while a deploy builds one. Rust writes its binary beside the old one and renames it over, as a worker may still run the old one.

**Checked:**

- The suite for each, on this machine. Python has no build step in `sst dev`, and any Python file rebuilds every function, so its fixture has no broken build and what it doesn't use isn't Python.
- A test that a change to six functions starts three workers at once, the three invoked last, and the rest when invoked, and one that a deploy builds all six at once and starts three. The first fails without the cap.
- All Go tests, and `sst dev`'s and the runtimes' with the race detector.
- **An independent review** found no bug in `sst dev`'s change, and these, now fixed:
  - Functions in one folder ran the build command at once there, which Bundler or .NET turns down. The suite's commands fixture now takes a lock as it builds, and the at-once check fails without the fix.
  - The dev command got no `PATH` or `HOME`, as `sst dev` gives a worker none, so the tools a runtime interface client starts weren't found. The suite gave them, which hid it; it now gives only what `sst dev` does.
  - A watch glob could match the build's output, so a build could start another for ever. The output is left out, and the settings say a glob shouldn't match what else the build writes. Leaving out every file changed while a build ran was tried, and dropped: it also leaves out an edit made then.
  - In `sst dev`, a function's copied files and links weren't where its worker ran. It runs in the function's folder now, as in Lambda.
  - A handler in a folder under the code's, or one that isn't a path, as .NET's, couldn't be given. The folder setting is for that.
  - The interface's rules said a runtime could put its build elsewhere, which the core never let it; the rules say what the core does now. Cloudflare's workers aren't run by the core, and the rules say so.
  - After a deploy, the functions outside the three built one by one as each was invoked, in `sst dev`'s loop. All of them build at once again, as before; only the starts are capped.
  - Older ones in Go and Rust: their map of folders could be read while a build wrote it, and Rust rebuilt over a binary a worker may be running.
  - Smaller: a function moved to a prebuilt bundle kept running with the runtime that last built it; a variable a dev command means for a shell it starts was expanded away; `./` and `../` in a glob; an absolute output; a missing output was the runtime failing, not a build error; links in the output didn't survive a deploy's copy; the plan's Ruby example used a Bundler flag that's gone.

**Found:**

- Python flushes what a function printed after it answers, so a worker stopped as soon as it answers loses it. `sst dev` doesn't stop one then, and the suite now waits, as `sst dev` does, until the worker asks for its next invocation.
- Python reports a failed deploy build as the runtime failing, not in the build's errors, and Node.js a handler it can't find and a failed install the same way. Left as they are.
- `input.Server`, as `AWS_LAMBDA_RUNTIME_API`, is a host and port followed by the worker's path, which keys its routes. A runtime interface client that takes it as a host and port only, as Python's `awslambdaric` does to report an init error, can't do that. Its invocations work.

**Left:**

- **Rust's suite** needs `cargo`, which this machine doesn't have, so Rust's changes here aren't run.
- **`sst.runtime`** in the platform, which gives a function's build input the commands, and a function in Ruby through it deployed and run in `sst dev` in the lab, as the community packages plan asks. The lab check of this step's `sst dev` changes comes with it.

## 2026-10-31: step 3, the transport as a place to plug in

The maintainer said to go on, with the places to plug in. The transport came first: its built-in already does all four things the plan's interface asks, spread over the CLI, the program and a 4.x component, and #212's HTTP transport is the second one to draw it from.

**Done, committed (not pushed):**

- **`bridge.Transport`** (`cmd/sst/mosaic/aws/bridge/transport.go`): `Stub` (the stub's environment and the permissions its role needs), `Connect` (the CLI's side) and `Remove` (on `sst remove`). `Stub` and `Connect` each find or create what the transport needs outside the state, like the Event API: the program asks for `Stub` while `sst dev` connects, and in `sst deploy --dev` and `sst diff --dev` without it. It writes down what a connection has to do, which `bridge.Conn` never said: an event goes to whoever subscribes at the time; one may be lost, reordered or copied; an error from `Publish` means it may not have been sent, and no error doesn't mean it arrived; a new subscription may miss events for a moment, lasts as long as the connection, and comes back by itself; the largest packet arrives whole; a slow subscriber's events may be held up or lost; and calls come from many goroutines at once. An error that may pass if `sst dev` starts again wraps `bridge.ErrNotReady`, so `sst dev` tells it apart without knowing the transport.
- **AppSync behind it** (`pkg/transport/appsync.go`), as it was: the shared Event API, or the stage's own with `dev.appsync: "stage"`. `sst dev` connects through `Project.Transport()`, and `sst remove` removes through it, still looking for the stage's own Event API whatever `dev.appsync` is now.
- **The stub's settings come from the core**, through a contract call, `Dev.Stub`, made once per program. The V5 `Function` and `Task` take their stub's environment and permissions from it; they used to work them out from what `Provider.Aws.Appsync` returned. The 4.x components still call that, until step 4. Which Event APIs a stub may reach is worked out in Go now, and tested there.
- **The transport suite** (`cmd/sst/mosaic/aws/bridge/transporttest`): a transport's events, a packet as large as the bridge sends, a subscription after reconnecting, a message of many packets, twenty messages at once, and the same message with a packet lost, the packets reversed, and every packet twice, by wrapping the connection under test, as the bridge's own fakes do. A message that isn't streamed is sent again with its ID while it isn't read, as `sst dev` sends a reply, so a transport that loses an event still passes, and every read has a time limit. It also reports what a small message takes. It runs against a transport in memory in every test run, and against AppSync's real Event API with `SST_TEST_AWS_APPSYNC=1`.
- **The bridge stops reading a subscription a transport closes**, as the rules allow when its connection ends.

**Checked:**

- The suite against the lab account's shared Event API: everything passes, and a small message takes about 140 ms at the median. The first run lost one message out of ten: a new subscription on AppSync can miss events for a moment, as the stub already allows for. The suite now waits, as the stub does, until each subscription receives.
- The AppSync stub settings: the shared Event API's give any Event API, the stage's own only its own, as the 4.x components did.
- All Go tests, and the platform's 1,792 tests and `tsc`. The suite three times with the race detector.
- **An independent review** found four problems, all fixed:
  - The interface said `Ensure` runs before `Stub`, which nothing made true: in `sst dev` the program runs at the same time, and `sst deploy --dev` never connects. `Ensure` is gone, and `Stub` and `Connect` each find or create what they need.
  - The rules didn't match AppSync: it can report a publish as failed that arrived, close a subscription when its connection ends, and hold events up for a slow subscriber. Several things the bridge relies on weren't written down. The rules now say what both AppSync and #212's HTTP transport do.
  - The suite could hang until `go test`'s timeout: only a message's first packet had a time limit, and a lost packet in a message that isn't streamed was never sent again. Both are fixed, and a test that loses a packet that way now passes after one resend.
  - The suite left out reconnecting, which the plan listed. It's in now, for a transport that can reconnect on demand, as AppSync's does. A full subscriber is left out of the plan's list: the rules let a transport hold up or lose its events, and the bridge reads as they come.
  - Smaller: a transport's empty permissions reach the program as `[]`, not `null`; the AppSync error handling left in `sst dev` and `sst remove` moved into its transport; the suite passes over pings by their content, reverses a message of more than one request's worth, and closes each test's connections.
- The suite against the real Event API again, twice: all ten pass, the new reconnect test included. One run lost one small message out of ten after the subscription was receiving, which sst dev's resends of a reply cover.
- **In the lab**, the serverless group with the V5 components in `sst dev`, on a stage of its own: `sst dev` connected through the transport, the functions answered, each stub's environment had the Event API's endpoints from `Dev.Stub`, and its role reached the shared Event API. `sst diff --dev` showed no changes. `sst remove` went through the transport, and the stage was cleaned up after; nothing of it is left, and no Event API was made for it.

**Left:**

- **#212's HTTP transport**, with rogueturnip, as the plan says. Its stub reads which protocol to speak from its environment, which the transport gives; AppSync's stays the default, so stubs already deployed keep working.
- **The plan's suite also runs the stub's own loop** and `harness_test.go` over each transport. The stub's loop is in its `main` package and reads its settings as it loads, so that comes with the HTTP transport, when there are two to run.

## 2026-10-31: step 3, the program contract, version 1

The maintainer said to go on, with [the program contract](plan.md#the-program-contract) next.

**Done:**

- **How it travels is settled** ([the plan](plan.md#the-program-contract)): in each component's own outputs, as one record, `_sst`, with the contract's version in it. One resource for the app would miss a component made inside an `apply`, which registers after the program's main function returns. The RPC would leave nothing in the state for `sst tunnel`, `sst shell` or a restarted `sst dev` to read.
- **A component reports with `this.report()`** (`platform/src/components/contract.ts`, on `PartsComponent`): a function the core builds, a dev command, a task, a tunnel, a hint. Each call adds the items it gives, and it never names an output. The record goes in with the component's outputs, since Pulumi registers those once: the first `registerOutputs()` call wins, and the SDK makes one after the constructor if the component didn't. A report after that is an error that says so, and so is an item SST doesn't read. An item given as `undefined` isn't reported, so a component given nothing to report writes no record.
- **`context()`** from `sst/components` gives the app, the stage, whether it's `sst dev`, the command, the paths, the components' versions, and the version of the contract the core speaks, which `$cli` now carries as `contract`. It reads what the globals hold, so the globals stay as they are until step 4.
- **The core reads one report per component** (`pkg/project/report.go`): the record, or 4.x's output names (`_metadata`, `_dev`, `_task`, `_tunnel`, `_hint`) as the same items. A field of the wrong type is left out and the rest read, as before. A record from a newer contract than the CLI's is an error that says to upgrade.
- **The `sst dev` UI lists functions by their report**, not by `sst:aws:Function` and `sst:cloudflare:Worker`, so a package's function shows too, and it no longer panics on a function without a handler. Nothing in the CLI finds a component by its type now.
- **The V5 components report** instead of naming outputs: `Function`, `Task`, `ApiGatewayV2`, `AppSync`, `Service` and `Alb`. `_live`, which the CLI doesn't read, stays as it is.
- **Links keep `sst:sst:LinkRef`** and versions keep `sst:sst:Version`, as the plan says.
- **The takeover tests compare outputs as the core reads them**, so a V5 component that reports what its 4.x one named is the same to them. The rulebook (`platform/src/components/README.md`) says to report, not to name outputs.
- **Found on the way:** the platform's `tsconfig.json` type-checked `dist/`, the output of the last build, along with the source, so a change to a hand-written `.d.ts` failed until the next build. `dist` is excluded now; the types build has its own config.

**Checked:**

- `testdata/contract/report-v1.json` is the record both sides are held to: the platform's test (`platform/test/components/contract.test.ts`) checks a component writes exactly it, and the core's (`pkg/project/report_test.go`) checks it reads it as meant. The core's test also reads every component of the three states 4.x left in the lab, and finds each output 4.x named as the same item.
- The platform's 1,790 tests and `tsc`; all Go tests.

**In the lab** (a build of this branch; the serverless group with the V5 components, `LAB_V5=serverless`, and a component written as a package would write one, `LAB_CONTRACT=1`, deployed by `sst dev` on a stage of its own):

- The core read every report from the state: 13 functions with their handlers, the package-style component's dev command with its two links and its task, and four hints, which `sst dev` printed after the deploy. Sixteen components wrote a record, and none wrote 4.x's output names.
- The reported dev command, run as `SST_CHILD=Reporter sst dev`, got its links from `/api/env`. The functions answered through `sst dev`. `sst diff --dev` shows no changes.
- The API's custom domain failed TLS from this machine: its name still resolved to the earlier stage's endpoint, from an hour before. The API answered on its own endpoint, so it's a DNS cache, not the contract.
- `sst remove` took everything down, and the stage's state in every version and its passphrase were deleted after. The audit and a direct check find nothing of it left.

**The independent review** (a separate agent, given the code and the plan). Fixed after it:

- **Every 4.x site would have been listed as a function in `sst dev`.** `StaticSite` and the server-rendered sites name what they are as `_metadata` too, with no handler. Only a `_metadata` with a handler is a function now. The lab run had only the serverless group, so it didn't show. The test over the recorded states now carries a copy of the old reading and requires the same functions, dev commands, tasks, tunnels and hints; it fails without the fix.
- **A report could be lost** if a component that reported passed `registerOutputs()` one Output: a secret in it makes all the outputs one secret value, where the core can't find the record. That's an error now that says to pass an object.
- **The takeover comparison** read a component's old output names even when it had a record, which the core doesn't. It reads them as the core does now, so a V5 component that writes a record and an old name too is a difference.
- Smaller: `report()` refuses an item SST doesn't read, like `functions`; `function` takes an `Input` like the other items; `context()` returns a copy; `mock()` gives the app a home and the contract's version from the platform; a doc said `internal` functions aren't listed, and they are.

**Left, on purpose:**

- **The home's bootstrap data isn't in `context()` yet.** It stays the call it is (`Provider.Aws.Bootstrap`), since it's for a region and may create the bootstrap.
- **A component that extends `Component` itself, not `sst.component()`, can't report.** `linkable.ts` extends `Component` as it loads, so the contract can't be imported there. 5.0's components and packages are built with `sst.component()`.
- **A report inside an `apply`** fails or not depending on whether the outputs are registered by then. The doc says to report in the constructor.
- **4.x's tunnel needed a list of subnets** to be read; now a tunnel needs its address, user and key. 4.x's `Vpc` always gives the subnets, and the recorded state reads the same.

## 2026-10-31: step 3 started, the RPC's safety rule

The maintainer said to go on with step 3's first piece: the [safety rule](plan.md#safety-rules) for the server the CLI runs, to the design in the plan's decisions.

**Done:**

- **The server listens on `127.0.0.1` only, on a port the system picks.** It holds the port from the moment it's made, so two CLIs can't pick the same one, and the program's first call waits until the server is ready. A port the system picks also stays clear of the ports 4.x's CLI looks for, from 13557 up, so a 4.x CLI and a 5.0 one can run at the same time.
- **Every route is under a token**, made when the server starts, as the first part of the path. `SST_SERVER` and the stage's server file (`.sst/<stage>.server`) hold the address with the token. On macOS and Linux the file is readable by its owner only; on Windows it has the permissions of the app's `.sst` folder. A request without the token, or with another server's, isn't found.
- **Why the token is in the path, not a header:** Pulumi stores the code of each of SST's dynamic resources with the resource, and runs that stored code to delete or read it. Every 4.x release, and 3.x since 3.0.41, stored code that calls `SST_SERVER + "/rpc"` and sends only the path. So it carries the token as it is, and `sst remove` works on any state 4.x wrote. A token in a header would have failed every such delete. Code stored by 3.0.0 to 3.0.40 has the address fixed in it, and fails on 4.x too whenever the port differs. A deploy with 4.x stores the current code again.
- **A worker reaches only its own routes:** `AWS_LAMBDA_RUNTIME_API` is `127.0.0.1:<port>/lambda/<worker id>.<key>`, and the key is an HMAC of the worker's id with a secret of the server's. A worker doesn't get the token, and a request with no key, another worker's or the token isn't found. The worker ids come from the deployed stub's log stream, which anyone who can read the function's logs sees, so they aren't the secret.
- **Each route takes its method only:** `POST /rpc`, `POST /api/deploy`, `GET` for the rest, and the Lambda runtime API's own.
- **The TLS proxy on the port 1,000 up is gone**, as decided.
- **Only the methods the program uses are offered.** `Resource.Run` and `Resource.Aws.FunctionCodeUpdater` are gone: nothing has called them since 3.6.41 and 3.1.18. Each had only `Create` and `Update`, and the code stored in a state only deletes, reads or diffs a resource the program no longer has, which treats a missing method as nothing to do. Every other method is called by the program or by code stored in a state (`OriginAccessIdentity`'s `Delete`, for one).
- **The runtimes log a worker's id, not its address**, which held the worker's key. **An error from a request to `sst dev` leaves out its URL**, which holds the token, as errors go to the log.
- **Only `sst dev` writes the stage's server file.** Everything that reads it calls routes only `sst dev` serves. In 4.x every command wrote it, so an `sst diff` beside `sst dev` replaced it, and removed it on exit: `sst dev <command>`, `sst tunnel` and `sst secret set` in another terminal couldn't find `sst dev` after that. The file is removed on exit only if it's still this `sst dev`'s.
- **`sst secret set` says "Run `sst deploy`"** when it couldn't reach `sst dev`, as with a file left by an `sst dev` that was killed. It said nothing before.
- **The Docker bridge:** no worker runs in a container yet. The listener for it comes with the first target or runtime that runs one, #212's.

**Checked:**

- `pkg/server/server_test.go`: loopback only; the RPC answers with the token and not without it, with a wrong one or with another server's; methods; a worker's routes take its key and nothing else; the server file's mode, even over an old file anyone could read, and that another CLI's file is left alone; `Discover` finds `sst dev` through its file, and not once it has exited.
- **The code v4.23.1 stored**, taken from a recorded state and run in Node against the new server: its delete reaches the RPC with the token, and gets a 404 without it.
- The `sst dev` tests (`cmd/sst/mosaic/aws`) run against a real server now, with its keyed routes. All Go tests pass.

**In the lab** (the test build of step 2 with this on top, the serverless group on a stage of its own, deployed by `sst dev`):

- The deploy created the seven `HostedZoneLookup` resources through the RPC. `lsof` shows one listener, on `127.0.0.1`. Nothing answers on the port 1,000 up, or on the machine's network address.
- The server file is `-rw-------`. Without the token, or with a wrong one, `/rpc` and `/api/completed` aren't found. With it, `/api/completed` answers, and `GET /api/deploy` and `GET /rpc` are refused.
- The function URL, the API, and its route behind a Lambda authorizer answer, through the workers on their keyed routes. A worker's id with no key, or a wrong one, isn't found. Neither the token nor a key is in any log.
- A dev command (`SST_CHILD=Printer sst dev`, a new `DevCommand` in the lab app, on with `LAB_DEV_COMMAND=1`) found the server through its file, and got its links from `/api/env`.
- `sst secret set` from another shell made `sst dev` deploy again, through `POST /api/deploy`.
- When `sst dev` stopped, its server file was removed and the port closed.
- `sst refresh --dev` read the seven lookups with their stored code. `sst diff --dev` shows no changes.
- **Found, in 4.x:** `sst refresh` without `--dev`, on a stage `sst dev` deployed, fails on a `LinkRef` ("cannot complete a resource whose registration isn't pending"). v4.23.1 fails the same way, and both pass with `--dev`. It's not the core's; it's for step 4's look at 4.x's bugs.
- `sst remove` deleted all 150 resources, the lookups by their stored code. Then the stage's state in every version, its secret and its passphrase were deleted. A direct check finds nothing of it left: no function, log group, user pool, SES identity, certificate or DNS record.

**The independent review** (a separate agent, given the code and the plan's rule). Fixed after it:

- The server file: only `sst dev` writes it now (above). The first version kept the guard on exit but still let every command write it, so an `sst diff` beside `sst dev` still hid it.
- `FunctionCodeUpdater` removed, and the Go copy of `SST_BUILD_CONCURRENCY_SITE`, which only the platform reads.
- An error from a request to `sst dev` held its URL, and so the token, in the log.
- The server's logs say `service=server` throughout.

Checked again with the final code, on an app with the local home and only a dev command, so no cloud: `sst dev` writes the file, a dev command finds it, an `sst diff` beside it leaves the file alone, `sst secret set` reaches `sst dev`, the file goes when `sst dev` stops, and with a file left behind `secret set` says to deploy. The app's files were deleted after.

**The Console's local connection, removed** (the maintainer's call, after the review). With `/socket` under the token and the TLS proxy gone, the SST Console couldn't reach `sst dev`, so `/socket` and `sst cert` had no user, and `sst cert` still installed a trusted root certificate. Both are gone, with `mkcert`'s download, and the docs page's "Local logs" section and its note on personal stages. What they did, and what bringing them back takes, is in [reference.md](reference.md#the-consoles-local-connection-removed).

**Left, on purpose:**

- A redirect from the server's router (a path missing its last slash, as `/debug/pprof`) leaves the token out, so it isn't found. The URL in `SST_PPROF`'s note has the slash.
- On Windows, the server file can't be replaced while another process has it open; the old one stays, and the error is logged.
- The dev tests' server doesn't wait for its handlers when a test ends, as `httptest` did. The race detector finds nothing.
- `cmd/sst/mosaic/multiplexer/tcell-term` has a data race under `-race`, on v4.23.1 too. It isn't touched here.

## 2026-10-31: steps 1 and 2 started

The maintainer approved the plan and asked for step 2, with step 1's recordings alongside it in the lab.

### Step 2: the core's state and lock behind `Home`

**Done, committed (not pushed):**

- **`Home` is a store of bytes** (`pkg/project/provider/home.go`): `Get`, `Put` (with `IfAbsent`), `Remove`, `List`, and the passphrase. A home whose store keeps versions (`VersionedHome`, the AWS home) also removes versions. The lock, the secrets' encryption, and the history (cleanup, prune, purge, the stages list) are written once, in `state.go`, on top of it. They were written three times before, once in each home.
- **The lock is a conditional write.** The AWS home writes it with `If-None-Match: *`, so S3 refuses the second of two writes. The local home creates the file with `O_EXCL`. Between 4.x and 5.0, the race stays what it was: 4.x reads, then writes.
- **A stage that was deployed, but whose state the home can't find, isn't deployed again.** A snapshot, or an update that deployed without errors, is the sign that it was deployed. A passphrase isn't one: `sst diff` (in 4.x) and `sst secret set` create it before a first deploy. An update alone isn't one either: a first deploy can fail before it writes any state. `SST_ALLOW_MISSING_STATE=true` lets a deploy go ahead anyway. This refines [goal 4](goals.md#4-the-home-stays-compatible), which said "a passphrase or update history".
- **`sst diff` writes nothing.** In 4.x it created the stage's passphrase if there was none. Now a stage with none gets one for the run only, since it has no state or secrets to decrypt.
- **A second CLI that creates the passphrase at the same moment uses the first one's**, rather than failing. SSM may not return a parameter just written, so it's read again a few times.
- **The preview fix for 4.x's `functionBuilder`** (`platform/src/components/aws/helpers/function-builder.ts`). In a preview, the function is created from what was passed, not after the values inside it are known. A deploy runs the code it always did. A test runs it as a preview, which the mock can now do (`preview` in `MockInput`): without the fix the function isn't in the preview at all. The Lambda inside it still waits on its zip and log group, which a mock preview has no ids for. In a diff of a deployed stage they come from the state.
- **A diff-only build:** `-X main.diffOnly=true` refuses every command but `sst diff`, `sst version` and help.

**Found and fixed on the way:**

- **Gzipped state writes couldn't be retried.** With `state.compress`, the body sent to S3 couldn't be rewound, so a write S3 asked the SDK to retry failed with "request stream is not seekable". 4.x has the same bug. Found by the home suite against a real bucket.
- **The AWS home listed the stages of other apps** whose names start with the app's, since it listed `app/<app>` without the slash. It only showed one if that app had a stage of the same name with resources.
- **The local and Cloudflare homes kept event logs and snapshots after a remove that left nothing.** The AWS home removed them. All three remove them now.

**Kept as it is:**

- **The Cloudflare home's lock is a read, then a write.** It talks to R2 through Cloudflare's API, which takes no conditional headers. R2's S3 API takes `If-None-Match`, so the home could move to it. That's for when step 4 reaches Cloudflare, with a Cloudflare lab account.
- **On Windows, the Cloudflare home's keys hold backslashes**, since they're joined with `filepath.Join`. Changing that would lose those stages' state.
- **Purge leaves the lock's old versions**, as 4.x does: it runs while the remove still holds the lock.

**Checked:**

- The home suite (`home_suite_test.go`), against the local home, a versioned home in memory, and a real S3 bucket and SSM, gzipped and not: ten CLIs racing for the lock, one wins; a held lock is reported; force unlock records the update; state round trips byte for byte; the passphrase stays the same, and a second CLI uses the first's; secrets round trip and aren't stored in the clear; prune keeps the newest history; cleanup; purge leaves nothing but the lock's versions; the stages list; deploy history. The run against S3 left nothing behind.
- `go build ./...`, `go vet` on the changed packages, the platform's `tsc` and its 1,784 tests.

**The test copy.** `v5-rewrite` doesn't have v4.23.1's `Router` fixes, so a diff from a build of it would show `Router` changes that aren't the core's. The test build for step 2 is v4.23.1 with the core's changes and the preview fix on top: the 4.x components unchanged, as the plan says.

**In the lab, on the stage step 1 recorded:**

- `sst diff` from the new core shows the same changes as v4.23.1's own `sst diff`: the same 21 resources and the same fields, and no change to a provider. Those 21 are the server-rendered sites (below). The one field that differs is `environment._` on the sites' build commands, which is the path of the CLI that ran.
- **The lock holds both ways.** While the new core deployed, v4.23.1 and a second new core were refused ("concurrent update"). While v4.23.1 deployed, the new core and a second v4.23.1 were refused. Each holder finished.
- **After a deploy by the new core,** v4.23.1's `sst diff` shows only the sites' 21 resources. The passphrase is still at its first version, so no second one was made. The home holds only what 4.x writes: the state, and an update, a snapshot and an event log for each deploy, and no lock left.
- **The guard for a missing state:** with the stage's state hidden behind a delete marker, a deploy by the new core is refused with its message, creates nothing and leaves no lock. Removing the marker brings the same version back.
- **Secrets:** each CLI reads a secret the other set.
- **The diff-only build** refuses `sst deploy` and `sst secret set`, and its `sst diff` shows the same 21 resources.

**Also done:**

- **What the core gives the program is pinned** (`pkg/project/program.go`, `program_test.go`): `$app`, `$cli` and `$dev`; the environment item by item (the user's, the providers', the secrets with the stage's over the fallback's, Pulumi's settings, `SST_SERVER`); the globals (each provider by its alias, and `sst`) and the platform's modules; and the provider settings Pulumi gets as `--config`. The test says so where today's behavior is a bug: a provider setting that's a boolean or a number is dropped. They were built inside `Run`; they're functions now, so the program contract in step 3 can be checked against them.
- **A data race in `Run`:** the stage's and the fallback secrets were read in parallel into one shared `err`. Each has its own now.
- **The recorded state is read through the homes in a test** (`recorded_state_test.go`): it round trips byte for byte through the local and the in-memory home, its stage is listed, and a state alone isn't taken for deploy history. A second test fails if a recorded state holds an account id, a home directory, an access key or a secret's ciphertext.

**The independent review** (a separate agent read the change against the old code, home by home). Fixed after it:

- **The diff-only build handed commands to a local `node_modules/.bin/sst`** before its own check, as every release build does. In an app with `sst` installed, the pre-release would have run the app's own 4.x CLI. It never hands off now. Its message says what's true: it doesn't deploy, and it doesn't write the app's state (a region with no bootstrap is still bootstrapped, and `sst diff --dev` can still create the account's AppSync Event API, as in 4.x).
- **The Cloudflare home could store an empty object** when Cloudflare rate-limited a write: the client sent the same reader again on the retry, and it was empty by then. 4.x has the same bug. It sends bytes now. Tested against a fake R2 API that answers the first write with a 429.
- **A deleted state bucket gave a raw S3 error on the lock**, not the hint that says how to recreate it. The lock is the first write now, and a write or a delete that finds no bucket maps to the hint.
- **The guard for a missing state:** a stage whose newest finished update is a remove isn't treated as deployed, so deleting a removed stage's leftover state doesn't block deploying it again. An update that can't be read is skipped. A purge removes the history before the state, so a purge that stops partway can't leave a stage the guard refuses.
- **A lock write whose response was lost** is retried by the SDK and finds the lock. If that lock is the CLI's own, it's taken, not reported as a concurrent update.
- **The preview fix applies only when a value isn't known yet.** Otherwise a preview builds the function from the values, as before, so a transform sees the same args in a preview and a deploy. Tested both ways.
- **Tests added:** each home's exact keys, spelled out; the Cloudflare home, through the whole suite against the fake API; the recorded states read from a file laid out as 4.x left it, not only written and read back by the new code; the gzipped body can rewind.
- **The fixtures:** the lab's hosted zone id and the app's folder are scrubbed too. The scrub test also looks for account ids outside ARNs, any home folder but `/home/user`, and records in another zone.
- **Merged:** the two loops over S3 versions, the two places that remove with or without versions, and where the passphrase key lives. The new files log with `log/slog`, as the homes do.

**Left from the review, on purpose:**

- `cmd/sst/diffonly_test.go` is matched by `.gitignore` (the `sst` line), so it needs `git add -f` when it's committed.
- An S3-compatible store, like LocalStack's, may refuse `If-None-Match` instead of ignoring it. That's for when a target is built, in step 3.
- The guard in `Run` is checked in the lab, not by a unit test.
- The core passes `context.TODO()` to the homes; contexts are threaded through with the program contract. A local purge leaves empty folders.

### Step 1: a record of today's state

- **The lab app has every Core component but the VPC group's now.** Added: a `Router` with `Nextjs` at its root and `Astro`, `SvelteKit` and a `StaticSite` on paths, a `StaticSite` with its own CDN, a `Bus` and an `Email` with a domain sender, and a NAT and a bastion on the `Vpc`.
- **Recorded: the serverless group and the sites, with v4.23.1.** 323 resources, 29 types of SST component. Every site, the API and the function URL answer. Scrubbed, it's `testdata/states/v4.23.1/serverless-sites.json`; `testdata/states/README.md` says what the scrub changes.
- **The server-rendered sites never settle on 4.x.** `Nextjs`, `Astro` and `SvelteKit` build again on every diff, and the build's files have new hashes each time: the build command, the code zips, the asset files, the functions and the invalidation all show as changing. Everything else shows no changes. For these sites, the baseline is 4.x's own diff: the new core has to show the same resources changing, in the same fields. Step 1's exit, "`sst diff` shows no changes", holds for everything else.
- The first deploy stopped partway, because the app's `sst` package (4.17.2) didn't match the CLI (4.23.1). The second, with the package at 4.23.1, finished what the first had started.
- **A recorded state is the object the home stored, not `sst state export`.** The export prints only the inner checkpoint (`{stack, latest}`); the home stores Pulumi's versioned file (`{"version": 3, "checkpoint": …}`), and the CLI can't read the export back as a state. The fixture is the snapshot 4.x wrote at the end of the deploy, from the versioned bucket.
- **A recorded state can be replayed.** With the app removed, the recorded state put back as the stage's state, and `sst diff` run again, the preview shows the same 21 changes as the live diff did. It needs the account's credentials and the stage's passphrase: the home is in AWS, and the program looks things up in AWS during a preview. So CI with no AWS can read a recorded state, but not replay one.
- **Removed and cleaned up:** the stage, then its state in every version, its sourcemaps and its passphrase. A direct check finds nothing of it left.
- **Recorded: the VPC groups, with v4.23.1** (`vpc-containers-databases.json`). A `Vpc` with managed NAT and a bastion, `Cluster`, `Service`, `Alb`, `Task`, `CronV2`, `Efs`, a function in the VPC, `Postgres` with a proxy, `Mysql`, `Redis`, `Aurora` and `Dsql`: 178 resources, 14 types of SST component. Each database's link reaches the function, the file system counts visits, and the services answer.
- **The `Vpc`'s bastion doesn't settle on 4.x.** Its AMI is looked up as the newest `al2023-ami-20*` for arm64, and Amazon released three of those in the same second (kernels 6.1, 6.12 and 6.18). The lookup can return any of them, so a diff or a deploy can replace the bastion, and the `Vpc`'s link changes with it. The bastion holds no data, but a replace gives it a new instance, which breaks `sst tunnel` until it's run again. The 5.0 `Vpc` looks it up so that only one AMI matches. Everything else in the group settles.
- **Recorded: the serverless group as `sst dev` deploys it** (`serverless-dev.json`): 163 resources, every function a dev stub (`bootstrap` on `provided.al2023`, described "live"). `sst diff --dev` shows no changes, from v4.23.1 and from the new core.
- **The new core on these stages:** its `sst diff` lists the same changes as v4.23.1's on the VPC stage (the bastion) and none on the dev stage. After it deployed the VPC stage, v4.23.1's diff shows only the bastion again, so 4.x reads what it wrote, the databases' secrets included.
- The lab app's config takes `LAB_ONLY=<groups>`, to deploy some groups to a stage of their own.
- **Every stage removed, and the account cleaned up.** After the removes: each stage's state in every version, its sourcemaps and its passphrase, the RDS proxy's log group, the inactive task definitions and the build cache image were deleted. The lab audit finds nothing of the app; what the tagging API still lists was checked one by one and is gone. Cloud Map namespaces named `sst` in the account belong to other apps and were left alone.
- **Step 1's exit:** every Core component of [v5-core-set.md](../v5-core-set.md) is in a recording (`Cdn` as the router's and the standalone site's). The VPC group's bastion and the server-rendered sites don't settle on 4.x, as above; everything else does. Left: one Cloudflare app, when step 4 reaches the Cloudflare components.
