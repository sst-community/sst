# The 5.0 rewrite

**Approved, 2026-10-31.** On the branch `v5-rewrite`, from `v5`. What's settled is under [Decisions](#decisions); the rest is open to change. What's been done is in [progress.md](progress.md).

Three files:

- **This plan:** the goal, the decisions, the design, and the steps with their exit tests.
- **[goals.md](goals.md):** what 5.0 holds to, how each goal is checked, and where it stands. Every change on `v5-rewrite` is held to them.
- **[reference.md](reference.md):** SST as it is, read from the code for this plan: what v5 taught, today's home and program, the `sst dev` path, SST's provider resources, linking, and #212.

It builds on two plans on the branch `v5-community-packages`, not on `v5` yet: [v5-community-packages.md](../v5-community-packages.md), and the draft [v5-core-set.md](../v5-core-set.md), which sorts the components into tiers by how much they're used. The links work once that branch is merged.

## Goal

v5 set out to make one thing easier, in the maintainer's words: "basically allowing an easier way to build custom components for both sst authors and external users that can be packages." It's a proof of concept, and so far the idea holds: SST's own components and an app's are built the same way, with `sst.component()`, and a component can be shared as a package ([what v5 taught](reference.md#what-v5-taught)).

5.0 is "a major rewrite to mature the product":

- **One set of new components**, built the v5 way, in place of the 4.x ones.
- **A core with designed contracts:** [the program contract](#the-program-contract) between the core and the Pulumi program, and typed [places to plug in](#places-to-plug-in) for homes, runtimes, the `sst dev` transport, emulator targets and checks. SST's built-ins sit behind them, in Go.
- **One checked step** to [move an app](#moving-an-app) across.

A [package](#packages) extends SST with components, checks, and target and runtime settings that the core carries out.

The one hard rule: "as long as the state file works the same way, at the end of the day that's really the most important because it dictates what's created and removed." [goals.md](goals.md) says what that means and how it's checked, and every step is gated on it. Breaking changes elsewhere are allowed.

**Why now.** [#212](https://github.com/sst-community/sst/pull/212) by rogueturnip adds `sst dev --floci`, local AWS emulation: 6,500 lines across 69 files. It had to touch the core almost everywhere, because SST has nowhere to plug such a thing in ([#212, mapped](reference.md#pr-212-mapped)). In 5.0, Floci, LocalStack and the like are packages: a target the core runs, and a check.

## Not goals

- **Replacing Pulumi.** The state is a Pulumi checkpoint, and Pulumi decides what's created and removed. 5.0 keeps Pulumi as its engine and its state format.
- **Running 4.x components.** An app stays on 4.x until every component it uses has a 5.0 form, then moves in one step.
- **Going back.** Moving an app back to 4.x after it has moved is best effort, as it is for v5 ([v5-goals.md](../v5-goals.md#not-goals)).
- **Rewriting what already does its job.** SST's built-ins (the homes, the runtimes, the AppSync transport), the event bus, the UI and the code that drives Pulumi move behind the new interfaces, in Go.
- **A host for package code, and permission grants.** Neither is in 5.0 ([Places to plug in](#places-to-plug-in), [Safety rules](#safety-rules)).
- **Changes on `main`.** What 5.0 needs is done on `v5-rewrite`.
- **New clouds.** A GCP home or an Azure target can come later.
- **Merging SST's releases.** 5.0's code won't match SST's. SST has mostly gone quiet (one commit on its `dev` branch in the 90 days to 2026-10-22, per [v5-core-set.md](../v5-core-set.md)), and a fix from it is ported by hand.

## Decisions

Change one only on purpose, and record it here with its date.

| Date | Decision |
| --- | --- |
| 2026-10-31 | **The rewrite is 5.0**, called "the 5.0 rewrite" for now, on the branch `v5-rewrite`, from `v5`. v5's alphas were its proof of concept, so users move once, not twice. |
| 2026-10-31 | **The v5 alphas stop.** New components start from the V5 ones where that helps. |
| 2026-10-31 | **4.x on `main` keeps going alongside**, as the line an app stays on until it moves. Nothing for the rewrite is done on `main`. |
| 2026-10-31 | **5.0 doesn't run 4.x components**, which keeps 4.x's shims out of the core. An app moves in one step ([Moving an app](#moving-an-app)). |
| 2026-10-31 | **Breaking changes are allowed** within [goals.md](goals.md): nothing that holds data is lost, and every change has a way across ([Breaking changes](#breaking-changes)). |
| 2026-10-31 | **A clean break from 4.x code.** No 5.0 component imports a 4.x file or builds on its types. Only identity carries over ([Components](#components)). |
| 2026-10-31 | **State maps are how a component changes from now on**, with a version for each component, in place of `registerVersion` and `forceUpgrade` ([State maps](#state-maps)). |
| 2026-10-31 | **The core and the program talk through one designed contract** ([The program contract](#the-program-contract)). |
| 2026-10-31 | **No host for package code in 5.0.** The places to plug in are Go interfaces, and SST's built-ins stay in Go behind them. A host comes in a 5.x release, when a package needs to run code in the CLI ([why](reference.md#why-theres-no-host-in-50)). |
| 2026-10-31 | **No permission grants.** Packages are trusted like any other dependency, and the core keeps the rules that need no grant ([Safety rules](#safety-rules)). |
| 2026-10-31 | **What a package builds on is a public API**, changed only in a major version, with an API report in CI ([Packages](#packages)). |
| 2026-10-31 | **Package code is TypeScript, for now.** Other languages may come later. |
| 2026-10-31 | **The RPC the program calls back into is redone in 5.0**, not fixed separately on `main` ([Safety rules](#safety-rules)). |
| 2026-10-31 | **The RPC's design:** loopback and a token for every route, the Lambda runtime routes keyed by a worker id nobody can guess, the Docker bridge only while a worker runs in a container, and no TLS proxy ([Safety rules](#safety-rules)). |
| 2026-10-31 | **The Console's local connection goes:** `sst dev` serves no `/socket`, and `sst cert` is gone. With the RPC's design, the SST Console can't reach `sst dev`, so it can't show local logs or see that `sst dev` is running ([what it did, and how to bring it back](reference.md#the-consoles-local-connection-removed)). |
| 2026-10-31 | **Cloudflare is in scope:** its home, its runtime, `sst dev` for workers, and its most used components, after the AWS ones. A Cloudflare account is used as a lab, like the AWS one. |
| 2026-10-31 | **5.0.0 ships with the Pulumi and provider versions of the 4.x it's built from**, so a move changes nothing it doesn't have to. A bump comes in a later release. |
| 2026-10-31 | **Step 2's result is released as a pre-release that only runs `sst diff`**, so real apps check the new core, not only the lab. |
| 2026-10-31 | **As few lab apps as cover the cases.** Nothing stays deployed: an app is removed and cleaned up after each check, unless it's checked again shortly after. |
| 2026-10-31 | **The Floci package is owned outside the core**, probably by rogueturnip, who wrote #212. |
| 2026-11-01 | **A check's finding stops a deploy before anything changes.** On a stage whose program has checks, the core deploys with Pulumi's preview first, and a finding in it fails the run, so a deploy never half-applies. Such a stage pays one more run of the program per deploy; one without checks pays nothing. |
| 2026-11-01 | **A target is a plain object of the type `Target`, not one `sst.target()` makes.** An app names it in `app()`, which is read before the platform is loaded, so nothing of `sst/components` runs there. A package imports the type with `import type`, and the core checks the settings. |
| 2026-11-01 | **`sst` installs what its SDK's types use**, like `@types/aws-lambda`, as dependencies, so code that imports `sst` type-checks without `skipLibCheck`. |
| 2026-11-01 | **A target's container has two commands, and stops on its own.** `sst target stop` stops it and keeps its data. `sst target reset` removes it, its data and the state of every stage on it, after asking. `sst remove` stops it once no stage of any app has anything deployed on it, and keeps its data: nothing uses it, and it may hold this machine's Docker socket. |
| 2026-11-01 | **What has nothing in the cloud behind it needs no place in a state map.** A component, a wrapper or a provider may leave the state or be created in a move without being listed, as [goal 3](goals.md#3-what-moves-is-mapped) already allows it to leave. Anything else a move creates, deletes or replaces is listed in the map, or `sst migrate --check` fails. |
| 2026-11-01 | **What a component creates is decided only from what a preview knows**: plain args, lookups whose inputs are known, and the code and config on disk. A value only known mid-deploy, like another resource's output or a link's value, is only ever passed in as an input. So a 5.0 component never creates a resource inside an `apply`, and `sst diff` and `sst migrate --check` see everything it creates. Where a build decides the shape (a function's source maps, a site's servers), a preview that doesn't know the build's inputs learns the shape from a build without them, and the deploy checks the real build has the same shape. Checked against Pulumi's own guidance and an inventory of the 69 places today's components create something inside an `apply`; none needs a value only known mid-deploy ([progress](progress.md#2026-11-01-step-4-started-sst-migrate---check)). A resource an app's own config creates inside an `apply` is the one thing it can't reach, and the docs say to create resources directly. |
| 2026-11-01 | **A site builds once per deploy.** A deploy builds a site with the real values of its links and environment, and creates the site's parts from what that build says. A preview that doesn't know one of those values builds without it, only to learn the parts. The two agree as long as a framework's config doesn't read a link's value, which the docs rule out. For sites, this replaces the deploy's check that the real build has the same shape as the preview's: checking would take a second build on every deploy. A function's build doesn't read its links, so it's built once either way. |
| 2026-11-01 | **The V5 `Router` drops inline routes**, the 4.x `routes` arg, which 4.x already marks deprecated. It routes with `route()`, `routeBucket()` and a site's `router` arg. A stage whose router has inline routes switches to `route()` on 4.x first, then moves; `sst migrate --check` fails on it and says so. |
| 2026-11-01 | **SST's own provider resources do their work in a provider the `sst` binary serves.** The CLI points Pulumi at its own binary from the work folder's `Pulumi.yaml`, so the provider is always the CLI's version, and Pulumi runs it as it runs any provider, for every operation. It gets a stage's setup as every process Pulumi starts does: the credentials and region the core resolved, and a target's endpoint, from the environment the core gives Pulumi, never from its config, which the state keeps. A resource's methods leave the RPC when it moves, so code in the program can't call them. The code 4.x stored with the old entries calls them only to delete or read one, which a moved stage never does: the move releases them. Forwarding each call back to the CLI was weighed and left: a detour with the same result, undone later. |
| 2026-11-01 | **A move releases by marking what the maps release as retained, then deploying.** Under the lock, after the copy is saved, the core sets `retainOnDelete` on each entry a map releases, which has to exist with the type the map names, and Pulumi takes it out of the state without calling its delete; the move's preview shows `delete [retain]`. It's the one edit a move makes to the state; aliases carry everything that moves. It works for any resource, so a later map can release one whose type or provider changes, and an old entry stays in the state until the deploy that creates what takes its place succeeds, so a move that fails can be run again. Answering the old delete in the CLI (only SST's own resources, only while their old code calls it) and deleting the entries from the state first (untracked after a failed deploy) were weighed and left. |
| 2026-11-01 | **The marker and the refusal come with releasing.** Only a move releases, so a plain deploy that switched a stage's components would delete what the move keeps, like a site's files, right after the new resources wrote them again. So [the move's](#the-move) marker is built in step 4: `sst:sst:Moved` in the state, which lists the components the stage has in their 5.0 form, a first form of [each component's version](#state-maps). The core refuses `sst deploy` and `sst dev` on a stage that has something deployed and no marker; `sst migrate` deploys it, and `sst diff`, `sst refresh` and `sst remove` still run on it, until step 5 takes away the RPC methods 4.x's code calls. A run on a stage that has moved, or a new one, leaves the marker before the app's program runs, so a deploy that fails partway keeps it, and a remove that doesn't finish puts it back. A move leaves it once the program has run, listing every component with a 5.0 form but those the stage kept in SST 4's form. A component counts as moved when the marker lists it or the stage has none of it. SST 4's form of one that counts as moved is refused, and outside a move, so is the 5.0 form of one the stage still has in SST 4's form, so a component that gains a 5.0 form after a stage moved is switched by a move too. A move switches all of a component at once, so no type is left in both forms for a plain deploy to switch back. One inside another of SST's components moves with that one. Refusing only a deploy whose program would release something was weighed and left: the program learns that only partway through, after other resources have changed. |
| 2026-11-01 | **A move holds the stage's lock from its check to its end, always saves its copy, and deploys with a preview first.** So what it deploys is what it checked, any move can be undone from its copy, not only one that releases, and it never stops after marking the state to run again with a preview. |
| 2026-11-01 | **SST's provider uses the AWS credentials the CLI resolved until they expire, then makes its own the way the CLI made them**, from the profile, the region and the roles to assume, which the core gives it in the environment, so they refresh in a deploy or an `sst dev` that outlasts them, and nothing is asked for twice, like a code from an MFA device. On a target's stage it uses the target's. This refines how the provider gets a stage's setup, above: still from the environment, never from its config. |
| 2026-11-01 | **What any deploy changes isn't the move's doing.** A file uploaded under a key that follows from what's in it, like a function's code and its source maps, is replaced whenever the file changes: a server-rendered site's build changes it on every deploy, and a code change since the last deploy does too. `sst migrate --check` lets that replace through without a map, when the object's key changed in nothing but its hash; a key that changes in anything else, as when a map renames a function, still needs the map. It's judged from the preview alone, so it holds for a 4.x component a move keeps, for a 5.0 one in a later move, and for an app's own objects. |
| 2026-11-01 | **DNS adapters for 5.0.** `sst.aws.dns()`, `sst.cloudflare.dns()` and `sst.vercel.dns()` also give the adapter SST 5's components take (`DnsAdapter`, which a package can write too): it creates records directly and names them only from plain values, as 4.x named them, so a switch keeps them. A record whose name in DNS is only known once something is deployed, like a certificate's validation record, is named after a plain `key`, and the component's map gives its old address (`delegated`, for what something creates on a component's behalf). A zone is found with a function, not a resource: Route 53's by SST's provider (`sst:aws:getHostedZone`, listed once a run, a public zone over a private one of the same name, two alike refused rather than guessed between), Cloudflare's by Cloudflare's provider (the longest zone the domain ends with). A move releases SST 4's lookups. The adapters' 4.x methods go with the 4.x components. |
| 2026-11-02 | **A component's deprecated args go in its 5.0 form**, refused with what to write wherever ignoring one would change what's deployed, and ignored where it changes nothing. Each is in [the breaking changes so far](#breaking-changes-so-far). |
| 2026-11-02 | **A component tells `sst dev` about a command of its own, and creates no `DevCommand` for it.** An app's own commands get the 5.0 `DevCommand`, `sst.x.v5.DevCommand`: SST 4's args less the internal `aws`, with `dev.command` required, since SST 4's ran nothing without one (a line in the guide: give it its command, or remove it). It reports what `sst dev` runs in `sst dev` alone, so a deploy no longer keeps it, with its environment, in the state. It has no takeover map while SST 4's components still create SST 4's `DevCommand`, so a new stage doesn't refuse that one. |
| 2026-10-31 | **Releasing 5.0 next to 4.x** (npm's tags, the docs site) is worked out near the release. |
| 2026-10-31 | **No timeline.** Getting it right matters more than when. |

## The design

### The core

A Go binary, as today. It owns what must hold for every app:

- Loading the config, and running the Pulumi program through [the program contract](#the-program-contract).
- The deploy loop: preview, deploy, remove, refresh and `sst diff`.
- State and locks. A home stores them; the core decides when the lock is taken and released, and when state is read and written.
- The event bus (`pkg/bus`) and the UI (`cmd/sst/mosaic`).
- The [places to plug in](#places-to-plug-in), with SST's built-ins behind them and a test suite for each.
- The [safety rules](#safety-rules).
- [Moving an app](#moving-an-app): `sst migrate`, the state maps, the marker and the tombstone.

### The program contract

How the core and the Pulumi program talk. Today it's whatever grew: globals going in, and output names the CLI looks for and calls back to the CLI in the middle of a deploy coming out. Nothing declares any of it, so a component type with two parts crashed the CLI after a deploy, and a component the CLI doesn't know by name half works ([today's program](reference.md#todays-program)).

In 5.0 it's designed, typed and versioned:

- **In: a context.** A component reads the app, the stage, whether it's `sst dev`, the paths, the home's bootstrap data and its own version in the state from `sst/components`, not from globals. `sst.config.ts` keeps `$app`, `$dev` and the rest as conveniences that read the same context.
- **Out: one declared channel** for what the core needs from a component: each function to build and to run in `sst dev`, dev commands, tasks, tunnels, the shape of what it links, and hints. It's part of the component contract, so the core reads SST's components and a package's the same way. How it travels, as one SST resource's outputs or over the RPC, is settled in step 3.
- **Calls into the core are the contract's own methods**, such as building a function, over the RPC, under the [safety rules](#safety-rules).
- **Versioned.** The core says which version it speaks, and a package's peer dependency on `sst` covers it.

**How it travels, settled in step 3:** in each component's own outputs, as one record the framework writes, `_sst`, with the contract's version in it. A component calls `this.report(...)` in its constructor, and never names an output.

- **Not one resource for the app.** A component made inside an `apply` registers after the program's main function returns, so a resource made at the end would miss it.
- **Not over the RPC.** `sst tunnel`, `sst shell` and a restarted `sst dev` read what was reported from the state, with no deploy running. And the state keeps each record with its component, so a deploy that fails partway leaves the records of what it didn't reach as they were.
- **Once per component.** Pulumi registers a component's outputs once: the first call wins, and the SDK makes one after the constructor if the component didn't. So the record goes in with that call, and a report after it is an error, not lost without a word.
- **Links keep `sst:sst:LinkRef`**, since a linkable resource that isn't a component can't hold a record. **Versions keep `sst:sst:Version`** until [state maps](#state-maps) replace them in step 4.
- Until step 4, the core also reads 4.x's output names, for the 4.x components still on this branch.

### Places to plug in

Each is a typed, versioned interface in the core, drawn from what two implementations need: the built-in, and the first outside one (Floci for a target, a runtime made of commands for a runtime). The built-in is fitted to the interface, not the other way round. Python rebuilds every function when shared code changes, so the core starts again at once only the workers of the few functions invoked last, whatever the runtime, and no runtime has to say how it starts.

| Kind | What it provides | Built-in today | Who provides one in 5.0 |
| --- | --- | --- | --- |
| `component` | resources, as parts | the components | SST, apps and packages |
| `check` | validation, in the program and of the preview | none | SST, apps and packages |
| `target` | where cloud calls go | the real cloud | SST, and packages as settings the core carries out |
| `runtime` | build, run in `sst dev`, which files to watch | node, python, go, rust, worker (`pkg/runtime/`) | SST, and packages as commands ([v5-community-packages.md](../v5-community-packages.md) step 4) |
| `home` | where state, locks and secrets are stored, and bootstrap | aws, cloudflare, local (`pkg/project/provider/`) | SST |
| `transport` | how a deployed stub reaches `sst dev` | AppSync | SST: AppSync, and #212's HTTP |
| `command` | an `sst <x>` subcommand | none | Waits for a host |

In the core, the shape and not the final API:

```go
// SST's built-ins implement these, and each passes its kind's suite.

// Stores bytes by key. The core does the lock, the encryption and the history.
type Home interface {
	Bootstrap(ctx context.Context) error
	Get(ctx context.Context, key Key) ([]byte, error)
	Put(ctx context.Context, key Key, data []byte, opts PutOptions) error // IfAbsent, for the lock
	Remove(ctx context.Context, key Key) error
	List(ctx context.Context, prefix Key) ([]Key, error)
	Passphrase(ctx context.Context, app, stage string) (string, error)
	CreatePassphrase(ctx context.Context, app, stage, value string) error // never overwrites
}

// Builds a function, and in sst dev runs it against the Lambda runtime API. Built in:
// node, python, go, rust, worker, and Commands, a runtime made of commands.
type Runtime interface {
	Match(runtime string) bool
	Build(ctx context.Context, input *BuildInput) (*BuildOutput, error)
	Run(ctx context.Context, input *RunInput) (Worker, error) // in sst dev, against the CLI's runtime API
	ShouldRebuild(functionID, path string) bool
}

// How the stub in the cloud reaches sst dev.
type Transport interface {
	Stub(ctx context.Context) (*StubSettings, error) // the stub's environment and permissions
	Connect(ctx context.Context) (bridge.Conn, error)
	Remove(ctx context.Context) error // on sst remove
}

// Where the providers send their calls.
type Target interface {
	Providers(ctx context.Context) ProviderSettings // endpoints, region, credentials
	Env(ctx context.Context) map[string]string      // for the program, the workers and sst shell
	Home() Home                                     // a target's stages never use the real home
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
}
```

What a package writes:

```ts
// A target: settings, which the core carries out. A plain object, as app() is
// read before the platform is loaded.
export const floci: Target = {
  name: "floci",
  endpoint: "http://127.0.0.1:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  providers: { aws: { s3UsePathStyle: true } },
  container: { image: "floci/floci:2.3.0", ports: [4566], dockerSocket: true }, // the core says so when it starts it
};

// A runtime: commands, as v5-community-packages.md step 4 plans. The dev command is the
// language's runtime interface client, run against sst dev's Lambda runtime API.
// Its watch globs leave out what the build writes, here vendor/.
export const ruby = sst.runtime({
  build: { command: "bundle install", output: "." },
  dev: { command: "bundle exec aws_lambda_ric $_HANDLER" },
  watch: ["*.rb", "lib/**/*.rb", "Gemfile.lock"],
});

// A check: runs in the program
export const allowlist = sst.check({
  resource(r) {}, // r.type, r.name, r.props, r.component
  invoke(i) {}, // i.token, i.args
});
```

An app names a stage's target in `app()`, as `targets: { local: floci }`, and a function's runtime in its args.

- **A package gives settings, not CLI code.** A target or a runtime from a package is settings, and a check runs in the program, so nothing from a package runs in the CLI. `app()` already reaches the core as JSON, and a function's build input already reaches it through the RPC, so neither needs anything new to get there.
- **No host in 5.0.** When a package needs to run code in the CLI (a home for another cloud, a command), a host comes in a 5.x release: a JavaScript runtime in its own process, talking to the core over a versioned protocol. Node or Deno is decided then ([why, and what else was weighed](reference.md#why-theres-no-host-in-50)).
- **A home only stores bytes.** The lock, the secrets' encryption and the history are the core's, as they are today, so a home can't change the layout, the lock or the encryption, and [goal 4](goals.md#4-the-home-stays-compatible) holds for every home. The AWS home's other duties, resolving credentials, giving the program its bootstrap data and pruning old object versions, stay in it, in Go.
- **A runtime only builds and runs.** The shared work stays in the core, as `runtime.Collection` does it now: bundles, copied files, and the links encrypted into `resource.enc`. The types of what's linked stay the app's, not a runtime's: a site's frontend or a Rails app reads its links too, and isn't a function, so the core makes them for the app's languages (`pkg/types`).
- **The stub stays in the core.** The deployed stub (`platform/functions/bridge/`) is a Go binary, so it starts fast in any Lambda runtime. It speaks a fixed set of wire protocols, AppSync Events and #212's token-authenticated HTTP, and a transport picks one and gives it its endpoint and permissions.
- **A transport only delivers packets.** The interface writes down what `bridge.Conn` never said: what a transport does about order, copies, loss, a channel with no subscriber, and closing. The bridge keeps doing the rest: packets, order, copies, and asking again for what's lost ([the `sst dev` path](reference.md#the-sst-dev-path)). `Stub` and `Connect` each find or create what a transport needs outside the state, like the AppSync Event API, as the program can ask for the stub's settings before `sst dev` connects, or without it, in `sst deploy --dev`. `Remove` removes it.
- **Checks build on what's there.** `--policy` already passes a Pulumi policy pack to the deploy, and the [policies experiment](../policies-experiment.md) built rules into one, each finding named by its component and part. #212's allowlist used Pulumi's transforms instead, which also see invokes. A check takes both, and the policies experiment's rules package becomes a check package.
- **A check sees a component's args through SST, not Pulumi.** `Component` passes `{}` to Pulumi, so a Pulumi transform sees no args, and passing them would record every component's args in the state, secrets included. So the core gives a check the args from SST's own hook (`ComponentTransforms` in `component.ts` today), and a resource's inputs from Pulumi's `registerResourceTransform`.

**Each has a test suite.** SST's built-ins pass it first, and a package's target or runtime runs it in its own CI.

- **home:** two clients race for the lock and one wins. A stale lock is reported. A checkpoint round trip is byte for byte. The passphrase stays the same. A home that finds no state for a stage with history refuses. Built-in homes also read a recorded state 4.x wrote.
- **runtime:** builds a fixture function, which then answers on a fake runtime API, and what it prints is in its logs. A change to a file it uses rebuilds it, and one to a file it doesn't, doesn't. An error in its code is reported as the function's, not the runtime's.
- **transport:** one set of behaviors run against any transport: loss, reordering, copies, reconnecting, large payloads, many invocations at once, and the time it adds. A full subscriber isn't one: a transport may hold up or lose its events, and the bridge reads as they come. Today's fakes in the `bridge` package and `harness_test.go` become wrappers around the transport under test, and the stub's own loop is run too.
- **target:** on its stage, the program, the workers and `sst shell` have none of the developer's `AWS_*` variables and can't read a planted credentials file. Every provider endpoint is the target's: a run behind a proxy that fails any other host passes. Its stage can't reach the real home.
- **check:** findings on fixture programs. An unknown value in a preview is reported, not dropped.

### Components

- **Built the v5 way.** `sst.component(type, parts)`, with `transform`, `existing` and `nodes` for every part, tested with `mock()`, and their docs written from the parts. The rulebook (`platform/src/components/README.md`) carries over.
- **A clean break from 4.x code.** A 5.0 component owns its args, types and docs, and imports nothing from a 4.x file. A test checks that, as `v5-components.test.ts` checks v5's rules today. The V5 components lean on 4.x ([how](reference.md#how-the-v5-components-lean-on-4x)); what's taken from them is the design, not those ties. What's kept from 4.x is identity: the names resources have (`named()`), and the state maps, which live apart.
- **The component contract.** What the core reads from a component is declared through [the program contract](#the-program-contract): its functions, dev commands, tasks, tunnels, the shape of what it links, and hints.
- **A version for each.** Its state map from 4.x is its first; a later change that moves resources ships a map of its own ([State maps](#state-maps)).
- **Which ones.** The Core tier of [v5-core-set.md](../v5-core-set.md), then Cloudflare's most used (`Worker`, `Bucket`, `Kv`, `Astro`), after the AWS ones. Each Kept and Community component gets a decision before 5.0: ported, left to a package, or dropped with what to use instead. The draft still keeps the Cloudflare components as 4.x, and has to be brought in line.
- **SST's own provider resources move into the `sst` binary**, if releasing and adopting them passes step 4's gate. The 15 resources made with `rpc.Provider` (`BucketFiles`, `KvKeys`, `WorkerScript`, a CloudFront invalidation and the rest) do their work in Go already; Node is only the way there. In the binary, the Node process Pulumi starts for them goes, their code leaves the state, they get a real diff, and the RPC shrinks to what the program needs. Each moves according to what it does ([one by one](reference.md#ssts-provider-resources)). If the gate doesn't pass, they stay as they are for 5.0.
- **Zipping and hashing move to Go only if they're slow.** The zips and hashes are inputs in the state, so moving them uploads every function's code once more and runs one invalidation per site ([what runs in Node](reference.md#what-runs-in-node)).

### Packages

A package can provide components, checks, and target and runtime settings. Writing one:

- **Typed:** `sst/components`, with the `Target` type, `sst.runtime` and `sst.check` beside `sst.component`.
- **Tested without the cloud:** `mock()` for components and checks, and each kind's suite for targets and runtimes.
- **Published on npm**, found by keyword, as [v5-community-packages.md](../v5-community-packages.md) step 3 plans.
- **Loaded with SST as the host.** A package imports `sst/components` and its providers by name, and the bundler maps them to the app's `.sst/platform`, so there's one copy of each, as v5 does (`pkg/js/js.go`, `pkg/project/run.go`).
- **Version-checked on deploy:** each package's peers on `sst` and on providers, against the CLI and the app (`pkg/project/packages.go`).
- **Documented from the source.**
- **Easy to set up.** A package shouldn't need `moduleResolution: "bundler"`, `skipLibCheck` or a pinned `google-protobuf`, and a group shouldn't pull in every provider. Each is fixed in step 3, or the reason it can't be is written down.
- **A template to copy:** `examples/component-package/` (on `v5-community-packages`), kept working with each change, and a template for a target package beside it.

**A public API, held still.** What a package builds on changes only in a major version: `sst/components` and its groups (`sst/components/aws` and the rest), the program contract, and the `Target` type, `sst.runtime` and `sst.check`. Adding to it is fine; removing an export, or changing what one accepts, waits for a major. A report of the API for each entry point is checked in, made with [API Extractor](https://api-extractor.com/) as [v5-community-packages.md](../v5-community-packages.md) step 2 plans, so a pull request shows each change and CI fails on one nobody meant ([goal 8](goals.md#8-what-a-package-builds-on-holds-still-within-5x)). So 5.0's breaking changes happen once, at 5.0.

**Trusted like any other dependency.** A package's components run in the Pulumi program with the deploy's credentials, and npm runs its install scripts. 5.0 makes no promise to contain a package. It promises the [safety rules](#safety-rules) hold for every app.

### Linking

How code reads a linked resource stays: `Resource.MyBucket.name`. The types and the format change ([what goes wrong today](reference.md#linking-today)):

1. **Types come from the components, not from deployed values.** A component declares the shape of what it links, through the program contract, and the generator writes `MyBucket: Linked<"sst.aws.Bucket">`. Types are there after `sst install`, with no deploy, they're exact, and nothing a deploy or a remove does can empty them.
2. **Each package gets only its own links:** what's linked to the functions and sites in it. A package with no links gets no file. Naming a resource that isn't linked fails the type check, in the right place.
3. **The link format is written down, as the shapes every SDK already reads:** the encrypted file with `SST_KEY` and `SST_KEY_FILE` for a deployed function, and `SST_RESOURCE_<Name>` for a process on the developer's machine. SST's JavaScript, Python, Go and Rust SDKs all read both today, so there's one format and no second one to keep ([goal 5](goals.md#5-deployed-code-keeps-working)). The spec says whether `SST_RESOURCES_JSON`, which only the JavaScript SDK reads, stays. Any other language reads it in a few lines, and each runtime writes its language's types through `Runtime.Types`.
4. **The fork publishes its own readers** for Python, Go and Rust, from the same spec, so they don't depend on SST's releases.

Not taken:

- **Types for each function.** They'd need a wrapper around every handler, which changes how every handler is written. Packages get most of the benefit.
- **Reading values at run time**, from SSM say. Slower cold starts, more permissions, and a new way to fail. Values stay baked in when a function deploys.
- **Types in `node_modules`**, as Prisma did for years. Prisma now asks for an output folder in the project, after `node_modules` broke under pnpm and in monorepos.

### Safety rules

The rules that hold for every app live in the core, where nothing a package does can weaken them. They need no grants:

- **Listeners are the core's, on loopback, with a token.** That includes the RPC the program calls back into (`pkg/server`), which also offers only the methods the program uses, and the routes `sst dev`'s own processes call. Two cases need more:
  - **The Lambda runtime API that workers call** (`/lambda/<worker>/…`) can't take a token in a header, since AWS's runtime clients send none. Its routes are keyed by a worker id nobody can guess.
  - **A worker in a container** reaches the core through the Docker bridge, which is listened on only while such a worker runs.

  The TLS proxy the dev server ran on the next port up, for a browser page, goes.

  The token is the first part of the path, not a header: `SST_SERVER` is the address with the token, and every route is under it. Pulumi stores the code of each of SST's dynamic resources with the resource, and runs that code, not the program's, to delete or read it. That code calls `SST_SERVER + "/rpc"`, so it carries the token as it is.
- **Nothing secret is kept in plain text in the state.** A command a component runs gets its environment when it runs, not as an input Pulumi stores.
- **Containers are started by the core**, with their ports on `127.0.0.1` only. A target that needs the Docker socket says so in its settings, and the core says so when it starts it.
- **On a target's stage, nothing gets the developer's credentials.** The program, the workers in `sst dev` and `sst shell` get the target's. The developer's `AWS_*` variables, profile files and proxies are taken out, as #212's `FlociEnvironment` does.
- **A stage that uses a target is bound to it in the config**, and to the target's own home. `sst remove --stage local` finds the target in the config, not in a flag or an environment variable, so forgetting one can't remove the real stage.
- **A home that finds no state for a stage with history is refused** ([goal 4](goals.md#4-the-home-stays-compatible)).

They close each of #212's review findings in the core, not by each package getting it right:

| Found in #212's review | Prevented by |
| --- | --- |
| Floci 2.3.0's web console is on by default, on every interface, with no login. | Containers publish ports on loopback only. |
| The bridge listened on `0.0.0.0`. | Listeners are the core's, on loopback, with a token. |
| A local `sst remove` needed an env prefix, so forgetting it would remove the real AWS stage. | A target's stage is bound to its target and home in the config. |
| The Docker-socket trust wasn't documented for users. | The target's settings say it needs the socket, and the core says so when it starts it. |
| The allowlist was pinned to Floci 2.3.0 and AWS provider 7.48.0, and a 35-minute Docker CI ran on most PRs. | The allowlist ships in the Floci package, which pins and tests what it supports in its own CI. |

### Moving an app

#### State maps

v5's takeover maps (`platform/src/components/takeover.ts`, and the rulebook's "Taking over what 4.x deployed") say which old resource each new part takes over, and turn that into Pulumi aliases. 5.0 makes them a general tool:

- **A map is data**, shipped with the component: for each part, the old addresses it can take over (`moved`), whether it's new (`added`), what changes for the user when a move replaces it (`replaced`), and what it takes the place of (`released`). What a move updates in place isn't listed; the check shows it. A component, a wrapper or a provider has nothing in the cloud behind it, so it may leave the state or be created without being listed.
- **The core applies it, not the component.** The core turns a map into aliases while a stage moves, and stops once the stage has. A component's code never carries its old layout.
- **Release, for what can't move.** A resource whose type or provider changes can't be carried to a new address; Pulumi would replace it. Where deleting the old one would remove something in the cloud, the map releases it: the move takes it out of the state without calling its delete, and the new resource writes the same thing again, or adopts it by its id.
- **`sst migrate --check` reads the same map.** It runs Pulumi's preview of the move, in which each component tells the core what its map says about each part it creates, and it sorts every step of the preview (`pkg/move`). It passes only with what [goals 1 to 3](goals.md) allow: no create, delete or replace the map doesn't list, and nothing that holds data deleted, replaced or emptied, whatever the map says. It shows what's kept, what's at a new address, and what updates in place. Under the mock, v5's takeover check (`test/helpers/graph.ts`), which compares addresses, inputs, deploy options, outputs, function builds and teardown order, stays the test of each component's map, against the recorded states too.
- **Maps are how a component changes from now on.** Each component has a version. A change that moves its resources ships a map from the version before, and `sst migrate` applies it, checked the same way. That replaces 4.x's `registerVersion` and `forceUpgrade` (in `Vpc`, `Cluster`, `Postgres`, `Redis` and `Auth`), which stop a deploy until the user renames the component to its old version, as `Cluster.v1`, or forces the upgrade. So a component can be restructured in a 5.x release, safely, without waiting for a major.

Aliases, rather than editing the state file directly, because they're how Pulumi itself carries a resource to a new address, the preview shows exactly what they do, and v5 has run them in AWS: on 2026-10-01, 73 resources kept their ids under new names ([the report](../v5-aws-test-2026-10-01.md)).

#### Recorded states

The first AWS run found three bugs that every test under the mock had passed ([the report](../v5-aws-test-2026-10-01.md#what-it-found)). The mock compares a 4.x component it ran itself with the V5 one, and never sees what 4.x really deployed. So step 1 records real states, and every later check runs against them:

- **In the repo, scrubbed.** An exported state has account ids and ARNs, and the repo is public. The account id, and anything else a scrub list names, is replaced with a fixed fake value before a state is committed, and a test fails when something that looks like an account id is left. The raw exports stay with the maintainers.
- **The takeover suites run against them.** With a recorded state, the "before" side is what AWS really had. The "after" side is still the mock, which is why step 4 also deploys.
- **A preview can replay one.** A preview reads the state, not the cloud, so a recorded state may be previewed again without the app deployed, as long as the app looks nothing up in AWS. Step 1 checks whether that holds. If it does, most re-checks need no deploy, and no 45-minute database teardown.

#### The move

`sst migrate --stage <stage>` takes the lock, saves a copy of the state in the home, deploys with the maps, releases what they release, and leaves two things behind:

- **A marker in the state,** which tells 5.0 the stage has moved. 5.0 refuses to deploy a stage that hasn't: on it, only `sst migrate`, `sst diff` and commands that only read run.
- **A tombstone,** a lock at the old key, for good. 5.0 locks under a new key from then on. Every CLI since v3.0.43 refuses to deploy, remove or refresh a locked stage, so a 4.x CLI deploying an old branch's config can't delete what moved. Its message says to run `sst unlock`, which deletes the tombstone, so it stops CI, not a person who unlocks. The migration guide says plainly not to.

#### The user's path

1. **Stay on 4.x until every component you use has a 5.0 form.** The migration guide lists them.
2. **Upgrade the CLI.**
3. **Rewrite the config.** `sst migrate --codemod` makes the changes that are mechanical: `sst.aws.v5.X` to `sst.aws.X`, renamed args, and each [breaking change](#breaking-changes) that has a rule. It lists what it couldn't do.
4. **Check.** `sst migrate --check --stage dev`.
5. **Move.** `sst migrate --stage dev`.
6. **Confirm.** `sst diff` shows nothing to create or destroy.

Stage by stage, a dev stage first and production last. A stage deployed by `sst dev` has stubs in place of functions, so `--check` covers that shape too. If a move goes wrong, the saved copy can be restored with the 4.x CLI before any other deploy; the guide says how, and step 5 tests it.

### Breaking changes

Allowed in args, defaults, names and how a component is built. The limit is [goals.md](goals.md): nothing that holds data is lost, any other replacement is listed in the state map and the migration guide, and each change has a codemod rule where it's mechanical and a line in the guide where it isn't ([goal 7](goals.md#7-every-breaking-change-has-a-way-across)).

Two lists to decide from, item by item, in step 4. Each decision goes in [Decisions](#decisions).

- **SST's own list for its next major** ([anomalyco/sst#6588](https://github.com/anomalyco/sst/issues/6588)):
  - `CronV2` becomes `Cron`, and the old `Cron` goes.
  - `watch.include` in place of a list for `watch`, and `cron.target` in place of `cron.job`.
  - `state.store` in place of `home`.
  - Longer default timeouts, and `state.purge` on by default.
  - Plain booleans in place of `Input<boolean>`, so nothing is created inside `.apply` (v5's `plain()` already does this).
  - Title case for the SDK's exports (`Workflow.start`, `Task.run`).
  - Required `package` and `version` for providers in the config.
  - Dropped: `backend`, `removalPolicy`, the config's `version` field, drop-in mode, and the custom Cloudflare Wrangler variable.
  - Required `version`, `instance` or `runtime`. A database's `version` and `Function`'s `runtime` were kept optional on 2026-10-14 ([v5-components.md](../v5-components.md#decisions)).
- **v5's own** ([v5-sharing.md](../v5-sharing.md), "Breaking changes"): re-exporting a global by name, a provider's module used while `app()` loads, and a provider version from another major.

#### Breaking changes so far

Every breaking change of the components built the 5.0 way, with its way across: a **codemod** rule where it's mechanical, a line in the **guide** where it isn't, and where `sst migrate --check` refuses a stage until it's dealt with, **check**. Each component's "Switch from" section on its docs page has the detail. A port adds its rows when it lands. Neither the codemod nor the guide exists yet ([step 5](#5-moving-an-app)).

| Date | Component | What changes | Way across |
| --- | --- | --- | --- |
| 2026-11-01 | Every one | An arg that decides what's created, or that a build reads, is a plain value, not an output. Each component's docs say which. | Guide: work the value out in the config. A deploy names the arg and says why. |
| 2026-11-01 | Every one | `nodes` holds the resources themselves, not outputs of them, and has every part. | Guide: drop the `.apply()` around a `nodes` entry. |
| 2026-11-01 | Every one | An object in `transform` is merged into the defaults, nested objects included. 4.x replaced a nested object whole. | Guide: to replace one, use a function. |
| 2026-11-01 | `Vpc`, `Bucket`, `Dynamo`, `Task`, `Redis` | A `transform` function is given outputs where 4.x gave plain values. Each component's docs list which. | Guide: decide inside an `apply`, or from the config. |
| 2026-11-01 | `Vpc`, `Cluster`, `Efs` | A 4.x component that takes one of these takes only the 4.x one. | Guide: switch what takes it first, or along with it. The codemod switches them together. |
| 2026-11-01 | `Vpc`, `Cluster`, `Redis` | `.v1` has no 5.0 form. | Guide: move to the 4.x component's current version first. |
| 2026-11-01 | `Vpc` | Parts in each AZ are in `nodes` by the AZ's number, named in the singular: `Object.values(vpc.nodes.privateSubnet)` for `vpc.nodes.privateSubnets`. | Codemod, for the lists 4.x had. |
| 2026-11-01 | `Vpc` | With `nat: "ec2"` and `bastion`, the first NAT instance is the bastion, so `nodes.bastionInstance` and `nodes.bastionSecurityGroup` are `undefined`. A `Vpc` from `get` has no subnets, route tables or NATs in `nodes`. | Guide. |
| 2026-11-01 | `Vpc` | The bastion runs the newest Amazon Linux 2023 image with the default kernel, so a switch can replace it once, and a deploy role needs `ssm:GetParameter` on Amazon's public image parameter. | Guide. |
| 2026-11-01 | `Function` | `role` becomes `existing.role`, `logging.logGroup` becomes `existing.logGroup`, `live: false` becomes `dev: false`, and `url.route` becomes `url.router`. The 4.x forms still work. | Codemod, inside a subscriber's function args too. |
| 2026-11-01 | `Function` | An object in `transform.function.environment.variables` adds to the variables, where 4.x's replaced them. | Guide. |
| 2026-11-01 | `Function` | The alias behind a durable function's URL is created with the function's `provider`, so with a `url` and a `provider` it's replaced on switch, the URL with it. | Check refuses it. Guide: remove the `url` and deploy before switching, then add it back. |
| 2026-11-01 | `Router` | `routes` is gone: `route()` and `routeBucket()`, switched to on 4.x first ([decision](#decisions)). | Check refuses it. Guide. |
| 2026-11-01 | `Router` | `invalidation`, which 4.x never used, is gone. | Codemod: remove it. |
| 2026-11-01 | `Router` | A 4.x `Function` that links the router and is routed to with `route()` waits on its own route, and is never deployed. | Guide: switch it with the router, or serve it with its own `url.router`. |
| 2026-11-01 | `Nextjs` | `route` and `cdn` are gone: serve the site through a `Router` with `router`. | Guide. |
| 2026-11-01 | `Nextjs` | `nodes.server` is by region, each an output. `nodes.revalidationQueue` and `nodes.revalidationTable` are outputs, `undefined` without ISR, and the revalidation function is the queue's `nodes.subscriber`. | Guide. |
| 2026-11-01 | `Nextjs` | `transform.revalidationEventsSubscriber` becomes the queue's `transform.subscriber`. In `sst dev` the function is `transform.devServer`. | Codemod for the first. Guide. |
| 2026-11-01 | `Nextjs` | The site is built in the deploy, and in `sst diff`, with values that aren't known yet left out. A build that checks its environment has to allow for that. `assets.textEncoding` is applied, where 4.x wrote `UTF-8`. | Guide. |
| 2026-11-01 | `Cdn`, and what has a domain | `domain.dns` takes SST 5's adapters (`sst.aws.dns()` and the others). An object written for SST 4's doesn't work. | Guide. |
| 2026-11-01 | `Cdn` | One with `domain.redirects` and a provider of its own can't switch yet. | Check refuses it. |
| 2026-11-02 | `Bucket`, `Queue`, `SnsTopic`, `Dynamo`, `Bus`, `CronV2` | A function they're given can't be a handler or a function's args in an output. Only a function or its ARN can be. Its args are typed as the 5.0 `Function`'s. | Guide. |
| 2026-11-02 | `Queue`, `SnsTopic`, `Dynamo`, `Bus` | A subscriber is created with the component's provider. One whose component takes its provider from a parent or `providers`, or a queue subscribed to a topic or bus with a provider, is replaced on switch. | Check refuses it. Guide: remove the subscriber and deploy before switching, then add it back. |
| 2026-11-02 | `Queue`, `SnsTopic`, `Dynamo`, `Bus` | `subscribe` and `subscribeQueue` return the component. What they created is in its `nodes` by the subscriber's name, and its `transform` is the component's. `subscribe` takes no `opts`. | Guide. |
| 2026-11-02 | `Queue`, `SnsTopic`, `Dynamo`, `Bus` | The static `subscribe` and `subscribeQueue`, which took an ARN, become `get(name, id).subscribe(...)`. | Codemod where the ARN is written in the config. Guide. |
| 2026-11-02 | `SnsTopic`, `Dynamo` | Every subscriber has a name. One without is refused. | Guide: remove it and deploy before switching, then add it back with a name. |
| 2026-11-02 | `Bucket` | `transform.publicAccessBlock: false` becomes `publicAccessBlock: false`, `public: true` becomes `access: "public"`, and `notify`'s `transform` becomes `transform.notification`. | Codemod. |
| 2026-11-02 | `Bucket` | `subscribe`, `subscribeQueue` and `subscribeTopic` are gone: `notify`. | Guide. |
| 2026-11-02 | `Bucket` | `subscribeEventBridge` is a method of the bucket, or of `get`. With the bucket's `provider`, what it created is replaced on switch. `get` gives its options to the component, so with a `provider` its notifications are replaced. | Check refuses it. Guide: remove them and deploy before switching, then add them back. |
| 2026-11-02 | `CronV2` | The deprecated `job` is gone: `function`, and `nodes.function` for `nodes.job`. | Codemod. |
| 2026-11-02 | `Cluster` | The deprecated `addService` and `addTask` are gone: create the service or task with `cluster`, and the cluster's `provider`. | Codemod. |
| 2026-11-02 | `Cluster` | The deprecated `vpc.serviceSubnets` becomes `vpc.containerSubnets`, and is refused with what to write. `forceUpgrade` is ignored. | Codemod: rename the one, remove the other. |
| 2026-11-02 | `Task` | `taskRole` and `executionRole` become `existing.taskRole` and `existing.executionRole`, and are refused with what to write. | Codemod. |
| 2026-11-02 | `Efs` | Mount targets are kept by AZ, so giving the VPC another way, a `Vpc` in place of its ids or the other way around, makes them again, which EFS refuses while the old ones are there. | Guide: keep giving the VPC the same way. |
| 2026-11-02 | `Redis` | The deprecated `nodes` becomes `cluster.nodes` where neither `cluster` nor `serverless` is set, and goes where one is, since 4.x ignored it there. It's refused with what to write. | Codemod. |
| 2026-11-02 | `DevCommand` | `dev.command` is required. 4.x took one without it, and ran nothing. | Guide: give it its command, or remove it. |

## Steps

Each step has an exit test. A step that fails its test stops the plan until it's thought through again.

### 0. Write down what v5 taught

In [reference.md](reference.md#what-v5-taught).

**Exit:** the maintainer has read it and nothing is missing.

### 1. A record of today's state, from real deploys

Deploy as few apps as cover the cases, with the latest 4.x (v4.23.1 now), and export their states:

- **The v5 lab app**, with what it lacks added: a `Vpc` with NAT and a bastion, a `Router`, and a `Nextjs` site behind it. Its groups are deployed one at a time.
- **The same app's serverless group, deployed by `sst dev`**, for `Function`'s dev stubs.
- **One Cloudflare app:** a `Worker`, a `Bucket`, a `Kv` and an `Astro` site. It can wait until step 4 reaches the Cloudflare components.

Every Core component of [v5-core-set.md](../v5-core-set.md) has to be in one of them. One that isn't is added to the lab app, not given an app of its own.

For each: deploy, call what's deployed, check `sst diff` shows no changes (an app that doesn't settle on 4.x can't be a baseline), export the state, scrub it, commit the scrubbed copy. The server-rendered sites never settle on 4.x: they build again on every diff, with new hashes. For them, the baseline is 4.x's own diff, and the new core has to show the same resources changing, in the same fields. Then try replaying a preview from it with the app removed.

**Nothing stays deployed.** An app is removed as soon as it's recorded, unless the next check that needs it comes shortly after. After every removal, the lab audit runs, and anything SST left behind for the app is deleted and checked gone. A later step that needs a live stage deploys it again.

**Exit:** every app deployed, settled and recorded. The scrubbed states are in the repo with the scrub test. Everything is removed, and the lab audit shows nothing left. We know whether a recorded state can be replayed.

### 2. The first proof that it's viable

Today's CLI, with its homes behind the new `Home` interface, reads an existing home, takes the lock, and previews an unchanged 4.x app with zero diff. If that works, the rest is building.

- **The state and lock code moves behind `Home`**, in Go, plus the conditional put for the lock and the guard for a home that finds no state.
- **The 4.x components run unchanged, as a test of the core.** 5.0 doesn't ship them. Here they keep the core's changes apart from the components', so a diff points at one or the other.
- **That test copy gets 4.x's preview fix.** Without it, an app with a 4.x function built inside an `apply` can't show zero diff ([goal 6](goals.md#6-sst-diff-shows-what-the-deploy-will-do)). The fix changes only the preview, not what's deployed.
- **A pre-release that only runs `sst diff`,** so real apps check the core, not only the lab. `diff` takes no lock and writes no state.

**Exit:**

- `sst diff` from the new core shows no changes for every recorded app, deployed again or replayed, as step 1 found: for a server-rendered site, the same changes 4.x's own diff shows. Not even the provider entries, since the platform is the same.
- [Goal 4](goals.md#4-the-home-stays-compatible)'s checks pass, apart from the tombstone.
- After a deploy by the new core, the 4.x CLI's `sst diff` shows no changes.
- What the new core gives the program matches [today's](reference.md#todays-program), item by item, with a test for each that can have one.
- The diff-only pre-release is out, and no app that ran it shows a change the lab can't explain.

### 3. The program contract, places to plug in, and Floci

- **[The program contract](#the-program-contract), first.**
- **[The places to plug in](#places-to-plug-in), in Go**, each drawn from the built-in and the first outside one, with SST's built-ins fitted behind them: the three homes, the five runtimes, the AppSync transport, and the real cloud as a target. A suite for each, which the built-ins pass.
- **The `Target` type, `sst.runtime` and `sst.check`** for packages, and a stage's target in `app()`.
- **The [safety rules](#safety-rules)**, the RPC's included.
- **Package setup fixed:** `bundler`, `skipLibCheck`, the protobuf pin, and a group that pulls in every provider.
- **#212 on them**, with rogueturnip:
  - into the core: its HTTP transport behind `bridge.Conn`, its client that only reaches one endpoint, its environment stripping, and its fix for `true`/`false` and number provider settings ([what's reused](reference.md#pr-212-mapped));
  - into a Floci package, in a repo of its own: its target settings, and its allowlist as a check, written for the V5 versions of the four components it covers (`Function`, `Bucket`, `Dynamo`, `Queue`), not the 4.x ones.

**Exit:**

- The built-ins pass their suites, and a deploy still shows no diff, as in step 2.
- A component written against the program contract reports its functions, dev commands and tasks without naming an output, under `mock()` and in a deploy.
- A Floci stage runs an app in `sst dev` and can't reach the real stage or home. Each of #212's review findings is closed by a core rule. The Floci package passes the target suite in its own CI.

### 4. New components

[Components](#components) says how each is built. In order:

- **`sst migrate --check` first.** It's the gate for every component.
- **The hard ones next, as a gate:** `Function` with its dev stubs, `Nextjs` with `Router`, and `Vpc`, and releasing and adopting `BucketFiles` and `KvKeys`. If a component can't move without losing data, or without a replace its map can't justify, stop: that answers a viability question the wrong way, and the design changes before anything else is built. If the release doesn't pass cleanly, SST's provider resources stay as they are for 5.0.
- **Then the rest of Core, then Cloudflare's**, each with a clean break, a version, and the [breaking changes](#breaking-changes) decided for it.
- **SST's own provider resources move into the `sst` binary**, if the gate passed, alongside the components that create them.
- **Zipping and hashing are timed** on a large site, and moved to Go only if they're slow.
- **An entry point for each component, if it's worth its API.** A group's declarations need every provider its components' parts are typed with, so a package's repo installs them all ([why](progress.md#2026-11-01-step-3-the-package-setup)). With 5.0's components each importing only what they use, `sst/components/aws/function` and the like would need only theirs. Decided with the first components.
- **Packages move with them.** The Floci package follows the new components. The template package moves, so authors always have a working one to copy. Packages built on the v5 alphas, `packages/aws-saas` among them, move to 5.0's API, and the migration guide has a section for package authors.

**Exit, for each component:** its state map passes `--check` against every recorded state it's in. Then a real deploy in the lab, compared by cloud id, keeps every resource ([goals 1 to 3](goals.md)).

**Exit, for packages:** the template builds and tests against the branch in CI, as it does on `v5-community-packages` now, and the API reports match what's promised ([goal 8](goals.md#8-what-a-package-builds-on-holds-still-within-5x)).

**Exit, for the provider resources:** after the move, the site serves the same files, the router has the same routes and the worker runs the same script, and the old entries have left the state without a delete.

### 5. Moving an app

- **Each Kept and Community component of [v5-core-set.md](../v5-core-set.md) gets a decision first:** ported, left to a package, or dropped with what to use instead.
- **The codemod, `sst migrate` for a whole app, the marker and the tombstone**, and the refusal on a stage that hasn't moved ([Moving an app](#moving-an-app)).
- **A migration guide** that lists which components have a 5.0 form and each breaking change, and says plainly not to run `sst unlock` on a stage that has moved.
- **The codemod moves the 196 examples**, which are also its best test.
- **The core stops running 4.x components**, and what it kept for them goes: their globals, the output names, and the RPC methods only they call.
- **Releasing 5.0 next to 4.x**, worked out near the release: npm's tags (`release.yml` publishes any tag without a suffix as `latest`, so a 4.x release after 5.0.0 would take `latest` back) and the docs site (built from `main` today).

**Exit:** every recorded app goes through [the user's path](#the-users-path) in the lab: codemod, check, move, and `sst diff` shows nothing to create or destroy. Compared by cloud id, every resource is kept, and data written before is read after. A 4.x CLI is refused on a moved stage. The saved copy is restored with the 4.x CLI once, and works. Then the same for an app in daily use, on a stage of its own. When this passes, `v5-rewrite` is merged into `v5`, and 5.0.0 can be released from there.

### 6. After 5.0

- **More targets and runtimes as packages**, when someone needs them: LocalStack, Ruby, .NET.
- **A host for package code**, in a 5.x release, when a package needs to run code in the CLI.
- **SST's provider resources into the `sst` binary**, if they didn't make 5.0.

Each comes when it's needed, with its own exit test.

## Viability questions

| Question | How it's answered |
| --- | --- |
| Can a new core drive existing state with zero diff? | Step 2: every recorded app shows no changes, the lock holds both ways, 4.x reads what the new core wrote, and real apps run the diff-only pre-release. |
| Can the worst components be restructured with a verified state map: `Function` with its dev stubs, `Nextjs` with `Router`, `Vpc`? | Step 4 does these three first. Each passes `--check` against the recorded states, then a real deploy compared by cloud id. `Vpc` is the one to watch: most of its resources are named by a `Name` tag, so a renamed part means a tag update, which is allowed, and nothing else. |
| Can a package plug in without running code in the CLI? | Step 3: Floci, as a target's settings and a check, with the core doing the rest. |
| Can the fork's maintainers carry it? | Below. |

**Carrying it with a small team.** Their time is small, so the plan leans on machines for safety and on scope for size:

- **The recorded states and `--check` turn "did we break anyone's state" into a test.** A pull request that changes a component runs its state map against real recorded states in CI, with no AWS. Nobody has to remember what 4.x deployed.
- **The lab runs once per step and per release**, not per pull request.
- **No component is kept in two copies.** 5.0 has only the new ones, and 4.x stays on `main`.
- **Fewer moving parts.** No host, no protocol and no grants in 5.0, and the built-ins stay the Go that works today.
- **Packages move work out.** Floci and whatever comes after it are kept up by the people who need them, in their own repos, with their own CI.
- **Each step stands alone.** Steps 1 and 2 are useful even if the rest waits: the recorded states and the diff-only pre-release test the core against real apps.

## Risks

- **The rewrite never ships.** Each step has an exit test and a result that's useful on its own. Step 2 is small on purpose.
- **Apps wait for components.** An app that uses a component with no 5.0 form stays on 4.x. Step 5 decides each one before 5.0.
- **Breaking changes add up.** Each is small, but together they make moving harder. Each has a codemod rule where it can, and the codemod runs on the 196 examples before anyone else's app.
- **A person can still unlock a moved stage.** The tombstone stops a 4.x CLI in CI, but its message says to run `sst unlock`. The guide says plainly not to.
- **The mock misses real bugs.** Recorded states fix the "before" side. The "after" side still needs a lab deploy for each component and each release.
- **A release leaves something behind.** A released resource is no longer tracked. If the new one doesn't take over exactly what the old one wrote (the same files, the same keys), the rest stays in the cloud. Each provider resource's tests check that it does.
- **Provider versions move.** 5.0.0 ships with the versions of the 4.x it's built from, so a move changes no provider. A later bump changes the default provider's address, which `sst diff` shows as the provider being replaced, and a docker-build update can rebuild every image once (see `MAINTAINING.md`). Release notes say so.
- **Pulumi changes underneath.** 5.0 pins Pulumi as 4.x does. Pulumi's own checkpoint format is outside this plan's control. A Pulumi bump is tested as `MAINTAINING.md` says.
- **Packages aren't contained.** The safety rules hold for every app, but a package runs with the deploy's credentials. The docs say so: install packages you trust.
- **Scrubbing misses something.** The scrub test looks for account ids, and a maintainer reads each scrubbed state before it's committed.
- **SST's fixes stop arriving for free.** 5.0's components don't match SST's files, so a fix from SST is ported by hand. SST is mostly quiet now, so there's little to port.
- **The program contract or the places to plug in turn out wrong.** SST's own components and built-ins go on them first, and Floci in step 3, before anyone else builds on them. They're versioned so a second version can follow.

## Open questions

1. **How long does `main` get fixes after 5.0.0?** Users stay on 4.x until their components have a 5.0 form, so they need to know. Proposed: a date set when 5.0.0 is released, at least six months out, in its release notes.
2. **What happens to each Kept and Community component?** Ported, left to a package, or dropped with what to use instead. Settled in [v5-core-set.md](../v5-core-set.md) before step 5.

## Status

| Step | Status |
| --- | --- |
| The plan | Approved, 2026-10-31. |
| 0. What v5 taught | Written in [reference.md](reference.md#what-v5-taught), 2026-10-31. |
| 1. A record of today's state | Started, 2026-10-31. Recorded with v4.23.1 and in `testdata/states/`: the serverless group and the sites, the VPC groups, and the serverless group by `sst dev`. A recorded state replays with AWS credentials and the passphrase, not without. Everything removed, and the audit is clean. Left: Cloudflare (at step 4). |
| 2. The first proof | Started, 2026-10-31, committed (not pushed). Done: `Home` as a store of bytes, the conditional lock, the guard for a missing state, `sst diff` that writes nothing, the preview fix, the diff-only build, and the program's input pinned by tests. Checked against every recording: the same diff as 4.x, the lock both ways, no second passphrase, 4.x's diff after a deploy by the new core. Reviewed, and the review's findings fixed. Left: the pre-release, which needs the maintainer. |
| 3. The program contract, places to plug in, and Floci | Started, 2026-10-31, committed (not pushed). Done: the RPC's safety rule (loopback, a token in the path, keyed worker routes, only the methods used, no TLS proxy), checked in the lab with `sst dev`, refresh and remove, and reviewed. The Console's local connection and `sst cert` removed. The program contract's version 1: `report()` and `context()`, the core's reader, the V5 components on it, checked in the lab and under `mock()`. The transport as a place to plug in: `bridge.Transport`, AppSync behind it, `Dev.Stub`, and the transport suite, checked against the real Event API and in the lab, and reviewed. The runtime as a place to plug in: the interface without `ShouldRunEagerly`, a runtime made of commands, and the runtime suite, which Node.js, Go, Python, Cloudflare's workers and the commands runtime pass, reviewed. `sst.runtime`, with a Ruby function deployed and run in `sst dev` in the lab, and each start of a worker keyed, so what a stopped one sends is left out, reviewed. The target: the interface with the real cloud behind it, and a target on this machine from settings, which the core carries out (its container on loopback, the Docker socket said, the developer's credentials kept out, the program fenced in to this machine, a home of its own), checked against Floci in the lab, and reviewed. #212's HTTP transport, which passes the transport suite, with `sst dev` on a Floci stage in the lab. `sst.check`, with a preview first, checked in the lab and reviewed, and the V5 `Function`'s preview of a new stage fixed. The package setup, reviewed: a package needs no `skipLibCheck`, `bundler` or `google-protobuf` pin, and an app can use `NodeNext`; a group still needs every provider its components use, for the reason [written down](progress.md#2026-11-01-step-3-the-package-setup). The target suite in `sst/testing`, which a target package runs in its own CI, and `context().target`. The Floci package, drafted for rogueturnip outside this repo: its check on the V5 `Function`, `Bucket`, `Dynamo` and `Queue`, which passes the suite and deploys them on Floci with the check on, in `sst dev` too. A new stage's preview with a V5 subscriber fixed. Reviewed. Then four gaps closed: `sst` needs no `skipLibCheck` in an app's code, the suite checks `sst dev`, a first deploy with checks shows no error, and `sst target stop` and `reset`, with the container stopped after the last remove. Left: the Floci package's repo and CI, which wait on a pre-release, and the check against the recordings. Found later (2026-11-01): `sst target stop` and `reset` don't stop what the target's container starts with the Docker socket, like Floci's ECR registry. That check can't replay the recorded states, since their stages' passphrases went with the stages, so it means deploying them again; the maintainer left it for later (2026-11-01). |
| 4. New components | Started, 2026-11-01, committed (not pushed). `sst migrate --check`: Pulumi's preview of the move, what each component's map says about its parts (`added`, `replaced`, `released`), and the rules of goals 1 to 3 in `pkg/move`. Checked on a Floci stage: a stage the 4.x `Bucket`, `Dynamo`, `Queue` with a subscriber and `Function` deployed passes with the V5 ones, and a deploy then kept every id the check said it would; with the table renamed, it fails. Reviewed, and the review's findings fixed. A preview sees everything a component creates, decided and checked against all 69 places today's components create something inside an `apply`; first applied to the V5 `Function`'s source maps. The maps against the recorded states, under the mock: the mock replays a state (its ids, outputs and lookups), 4.x has to give what the state has, and V5 has to take over what 4.x gave, with nothing secret in plain text; the serverless group, deployed and in `sst dev`, passes, with the V5 `Function` writing its links' values into the state in `sst dev` found and fixed. Reviewed, and the review's findings fixed. The VPC groups pass too: the containers and databases update nothing in AWS. The V5 `Function` takes over 4.x's shared dev stub code; the gap found there was the test's. The `Vpc`, the first built the 5.0 way (its own args, no 4.x file, nothing inside an `apply`), takes over 4.x's in every case and in the VPC recording, updating nothing; its bastion takes one image now, so a switch can replace it once. In the lab, with an EC2 NAT and with a managed one, `--check` passed and the deploy kept every resource by id. Going back to the 4.x `Vpc`, `Cluster`, `Postgres` or `Redis` after a switch fails on 4.x's version check; the way back is the saved state. The `Function` built the 5.0 way: its own args, no 4.x file (the 4.x `Efs` and `Router` reached through helpers that take either kind), what a build reads a plain value, a URL behind a router with its permissions in a new stage's preview, and what an app creates once made once in each run, outside the 4.x `Function`; a test checks the clean break. In the lab, the serverless group's switch passed `--check` and kept every resource by id but the functions' code, as the map says, and ran in `sst dev`. The `Router` built the 5.0 way, on a V5 `Cdn`: its own args, no 4.x file, nothing inside an `apply`, and each route a part of the router, where 4.x kept it in a component of its own; it takes over the recorded router with nothing changed, and serves 4.x sites and functions as well as V5 ones. Reviewed, and the review's findings fixed. In the lab, with 4.x sites behind it and routes of its own, the switch kept every resource of the router by id, moved only its route entries, and served the same. `Nextjs` built the 5.0 way, on the V5 `Router` and `Cdn`: built once per deploy in the program, what the build makes created after it, its server in `nodes` from the start, and a failed build reported once, with its own message. It takes over the recorded Next.js site, and 4.x's in 18 setups. Reviewed twice, and the reviews' findings fixed. In the lab, behind the router beside 4.x sites, the switch kept every resource by id but its code, took its build command out of the state, and served the same. The gate's three hard components pass. Domains the 5.0 way ([decision](#decisions)): the DNS adapters create their records directly, named from plain values as 4.x named them; zones are found with functions, not resources; a 5.0 certificate names its validation records after the domains it validates, and its map gives their old names; a 5.0 redirect; and the `Cdn` rebuilt on them, with domain args of its own. A new stage's preview plans all 11 records of a CDN with aliases and a redirect, where 4.x's planned none. Reviewed, and the review's findings fixed. In the lab, a router with a domain and a redirect switched and moved: every record, certificate and the redirect's function kept their ids, SST 4's lookups were released, and the sites and the redirect answered the same. A stage that keeps 4.x server-rendered sites failed `--check` on their functions' code, uploaded again on every deploy: a file uploaded again under a key that follows from it is now a deploy's doing, not the move's ([decision](#decisions)), checked on a Floci stage and in the same lab run. Left for domains: the other components with one (`ApiGatewayV2`, `AppSync`, `CognitoUserPool`, `Alb`, `Service`, `Email`) take the 5.0 certificate and adapters as each is rebuilt; a CDN with redirects and a provider of its own can't switch yet (its redirect's function would be replaced under the same name, so `--check` refuses it); and the Cloudflare and Vercel adapters' CAA records still use SST 4's record resource, which moves into SST's provider with the others ([one by one](reference.md#ssts-provider-resources)). Releasing, the gate's last item: SST's `BucketFiles` and `KvKeys` served by the `sst` binary, and `sst migrate`, which holds the lock from its check to its end, saves a copy and releases what the maps say; with it, the marker and the refusal of a stage that hasn't moved, built ahead of step 5 ([decisions](#decisions)). Reviewed four times, and the reviews' findings fixed. In the lab, the switch of a Next.js site and its router released their files and entries, kept every one of them, and a plain deploy before the move was refused. The gate passes. Then the rest of Core: the `Bucket` built the 5.0 way, with its own args, the 4.x `Queue` and `SnsTopic` reached through helpers that take either kind, and a function it's given decided from what a preview knows (only a function or its ARN can be an output). A new stage's preview plans what a deploy creates. Reviewed, and the review's findings fixed. The `Queue` the same way, with what 4.x's static `subscribe` created kept through `get`, and the `SnsTopic`, with its static methods' subscribers kept the same way and an unnamed subscriber refused, the `Dynamo`, the `Bus` and the `CronV2`, with a function part's args left as they're given unless the component adds to them, so a `$transform` for functions can add to them. A subscriber of a component that takes its provider from a parent is replaced on switch, which `--check` refuses and the docs say to avoid. Each reviewed, and fixed. In the lab, all six switched at once and kept every resource by id and every setting in AWS, and each subscriber still ran. The `Cluster` the same way, with the deprecated `vpc.serviceSubnets` refused with what to write, and the `Task`, with what a task and a service both take in a helper the `Service` will use, and `publicIp` kept. The `Efs` with no mount target made inside an `apply`: each kept by its AZ, by its number in a `Vpc` the app creates and by its name in any other VPC, looked up with `after()` once a preview knows the subnets. In the lab, the `Cluster`, `Task` and `Efs` switched with the `Vpc` and the services, kept every resource by id, the mount targets under their AZ's number, and served the same. The `Redis` the same way, which tells `sst dev` about its pane for a local server where 4.x created a `DevCommand`, and a 5.0 `DevCommand` for an app's own commands; both checked in `sst dev` in the lab, beside SST 4's `DevCommand`. |
| 5. Moving an app | Started with step 4's releasing (2026-11-01): `sst migrate`, the marker, which lists the components a stage has in their 5.0 form, and the refusal of a stage that hasn't moved. Left: the codemod, the tombstone, the migration guide, the Kept and Community decisions, and the core no longer running 4.x components. |
| 6. After 5.0 | When needed. |
