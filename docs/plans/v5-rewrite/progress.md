# The 5.0 rewrite: progress

What's been done on [the plan](plan.md), newest first. Each entry says what was done, what was checked, and what it found. The plan's [status](plan.md#status) has the summary.

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
