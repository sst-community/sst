# The 5.0 rewrite: progress

What's been done on [the plan](plan.md), newest first. Each entry says what was done, what was checked, and what it found. The plan's [status](plan.md#status) has the summary.

## 2026-11-03: step 4, Cloudflare's components built the 5.0 way, and their lab check

**Done, not committed:**

- **The harness takes a provider's `v5` folder.** Cloudflare's 5.0 components are in `cloudflare/v5/`, as `sst.cloudflare.v5.X`, with their maps in `cloudflare/takeover/`, which `sideEffects` lists. `v5-components.test.ts` checks both providers' folders, with `RENAMED` and the types SST 4 spelled otherwise by provider. A takeover suite says `provider: "cloudflare"` to run its third way with a Cloudflare provider. The docs generator and the sidebar list Cloudflare's 5.0 pages, and keep the V5 class names by provider (`Bucket`, `Cron`, `Queue`, `StaticSite` and others are in both).
- **The `Worker`**, the base of the rest: its zone found with a function, not SST 4's `ZoneLookup`; each of a domain's aliases and redirects kept by its domain, moved from SST 4's place in the list by the map; the IAM user a link to AWS gives it created directly; what it's linked to read without waiting on it, so a Worker inside a component can link that component; its bindings read together, so one that's secret keeps them all secret, as SST 4 did. Every `existing` entry is refused: it builds its code.
- **`Kv`, `D1`, `Bucket`, `Hyperdrive`, `Ai`, `RateLimit`:** one resource each, or none, with `get` through `existing` and one helper that uses what's in `existing` or looks it up by an id with its account in front. `Bucket` gives a linked Worker its jurisdiction; `Hyperdrive` keeps its origin secret; `RateLimit` checks its settings when it's created.
- **`Queue`** with one unnamed consumer, inside the queue where SST 4 kept it in a `QueueWorkerSubscriber`, and `dlq.retryDelay` sent in seconds; **`Cron`**, **`Workflow`** and **`DurableObject`**, each with its Worker kept under SST 4's name, so a Worker with Durable Object migrations finds its current tag.
- **The sites,** `StaticSite` (SST 4's `StaticSiteV2`, with its type, `sst:cloudflare:StaticSite`, which SST 4's first `StaticSite` has too), `Astro`, `ReactRouter` and `TanStackStart`, built in the program on one helper, with the Wrangler config SST 4 wrote, and a binding whose id a preview doesn't know left out of it.
- **Left out:** Cloudflare's `Auth`, the maintainer's call, as for `Auth.v1`; it was ported and tested first, and is in the history.
- **A review of the set** found no resource a switch would lose, and 17 things to fix, all fixed: a preview's Wrangler config with empty binding ids, a queue given by its id read with its account in its id, a Worker that refused an output domain and took `existing` entries it would ignore, the R2 jurisdiction in a site's Wrangler config, four duplicates made helpers, and "Switch from" notes. It also found a framework bug: a `$transform` that set a part's `transform` for every component of a type made that type's `get` fail; fixed in `parts-component.ts`, with a test.

**Checked:** `tsc`, the platform tests (4,199, 123 files), Prettier on what was clean before, and the docs generator: 16 Cloudflare pages, each with its switch notes.

**Checked in the lab,** in a Cloudflare account without R2 (so `Bucket` and `Hyperdrive` are checked under the mock only), on a stage of its own (`LAB_ONLY=cloudflare`): a Worker linked to a `Kv`, a `D1`, a `Queue` with a consumer, an `Ai`, a `RateLimit`, a `DurableObject` and a `Workflow`, with Durable Object migrations, placement and an environment variable; a `Cron`; and a `StaticSite` with a 404 page. The SST 4 side was deployed with a CLI built from `main`, which keeps the API token out of the state.

- **Deployed with SST 4, and called:** every binding answered, the queue's consumer handled a message, and the site served its page and its 404.
- **`sst migrate --check` passed:** 43 resources kept, 7 at a new address, 7 updated in place, nothing replaced or deleted. The updates: SST 4's dynamic resources' code, and the API Worker, which reads its Durable Object migration tag and sends no steps, as SST 4 does on its second deploy.
- **The move** kept all 17 resources by id, the queue's consumer under its new name. `sst diff` after it showed no changes. Every route answered the same, and the Durable Object's count went on from where it was.
- **The cron job ran after the move,** its Worker moved into the `Cron` from the top of the app and its trigger kept: Cloudflare took about four minutes to fire a new trigger.
- **Removed, and cleaned up:** `sst remove` deleted the 34 resources and components; Cloudflare's API lists no script, KV namespace, D1 database, queue, workflow or Durable Object namespace in the account. Then the stage's 64 state versions and markers, its `migrate` copy among them, and its passphrase. Nothing of it is left. The exported states hold no API token.

## 2026-11-03: step 4, the maintainer's calls on what the review left

**Done, not committed:**

- **`ApiGatewayRest` and `ApiGatewayHttp`.** The maintainer asked "Can we change the names of the api gateways to be more clear what they are instead of v1 and v2?", and chose these: the REST API (SST 4's `ApiGatewayV1`, with its `ApiGatewayRestApiKey` and `ApiGatewayRestUsagePlan`) and the HTTP API (`ApiGatewayV2`), in `aws/v5/apigateway-rest.ts` and `apigateway-http.ts`. Each keeps its type, so a switch keeps what's deployed. The components test lists the renamed ones in `RENAMED` and finds each original by its type, as the docs generator now does too, which replaces the rule that read a dropped version from the type.
- **`Realtime`'s subscribers take an optional name,** which keys them in `nodes` and `transform`, and a function or its ARN with one. Without a name they're keyed by SST 4's hash, so a switch keeps them.
- **The WebSocket API's `addAuthorizer` takes one object,** `{ name, lambda }`, as the other two APIs' do; the old call is refused with the call to write.
- **A `Task` or `Service` given an existing task definition creates nothing it wouldn't use,** and refuses what would only go into one; a `Service` given an existing ECS service only references it. What runs a task, the `Cron` and `StepFunctions`, passes the roles the task definition has (`rolesToPass()`).
- **The docs generator writes the "Switch from" notes the nine sites share,** in place of ten copies in each.
- **`Auth.v1` is left out of 5.0,** and Cloudflare's components are next, with the mock first.

**Checked:** `tsc`, the platform tests (3,691), Prettier on what was clean before, and the docs generator: the renamed pages, the sites' notes in order.

**Checked in the lab** (a stage of its own, and a CLI built from the branch). A REST API that waits between its routes and `deploy()`, as a config that imports its routes does, an HTTP API, and a WebSocket API with an authorizer.

- **Deployed with SST 4, and called:** every route answered. SST 4 showed no URL for the REST API: its hint was lost after the wait.
- **`sst migrate --check` passed:** 70 resources kept, 52 at a new address, 6 updated in place; 6 replaced, each as its map says: the REST API deployed again with the same routes, and the functions' code uploaded under a new key.
- **The move** kept 55 of 62 resources by id, 48 under a new name, the API Gateway account's setup among them; the other 7 are that deployment and code. `sst diff` after it showed no changes, every route answered at the same URL, and the REST API's URL was shown: its outputs, registered by `deploy()`, reached the CLI.
- **Removed, and cleaned up:** `sst remove` deleted 72 resources. Then the stage's 61 state versions and markers, its `migrate` copy among them, its passphrase, and 5 source maps of SST 4's functions. Nothing of it is left. The account's API Gateway logging role is the one it had before.

## 2026-11-03: step 4, a review of the 5.0 components as a set, and its fixes

**Done, not committed:** the maintainer asked for "a review of all the components and make sure they are right. There's not a lot of duplications and they follow the right pattern and consistent". Six reviewers read the 5.0 components, each family against the rulebook and one pattern across all of them; about 75 findings, each checked against the code. Five agents then fixed them, a family each, on files of their own, and the rest was done across them. 119 files, with 7 new helpers.

- **The rules, in the framework and the rulebook.**
  - Every error names its component the same way, `the "Web" Astro site`; `notAnOption` takes the owner.
  - An `existing` entry a component has no use for is refused (`notAnExistingPart`, `onlyExisting`), and so are settings next to a resource given in `existing` (`usedAsItIs`), where most components dropped them without a word. A `get` marks its args with `getArgs()`, so what a `$transform` adds to them isn't refused.
  - `lookupPart` uses a resource passed in `existing`.
  - The README has the exceptions the code had: the `Service`'s dev panes as parts, and the `ApiGatewayV1` reporting from `deploy()`.
- **Bugs fixed.**
  - A function part given a name or a handler in `existing` built a function from it.
  - Parts `get` doesn't create were typed as always there (`Postgres.get(...).nodes.secret`).
  - `Task` and `Service` read the region from the default provider, so with `providers` their logs went elsewhere.
  - `ApiGatewayV1.deploy()` after an `await` failed to report its hint.
  - The WebSocket API's refusal of `transform.accessLog` came too late to run.
  - The API Gateway account setup was created inside an `apply`, with the default provider.
  - `Router.routeSite` told users to set `route`, which the sites refuse.
  - A Redis given an existing serverless cache still created a password it doesn't use.
  - `dev`, `retries` and `serverless.password` decided what's created without being plain.
  - A server given as an output got the wrong error.
  - The base path of four sites was read past its quote.
  - A container's own `environmentFiles` weren't granted to the execution role: an update in place on switch, in "Switch from".
- **Duplication taken out.**
  - The databases share credentials and the proxy with `Aurora` (`helpers/rds.ts`), and the password in a tagged secret (`helpers/secret.ts`) and the local server (`helpers/local-server.ts`).
  - `Task` and `Service` build their task definitions one way (`helpers/fargate.ts`), with `isCluster()` and shared IAM (`helpers/iam.ts`) and VPC helpers that `Function` and `MicroVm` use too.
  - The three API Gateway components share their domain, access log, routes and permissions (`helpers/apigateway.ts`).
  - The `Router`, the server sites and the `StaticSite` share their distribution (`helpers/distribution.ts`) and site plumbing (`helpers/site.ts`); the four Nitro frameworks load with `nitroSite()`.
  - The subscribers share an event-source helper and one name check, the EventBridge rules one helper (`helpers/eventbridge.ts`), and the queues and topics one ARN helper each.
- **Consistency.** SST 4's removed methods are refused with the call to write. `Bus.get` and `Dynamo.get` take the ARN `Queue.get` and `KinesisStream.get` take. `KinesisStream`'s subscribers are described after their component, as `Dynamo`'s, `SnsTopic`'s and `Queue`'s are; the `Bus`'s keep SST 4's, after the bus's name in AWS, which would otherwise be updated on switch. The recurring "Switch from" bullets are worded the same everywhere, the nine sites' identical, and each page's sections are in the same order. The breaking changes have a row each in the plan.

**Checked:** `tsc`, the platform tests (3,669, from 3,526 before), Prettier on what was clean before, and the docs generator, which checks no page names its original outside "Switch from". Every takeover case passes as it was, except the two updates in place above, which are on purpose. Each family's agent read its diffs against what they replaced. Not checked in AWS yet: the `ApiGatewayV1`'s outputs, now registered by `deploy()`, and the API Gateway account set up with `after()`, which change how they meet the engine.

**Left for the maintainer:** names for `Realtime`'s subscribers, the WebSocket API's `addAuthorizer(name, args)`, generating the sites' shared "Switch from" bullets, and whether a `Task` or `Service` given an existing task definition or service still creates the roles and images it doesn't use.

## 2026-11-03: step 4, `CronV2` is `Cron` in 5.0

**Done, not committed:** the maintainer decided that a 5.0 component drops the version SST 4 put in its name, where it can ([decision](plan.md#decisions)). With SST 4's first `Cron` left out of 5.0, `CronV2` is `sst.aws.v5.Cron`.

- The file is `aws/v5/cron.ts`, with its map and tests renamed to match, and its args are `CronArgs`. Its type stays `sst:aws:CronV2`, which a deployed one has: `sst:aws:Cron` is the first `Cron`'s, and a 5.0 component of that type would be taken for it. "Switch from" says so.
- The rule is written in `PORTING.md`: a component drops the version from its name and its file, and keeps its type. The naming test and the docs generator find the original from the version in the type, so there's no list of renamed components to keep. On a 5.0 page, an inherited example of `sst.aws.CronV2(` is shown as `sst.aws.v5.Cron(`, and one of the first `sst.aws.Cron(` is left alone.
- The recorded lab program calls `CronV2` on SST 4's side and `Cron` on 5.0's.
- The plan's open question of which `Cron` is `sst.aws.v5.Cron` is settled, and the breaking changes have a row for the rename. Cloudflare's `StaticSiteV2` becomes `StaticSite` when it's ported. `ApiGatewayV1` and `ApiGatewayV2` keep their names: they're AWS's names for its two APIs, and both stay.

## 2026-11-03: step 4, SST 4's deprecated components left out of 5.0

**Done, not committed:** the maintainer decided to leave SST 4's deprecated components out of 5.0, and to add one back if users ask for it ([decision](plan.md#decisions)): `Cron`, `Vector` and `OpenControl`, and Cloudflare's first `StaticSite`. SST 4 names what to use instead of each.

- The 5.0 forms of `Cron`, `Vector` and `OpenControl` are removed, with their maps and their tests. Each was ported, reviewed and lab-checked first, as the entries below say, and comes back from the history as it was: `Cron` from `de729d193`, `Vector` from `e574fea61`, `OpenControl` from `9e35da796`.
- Cloudflare's first `StaticSite` won't be ported, and its `sst.cloudflare.x.StaticSite` alias goes with it.
- The plan's breaking changes say what an app does with SST 4 before it moves: a `Cron` becomes a `CronV2`, a Cloudflare `StaticSite` a `StaticSiteV2`, a `Vector`'s vectors move out before it's removed, and an `OpenControl` is removed. The rows for the `Cron`'s and the `Vector`'s 5.0 forms are gone.
- The open question of which `Cron` is `sst.aws.v5.Cron` is now whether the 5.0 `CronV2` takes the name.
- The sites' map still takes over SST 4's warmer, which SST 4 kept in a `Cron`: it names the type, not the 5.0 form.

## 2026-11-03: step 4, the `OpenControl` built the 5.0 way, the last of Community, and its lab check

**Done, committed (not pushed):**

- **`OpenControl`** (`aws/v5/opencontrol.ts`), deprecated as SST 4's is. Its key and its server's function keep their names, so its map is empty. The server is a 5.0 `Function`, given the key as `OPENCONTROL_KEY` and a URL without CORS, as SST 4 gave it.
  - `server` is a plain value, a handler or a function's args: the function is created from it. A function's ARN is refused, since the server is reached through the URL of the function the component creates. So are `existing.server` and `existing.key`, with what to write.
  - `nodes` has the key, and `nodes.server` is an output of the 5.0 `Function`.

**Checked:** `tsc`, the platform tests (3,638), and the docs page. The `OpenControl` has 25 tests. The takeover runs in 7 cases, each three ways: a server from a handler, from function args with a link, with a URL of its own, with permissions of its own, with a key of its own, in `sst dev`, and in `sst dev` with args and a link. Tests of their own cover the key and the URL, what's refused, and `transform` for the server and the key.

**Reviewed.** Fixed from it:

- With an `OPENCONTROL_KEY` of the app's own, the 5.0 merge of the server's environment would have left out the generated key, and with it the secret: the state would have held the environment unencrypted from the switch on, and the function would no longer have waited on the key. The defaults' environment is an output now, as SST 4's was, and a case covers it.
- `existing.server` was taken and used as it was, with no key and no URL; `existing.key` was looked up. Both are refused.
- "Switch from" says what inside the server's args is a plain value, and that `nodes.server` is an output of the 5.0 `Function`; the plan's breaking changes have a row for it, with `Auth`'s issuer.
- Tests: the key is a secret in the mock, as it is in AWS, and the cases and tests above.

**Checked in the lab** (a stage of its own, and a CLI built from the branch). A server from function args, with an environment variable of its own, that says whether it has a 16-character key.

- **Deployed with SST 4, and called:** it had its key and its variable.
- **`sst migrate --check` passed:** 15 resources kept, 2 at a new address and none updated in place; nothing replaced, released or taken out.
- **The move** kept all 10 resources by id, 2 under a new name. `sst diff` after it showed no changes. The server answered at the same URL with its key and its variable, and its environment is still encrypted in the state.
- **Removed, and cleaned up:** `sst remove` deleted 15 resources. Then the stage's 45 state versions and markers, its `migrate` copy among them, its passphrase, and its function's source map. Nothing of it is left: no function, URL, role or log group.

## 2026-11-03: step 4, the `OpenSearch` built the 5.0 way, and its lab check

**Done, committed (not pushed):**

- **`OpenSearch`** (`aws/v5/open-search.ts`). The domain, its policy, the generated password and the secret it's kept in keep their names, so its map is empty.
  - With `dev` set, SST 4 created a `DevCommand` for the pane `sst dev` shows, in every deploy. The 5.0 one tells `sst dev` through the program contract, and creates nothing in `sst dev`: reading `nodes` there says why it's empty.
  - `get` looks the domain up inside the component, with the component's provider, and reads the username and password from the domain's tags, as SST 4 did.
- **Better than SST 4:** `get` takes the domain's name or its ARN, the component's `id`. SST 4's docs said to pass the `id`, but SST 4 could only look a domain up by its name. An object in `transform` for the domain's `tags` keeps SST's tags next to the app's, so `get` still finds the username and password, where SST 4 dropped them.

**Checked:** `tsc`, the platform tests (3,638), and the docs page. The `OpenSearch` has 40 tests. The takeover runs in 10 cases, each three ways: a domain, one with everything set, tags set with an object in `transform`, a nested setting set with one, a master user given by its ARN in a function, a username with a generated password, a password of its own, `dev` outside `sst dev`, `dev` in `sst dev`, and a domain referenced with `get`. Tests of their own cover the domain and its secret, the links, the storage minimum, `get` by name and by ARN, and `sst dev`.

**Reviewed.** Fixed from it:

- "Switch from" names each of the domain's nested settings an object in `transform` now merges into, and says to replace `advancedSecurityOptions` in a function for a master user given by its ARN; a case covers it.
- A "Switch from" bullet that described no change is gone, and one says that `get` looks up with the component's provider.
- Tests for a username alone, a password alone, and the master user above.
- From reading the docs page after: `get`'s example called the domain's name its ID, which is its ARN.

**Checked in the lab** (a stage of its own, and a CLI built from the branch). A domain with `dev` set and a `get` of it, linked to an SST 4 function that indexed a document through the first and read it back through the second. SST 4's `get` was given the domain's name: given the `id`, as its docs said, it failed in AWS, which is why the 5.0 `get` takes the ARN. The 5.0 one was given the `id`.

- **Deployed with SST 4, and called:** the document was indexed and found, with the same master user through both.
- **`sst migrate --check` passed:** 24 resources kept, none at a new address and none updated in place; nothing replaced or released, and 2 resources taken out with nothing in the cloud behind them, SST 4's `DevCommand` among them.
- **The move** kept every resource by id. `sst diff` after it showed no changes. The document indexed before the switch was found after it, next to a new one.
- **Removed, and cleaned up:** `sst remove` deleted the domain, its secret and the function, after a 14-minute wait for the domain. Then the stage's 70 state versions and markers, its `migrate` copy among them, its passphrase, and the SST 4 function's source map. Nothing of it is left: no domain, secret, function, role or log group.

## 2026-11-03: step 4, the `KinesisStream` built the 5.0 way, and its lab check

**Done, committed (not pushed):**

- **`KinesisStream`** (`aws/v5/kinesis-stream.ts`), as the 5.0 `Dynamo`'s stream subscribers are built. SST 4 kept each subscription in a component of its own at the top of the app; the 5.0 one keeps the subscriber's function and event source mapping inside the stream, by the subscriber's name, and `subscribe` returns the stream. A subscriber without a name, a subscriber's own `transform`, and a handler or args in an output are refused with what to write.
  - The map finds a subscriber where either of SST 4's forms put it: after the stream's component, or, for the static `subscribe`, after the stream's own name.
  - The subscriber's function keeps SST 4's description, after the component it was in, so a switch updates nothing.
  - SST 4's static `subscribe`, which took a stream's ARN, becomes `get(name, stream).subscribe(...)`. It's kept, `@internal`, only to say so.
- **Better than SST 4:** `get` references a stream by its name or its ARN, so a stream in another stage can be shared, and an SST 4 config's ARN works as it's written.

**Checked:** `tsc`, the platform tests (3,561), and the docs page. The `KinesisStream` has 34 tests. The takeover runs in 8 cases, each three ways: a stream, transformed, subscribers given as ARNs with filters and SST 4's transform, from a handler, from function args, one that links its stream, a function's ARN in an output, and in `sst dev`. Tests of their own cover the static form (with an ARN, with a handler, and on a stream of the app), `get`'s options, and a provider from a parent.

**Reviewed.** Fixed from it:

- A subscriber of the static form would have had its description updated: from `get`, it's described after the stream's own name, as the static `subscribe` named it.
- `get` takes the ARN the static form was given, where it took only a name.
- "Switch from" now says that a provider or parent given to `get` replaces the subscriber, and no longer says `nodes.stream` was an output, which it wasn't.
- Tests for a linked subscriber, the static form with a handler and on a stream of the app, and `get`'s options. The mock now gives a created stream the ARN of its physical name, as AWS does.

**Checked in the lab** (a stage of its own, and a CLI built from the branch). A stream with a subscriber filtered to one kind of record, and one subscribed the static way: on SST 4 by the stream's ARN, on 5.0 through `get` given that ARN. Each wrote what it got to a bucket. An SST 4 function put one record each subscriber should get and one the filter drops, and waited for them.

- **Deployed with SST 4, and called:** both subscribers recorded the record, and the filtered one didn't get the other. A first call, made before the event source mappings were enabled, recorded nothing: they start at the latest record.
- **`sst migrate --check` passed:** 37 resources kept, 13 at a new address, and the static subscriber's function updated in place. Its code is uploaded again under a new key, as the `Function`'s map says, since the function is named after `get`'s component now. Nothing released, and SST 4's two subscriber components taken out with nothing in the cloud behind them.
- **The move** kept 25 resources by id, 7 under a new name. The only new one is that code. `sst diff` showed no changes, both subscribers recorded a new record, and the filter held. `get` found the stream by the name in its ARN, and a refresh followed by `sst diff` showed no changes.
- **Removed, and cleaned up:** `sst remove` deleted 35 resources. Then the stage's 79 state versions and markers, its `migrate` copy among them, its passphrase, and 3 source maps of SST 4's functions. Nothing of it is left: no stream, event source mapping, function, role, bucket or log group.

## 2026-11-03: step 4, the `Vector` built the 5.0 way, the first of Community, and its lab check

**Done, committed (not pushed):**

- **`Vector`** (`aws/v5/vector.ts`), deprecated as SST 4's is. SST 4 kept its database in a `Postgres.v1` inside it, which has no 5.0 form. The 5.0 one takes that database's cluster, instance and subnet group over as parts of its own, through `childWithin` in its map, and a move takes the `Postgres` component out of the state. Its table and its three functions keep their names.
  - What SST 4 took only through `transform.postgres` the 5.0 one takes as args of its own: `vpc`, `version`, `scaling` and `databaseName`, with SST 4's defaults and types. Changing a cluster's subnet group would replace it, so an app that put the database in a VPC needs `vpc`.
  - `transform.postgres` is refused, before the component turns down a key it doesn't have, with what to write. So is `vpc: "default"`, SST 4's name for the default VPC: leave `vpc` out.
  - `get` passes the cluster in `existing` and looks its instance up, as the 5.0 `Aurora` does, and takes `opts`.
- **Better than SST 4:** `vpc` takes either kind of `Vpc`, and the database's settings are args, documented, where SST 4 had them only in a transform of a component the docs didn't show.

**Checked:** `tsc`, the platform tests (3,521), and the docs page, which now has the SDK's `VectorClient` (the generator's fix in the `MicroVm` entry). The `Vector` has 33 tests. The takeover runs in 7 cases, each three ways: a vector database, in a VPC by its ids, in a `Vpc`, its database transformed, its database's settings, its database protected by a function, linked by a function, and in `sst dev`. `get` is a case of its own, since SST 4's took no options.

**Reviewed.** Fixed from it:

- A cluster given a version through `transform.postgres` kept changes to it in SST 4, and would have ignored them after the switch: `version` is an arg now, and without one the version is ignored, as in SST 4.
- The refusal's message said to write ACU strings as the cluster's numbers: `scaling` takes them as SST 4 did.
- `vpc: "default"` was taken and made a subnet group with no subnets: it's refused.
- "Switch from" now says where a function's resource options go, and that a `$transform` of `Postgres` no longer reaches the database.
- Tests for the database's settings, a function-form transform, a linked function and the link's values.
- The docs: the subnet group in the intro, when the table isn't created, and `get`'s example id.

**Checked in the lab** (a stage of its own, the database in a VPC set through `transform.postgres` as SST 4 needed, since the lab account has no default VPC, and a CLI built from the branch). An SST 4 function linked to the database put and queried a vector through the SDK.

- **Deployed with SST 4, and called:** the query found nothing, the put stored the vector, and the query then found it.
- **`sst migrate --check` passed:** 55 resources kept, the database's 3 at a new address and none updated in place; nothing replaced or released, and SST 4's `Postgres` taken out with nothing in the cloud behind it.
- **The move** kept all 41 resources by id, the 3 under a new name. `sst diff` after it showed no changes. The query found the vector put before the switch, and a remove and a put then worked through the 5.0 form.
- **Removed, and cleaned up:** `sst remove` deleted 51 resources. Then the stage's 85 state versions and markers, its `migrate` copy among them, its passphrase, and the SST 4 function's source map. Nothing of it is left: no RDS cluster, instance, subnet group or snapshot, no VPC, subnet or security group, and no role, function, secret or log group.

## 2026-11-03: step 4, the `MicroVm` built the 5.0 way, the last of Kept, and its lab check

**Done, committed (not pushed):**

- **`MicroVm`** (`aws/v5/microvm.ts`). Every part has SST 4's name and place, so its map is empty: the image and its versions, the roles, the log group, the code's zip, the prune resource and the network connector are kept as they are, and the image isn't built again.
  - In `sst dev` it reports its pane through the program contract, where SST 4 created a `DevCommand`. A move of a stage last deployed by `sst dev` takes that component out of the state; nothing in AWS is behind it. It runs locally through `this.runsLocally()`, so `nodes` says why a part isn't there.
  - `vpc` takes either `Vpc`, with the NAT warning for both, and refuses another resource given as a VPC's ids.
  - The prune resource, one of SST's dynamic resources, is a part, as the sites' invalidation is.
- **Better than SST 4,** each change listed in "Switch from" where an app would notice:
  - Images can share one network connector, given in `existing` in place of `vpc`. Each connector takes about 5 minutes to create.
  - `existing` is refused where the component can't use what it's given: the log group (Lambda writes an image's build logs to the one named after it), the code, the image and the prune resource; `permissions` beside an existing execution role; an operator role with no connector to create. An existing build role, execution role or operator role is used.
- **The docs generator:** a 5.0 page gets its SDK's functions. The generator matched the SDK by the module's third segment, `v5` for a 5.0 component, so the 5.0 `Task`, `Realtime` and `Workflow` pages had none; they have them now, as the `MicroVm`'s does. On a 5.0 page, a class the SDK's docs name in backticks gets its 5.0 name too, which changed one line, on the `Workflow`'s page.
- **What earlier ports missed:**
  - `Realtime`, `ApiGatewayWebSocket` and `ApiGatewayV2` create their subscribers, routes and authorizers with the component's provider, where SST 4 gave them only a `provider` passed to the component. So one that takes its provider from a parent replaces them on switch. Their "Switch from" sections now say so, as the `ApiGatewayV1`'s and the `Queue`'s do, with a test each.
  - None of the ports since the `StaticSite` had added its rows to the plan's [breaking changes](plan.md#breaking-changes-so-far): the six framework sites, seven of Kept, the `ApiGatewayV1` and the `MicroVm` have 23 now.

**Checked:** `tsc`, the platform tests (3,482), and the docs pages. The `MicroVm` has 52 tests: SST 4's, carried over, and the takeover in 9 cases, each three ways. The cases: an image from its context, with everything it's run with, linked, in a VPC by its ids, in a `Vpc`, with its resources transformed, in `sst dev`, in `sst dev` in a VPC and linked, and built in `sst dev`.

**Reviewed.** Fixed from it:

- The docs' example of a shared connector failed in `sst dev`, where the first image runs locally and has no connector. The example guards it with `$dev`, and a test runs it in `sst dev`.
- What an object `transform` now merges into, the image's variables and the connector's configuration, is named in "Switch from", with a test.
- An existing operator role that would have been ignored is refused.
- An empty `permissions` beside an existing role is allowed, and the `link` docs say an existing role gets no permissions.
- The pane's new name, which `SST_CHILD` takes, is in "Switch from".
- Tests: `sst dev` with a link and a VPC, and existing build and operator roles.
- The breaking changes and a real `sst dev` run, both done (above and below).

**Checked in the lab** (a stage of its own, with a VPC with EC2 NATs, and a CLI built from the branch). An image in the VPC, with an environment variable and a link to a bucket, run by an SST 4 function that runs a MicroVM, calls it and terminates it.

- **Deployed with SST 4, and called:** the MicroVM answered with the image's environment and the link's value, and its outbound traffic left through the VPC's NAT.
- **`sst migrate --check` passed:** 59 resources kept, none at a new address or updated in place, and nothing replaced, released or taken out.
- **The move** kept all 46 resources by id, none of them renamed. `sst diff` after it showed no changes, and the MicroVM answered the same.
- **A second image sharing the first one's connector** created no connector or operator role of its own, and its MicroVM's traffic left through the same NAT.
- **`sst dev`:** its deploy deleted the images, their code, the build roles, the connector and the operator role, and the execution roles trusted the account. The pane ran the app on this machine as the execution role, with the image's environment and the link, and the SST 4 function, run locally, reached it through the SDK.
- **Removed, and cleaned up:** `sst remove` deleted 49 resources. Then the stage's 121 state versions and markers, its `migrate` copy among them, its passphrase, and the 2 source maps of the SST 4 function. Nothing of it is left: no MicroVM image or network connector in the account, and no instance, address, VPC, role or log group.

## 2026-11-03: step 4, the `ApiGatewayV1` built the 5.0 way, and its lab check

**Done, committed (not pushed):**

- **`ApiGatewayV1`** (`aws/v5/apigatewayv1.ts`), with the usage plan and the API key as small 5.0 components of their own (`apigatewayv1-usage-plan.ts`, `apigatewayv1-api-key.ts`), at the top of the app as SST 4 made them, so nothing of theirs moves.
  - The routes and authorizers are inside the API, by the route's name or the route itself, where SST 4 kept each in a component of its own. `route` and `routeIntegration` return the API.
  - Each path's resource is kept under the hash SST 4 named it with. SST 4 hashed the text Pulumi gives an output in place of its value, which isn't `outputId`; the 5.0 form keeps today's text as a constant, so a later Pulumi doesn't rename the resources.
  - What CORS adds to each path keeps the name SST 4 gave it, made from the AWS id of the path's resource, which the move keeps: the map's names are outputs, as the `Efs`'s are.
  - `deploy()` stays. A route after it, or a second `deploy()`, is refused.
  - An edge API's certificate is made in `after()`, once the API's region is known, so it gets the provider SST 4 gave it: the API's own in us-east-1, one of its own elsewhere.
  - The deployment is listed under `replaced`: its triggers are keyed by URNs, which the move changes, so the switch deploys the API once more, with the same routes.
- **Better than SST 4,** each change listed in "Switch from":
  - A refresh doesn't deploy the API again. A refresh reads empty settings back from AWS as `[]`, `{}` or `""`, which changed SST 4's triggers (each resource's outputs) after every refresh (found in the lab). The 5.0 triggers leave empty settings out.
  - A route added after `deploy()` is refused. SST 4 deployed it without CORS for its path.
  - An authorizer's function takes a `Function` or an ARN.
  - SST 4's transforms (`transform.route`, `transform.accessLog`) are refused with what to write, before the component turns down a key it doesn't have.

**Checked:** `tsc`, the platform tests, and the three docs pages. One full run failed a Remix case that passes alone: under the suite's load, the SST 4 site registered its outputs after the mock's `settle()` had stopped waiting, which waits only until it sees nothing happen three times. That gap in the test harness is older than this change. The API takes over SST 4's in 14 cases, each three ways: routes by route, by name and to integrations, streaming, CORS on and off, the three kinds of authorizer, auth and API keys on routes, a usage plan and key, edge, regional and private endpoints, a domain with a path, one it didn't create, a linked route, and its resources transformed.

**Reviewed.** Fixed from it:

- An edge API with a provider of its own in us-east-1 would have had its certificate replaced: SST 4 read that provider's region. Now decided once the region is known, as above.
- "Switch from" said SST 4 didn't deploy a route added after `deploy()`; it did, without CORS. It now says to move it above `deploy()` with SST 4 first.
- A part's doc named SST 4's component, which the docs generator refuses outside "Switch from".
- A route that takes its provider from a parent is replaced on switch, as with the other ports; now in "Switch from".
- `transform.route.args` is refused with what to write.
- The hashed text is now a constant.
- The stage is read from `context()`.
- The route `name` docs.
- A takeover case with a linked route.

**Checked in the lab** (a stage of its own, no VPC, with a CLI built from the branch). An edge API with a domain and a base path, its certificate made in us-east-1 from us-west-2. Five routes: four to functions, one named and one keyed, and one to a mock integration. A token authorizer whose name isn't a logical name, CORS, a usage plan with a key, and an SST 4 function linked to the API and the key, which calls the keyed route.

- **Deployed with SST 4, and called:**
  - each route answered;
  - the authorizer refused no token (401) and a wrong one (403), and passed the right one through;
  - the keyed route refused a call without its key, and the linked function's call with it answered;
  - CORS answered `OPTIONS` with its headers, and an unknown path's error had them;
  - the stage, domain mapping, usage plan and access log were as set.
- **`sst migrate --check` passed:**
  - 102 resources kept, 68 at a new address and 6 updated in place (the stage's deployment and five functions' code);
  - 7 taken out with nothing in the cloud behind them (SST 4's route and authorizer components, and its dynamic-resource provider);
  - 3 of SST 4's zone lookups released;
  - 6 replacements: the deployment, as the map says, and five functions' code under new keys.
- **The move** kept 85 resources by id, 62 of them under a new name. The same 15 answers before and after.
- **`sst diff` after the move:** no changes.
- **A refresh** then showed a new deployment in the next diff: SST 4's design, carried over, and fixed above. With the fix, a deploy that added a route served it (through the domain and with CORS) once API Gateway had it live, about half a minute later. A refresh after that left `sst diff` with no changes.
- **Removed, and cleaned up:** `sst remove` deleted 119 resources. Then the stage's 131 state versions and markers, its `migrate` copy among them, its passphrase, and 7 source maps. One of the maps is the 5.0 handler's for the added route: the 5.0 `Function` keeps its source maps on delete as SST 4's does (`retainOnDelete`, so an error logged before a deploy can still be mapped), and so a removed stage leaves them behind. Nothing of it is left in API Gateway (APIs, domain names, usage plans, keys), ACM in either region, Route 53 or CloudWatch Logs.

## 2026-11-03: step 4, seven of Kept built the 5.0 way, a map for every 5.0 component, and their lab check

**Done, committed (not pushed):**

- **`StepFunctions`, `Cron`, `CognitoIdentityPool`, `Auth`, `Realtime`, `Workflow` and `ApiGatewayWebSocket`** (`aws/v5/`), each built the 5.0 way: its own args, no 4.x file, nothing created inside an `apply`, a "Switch from" section, and on the clean break's list.
  - `StepFunctions`: the state classes are SST 4's (`aws/step-functions/`, which the clean-break test now walks). The five integrations that take a component have their own args and take the V5 `Function`, `SnsTopic`, `Queue`, `Task` and `Bus` as well as the 4.x ones. `lambdaInvoke` creates a V5 `Function`, under the name SST 4 gave its function.
  - `Cron` is the old, rule-based `Cron`, under its own type ([open question 3](plan.md#open-questions)). Its function is moved from `<name>Handler` to `<name>Function`. `job` is refused.
  - `CognitoIdentityPool`'s `get` reads the pool, its roles and their attachment inside the component.
  - `Auth`'s table, issuer and router are the V5 `Dynamo`, `Function` and `Router`. `authorizer` and `forceUpgrade` are refused, and `Auth.v1` has no 5.0 form ([open question 4](plan.md#open-questions)).
  - `Realtime` keeps each subscriber inside the component, by the hash SST 4 named it with, where SST 4 kept each in a component of its own.
  - `Workflow`'s function is a V5 `Function`, with versions and durable execution. SST 4's shape of `transform.function` is refused with what to write.
  - `ApiGatewayWebSocket` keeps each route and authorizer inside the component, as the `ApiGatewayV2` does. Its domain is on the 5.0 certificate and adapters. An authorizer's `jwt`, `payload` and `response` are refused.
- **A map for every 5.0 component, even an empty one.** Only a type with a map counts as taken over. Without one, a new stage could use the 4.x form, and a plain deploy could then switch it, which only `sst migrate` should do. `Cdn`, `Cluster` and `CognitoUserPoolClient` were missing one; a test now checks every component in `aws/v5/`, and `PORTING.md` says so.
- **Shared:**
  - `AnyBus` (`helpers/bus.ts`) and `AnyFunction` take either kind.
  - A function part takes the V5 `Workflow`.
  - API Gateway's account and its log role are read once per run, not once per process.
  - The V5 `Router` can be told not to report its URL, so `Auth` reports only its own.
  - The docs generator renames static methods (`sst.aws.StepFunctions.pass(`) in the examples too.
  - The takeover tests' helper waits for a case that's async. The `Workflow`'s case on a bus imports the `Bus`, and failed under the full suite's load, when the import finished after the helper had looked.
- **Better than SST 4,** each change listed in its component's "Switch from":
  - `StepFunctions` with `logging: false` deploys. SST 4's sent AWS a log destination of `undefined:*`, which AWS turns down (found in the lab).
  - The `StepFunctions` integrations and `Cron`'s `task` take the V5 components.
  - `nodes` has what SST 4's left out: `StepFunctions`'s role and log group, `Cron`'s permission and role, the identity pool's attachment, `Realtime`'s authorizer permission.
  - `ApiGatewayWebSocket` refuses a JWT authorizer when the app runs, where SST 4's failed in the deploy (API Gateway doesn't take one on a WebSocket API), and `nodes.domainName` is `undefined` without a domain, where SST 4's threw.
  - The docs' examples were fixed: the `choice` example gives each `lambdaInvoke` a function and has its missing comma.

**Checked:** `tsc`, all platform tests, and the seven docs pages. Each component takes over SST 4's in its cases: 192 tests in the seven files.

**Reviewed.** No state bug left. Fixed from it:

- the missing maps, above;
- `ApiGatewayWebSocket`'s authorizer, whose old name SST 4 didn't pass through `logicalName`;
- a route called `default` beside `$default`, which had the same old name;
- SST 4's `transform.function` on a `Workflow`, which was dropped without a word;
- docs slips, and tests for what wasn't tested.

**Checked in the lab** (a stage of its own, no VPC). The seven, with a 4.x `Queue` for a state machine to send to: a standard state machine that invokes a function and sends to the queue, an issuer with its table, a WebSocket API with a Lambda authorizer on `$connect`, a realtime server with a subscriber, a cron job, an identity pool and a workflow.

- **Deployed with SST 4**, and called: the state machine ran both tasks; the issuer answered with its storage; the WebSocket refused a client without the token and ran `sendMessage` for one with it; the realtime subscriber got a message published to its topic; the rule, the pool's two roles and the workflow's durable version were in AWS.
- **`sst migrate --check`** with a new state machine added refused it: "add it after the move". Without it, it passed:
  - 109 resources kept, 46 at a new address and 6 updated in place;
  - 6 components taken out, with nothing in the cloud behind them (the routes', the authorizer's and the subscriber's);
  - 6 replacements: functions' code, uploaded again under a new key where the function's name changed.
- **The move** kept 79 of the 85 resources in AWS by id, 40 of them under a new name. The other 6 were those code objects.
- **The same answers before and after,** on every call above.
- **`sst diff` after the move:** no changes.
- **After the move,** a 5.0 `StepFunctions` with `logging: false` deployed, with logging off, and its express machine ran.
- **`sst refresh`** changed no resource, and `sst diff` after it showed no changes.
- **Removed, and cleaned up:** the stage's 127 state versions and markers, its `migrate` copy among them, its passphrase, and 14 source maps the SST 4 functions left. Nothing of it is left in IoT, Step Functions, Cognito, EventBridge, API Gateway, Lambda or IAM. The cleanup after the framework sites' check had missed 32 of its stage's state files; they're deleted too.

## 2026-11-02: step 4, the six framework sites built the 5.0 way, and their lab check

The maintainer decided that every component gets a 5.0 form, so these come first: the sites on the base the `Nextjs`, `Astro` and `SvelteKit` share.

**Done, committed (not pushed):**

- **`TanStackStart`, `Nuxt`, `SolidStart`, `Analog`, `Remix` and `React`** (`aws/v5/`), each `createSsrSite()` with its framework's reader of the build. The args and docs are SST 4's, with the examples on `sst.aws.v5`, a "Switch from" section, and takeover maps from `ssrSiteTakeover()`. All six are on the clean break's list. `TanStackStart` keeps SST 4's type, `sst:aws:TanstackStart`, with its small "s".
- **Shared:**
  - `readNitro()` in `helpers/nitro.ts` reads the four Nitro builds and refuses one without the `aws-lambda` preset, in either of Nitro's spellings.
  - `configText()` in `helpers/site-build.ts` reads a config file in any extension.
  - A framework whose build has no versioned folder says `versionedFiles: false`. Then `invalidation.paths: "versioned"` makes no invalidation, as in SST 4; the base had failed the deploy instead.
  - `Remix` is made from its args, as `Nextjs` is, so `buildDirectory` is checked as a plain value.
- **Better than SST 4,** each change listed in its component's "Switch from":
  - TanStack Start's base path is read where builds with Nitro 3 put it, `.output/server/_ssr/ssr.mjs`, as well as where earlier builds did. SST 4 read only the earlier place, so a site under a router's `path` didn't deploy with a current TanStack Start.
  - Config files are read in any extension. SST 4 failed without the `.ts` one.
  - Nuxt and Analog refuse a build without Nitro's preset, which has no Lambda handler.
  - Analog's server streams when Nitro says so.
  - Remix doesn't load Vite after the build only to check its config.
  - React's base-path errors are the kind the CLI shows plainly.
  - TanStack Start's advice on the preset looks in the site's own folder.
- **Kept as SST 4 had it:** Nuxt's `_nuxt` isn't marked as versioned. Its `builds/latest.json` isn't hashed, and a year's cache would break Nuxt's check for new builds.
- **The mock** links the platform's `functions/` folder into its own platform folder (a junction on Windows), so a component that reads its files there, as `Remix` and `React` do, can be tested.

**Checked:**

- `tsc`, all 3,083 platform tests, and the six docs pages.
- Each site takes over SST 4's in the shared suite's setups, each three ways, plus its own: streaming, React's SPA mode, and Remix's build directory. Nothing changes but Analog's URL with streaming, which its docs list.

**Reviewed.** No state or path bug. Fixed from it:

- the mock's symlink, which Windows makes only with admin rights;
- Remix's `buildDirectory` doc, which had landed on `router`;
- React's "Switch from", which said `regions` lists the server from the start;
- two tests that passed without what they tested;
- `configText()`, which now resolves against the app's folder;
- three messages and docs slips;
- three errors that weren't tested.

**Checked in the lab** (a stage of its own, no VPC, with a CLI built from the branch). The six came from SST's examples. Each is linked to a bucket its page signs an upload URL for. Five sit at their root on subdomains of a 4.x router; React has a distribution of its own.

- **Deployed with SST 4.**
  - Three of the examples needed `--legacy-peer-deps`.
  - Two needed a newer Vite than their ranges allow: TanStack Start 1.169 wants Vite 8, and Analog 1.22 calls Vite 6.
  - Analog's example fails its own render (Angular's `NG0210`, `document is not defined`) with the Angular its ranges install. Its server answers through Nitro, so it was checked as it was.
- **`sst migrate --check` passed:**
  - 148 resources kept, 12 at a new address and 2 updated in place;
  - only SST's file and key-value resources released;
  - one replacement: Nuxt's server code, uploaded under a new key, as each Nuxt build has a new build id.
- **The move** kept every resource by id but that code object, the six builder commands and SST's own resources, which came back under their new type. The other five servers' code was byte for byte the same, and so were all six servers' settings and key-value entries.
- **The same answers before and after**, on 18 paths:
  - each page, an asset and a missing page;
  - status and size, within the length of a signed URL's session token;
  - each server signing a URL for its link (Analog's aside).
  - One difference isn't the move's: Solid's missing page answered 200 once before and 404 since, with the same body. Its server started once, before the move, so the same container gave both; that's SolidStart's first render after a cold start.
- **`sst diff` after the move** shows only Nuxt's next build.
- **`sst refresh`** built none of the six and kept all 164 resources.
- **Removed, and cleaned up:** the stage's 109 state versions and markers, its `migrate` copy among them, its passphrase, and the two source maps of Remix's and React's servers. Nothing of it is left in CloudFront, ACM or Route 53.

## 2026-11-02: step 4, the lab check of the `StaticSite`, and two fixes to the move it found

**Checked in the lab** (a stage of its own, no VPC, with a CLI built from the branch). The lab app's sites group, with `Astro` and `SvelteKit` left out: the router with its two routes, `Nextjs` at its root, a `StaticSite` under `/static`, one with a distribution of its own that has an error page and a viewer response function, and a third one built into `dist` and served without edge routing, with an error page. Only the `StaticSite`s switched; the router, its bucket and `Nextjs` stayed SST 4's.

- **Deployed with SST 4.** The first `sst migrate --check` failed, but not on the static sites: on the `Nextjs` the stage kept, whose ISR seed SST 4 calls again on every deploy (its trigger is the time of the deploy). Fixed (below); then it passed: 113 kept, 6 replaced (the `Nextjs`'s code and its seed, as any deploy of it does), 5 released (the static sites' files and key-value entries), 8 created.
- **The move** kept every resource of the static sites by id: buckets, distributions, their functions and key-value store, the router's entry, and both origin access controls. Only SST's resources for their files and entries were written again by the binary's, and the built site's build command left the state.
- **But the marker it left was wrong:** it listed `sst:aws:Bucket` as moved, from the 5.0 buckets inside the 5.0 static sites, so the next `sst diff` refused the router's own bucket, which the stage kept in SST 4's form. Fixed (below). The stage was put back with the copy `sst migrate` saved, as a move that went wrong is undone, and moved again with the fix: the marker lists `sst:aws:StaticSite` and not `Bucket`, `Router` or `Nextjs`.
- **The same answers before and after**, on 14 paths: the routed site's pages and its fallback, the standalone site's pages with the response function's header and its 404 page, and the built site's pages, its error page for a missing file, and its 404s.
- **`sst diff` after the move** shows no change to the static sites; only the SST 4 `Nextjs` building again, as it does on every run.
- **`sst refresh`** built none of the static sites and kept all 127 resources in the state. The SST 4 `Nextjs` built, as SST 4's sites do for a refresh.
- Removed, and cleaned up: the stage's 170 state versions and delete markers, its `migrate` copies among them, and its passphrase. It left no source maps, and nothing of it is left in CloudFront.

**Fixed:**

- **A move lets through a Lambda invocation any deploy calls again** (`calledAgain()` in `pkg/move/check.go`): one replaced for nothing but what it's keyed on, when that's the time of the deploy, in its `triggers` or its `input`, as SST 4 seeds a Next.js site's ISR data and warms a site's server and an app runs its migrations; or when it's right under one of SST's components and keyed on one `version`, as the 5.0 sites key the same calls on what they run. It extends the decision that what any deploy changes isn't the move's doing.
- **A component kept in SST 4's form at the top of the app isn't listed as moved**, even when one of SST's 5.0 components has its 5.0 form inside it (`createdVersions()` in `move.ts`). That one moves with the component it's in, as the marker's rules say.

**Reviewed** (both fixes). Fixed from it: the first form of the invocation rule took only SST 4's time-keyed calls, so a later move on a stage with a 5.0 `Nextjs`, whose seed most builds re-key, would have been refused; and it took an app's own invocation keyed on the time in its `triggers` but not in its `input`, as SST's migrations example writes it. The marker's test now covers the next plain deploy, which the old code also got wrong through the record of versions, and the move that switches the app's own bucket. Left, and written down in `move.ts` and `PORTING.md`: until that move, a 5.0 component inside one of SST's whose type the app keeps in SST 4's form gets its first map's aliases on each run. They only match what's already its own, so it's harmless while the maps of the components that are nested only move parts. The exact model, a nested component following its parent's version, is left for later, with a nested component's own version, which a plain deploy moves today.

## 2026-11-02: step 4, the `StaticSite` built the 5.0 way

**Done, committed (not pushed):**

- **The `StaticSite`** (`aws/v5/static-site.ts`) with its own args, docs and parts, on the clean break's list. It isn't on `createSsrSite()`: it has no server, no framework, and serves its files itself. What it shares with the sites with a server: `buildSite()` for its `build`, `routeOf()` for a router, the 5.0 `Cdn` and `Bucket`, `kvNamespace()`, and the code of the viewer request function that routes it, out of `createSsrSite()` into `siteRequestCode()`.
- **Built the 5.0 way:** nothing created inside an `apply`. What decides what's created is a plain value: `build`, `vite`, `indexPage`, `errorPage`, `edge`, `edgeRouting`, `router`, `invalidation` and `assets.bucket`. A `build` runs in the deploy and in `sst diff`, once, and not for `sst refresh` or in `sst dev`.
- **What it keeps of SST 4's:** the bucket, the distribution, its functions and key-value store, its entry in a router, and the origin access control, which SST 4 created with a resource of its own provider when the site serves from its bucket (with an `errorPage`, or `edgeRouting: false`). The V5 site creates the same resource, under the same name, so it's kept by its id; it moves into the `sst` binary with the rest of SST's own resources, one by one.
- **What a move releases:** the site's files and its key-value entries, written again by the `sst` binary's resources, as for the other sites. The bucket an `assets.bucket` names was looked up with a resource; the V5 site looks it up with a function, and a move drops the lookup from the state, which changes nothing in AWS.
- **What's written differently** is in its "Switch from" docs: `route`, `base`, `cdn` and `edge`'s `kvStores` are gone and refused; `assets.textEncoding` is applied, where SST 4 ignored it; Vite's types are written once the keys of `environment` are known; an object `transform.cdn` is merged with the site's cache behavior.
- **The sites with a server's docs:** `sst migrate` previews the move first, so it builds a site twice, as a deploy on a stage with checks does. The three sites' docs say so now.
- **`PORTING.md`:** a resource 4.x looked up under a component for a value is looked up with a function, as the V5 `Efs` already did. The rule had said to keep 4.x's lookup in the state.

**Checked:** `tsc`, all 2,640 platform tests, and the docs page. The `StaticSite` takes over SST 4's in 24 setups, each three ways: on its own distribution, built, with an error page (at the bucket's root and under a path in it), without edge routing (with an error page, edge code and its own index page; with a domain; with only a viewer response function), with a domain that redirects, with a domain, edge code and its own index page, with a domain of its own DNS and an error page, with edge code on the user's store, in a bucket it's given (on its own, without edge routing and with an error page, and behind a router), with file options and routes, with a text encoding (its files' `Content-Type` changes, as the docs say), without invalidation, invalidating some paths and none, behind a 4.x Router (built, under a path in the bucket) and a V5 one under a path and a domain, and with its parts transformed. The recorded `Static` and `Standalone` sites are taken over with nothing changed. A new stage's preview plans everything a deploy creates, builds without what isn't known, and writes Vite's types with every key.

**Reviewed.** It found one change to what's deployed: SST 4 gave the viewer response function the first of `edge.viewerResponse.kvStores`, which the V5 site dropped without a word. `kvStores` is refused now, on both functions, with what to write. Also from it: the docs of three parts made exact; `assets.purge` and an empty `path` read as SST 4 read them; the "Switch from" section names the build's environment, `nodes` in `sst dev`, what `transform.cdn` is given, and an `injection` given as an output that turns out empty; and tests of the cases above it found missing, an object `transform.cdn`, `dev: false` in `sst dev`, and a new stage's preview.

## 2026-11-02: step 4, the lab check of the sites with a server

**Checked in the lab** (a stage of its own, no VPC, with a CLI built from the branch). The lab app's sites group: a V5 `Router` with a domain, `Nextjs` at its root, `Astro` and `SvelteKit` under `/astro` and `/svelte`, a `StaticSite` under `/static`, a route to a URL and one to a bucket, and a `StaticSite` with a CDN of its own. `Nextjs`, `Astro` and `SvelteKit` switched at once; both `StaticSite`s stayed 4.x.

- **Deployed with SST 4.** `sst migrate --check` passed: 126 kept (16 at a new address, 8 updated in place: 6 functions for their code and the 2 invalidations), 8 replaced (6 functions' code and a source map, uploaded again under new keys, and the ISR seed run once more, as the maps say), 11 released (each site's files and key-value entries, the router's two route entries, and SST 4's three lookups of the hosted zone), 7 taken out of the state with nothing in the cloud behind them (the sites' build commands among them), and 11 created.
- **The move** kept every resource by id but the code objects. The sites' files and entries, and the router's, are kept under new names.
- **The same answers before and after**, on 15 paths through the router's domain: each site's pages, assets and 404, the static site, and the two routes. A body that differs is one each build makes again: Next.js's pages, SvelteKit's version file. The Next.js image optimizer answers 500 before and after, and the bucket route 403: both as SST 4 deployed them.
- **`sst diff` after the move** shows what SST 4's own diff shows for these sites: their code, files and invalidations, made again by each build.
- **`sst refresh` built no site** and kept all 145 resources in the state: Pulumi keeps what the program doesn't register when it refreshes, as the change for refresh needed. SST 4 builds its sites for a refresh, so the three sites' docs now say a refresh is one place they differ.
- Removed, and cleaned up: the stage's 156 state versions and delete markers, its `migrate` copy among them, its passphrase, and two Astro source maps in the asset bucket. Nothing of it is left in CloudFront.

## 2026-11-02: step 4, the `Astro` and the `SvelteKit` built the 5.0 way, on the sites' base

**Done, committed (not pushed):**

- **The `Astro`** (`aws/v5/astro.ts`) is a call to `createSsrSite()` with Astro's build: what the "astro-sst" adapter says in `dist/sst.buildMeta.json` becomes the site's plan, and its server when it has one (the adapter's entry, `sharp` installed, streaming as the adapter says, and the 404 page copied in). A static site has no server, so its servers are listed once the build says there is one. Its own args and docs, and on the clean break's list.
- **What the review of the base found, for it:** a site whose framework has no build command of its own builds with its `build` script, run by the package manager whose lockfile is in the site's folder or the app's (`defaultBuildCommand()` in `helpers/site-build.ts`), as SST 4 does. A framework's `beforeBuild` runs before every build, a command given or not: the `Astro`'s check that SST's adapter 3.x isn't building an Astro 6 app.
- **The takeover map's shared part** (`ssrSiteTakeover()` in `takeover/ssr-site.ts`): the warmers moved out of their `Cron`s, the files and key-value entries released, and the prewarm made again once. The `Nextjs`'s map is that and its ISR seed.
- **The 404 page is copied from a path from the app's folder.** SST 4 joined the site's path to it as given, which is the same path for a site's folder given from the app's, and broke for one given as an absolute path.
- **The `SvelteKit`** (`aws/v5/svelte-kit.ts`) the same way: the adapter's manifest gives the base path, its `adapter.json` whether the server streams, and the server is the adapter's handler with the prerendered pages copied in. SST 4 gave `minify` in the server's `esbuild` options, which the CLI doesn't read there, so the server was never minified; it's given the same way, so the server is built from the same args, and still isn't.
- **A site isn't built for `sst refresh`**, which runs the program but creates nothing: what's made from the build isn't registered, and stays as it is. (This entry first said SST 4's sites weren't built for it either. They are, since v4.1.4: their program can't run without the build.) A lab check of the sites runs a refresh to confirm Pulumi keeps what isn't registered.
- **A site's build doesn't see what the CLI passes for SST's own calls to Cloudflare**, as SST 4's builds didn't. `buildSite()` passed them on, the `Nextjs`'s included.
- **One suite for the sites** (`test/components/v5/ssr-site.suite.ts`): the takeover cases and the tests every site passes, out of the `Nextjs`'s, run by `nextjs.test.ts`, `astro.test.ts` and `svelte-kit.test.ts` with their own. The `Astro`'s own: a static site, kept warm or not, and under a router's path, a streaming server, its server's entry and files, the default build command, the adapter check, and an adapter too old. `buildSite()` and the default build command have tests of their own.

**Checked:** `tsc`, all platform tests, and the two docs pages. The `Astro` takes over 4.x's in 21 setups and the `SvelteKit` in 18, each three ways. The recorded Astro site and SvelteKit app, behind the router under `/astro` and `/svelte`, are taken over with nothing changed: only the command that built each goes, and their servers are removed in the same order as the `Nextjs`'s.

**Reviewed:** the `Astro`, and the base's hooks for it; then the `SvelteKit`, the refresh and the credentials. Fixed from them: the CLI's Cloudflare credentials, the refresh, and tests of a static site under a router's path and of SvelteKit 3's spelling of its manifest. The three sites' docs say a refresh doesn't build them. A site's folder given as an absolute path gives its server's files another path than SST 4 did, which joined it to the app's folder and couldn't deploy it. The `SvelteKit`'s tests run in the app's folder, with each site's folder given from there: SST 4 copies a server's files from the app's folder joined with it.

## 2026-11-02: step 4, one base for the sites with a server, out of `Nextjs`

**Done, committed (not pushed):**

- **What every site with a server creates is in `helpers/ssr-site.ts`**, as the databases' is in `helpers/rds-instance.ts`: the shared parts (`ssrSiteParts`), the shared args (`SsrSiteArgs`), and `createSsrSite(this.builder(), name, args, framework)`, which creates the site from its build: the bucket and its files, the server in each region with its warmer and the permissions to call it, the distribution or the route through a router, the key-value entries and the invalidation, and in `sst dev` the pane the site runs in.
- **A framework says what's its own** (`SsrFramework`): the command that builds the site when it isn't given one, how its build is read (a `SiteBuild`, with the plan of what's served from S3 and from the server, and whether it has a server), how the server is built (a `ServerPlan`, which the site's own `environment`, `permissions`, `link`, `layers` and `server` args are merged into, as SST 4 merges them), and what it creates beside the server. `Nextjs`'s is OpenNext's build command, ISR's queue, table and seed, and the image optimizer. With a build id, the prewarm is keyed by it; without one, by the server's code.
- **`Nextjs` is a call to it now**, and its file is about 780 lines shorter.
- Committed first, on their own: the shared parts and args, `after()` and `willCreate()` on `PartsBuilder`, and the docs generator following a spread of shared parts.

**Checked:** `tsc`, all platform tests, and the `Nextjs` docs page, the same before and after. A dump of every resource `Nextjs` registers, with its inputs, options, parent and what its functions are built from, is the same before and after in six setups: plain; two regions with `warm`, a domain and most args; behind a signing V5 `Router` under a path; signed by an edge function; ISR off; and `sst dev`.

**Reviewed:** nothing `Nextjs` deploys or reports changes, and its args are read in the same order. The base merges a `ServerPlan` with the site's args as SST 4 does for `Astro` and `SvelteKit`. Fixed from it: where a plan puts its files in the bucket loses a slash around it, as SST 4 trims it. The plan is made ready once, as the build is read, without changing the framework's own. Left for `Astro` and `SvelteKit`, from the review:

- A default build command when the site isn't given one, from the app's lockfile, as SST 4's sites pick `npm`, `yarn`, `pnpm` or `bun`.
- `Astro`'s check of its adapter runs before every build in SST 4, a given `buildCommand` or not; a framework needs a hook for that, which `check` isn't: it runs before the build command is known, and isn't given the site's path.
- A framework can't set its server's default timeout (SST 4's plan could); neither framework does.
- With `warm`, their server is warmed again when its code changes, where SST 4 warmed it on every deploy: their switch docs say so.

## 2026-11-02: step 4, the lab check of the load balancers' domains, with the containers group

**Checked in the lab** (a stage of its own, the only one with a VPC, with a CLI built from the branch). The lab app's containers group: a `Service` with a load balancer and a domain of its own, an `Alb` with a domain and a `Service` on it, a `Task` with a `CronV2`, an `Efs`, and a function in the VPC that mounts the file system, all switched at once with the `Vpc`.

- **Deployed with SST 4.** `sst migrate --check` passed: 110 kept (16 at a new address, nothing updated in place), 1 replaced (the bastion, which the 5.0 `Vpc` gives one image, as its docs say), 6 released (SST 4's lookups of the hosted zone), 5 taken out of the state with nothing in the cloud behind them (4.x's version markers and the `DevCommand`s of services without a command), and 3 created.
- **The move** kept every resource by id but the bastion. Each DNS record kept its id: both domains' alias records, and both certificates' validation records under their new names. Then `sst diff` showed no changes.
- **The same answers before and after:** the service's page through its domain and its redirect to https, the `Alb`'s domain, and the function's count of visits in the file system, which went on from where it was.
- Removed, and cleaned up: the stage's 144 state versions, its passphrase, a source map and three inactive task definitions. The asset registry holds one build cache, `Web-cache`, pushed hours before this stage; its tag names the component, not the app, so it was left.

## 2026-11-02: step 4, the lab check of the serverless group with today's components

**Checked in the lab** (a stage of its own, no VPC, with a CLI built from the branch). The lab app's serverless group: a `Bucket`, `Queue`s, an `SnsTopic`, a `Dynamo`, a `CognitoUserPool` with a trigger and a client, a `Function` with a URL, an `ApiGatewayV2` with a domain and a Lambda authorizer, an `AppSync` with a Lambda data source, a `CronV2`, a `Bus` and an `Email` whose sender is a domain, all switched at once.

- **Deployed with SST 4**, with a CLI from before the refusal of SST 4's form on a new stage. `sst migrate --check` passed: 158 kept (99 at a new address, 11 functions updated in place for their code), 9 replaced (the functions' code, uploaded again under new keys), 7 released (SST 4's lookups of the hosted zone), 14 taken out of the state with nothing in the cloud behind them, and 3 created (SST's provider, the marker and the record of versions).
- **The move** kept every resource by id but the functions' code. Each DNS record kept its id: the API's alias records and its certificate's validation record, the `Email`'s DMARC record, and its three DKIM records, now named after their place, each under the name made from its own token before. Then `sst diff` showed no changes.
- **The same answers before and after:** the function's links, the API's routes through its domain with and without the authorizer's token, and the domain's DKIM still verified by SES.
- Removed, and cleaned up: the stage's 116 state versions (with two delete markers an earlier cleanup left in the state bucket), its passphrase, and the 12 source maps 4.x's functions leave in the asset bucket. The SES identity and the domain's records are gone. What the tagging API still lists was checked directly, and is gone.

## 2026-11-02: step 4, the `Service` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/service.ts`): what it took from 4.x's (`dev`, `serviceRegistry`, `capacity`, `health`, `wait`) is its own now, on the `FargateBaseArgs` it shares with the `Task`, and it's on the clean break's list. The 4.x `Alb` it can share is reached through `helpers/alb.ts`, which takes either kind; any other `loadBalancer.instance` is refused, where 4.x ignored it.
- **Its panes in `sst dev` are SST 5's `DevCommand`**, one for each container with a `dev.command`, created directly where they were created inside an `apply`. `sst dev` ran nothing for a container without a command, so none is created for it. SST 5's `DevCommand` takes the role the command runs as (`aws.role`, internal, as SST 4's had) and reads `context()`.
- **It reads `context()`** for `sst dev`, the app and the stage, not `$dev` and `$app`.

**Checked:** `tsc`, the docs page, and all platform tests. The tests that compare what `sst dev` runs read SST 4's `_dev` and SST 5's report alike, and compare only in `sst dev`, where SST 5's `DevCommand` reports.

**Reviewed:** nothing in AWS changes on switch, each pane has the same command, directory, autostart, title, links, environment and role, and the args are read as 4.x read them. Fixed from it: a container whose `dev.command` is empty has no pane, as one without, where SST 5's `DevCommand` would have refused it.

## 2026-11-02: step 4, the `Alb` built the 5.0 way, and the load balancers' domains

**Done, committed (not pushed):**

- **The `Alb`'s own args and docs** (`aws/v5/alb.ts`), with no 4.x component file reached, and on the clean break's list. Its `vpc` is either kind of `Vpc` or the ids; any other resource is refused, where it was read as the ids.
- **A load balancer's domain on the 5.0 certificate and adapters.** `helpers/load-balancer-args.ts` builds `loadBalancerDomain()` (renamed from `domainOf()`, which is `helpers/domain.ts`'s) on `domainOf()`, and points the domain and its aliases with the adapters' `alias()`. The `Service`, which shares it, has its domain on them too, ahead of its rebuild, with its docs saying so.
- **`helpers/custom-domain.ts` is gone**: nothing uses SST 4's adapters through it now.

**Checked:** `tsc`, the docs pages, and all platform tests, with the `Alb` switched with its `Vpc`, the `Alb`'s and the `Service`'s domains on Route 53, with aliases, taking over 4.x's, a resource refused as the `vpc`, and a domain's name refused as an output. The tests' own certificate mocks gave ACM one validation record for any domain; they use the shared mock now, which gives one for each, so a domain with an alias and a wildcard has the two records 4.x made for it.

**Reviewed:** the certificate, its records, the alias records on each adapter, the load balancer, its listeners and its security group keep their 4.x names and inputs, for the `Alb` and the `Service`, and the new record count is 4.x's. Fixed from it: an `Alb` with an https listener and no domain is refused as the config is read, as a `Service` is, where AWS refused it on deploy.

## 2026-11-02: step 4, the `Email` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/email.ts`), with no 4.x component file reached, and on the clean break's list.
- **Its DNS records on the 5.0 adapters, none created inside an `apply`.** 4.x created a domain's DKIM records once SES had given the identity's tokens, named after them, so a preview of a new stage showed none. The V5 one creates the three directly, named after their place (`dkim1` to `dkim3`), with the tokens in order as their values; its map gives each its old name from the token, as the certificate's does. The DMARC and MAIL FROM records keep the names they had, since those are known up front.
- **A DKIM key of your own** (set through `transform.identity`) gives no tokens, so `dkim: false` says not to create the DKIM records, and the domain's other records are still created, as 4.x did. Without it, a deploy says to set it.

**Checked:** `tsc`, the docs page, and all platform tests, with a domain on Route 53, Cloudflare and Vercel taking over 4.x's, its MAIL FROM records on Cloudflare, and the DKIM records' names. The recorded serverless group found the tokens secret: the identity's `dkimSigningAttributes` can hold a signing key, so Pulumi keeps the whole of it secret, and the records' names would have been too. The tokens go in public DNS records, so they're read with `unsecret()`.

**Reviewed:** every resource and record keeps its 4.x name on each adapter, and the DKIM map gives each key the record of its token whatever order SES gives them in. Fixed from it: a stage signing with its own key was told to set `dns: false`, which would have removed its DMARC and MAIL FROM records; it's `dkim: false` now, which leaves them. The test's tokens come out of order, and a stage signing with its own key takes over 4.x's.

## 2026-11-02: step 4, the `CognitoUserPool` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/cognito-user-pool.ts`): the user pool's, its triggers', an identity provider's, and its client's (`aws/v5/cognito-user-pool-client.ts`), with no 4.x component file reached. Both are on the clean break's list.
- **Its custom domain on the 5.0 certificate**, in `us-east-1` as Cognito's CloudFront needs, and the DNS adapters, through `domainOf()`. A prefix domain is as it was.
- **Each trigger's handler or function args are a plain value**, as `triggers` already was; a function you already have, or its ARN, can be an output.

**Checked:** `tsc`, the docs page, and all platform tests, with the domain on Route 53, Cloudflare and Vercel taking over 4.x's, the certificate's provider in `us-east-1`, an output refused for a trigger's handler, and a function's ARN taken as one.

**Reviewed:** the user pool's settings, each trigger, the domain, clients and identity providers match 4.x's. Fixed from it: 4.x created an identity provider beside the user pool with only a `provider` passed to it, so a user pool that takes its provider from a parent or `providers` has its identity providers replaced on switch. The docs and the plan say so now, with a test that pins it, and say what a `get`'s `parent` reaches, and that `nodes.userPool` is the user pool, not an output.

## 2026-11-02: step 4, the `AppSync` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/app-sync.ts`): the API's, and a data source's, an AppSync function's and a resolver's, with no 4.x component file reached, and on the clean break's list. Two of 4.x's examples named the wrong field (`requestTemplate` for an AppSync function's `requestMappingTemplate`, and the same for the response); they're right now.
- **Its domain on the 5.0 certificate**, in `us-east-1` as AppSync needs, and the DNS adapters, through `domainOf()`, as the `ApiGatewayV2`'s is. The certificate's map gives its validation records their old names.
- **A Lambda data source's handler or function args are a plain value**; a function you already have, or its ARN, can be an output.

**Checked:** `tsc`, the docs page, and all platform tests, with the domain on Route 53, Cloudflare and Vercel taking over 4.x's, an output refused for a data source's handler, and a function's ARN taken as one.

**Reviewed:** every data source kind, role, AppSync function, resolver and the domain match 4.x's, with the map's names. Fixed from it: the docs and the plan said only a `provider` given to the API replaced anything on switch. 4.x created a data source's, function's and resolver's resources beside the API with only that `provider`, so an API that takes its provider from a parent or `providers` has those replaced too. The docs of the `ApiGatewayV2`, the `AppSync` and the `CognitoUserPool` now say a function's args are the 5.0 `Function`'s, as the `Queue`'s do.

## 2026-11-02: step 4, the `ApiGatewayV2` built the 5.0 way, and one domain helper

**Done, committed (not pushed):**

- **One helper for a custom domain built the 5.0 way** (`helpers/domain.ts`): `DomainArgs`, with its docs, and `domainOf()`, which checks that the name and the DNS adapter are plain and that there's a `cert` without one. The `Cdn`'s domain builds on it, so the checks are in one place. The components that aren't rebuilt yet keep SST 4's adapters through `helpers/custom-domain.ts`, which goes with the last of them.
- **The `ApiGatewayV2`'s own args and docs** (`aws/v5/apigatewayv2.ts`), with no 4.x component file reached, and on the clean break's list. Its domain uses the 5.0 certificate and the DNS adapters, as the `Cdn`'s does: the certificate's map gives its validation records their old names, and SST 4's lookups of the hosted zone leave the state.
- **What creates a function is a plain value:** a route's handler, and an authorizer's `lambda` with its `function`. A function you already have, or its ARN, can be an output, as for the `Bucket` and the others.
- **Its `vpc` is either kind of `Vpc` or the ids**, with the VPC link in a `Vpc`'s public subnets, as 4.x put it. Any other resource is refused.
- **What 4.x took and 5.0 doesn't is refused with what to write:** `domain.nameId` (now `existing.domainName`) and `transform.route.args` (a route's `auth`, or `authorizationType` in `transform.route`), with a route's and an authorizer's own `transform`, which were already.

**Checked:** `tsc`, the docs page, and all platform tests, with the API switched with its `Vpc`, the domain on Route 53, Cloudflare and Vercel taking over 4.x's, a V5 `Vpc`'s public subnets, a resource refused as the `vpc`, outputs refused for a handler and an authorizer, and a function's ARN taken as one.

**Reviewed:** every part, route and authorizer resource matches 4.x's, and the 5.0 adapters name the alias and CAA records as SST 4's did, with the same parent. Fixed from it: the docs say Cloudflare's `ZoneLookup` leaves the state too, and tests for a `cert` with the default DNS, a domain's checks, and a `name` given as an output. Left: the load balancers' own `domainOf()` in `helpers/load-balancer-args.ts`, which goes when the `Alb` is rebuilt.

## 2026-11-02: step 4, the `Dsql` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/dsql.ts`), with no 4.x component file reached, and on the clean break's list. Its `vpc` is either kind of `Vpc`, alone or as `vpc.instance` with the endpoints to create, and the endpoints are in its private subnets read with `subnetsOf()`. Any other value is refused with what to pass, where it failed on a missing property.
- **A witness region that's the peer region is refused** when both are plain, where AWS refused it on deploy.
- **`id`**, the cluster's identifier, which `get` asks for and had no getter, and **`DsqlGetArgs`** with its docs. A peer's id can be an output.
- **The peer region's vault gets the component as its parent in the options its transform sees**, as the vault in the app's region does and as 4.x gave both.
- **The provider for another region is made once in each run** (`useProvider()`, shared with 4.x), as the rule for what an app shares says. The CLI runs the program once in each process, so nothing changes there; under the mock, a test saw the provider an earlier test had made, and one test's expectation was wrong because of it.

**Checked:** `tsc`, the docs page, and all platform tests, with a V5 `Vpc`, a `vpc` that isn't one, the witness check, the peer vault's options, and a peer id given as an output.

**Reviewed:** every resource matches 4.x's, in every combination of `regions`, `vpc` and `backup`, with the three renames in the map, and `perRun()` changes nothing for the CLI, since no caller of `useProvider()` runs before the run starts. Fixed from it: a takeover case where the cluster switches with its `Vpc`, as an app moves, and a note in `PORTING.md` that said the provider was made once in a process.

Left: a lab check. The single-region cluster in a VPC, which the October lab run and the VPC recording cover, deploys the same; what's renamed (the peering's two sides and the peer region's vault) is multi-region, and needs a second region in the lab account.

## 2026-11-02: step 4, the rest of the review's fixes

**Done, committed (not pushed).** The smaller fixes the [review](plan.md#decisions) asked for:

- **The clean-break test follows imports through helpers.** A rebuilt component reaches 4.x's code only through a helper that takes either kind, which the test lists with the 4.x file each may import. It found one more: the `Task`'s container `health` and `dev` were typed by the 4.x `Service`'s args, and are its own now.
- **The rebuilt components read `context()`**, the program contract, for the app, the stage, `sst dev` and the paths, as a package's components do, not `$app`, `$dev` or `$cli`.
- **The README is the guide to writing a component**, about 270 lines, and the rules and checklist for porting SST's 4.x components are in `PORTING.md` beside it, which goes once 5.0 has none.
- **`v5-community-packages` is merged in**: the template package, the components in tiers, and the template's job in the checks. Its tests pass against `sst` packed from this branch.
- **The public API**: `sst.linkable`, deprecated in 4.x, is gone for `sst.Linkable.wrap`, and `V5Args`, which wraps 4.x args, isn't exported. `sst.Component` and `sst.x` stay until the swap.
- **The swap** from `aws/v5/` to `aws/` is a step of its own in step 5, with the 4.x files kept frozen under `test/fixtures/v4/` for the takeover suites, and an exit test.

**Reviewed**, the RDS base: no change to what either database deploys, every old test kept, and every generated page byte for byte the same. Fixed from it: a local Aurora's port given as an output that's undefined, and the docs generator's following of shared parts.

Left from the review: a shared base for the sites, out of `Nextjs`, before `Astro`, `SvelteKit` and `StaticSite`; and, for the maintainer, what happens to each Kept, Community and Cloudflare component.

## 2026-11-02: step 4, one base for the databases on an RDS instance

**Done, committed (not pushed).** The second fix from the [review](plan.md#decisions): the `Postgres` and the `Mysql` differed in 48 of their 873 lines, and their tests in 57 of 827, so a fix was made by hand in each, as several were the same day.

- **`helpers/rds-instance.ts` builds either**: the parts, the args that read the same for each, and the whole of what the constructor does, from the engine's settings (`RdsEngine`: its name, defaults, parameter group, Performance Insights, the tags 4.x writes, the proxy's engine family). Each component keeps its class, its docs, its getters and `get`, and the args that read differently for it (`version`, `username`, `dev`). Each is about 400 lines now.
- **`localDatabase()`** in `helpers/rds.ts` is what `sst dev` connects to and the pane for it, for the `Postgres`, the `Mysql` and the `Aurora`.
- **One suite of tests**, `rds-instance.suite.ts`, which each engine's file runs with its own values, beside the tests only it has: its parameter group, and MySQL's Performance Insights.
- **The docs generator** follows `const parts = rdsInstanceParts` to the file that declares them, and no longer shows a type only a class's private field uses.

**Checked:** `tsc`, all platform tests (2,335): every test of the two components passed unchanged before the suite took their place, the takeover cases included, so they deploy what they did. The two pages have the same sections as before.

## 2026-11-02: step 4, an architecture review, and component versions

**The review.** Before the rest of the components, the maintainer asked whether the design still holds: the same functionality for developers, a codebase clearly more mature than 4.x's, and custom components still easy to write. An independent review and a read of the code found the design right, and what to fix, now a [decision](plan.md#decisions) with its order. The main one was a bug: an app's or a package's own component that renamed a part with `sst.takeover()`, as the README says to, was refused on a stage SST 5 created, as if it were SST 4's. And after one move, a later map was applied with no check.

**Done, committed (not pushed): component versions** ([decision](plan.md#decisions)).

- **Maps are numbered.** `sst.takeover(C, { version: 2, moved })`; version 1 takes over from a component's form before SST 5, and is the default. A component with no map is at version 1, SST 4's form at 0. A map's keys may be what a part was called in its version.
- **The state records each component's version** in `sst:sst:Versions`, left at the end of every deploy and waiting for everything it deployed, so it has what an app or a package registered as the program ran, components inside SST's own included, and a deploy that fails partway leaves the one before. The marker keeps saying the stage is on SST 5, with a list the record takes the place of. The core reads both, and tells the program which types the stage has only inside SST's components.
- **A stage behind a component's version is refused by a deploy and a diff**, and `sst migrate` moves it, applying every map from the stage's version on, following renamed keys through each, checked as the first move is. A stage ahead of it, deployed with newer code, is refused by a deploy, a diff and a move: deploying an older branch would delete what a move kept. A refresh and a remove run whatever the versions. Aliases are given only to a component that's behind, not on every deploy. A move's marker waits for everything it deploys, so a move that fails partway is run again.
- **For what components share, a helper can build parts on a component's behalf** with `this.builder()`, typed, without reaching into the component.

**Checked:** `tsc`, all platform tests (2,335), the Go tests. On a local Floci stage, nothing in AWS: an app's own component at version 1 deployed; version 2 refused by a deploy; `sst migrate --check` and the move kept the bucket under its new key; `sst diff` showed no changes; the record listed version 2; version 1 deployed again was refused and changed nothing. A first build deleted the moved bucket there, because only a component with a map was checked; every component is now. Removed, and the target's files deleted.

**Reviewed**, and fixed: a component inside SST's own got no aliases, since the core leaves those out of the stage's types; a map registered as the program ran was missing from the marker, so the next deploy refused the component; a move that failed partway left the marker with versions it hadn't reached; a move with older code wasn't refused. The decision's wording, and the README's note on a part declared with `sst.named()`.

## 2026-11-02: step 4, the lab check of the `Postgres`, `Mysql`, `Aurora` and `Redis`, with the `Vpc`

**Checked in the lab** (a stage of its own, the only one with a VPC, with a CLI built from the branch). The lab app's databases group: a `Postgres` with a proxy, a `Mysql`, a `Redis`, an `Aurora` and a `Dsql`, in a VPC with a NAT gateway in each AZ and a bastion, and a function linked to all five that says which properties each link gives it. The move switched the `Vpc` with them.

- **Deployed with SST 4**, then switched it all at once. `sst migrate --check` passed: 89 kept (11 at a new address), nothing updated in place, replaced or released, 3 taken out of the state with nothing in the cloud behind them (4.x's version markers) and the marker created.
- **The move** kept every resource by id: all 70 in the state, the databases' secrets under their new names among them. Then `sst diff` showed no changes, and the function's links gave the same properties as before.
- **In `sst dev`** on a stage of its own (`LAB_ONLY=panes`, nothing in AWS), the `Mysql`'s and the `Aurora`'s panes beside the `Postgres`'s and the `Redis`'s: the `Aurora` on MySQL with its engine's username and port, and its empty password shown as none.
- Removed, and cleaned up: 105 state versions and the passphrase of the stage, the proxy's log group and the function's source map; and the pane stage's 18 state versions and passphrase. The state bucket has no key of the lab app. Each resource the tagging API still lists was checked directly, and is gone.

## 2026-11-02: step 4, the `Mysql` and the `Aurora` built the 5.0 way

**Done, committed (not pushed):**

- **The `Mysql`'s and the `Aurora`'s own args and docs** (`aws/v5/mysql.ts`, `aws/v5/aurora.ts`), with no 4.x component file imported, and on the clean break's list. Their parts, and what each is created with, are the proofs of concept's, which took over 4.x's. Each takes either kind of `Vpc`, or ids, and refuses another resource in its place.
- **In `sst dev` with `dev` set, each reports the pane for the local database**, as the `Postgres` does, where 4.x created a `DevCommand` in every deploy, and `dev` wins over `existing`.
- **The `Aurora` reads a `Vpc`'s subnets and security groups as two outputs again**, as 4.x did, so its subnet group and proxy don't wait for the security group. The proof of concept read them as one. `subnetsAndSecurityGroupsOf()` in `helpers/vpc.ts` does it for the `Aurora` and the `Redis`, which had its own.
- **Docs:** 4.x's `Aurora` docs gave `scaling.min` a default of `0.5 ACU` where it's `0 ACU`, wrote the `database` example as `databaseName`, gave `dev.port` as `5432` whatever the engine, and spelled PostgreSQL "PostgresSQL"; the V5 page has them right. The `Mysql`'s local example mounted a folder MySQL doesn't keep its data in, and used MySQL's system database as the local one. The `Postgres`'s, the `Mysql`'s and the `Aurora`'s `version` say only what SST does to a deployed database's version, as 4.x's `Mysql` was changed to say on 2026-10-19.
- Breaking changes, in the plan's table: the `Mysql` and the `Aurora` added to the rows for `nodes` in `sst dev`, and the `Mysql` to the one for `proxyId`. Neither has a `.v1`.

**Checked:** `tsc`, all platform tests (2,318), the docs pages, and the site's build. Each takes over 4.x's in every case, with `dev` set in and outside `sst dev` (a secret password included, with nothing revealed), with a `Vpc` of either kind, and with the `Vpc` switched along with it: only, with `dev`, its dev command leaves the state. Neither was checked in the lab: their panes go through the helper the `Postgres` was checked with, and the recorded databases group, replayed under the mock, is taken over with nothing changed. A lab run of a real switch is left for one stage with a VPC for the three of them.

**Reviewed**, each; neither review found a bug. Fixed from them: the `version` wording the `Mysql` was given went back on what 4.x's was changed to say; the `Mysql`'s local example and its missing link to the full one; 4.x's `Aurora` docs gave `scaling.max` as at most 128 ACU and `pauseAfter` as at most an hour, where recent versions go higher and a pause can wait a day; a `transform.instance` function wasn't given the `Aurora` as the parent for its replicas, where 4.x gave it; the "Switch from" sections listed `dev` as newly plain, which 4.x already had as a plain object; the helper's comment and the rulebook's table of helpers. Tests added for `existing` with `dev` outside `sst dev`, in all three.

**Found:**

- RDS's standard support for MySQL 8.0 ended on 2026-07-31, so a new `Mysql` on the default `"8.0"`, in 4.x and V5, runs on RDS Extended Support, which is billed on top of the instance; the cost on the page doesn't say so. RDS's own default is 8.4 now. The Aurora MySQL default, `3.08.0`, passed its end of standard support on 2026-08-31, though RDS still creates it; its own default is 3.10. Changing a default only changes new databases: one that's deployed without a `version` is pinned. Left for the maintainer to decide.
- The `aws-mysql-local` example mounts `/var/lib/mysql/data`, where MySQL keeps nothing, so its data isn't kept between runs. It's SST's example; left as it is.

## 2026-11-02: step 4, the `Postgres` built the 5.0 way

**Done, committed (not pushed):**

- **The `Postgres`'s own args and docs** (`aws/v5/postgres.ts`), with no 4.x component file imported, and on the clean break's list. Its parts, and what each is created with, are the proof of concept's, which took over 4.x's. `vpc` takes either kind of `Vpc`, or subnet ids.
- **In `sst dev` with `dev` set, it reports the pane for the local database** with `localServerPane()`, where 4.x created a `DevCommand` in every deploy; a switch takes that out of the state. The password is still asked for in `sst dev` alone. A password from a secret stays a secret in the report, and the core reads it decrypted, as it read 4.x's.
- **`dev` wins over `existing` in `sst dev`**, in the `Postgres` and the `Redis`: with both, `sst dev` connects to the local server, as `dev`'s docs say. Before, it connected to the deployed one.
- **`assertVpcIds()`** in `helpers/vpc.ts` refuses another resource where a VPC's ids go. The `Efs`, `Cluster` and `Redis` each had the same check; they and the `Postgres` use it now, and `Mysql` and `Aurora` will.
- **`shownPassword()`** in `helpers/local-server.ts` shows an empty password as "[no password]". The `Redis`'s pane did that only for a password written as a string, not for one given as an output.
- Breaking changes, in the plan's table: `Postgres.v1` has no V5 form, `proxyId` fails as soon as it's read without a proxy, and in `sst dev` with `dev`, reading `nodes` says why a resource is missing where 4.x gave `undefined`.

**Checked:** `tsc`, all platform tests (2,283), the docs pages, and the site's build. The `Postgres` takes over 4.x's in every case, with `dev` set in and outside `sst dev` (a secret password included, with nothing revealed), with a `Vpc` of either kind, and with the `Vpc` switched along with it: only 4.x's version marker, and with `dev` its dev command, leave the state. In the lab, `sst dev --mode=mono` on a stage of its own (`LAB_ONLY=panes`, nothing in AWS): the `Postgres`'s pane, with its password from `$util.secret()` and the default username and database, beside the `Redis`'s, the 5.0 `DevCommand` linked to both, and SST 4's `DevCommand`. The pane's message was encrypted in the state. Removed, and cleaned up: 18 state versions and the passphrase. The audit is clean. No RDS database was deployed for this: the parts are the proof of concept's, and the recorded databases group, replayed under the mock, is taken over with nothing changed. A lab run of a real switch is left for when `Mysql` and `Aurora` are built the same way, one stage with a VPC for all three.

**Reviewed**, and fixed: in `sst dev`, reading `nodes` now fails where 4.x gave `undefined`, which the docs and the plan didn't say. With `existing` and `dev`, `sst dev` connected to the deployed database. Tests were missing for `dev` without a password outside `sst dev`, a secret password taken over in `sst dev`, and `sst dev` without `dev` reporting nothing; one test left resources unsettled. A stray space in an example subnet id, in the `Postgres`'s and the `Redis`'s docs.

## 2026-11-02: step 4, the `Redis` built the 5.0 way, and a 5.0 `DevCommand`

**Done, committed (not pushed):**

- **The `Redis`'s own args and docs** (`aws/v5/redis.ts`), with no 4.x component file imported, and on the clean break's list. `vpc` takes either kind of `Vpc`, or ids; another resource in its place is refused.
- **The deprecated `nodes` is refused** with what to write: `cluster.nodes` where neither `cluster` nor `serverless` is set, and nothing where one is, since 4.x ignored it there. Left in and ignored, it would reshard the cluster ([decision](plan.md#decisions)).
- **In `sst dev` with `dev` set, it reports the pane for the local server** through the program contract, with `localServerPane()` in `helpers/local-server.ts`, which `Postgres`, `Mysql` and `Aurora` will use too. 4.x created a `DevCommand` for it in every deploy; a switch takes that out of the state, with nothing in AWS behind it. The pane is keyed by the component's name (`MyRedis`, so `SST_CHILD=MyRedis`), where 4.x's was `MyRedisDev`. Outside `sst dev` nothing is reported.
- **A 5.0 `DevCommand`**, `sst.x.v5.DevCommand` (`experimental/v5/dev-command.ts`), for an app's own commands: SST 4's args less the internal `aws`, with `dev.command` required. SST 4's documented `npm run dev` as its default, but `sst dev` runs nothing without a command. It reports what `sst dev` runs in `sst dev` alone, so a deploy no longer keeps it, with its environment, in the state. It has no takeover map, so SST 4's `DevCommand`, which SST 4's components create, isn't refused on a new stage ([decision](plan.md#decisions)).
- **The docs generator** names the experimental V5 components `sst.x.v5`, leaves out an empty `nodes`, gives the note about objects in `transform` only to a component that has one, and escapes braces in a type it can't resolve. That last one, and an unclosed code block on the V5 `Efs`'s page, broke the site's build; both are fixed.

**Checked:** `tsc`, all platform tests (2,267), the docs pages, and the site's build. The `Redis` takes over 4.x's in every case, with a `Vpc` of either kind and with the `Vpc` switched along with it: only 4.x's version markers, and with `dev` set its dev command, leave the state. Its subnet group no longer waits for the VPC's security group, which it never used; the cluster still does. In the lab, `sst dev --mode=mono` on a stage of its own (`LAB_ONLY=panes`, nothing in AWS): the `Redis`'s pane, the 5.0 `DevCommand` with its environment and its link to the cache, and SST 4's `DevCommand` beside them each ran. Removed, and cleaned up: 28 state versions and the passphrase. The audit is clean.

**Reviewed**, and fixed: the `nodes` message told someone with `cluster` set to write `cluster.nodes`, which would have resharded the cluster. A `transform.cluster` function is given outputs where 4.x gave plain values; the docs say so now. An empty `dev.password` showed as `""` in the pane, where 4.x said there was none. The cost text still said `nodes`, and the docs didn't say `Redis.v1` has no V5 form.

**Found:**

- The breaking changes of the ports before this one, like the `Cluster`'s `vpc.serviceSubnets`, aren't in the plan's Decisions table, which [goal 7](goals.md#7-every-breaking-change-has-a-way-across) asks for. Their "Switch from" sections have them.
- `sst dev --mode=basic` runs no dev commands; `--mode=mono` does.
- The docs generator doesn't resolve the V5 `Nextjs`'s `assets.fileOptions` type, so its page shows the type as text, where the 4.x page lists its fields.

## 2026-11-02: step 4, the lab check of the `Cluster`, `Task` and `Efs`, with the `Vpc`

**Checked in the lab** (a stage of its own, the only one with a VPC, with a CLI built from the branch). The lab app's containers group: a cluster, a file system, two services (one with a load balancer and a domain of its own, one on a shared ALB with a domain), a task run by a cron job, and a function that mounts the file system and counts its visits in it. The lab app can now create its VPC with the 5.0 `Vpc` (`LAB_NET=v5`), so the move switched the `Vpc` with everything in it.

- **Deployed with SST 4** (with its `Vpc`), then switched it all at once. `sst migrate --check` passed: 118 kept (18 at a new address), nothing updated in place, replaced or released, 4 taken out of the state with nothing in the cloud behind them (4.x's version markers and dev commands) and 3 created with nothing behind them.
- **The move** kept every resource by id. The file system's two mount targets, which 4.x named after their subnets' ids, are kept by the AZ's number now (`FilesMountTarget1` and `2`), with the same ids. Then `sst diff` showed no changes.
- **Everything still answers the same:** both domains serve, the shared ALB's own address still refuses what it doesn't route, and the function that mounts the file system counted on from the visit 4.x recorded, so the data was kept.
- Removed, and cleaned up: its state versions, passphrase, a source map and three inactive task definitions. Each resource the tagging API still lists was checked directly, and is gone.
- **Found, in both checks:** the functions' source maps outlive a remove, for the 5.0 `Function` after a move as for the 4.x one (11 on the bucket group's stage, one here), keyed by the log group's ARN. Left to look into.

## 2026-11-02: step 4, the lab check of the `Bucket`, `Queue`, `SnsTopic`, `Dynamo`, `Bus` and `CronV2`

**Checked in the lab** (a stage of its own, with a CLI built from the branch, the maintainer having said to catch up on what wasn't tested). The lab app's bucket group deploys all six: a bucket with versioning, CORS, a lifecycle rule, CloudFront access, a statement of its own, a function, a queue and a topic notified, and an EventBridge subscriber; queues with subscribers; a topic with a function and a queue subscribed; a table with a stream subscriber; a bus with a function and a queue subscribed; a cron job. Each of the queue, topic, table and bus also has a subscriber from 4.x's static methods, which `get` takes the place of.

- **Deployed with SST 4**, then switched all six at once. `sst migrate --check` passed: 121 kept (84 at a new address, 10 functions updated in place), 13 taken out of the state with nothing in the cloud behind them (4.x's wrapper components), 9 created with nothing behind them (the components from `get`, their links, the marker), and the functions' code uploaded again under new keys. Nothing released, nothing deleted.
- **The move** kept every resource that has an id: the state's ids compared one by one, and every setting in AWS (the bucket's policy, CORS, lifecycle, notifications and EventBridge, each queue's policy, the topic's subscriptions, the event source mappings by id, the rules, the table's stream) was the same, but for the order of entries in the queues' policies. 4.x's lookup of the default event bus went, which has nothing behind it. Then `sst diff` showed no changes.
- **Everything still runs:** an upload, a delete, an item and an event reached each subscriber once, by every path: the bucket's function, queue and EventBridge rule; the topic's function and queue, and the queue's subscriber; the table's stream; the bus's function and queue; and each subscriber from `get`.
- **Found:** two subscriber functions' descriptions change on switch, from 4.x's wrapper's name to the component's ("Subscribed to BucketEvents"), an update in place. 4.x names a function's log group with a suffix of its own, so a function's logs are in the group its logging settings name, not `/aws/lambda/<name>`.
- Removed, and cleaned up.

## 2026-11-02: step 4, the `Efs` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/efs.ts`), with no 4.x component file imported, and on the clean break's list.
- **No mount target is made inside an `apply`** (the maintainer chose this design from three, on 2026-11-02). 4.x, and the `v5` branch's port, made one for each subnet once the subnets' ids were known, named after each id, so a new stage's `sst diff` didn't list them. Now each is kept by its availability zone, EFS's own rule of one mount target in each:
  - In a `Vpc` the app creates, by the AZ's number, as the `Vpc` keeps its subnets: made directly for a V5 `Vpc`, which gives its private subnets by that number, and once a preview knows them for a 4.x one, from the order 4.x made them in. The keys are the same, so switching the `Vpc` too keeps them.
  - In any other VPC, one from `get` or one given by its subnets' ids, by the AZ's name, looked up for each subnet and made with `after()` once a preview knows the subnets. A lookup keeps no order, and an edit of the ids, removing one or reordering them, changes only the AZs it adds or removes. Two subnets in one AZ are refused. Subnets the same deploy creates outside a `Vpc` aren't known to a preview, so `sst diff` can't list their mount targets; the docs say so.
  - `privateSubnetsOf()` and `subnetsByAz()` in `helpers/vpc.ts` give a VPC's subnets that way, each still an output of what made it, so a mount target is removed before its subnet. `knownValue()` in `args.ts` reads what a preview knows of an output. The 4.x `Vpc` says whether it's from `get`, which changes nothing for an app.
- **A mount target is removed before it's made again** (`deleteBeforeReplace`). 4.x made the new one first, which EFS refuses when a subnet in an AZ is replaced.
- **The VPC given by its ids is looked up with a function**, where 4.x read it into the state; a switch drops that read.
- **A map** moves 4.x's mount targets, named after their subnets' ids, to their keys.

**Checked:** `tsc`, the docs page, and all platform tests: each kind of VPC, the switch with the `Vpc`, removing and reordering ids, the refusals, that a created `Vpc` doesn't wait for the subnets (which fails on the old code), a new stage's preview, and the lab's recorded VPC groups, whose two real mount targets are kept with only the new option.

**Reviewed**, and fixed: the first version kept given ids by their place in the list, so removing one but the last left a deploy stuck on EFS's one mount target in each AZ, and treated a 4.x `Vpc` from `get` as ordered; both are kept by AZ name now. Also a raw error for ids without subnets, and the docs. Not tested under the mock: a 4.x `Vpc` from `get`, which takes the same path as a V5 one.

**Left:** the lab check, with the containers group.

## 2026-11-02: step 4, the `Task` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/task.ts`), with no 4.x component file imported, and on the clean break's list. What a task and a service both run, and with what, is `FargateBaseArgs` in `helpers/fargate.ts`, with a container's args, `ContainerArgs`, the 5.0 way: their docs are the 5.0 components' own, written for any page. The `Service` takes them when it's rebuilt. The tables of the CPU and memory Fargate allows moved into the helper too; the 4.x file imports them from there.
- **`publicIp` is kept, not deprecated.** 4.x marked it deprecated in favor of `public` and refused the two together, but `public` also opens a security group to everything and moves the task to the public subnets, so a task in a cluster given the ids of a VPC had no other way to get a public IP. The V5 `Task` refuses only `public` with `publicIp: false`. Every 4.x state switches as it is, since 4.x never took both.
- **Docs fixed on the way:** a log group's default name, which has the app, the stage and a random suffix, and is read only when the log group is created; what a public IP does and doesn't do; that a role passed in `existing` gets nothing from `link`, `permissions` or `sst dev`; and two typos from 4.x.

**Checked:** `tsc`, the docs page (the `Service`'s page is unchanged), and all 2,226 platform tests, with a public task in a VPC given by ids without public subnets, and a task given both `public` and `publicIp`.

**Reviewed**, and fixed: the docs above, examples in the helper that still created the 4.x `Vpc`, the tables read from a 4.x file, and the two cases. Left for the `Service`'s rebuild: a container's `health` and `dev` are still typed from the 4.x `ServiceArgs`. The page lists `existing.image`, which the component refuses with what to write, as before.

**Left:** the lab check, with the containers group.

## 2026-11-02: step 4, the `Cluster` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/cluster.ts`), with no 4.x component file imported, and on the clean break's list. Its `vpc` is either kind of `Vpc` (`AnyVpc`) or the ids of a VPC.
- **What 4.x took and 5.0 doesn't:** the deprecated `vpc.serviceSubnets` is refused with what to write (`vpc.containerSubnets`, the same subnets), and `forceUpgrade`, which upgraded a `Cluster.v1`, is no longer an arg; one left in is ignored. Any resource in place of a `Vpc`, a `Vpc.v1` or an `aws.ec2.Vpc`, is refused, where it was read as the ids and failed on what's missing.
- **The ids are checked as they're given**, so a preview fails on what's missing even when their values aren't known yet, and once more when they are.
- **The docs no longer call the ids "equivalent" to a `Vpc`**: given ids, the containers get no public IP, so they need subnets with a NAT, and the example now shows that.
- **The notes on going back to a 4.x component after a switch were stale**, in the rulebook and the `Vpc`'s docs: since the marker, the CLI refuses SST 4's form of what moved, and the way back is the copy `sst migrate` saves.

**Checked:** `tsc`, the docs page, and all platform tests, with a 4.x service and task in a switched cluster given ids, a `forceUpgrade` left in, and each refusal, each failing without its check.

**Reviewed**, and fixed: the docs above, the checks made only once the values were known, a plain resource read as the ids, and the missing cases. The review's way back for the 4.x `Cluster` (setting `forceUpgrade`) doesn't apply: the CLI refuses it first.

**Left:** the lab check, with the containers group.

## 2026-11-02: step 4, the `CronV2` built the 5.0 way, and a function part's args

**Done, committed (not pushed):**

- **The `CronV2`'s own args and docs** (`aws/v5/cron-v2.ts`), with no 4.x component file imported, and on the clean break's list. The 4.x `Task` it can run is reached through `AnyTask` (`helpers/task.ts`), and its function goes through `plainFunction()`. A 4.x config that gave the function's args in an output switches by writing them plainly, with outputs inside, which a takeover case shows. Its examples use the 5.0 `Vpc`, since a new stage refuses SST 4's.
- **A `$transform` for functions can add to what a component's function is given again.** `functionPart()` made a function's `link`, `environment` and `permissions` outputs whatever was given, so a `$transform` that spread `args.environment` copied an output and lost what it added, with no error, in every 5.0 component. They're made outputs only when one side is one, as 4.x left them. A test fails without it.
- **Each "Switch from" section of a component that creates functions** says that inside a function's args, what it's built from and what decides what's created are plain values, as the 5.0 `Function` takes them.

**Checked:** `tsc`, the docs pages, and all 2,221 platform tests, with a function and its ARN given to a cron job in an output.

**Reviewed**, and fixed: the lost `$transform` additions, the docs and examples above, and the missing tests.

**Left:** the lab check, with the others'.

## 2026-11-02: step 4, the `Bus` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/bus.ts`), with no 4.x component file imported, and on the clean break's list. Its function subscribers go through `plainFunction()`, and a queue subscriber is either kind of `Queue` or an ARN. The map already found what 4.x's static `Bus.subscribe` and `subscribeQueue` created.
- **The "Switch from" section** says the plain-function rule, what the methods return, and which provider each subscriber is created with: as for the `SnsTopic`, a provider a bus takes from a parent, or one that reaches `get` any way, replaces a subscriber 4.x created with another.

**Checked:** `tsc`, the docs page, and all 2,218 platform tests, with a case for a subscriber that links its bus, and for a static subscriber created from a handler, which keeps its function.

**Reviewed**, and fixed: the static methods' line in the `Bus` and `SnsTopic` docs named only a `provider` given to `get` directly, and the two cases above were missing.

**Left:** the lab check, with the others'.

## 2026-11-02: step 4, the `Dynamo` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/dynamo.ts`), with no 4.x component file imported, and on the clean break's list. Its subscriber goes through `plainFunction()`. A subscriber without a name is refused in every shifted form 4.x took, a handler with the subscription's args included. The map already found what the static `Dynamo.subscribe` created.
- **A subscriber of a component that takes its provider from a parent, or from `providers`, is replaced on switch**, for the `Dynamo`, `Queue` and `SnsTopic`: 4.x gave it only a `provider` passed to the component itself, and the 5.0 subscriber has the component's. Its log group goes with it, so `sst migrate --check` refuses the move; each "Switch from" section says to remove the subscriber and deploy first. A test shows it for each.
- **A handler or args in an output is refused, and no function created**, now tested at each of the four components, through `applyErrors()` in the tests' helpers, which collects what's thrown inside an `apply` where the mock would fail the run. Before, removing `plainFunction()` from a component failed no test.
- The "Switch from" sections say the plain-function rule the same way in all four, and the `Dynamo`'s says a table `transform` is given its keys as outputs too.

**Checked:** `tsc`, the docs pages, and all 2,211 platform tests. Each new refusal test fails with `plainFunction()` taken out of its component.

**Reviewed**, and fixed: the provider a subscriber inherits, the untested guard, and the docs above. The table's own resource is unchanged, so nothing here can replace or empty it.

**Left:** the lab check, with the others'.

## 2026-11-02: step 4, the `SnsTopic` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/sns-topic.ts`), with no 4.x component file imported, and on the clean break's list. Its function subscribers go through `plainFunction()`, and a queue subscriber is either kind of `Queue` (`AnyQueue`) or an ARN.
- **What 4.x's static `SnsTopic.subscribe(name, topicArn, ...)` and `subscribeQueue(name, topicArn, ...)` created is kept.** They named it after the topic's own name, at the top of the app, and `get(name, topicArn)` with the method takes their place.
- **A subscriber without a name**, which 4.x took and marked deprecated, is refused with the call to write. 4.x named one after what it subscribed and its filter, so a switch can't find it.
- **The "Switch from" section** says what the methods return now, where a subscriber's `transform` went, and not to give `get` a `provider` for what the static methods created.

**Checked:** `tsc`, the docs page, and all 2,203 platform tests. The static methods' case runs as it is and with the topic inside another component, with a component named apart from its topic, and fails without the map's new name. A new stage's preview plans a topic's subscriber. Every form a subscriber can be given with a name is taken.

**Reviewed**, and fixed: the docs' wording on the static methods and the provider, an example of a subscriber's args that had been dropped, and tests for the forms the name check must take. As in 4.x, a topic named like another topic component can claim that component's old subscriber in a switch that adds a subscriber of the same name to both; the map says so.

**Left:** the lab check, with the `Bucket`'s and the `Queue`'s (`LAB_ONLY=bucket` in the lab app now covers all three, with a static subscribe each for the queue and the topic).

## 2026-11-02: step 4, the `Queue` built the 5.0 way

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/queue.ts`), with no 4.x component file imported, and on the clean break's list. Its subscriber goes through `plainFunction()`, as the `Bucket`'s do.
- **What 4.x's static `Queue.subscribe(queueArn, ...)` created is kept.** It was named after the queue's own name, and the map didn't look there. `Queue.get(name, queueArn).subscribe(...)` takes its place, given the options the static one was.
- **The "Switch from" section** says what `subscribe` returns now, where its `transform` went (for a queue from `get` too), and that `get` needs the static one's `parent` and `provider`. The docs say a function passed in, or its ARN, isn't given permission to receive from the queue, as in 4.x, and the `batch` default's window is 0 seconds, as the code has it.
- A test that gave a subscriber's args in an output now gives them plainly, and two that write a subscriber the 4.x way say it isn't typed.

**Checked:** `tsc`, the docs page, and all 2,198 platform tests. The static subscribe's case runs the three ways, with a component named apart from its queue, and fails each without the map's new lines.

**Reviewed**, and fixed: the map missed a static subscribe given a `parent`; the first test of it passed without the new lines, since the component and the queue had the same name; a subscriber's `transform` had no way across for a queue from `get`; and the docs above.

**Left:** the lab check, with the `Bucket`'s.

## 2026-11-02: step 4, the `Bucket` built the 5.0 way

The first of the rest of Core, after the gate. The `Bucket` is the most used of them, and the sites and a router's bucket routes build on it.

**Done, committed (not pushed):**

- **Its own args and docs** (`aws/v5/bucket.ts`), with no 4.x component file imported, and on the clean break's list. The 4.x `Queue` and `SnsTopic` it can notify are reached through `AnyQueue` (`helpers/queue.ts`) and `AnySnsTopic` (`helpers/sns-topic.ts`).
- **A function it's given is decided from what a preview knows.** A notification's `function`, and the subscriber of `subscribeEventBridge`, is a handler or args as a plain value, or a function or its ARN, which can be an output. `plainFunction()` in `helpers/function-part.ts` checks it, with `FunctionInput` as its type, and refuses a handler or args in an output with a message. The other components that create functions take it as each is rebuilt.
- **`cors: true`** is taken, as its docs said.
- **The rulebook** lists the new helpers and the `Bucket` among the components built the 5.0 way.

**Checked:** `tsc`, the docs page, and all 2,194 platform tests. A new stage's preview plans exactly what a deploy creates for a bucket with a part of every kind (`bucket-preview.test.ts`). A notification whose function links the bucket switches with only the function's description changed. In 4.x its permission and the notification also waited for the bucket's CORS rules, which nothing in AWS needs; the test names that order with the reason.

**Reviewed**, and fixed: the "Switch from" section lacked three changes (each notification is a plain value, a `transform` function for `cors` or `lifecycle` is given outputs, and the 4.x way of writing a function's args no longer type-checks); a lifecycle example with a prefix that matches nothing; an output of a function component, which creates nothing, was refused; and the tests the rulebook asks for.

**Left:** the lab check, a 4.x deploy of a bucket with every feature (`LAB_ONLY=bucket` in the lab app), `--check`, the move and a comparison by id.

## 2026-11-02: `main` merged in, with credentials kept out of the state

The maintainer asked to bring `main`'s fix for SST's Cloudflare and Vercel resources onto `v5-rewrite`.

**Done, committed (not pushed):**

- **`main` merged into `v5-rewrite`:** SST's Cloudflare and Vercel resources call the API with the credentials the CLI resolved. The RPC resources get them in Go. The dynamic providers written in TypeScript read `SST_CLOUDFLARE_*` from the program's environment on each call, as SST reads `SST_AWS_*` for AWS. A site's build doesn't get them. Each of these resources updates once on its next deploy. The 5.0 Cloudflare and Vercel adapters still create their CAA records with SST 4's record resource, so those records keep nothing secret in their inputs now either.
- **The Cloudflare fetch helper:** `v5-rewrite` read the token when a request was made, from `$app` or the environment. `main`'s reads only the environment, so the code saved with SST's dynamic providers reads nothing from the app's config. The merge keeps `main`'s.
- **`cloudflare.go`:** `v5-rewrite` had moved the Cloudflare home out of it, and the merge put back the import the new code needs.

**Checked:**

- All Go tests, `tsc`, and the platform's 2,184 tests. The new test builds each Cloudflare and Vercel resource SST makes, and a server-rendered site's build, with credentials in the config and the environment. It finds none in their inputs or their saved code. It fails on the code from before the fix, with the site's build given the CLI's credentials, and with the fetch helper reading `$app`.
- Not checked against Cloudflare or Vercel: the lab has neither.

## 2026-11-01: step 4, domains the 5.0 way

Every component with a domain created its DNS records through the adapters, inside an `apply`, and looked up each record's zone with a resource, so a new stage's preview showed none of them ([decision](plan.md#decisions)).

**Done, committed (not pushed):**

- **The adapters' 5.0 form** (`dns-adapter.ts`, and `dns-adapter.ts` in `aws/`, `cloudflare/` and `vercel/`), which `sst.aws.dns()`, `sst.cloudflare.dns()` and `sst.vercel.dns()` also give: `record`, `alias` and `caa`, which create directly and name from plain values as 4.x did. A record whose name in DNS isn't known yet is named after a `key`.
- **Zones found with functions.** SST's provider serves its first function, `sst:aws:getHostedZone`: it lists the zones once a run, takes the longest zone the domain ends with, a public one over a private one of the same name, and refuses two alike, where 4.x took the first listed and kept it in the state. Cloudflare's zone comes from Cloudflare's provider. `--check` releases SST 4's lookups, and the move marks them retained, so their delete isn't called.
- **A 5.0 certificate** (`aws/v5/dns-validated-certificate.ts`): one validation record for each domain, and one for a domain and its wildcard, named after the domain. Its map gives each record's old name, made from its name in DNS, which the certificate gives once it's deployed: a new entry in the takeover maps, `delegated`, for what an adapter creates on a component's behalf.
- **A 5.0 redirect** (`aws/v5/https-redirect.ts`), with the CloudFront function 4.x created at the top of the app moved inside it.
- **The `Cdn` rebuilt on them**, with domain args of its own, and on the clean break's list with the certificate and the redirect.
- **The mock** gives a certificate's validation records as ACM does, one for each domain, and the same zone from 4.x's lookups and 5.0's functions. A recorded state answers the zone function from 4.x's lookup.

**Checked:** all 2,182 platform tests, `tsc`, `go test ./...`. In a new stage's preview, a CDN with aliases and a redirect plans all 11 DNS records; 4.x's `Cdn` planned none. The recorded router and Next.js site switch with nothing changed, the certificate taking over its real validation record by its old name. A switch keeps every record on Route 53, Cloudflare and Vercel.

**Reviewed**, and fixed:

- A certificate on Cloudflare or Vercel failed: its CAA records were created before the map could read its validation records. The takeover cases now switch a CDN on each adapter.
- A redirect inside a component with a provider of its own was listed as replaced. Pulumi does replace a resource whose provider changes, and the replacement keeps the function's name, which CloudFront refuses, so a move would have stopped partway. The map no longer lists it, so `--check` refuses that move before anything changes.
- The zone function looked up once per record, on every run, and took zones in Route 53's order: listed once a run, with the choice above.
- A 4.x Cloudflare lookup with `.sst.` in its domain wasn't recognised as one. A hex name right before a hash counted as part of it, so a rename passed as an upload; only a run as long as a hash counts now.
- A domain in another case than ACM's found no validation record: matched in any case, with a message.

**Checked in the lab** (stage `dom`, `LAB_ONLY=sites` with `LAB_REDIRECT=1`, the 4.x Astro and SvelteKit sites kept), with the code before the review's fixes, none of which changes what it ran: Route 53 with one public zone, no provider of its own, and SHA-256 keys:

- Deployed with the 4.x router, with a domain and a `www.` redirect. Switched with `LAB_ROUTER=v5 LAB_NEXT=v5 LAB_ROUTE_FILES=v5`.
- `sst migrate --check` passed: 146 kept, 14 at a new address (the two validation records and the redirect's function among them), the six zone lookups released, and the Astro and SvelteKit servers' code uploaded again as uploads.
- `sst migrate`: the state had no lookups, the records and the function kept their ids under their new names, and the marker listed 25 components, the certificate and the redirect among them. The site's bucket lost nothing, the key-value entries were the same, and the sites and the redirect answered as before. A diff after showed only what a new build changes.
- Removed, and cleaned up.

## 2026-11-01: step 4, what any deploy changes in a move

A stage that keeps 4.x server-rendered sites failed `sst migrate --check`: their servers' code and source maps are uploaded again on every deploy, under new keys, and nothing maps them. The same would fail any later move of a stage whose code changed since its last deploy, or that has a 5.0 site, whose build changes its code each time too.

**Done, committed (not pushed):**

- **A file uploaded again because it changed isn't the move's doing** ([decision](plan.md#decisions)). `--check` lets an object in a bucket be replaced without a map when only its key changed, in nothing but a hash of what's in it, as SST keys a function's code and its source maps. A key that changes in anything else needs the map, as when a map renames a function, and so do a key a preview doesn't know, a move to another bucket, and anything that isn't an object in a bucket. What a map says comes first. It's judged from the preview alone, so it holds for a 4.x component a move keeps, a 5.0 one in a later move, and an app's own objects.

**Checked:** `go test ./...`. On a Floci stage, no AWS: the 4.x target group deployed with a build from before the refusal, then a function's code changed. Before, `--check` failed on its two functions' code and source maps; with the rule, it passed, listing all four as uploaded again. The switch to the V5 components with the same change passed too, with the maps' own words for the same four. Removed, and the stage's files deleted.

**Found:** Floci's ECR registry, a container Floci starts with the Docker socket the core gives it, had run since the day's first Floci run: neither `sst target stop` nor `sst target reset` stops what the target's container started. Removed by hand. Left for step 3's target, with the Floci package.

## 2026-11-01: step 4, SST's own resources in the `sst` binary, and the move that releases them

The maintainer asked for the long-term direction for SST's provider resources and for how a move releases, then said yes to it ([decisions](plan.md#decisions)). This closes the gate's last item: releasing `BucketFiles` and `KvKeys`.

**Done, committed (not pushed):**

- **The `sst` binary serves SST's own resources as a Pulumi provider** (`pkg/provider`): `sst:aws:BucketFiles` and `sst:aws:KvKeys`, the classes in `aws/resources/`, which the V5 `Nextjs`, `Router` and `Function` use. Each run's work folder links the running binary in as the plugin, and its `Pulumi.yaml` points Pulumi at it, so the provider is always the CLI's version. It gets the stage's setup from the environment, never from its config: the region, a target's endpoint, and the credentials the CLI resolved, until they expire; then it makes its own the way the CLI made them (the profile, and the roles to assume), so a deploy or an `sst dev` that outlasts them goes on, and nothing is asked for twice, like a code from an MFA device.
- **`sst migrate` moves a stage.** It takes the stage's lock, runs the check, and stops there if it fails. Then, under the same lock, it saves a copy of the state in the home, marks what the maps release as retained, and deploys with a preview first, so Pulumi takes each released entry out of the state without calling its delete. A remove that leaves nothing takes the copies too.
- **The marker.** Only a move releases, so a plain `sst deploy` or `sst dev` after a switch would have deleted the old entries at the end, and with them the files and route entries the new resources had just written. Now the state of a stage on SST 5's components has `sst:sst:Moved`, which lists the components it has in their 5.0 form, and the core refuses to deploy a stage that has something deployed and no marker, except with `sst migrate`. A component counts as moved when the marker lists it or the stage has none of it, so a new stage starts with all of them. SST 4's form of one that counts as moved is refused, and outside a move, so is the 5.0 form of one the stage still has in SST 4's form, so a component that gains a 5.0 form after a stage moved is switched by a move too. A move switches all of a component at once, and one that keeps a component in SST 4's form leaves the marker without it. A remove that doesn't finish puts the marker back. `mock()` runs as a new stage's first deploy.
- **The maps release** a site's files and key-value entries, and a function's route entry. A released entry with no parent is looked for at each address its component answers to, as Pulumi names a child's alias, so a function a parent's map renamed releases the right one.

**Checked:** all 2,157 platform tests, `tsc`, `go test ./...`. Reviewed four times. The first review found that a plain deploy after a switch deleted the site's files, that a move saved no copy when it released nothing, that the provider's credentials couldn't refresh, that a move with checks could save a copy it had already marked, that a function a parent's map renamed released the wrong route entry, and that nothing kept the stage from changing between the check and the move: all fixed (above). The second found that the marker said a stage had moved while it kept SST 4 components with no 5.0 form yet, which a plain deploy could later switch, and that a remove that didn't finish lost the marker: fixed by the marker's list, and by putting it back. The third found that a move could switch some of a component and keep the rest, after which a plain deploy could switch the switched ones back and delete what they wrote: a move now switches all of a component at once. The fourth found that a setup the provider built by hand, to stay clear of a profile only the CLI could read, lost what the AWS SDK reads from the environment, like a CA bundle or FIPS endpoints: it's the SDK's again, as such a profile breaks Pulumi's AWS provider all the same. Left, as they fail closed: a stage whose first deploy stopped before the marker's list was saved is refused until `sst migrate` runs on it, and a remove killed outright leaves a stage that has to be removed to the end. Left on purpose: on Windows without the right to make a symlink, with the project on another drive than the CLI, the binary is copied into each run's work folder; it only costs time, and a folder shared between runs would risk replacing a binary another deploy is running.

**Checked in the lab** (stage `rel`, `LAB_ONLY=sites` with `LAB_SSR=0`, which leaves out the 4.x Astro and SvelteKit sites: they build again on every run, so `--check` fails on a stage that keeps them):

- Deployed with the 4.x `Nextjs` behind the 4.x `Router`, with a route to a URL and one to a 4.x `Bucket`, beside two 4.x static sites. Switched with `LAB_ROUTER=v5 LAB_NEXT=v5 LAB_ROUTE_FILES=v5`.
- A plain `sst deploy` was refused, and changed nothing.
- `sst migrate --check` passed: 95 kept, 11 at a new address and 5 updated in place; the site's files and key-value entries and the router's two route entries released; what takes their place created, with SST's provider and the marker; the site's code and its seed replaced, as the maps say. Its first run failed on its own count of the preview's steps, which included the default providers Pulumi's summary leaves out (fixed).
- `sst migrate` kept every object in the site's bucket and every key-value entry, with the same values; the new build added its files. The state had none of the released entries, had the new ones, SST's provider and the marker, listing the 23 components with a 5.0 form, and nothing left marked retained.
- A diff after showed only what a new build changes. SST 4's `Nextjs` on the moved stage was refused. A plain deploy after kept everything, and the pages and assets answered as before.
- Removed, and cleaned up.

## 2026-11-01: step 4, `Nextjs` built the 5.0 way

The maintainer said to continue. With the `Router` and its `Cdn` done, `Nextjs` was the last of the gate's three hard components.

**Done, committed (not pushed):**

- **The V5 `Nextjs`** (`sst:aws:Nextjs`), built the 5.0 way: its own args and docs, no 4.x component file, and nothing inside an `apply`. It's served through a `Router`, V5 or 4.x, with `router`, or through a V5 `Cdn` of its own. Its parts keep 4.x's names, so a switch moves nothing in the cloud.
- **The site is built in the program, once per deploy** (`buildSite()` in `helpers/site-build.ts`), with the values of its links and its environment ([decision](plan.md#decisions)). A preview builds it without the values it doesn't know, and passes a link none of whose properties it knows with only its type. Builds take their turn, as many at once as `SST_BUILD_CONCURRENCY_SITE` says; 4.x sites keep a limit of their own. A failed build fails the deploy once, with the end of its output, and the `nodes` made from it fail with it. 4.x kept its build in the state as a `command:local:Command`, which a switch takes out. `sst migrate --check` lets a 4.x site's build go, or be replaced as it is on every deploy, since it only writes the site's files on this machine; a user's own local command only goes when it's deleted without a delete command.
- **What the build makes is created after it**, with `this.after()`: a server in each region, the image optimizer, ISR's queue, table and seeder, the warmer and who may call the functions' URLs. The rest is created directly. `nodes.server` has the server of each region from the start (`willCreate()`); without `regions`, that's the app's region, read from its config.
- **Plain args:** `regions`, `warm`, `protection`, `edge`, `router`, `invalidation`, `imageOptimization` and `server`, which decide what's created, what the build reads (`path`, `buildCommand`, `openNextVersion`), and the domain's names. `route`, `cdn` and `server.edge` are turned down with a message saying what to write.
- **Seeding and warming follow the build.** 4.x seeded the ISR data and warmed the server on every deploy, triggered by the time. The V5 one seeds when the data changes and warms when the site is built. The data is keyed by the build's id, which Next.js makes new on every build unless an app sets `generateBuildId`, so it's most often seeded on every deploy all the same. `assets.textEncoding` sets the charset, which 4.x ignored.
- **Shared with the 4.x sites:** the files, key-value entries and invalidation a site makes moved to `site-code.ts`, which the 4.x `SsrSite` calls, unchanged for an app. The framework has `after()`, `deferred(optional(...))` and `willCreate()`, and a takeover map can give an address inside the component (the 4.x warmer's `Cron`) or beside a queue (4.x's subscriber).
- **A `VisibleError` keeps its message as it's written.** Pulumi added the property it was serializing to an error's message, in place, once for each resource that waited on it, so a failed build read `error serializing property "entries": error serializing property "paths": ...`. This cleans up such errors from 4.x components too, and changes nothing else for an app.

**Checked** (all 2,139 platform tests, `tsc`, the docs page):

- **Against what 4.x really deployed:** the recording of the lab's Next.js site, as v4.23.1 deployed it. 4.x gives what the state has, but for what a build changes, and the V5 `Nextjs` takes it over with only the build command and the subscriber's wrapper gone, and the seed and the code made again. Nothing secret is in plain text in its state.
- It takes over 4.x's in 18 setups, each run as it is, inside another component and with a provider of its own: on a distribution of its own; behind a 4.x `Router`, and a V5 one that signs, under a path; each `protection`, and the user's edge signer; kept warm, in one region and two; ISR off; links and environment; edge code on the site's store and on the user's; a cache policy; each kind of `invalidation`; server and image options; a domain with aliases and redirects; a VPC; `transform.server`; two regions behind a router that signs; and a stage deployed in `sst dev`.
- A new stage's preview plans everything a deploy creates, and builds with what it knows. A failed build fails once, with its own message; a test fails on the old `VisibleError`.

**Checked in the lab** (stage `next`, `LAB_ONLY=sites`, with a CLI built from the branch):

- Deployed with the 4.x `Nextjs` behind the 4.x `Router`, beside 4.x Astro, SvelteKit and static sites. Switched with `LAB_NEXT=v5`: `sst migrate --check` showed, for the site, its build command and its subscriber's wrapper taken out of the state, its seed and its code replaced as the maps say, its functions updated, and nothing created or released. The check failed only on the 4.x Astro and SvelteKit sites, which build again on every run, as in the router's check: their build commands, which pass now (above), and their functions' code, which doesn't (Left).
- The deploy kept every resource with the same id but the code objects, uploaded again under new keys, and the build commands. Twelve kept their id under a new name: the revalidation subscriber, out of its wrapper. Its `SST_KEY_FILE` follows its new name.
- The pages, the other sites and the image optimizer answered as before. A diff after it showed only what a new build changes, as 4.x's does. A build that fails in `sst diff` shows its message and the end of its output, once.
- Removed, and cleaned up.

**Reviewed** by a separate agent, which found nothing a switch loses: names, parents, providers and options match 4.x, and the extraction to `site-code.ts` leaves 4.x's sites byte for byte the same. Its findings, fixed:

- **`nodes.server` was empty until the build, without `regions`.** It's there from the start now, as above.
- **A preview builds the site, where 4.x's skipped the build when a value wasn't known.** On a new stage, a build that checks its environment can fail `sst diff`. A link whose properties weren't known was dropped from it; it's passed with its type now, and "Switch from" says what a preview's build gets.
- **A failed build's message was rewritten** for each resource waiting on it, as above.
- **The build's stdin was left open**, so one that asked for input hung. It gets none now.
- **`sst migrate --check` let any local command go**, where only its delete does nothing. A user's command created or replaced runs, so it's listed now.
- The tests: six setups above weren't run (a domain with redirects, a VPC, the user's store, `transform.server`, two regions behind a signing router, `sst dev`), nor a failed build or `nodes.server` without `regions`, and the removal orders 4.x had and V5 doesn't were matched too loosely. Added, and listed one by one.

A second agent reviewed those fixes. Its findings, fixed:

- **The stricter rule failed every stage that keeps a 4.x site**, whose build is replaced on every deploy. A 4.x site's build is told apart now: the one local command an SST component runs, right under the site, with no delete command.
- **A failed build left the server in `nodes` as `undefined`**, so a resource made from its URL could be updated without it before the deploy failed. It fails with the build's error now, which Pulumi reports once.
- **Sharing the limit with 4.x could hang a deploy**: a failed 4.x build never gives back its turn, and a V5 site waiting for it kept the program running. The limits are separate again.
- A test helper rewrote an error's message to add context, which a `VisibleError` would have dropped; it wraps the error now.

These came after the lab's check, which ran the first round's CLI. They change what a failure does and what `--check` allows, which the tests cover; they weren't deployed.

**Left:**

- **Domains the 5.0 way**, as for the `Router`: a new stage's preview doesn't show a domain's DNS records.
- **A deploy that previews first builds a site twice**: on a stage with checks or a policy pack, once in the preview and once in the deploy.
- **`sst migrate --check` fails on a stage with 4.x server-rendered sites that stay 4.x**: their functions' code is uploaded again on every deploy, under a new key, and the 4.x `Function` has no map. The move (step 5) has to tell what a stage changes on every deploy from what the move changes.
- Releasing and adopting `BucketFiles` and `KvKeys`, the gate's last item: the site's switch didn't need it, since they keep their type and address.

## 2026-11-01: step 4, the `Router` built the 5.0 way

The maintainer said to continue, with `Nextjs` and `Router` next. The `Router` comes first: every site, and a function's URL, is served through it. Two decisions came first ([Decisions](plan.md#decisions)): a site builds once per deploy, and the V5 `Router` drops inline routes.

**Done, committed (not pushed):**

- **A V5 `Cdn`** (`sst:aws:CDN`, as 4.x spelled it), which the `Router` and the sites are built on. Its domain, with the `name`, `aliases` and `redirects` that name its DNS records, and `wait` are plain values, so its distribution, deploy waiter, certificate and redirect are created directly. It keeps 4.x's names, so a switch moves nothing. It also keeps a quirk of 4.x's: unless `wait` is set to `true`, the waiter only waits for the first deploy.
- **The V5 `Router`**, built the 5.0 way: its own args and docs, no 4.x component file, and nothing inside an `apply`. `domain`, `edge`, `protection`, `waf` and `waf.logging`, and a route's pattern, are plain values. The distribution, key-value store, request and response functions, cache policy, Lambda@Edge signer and WAF are parts, with 4.x's names. A route is a pair of parts inside the router, its entry in the store and its line in the router's list, where 4.x kept each in a component of its own at the top of the app; the takeover map finds them there. Their entries in the store are the same, byte for byte. `get` finds a router from another stage by its distribution's tags, as 4.x does.
- **Inline routes and `invalidation`** are turned down with a message saying what to write. `invalidation` never did anything in the 4.x `Router`.
- **The CloudFront code** the router's and the sites' functions run moved out of the 4.x `router.ts` into `router-code.ts`, which both `Router`s and the sites use. The 4.x file exports it as before.
- **A function behind a V5 `Router` creates its URL's permissions directly**: the router says whether it signs its requests as a plain value (`routeOf()` in `helpers/router.ts`, which now takes either `Router`). Behind a 4.x one, or one referenced with `get`, it's still an output, which a preview knows. A 4.x site or function can be served through a V5 `Router`: it reads the same values off it.
- **The rulebook and the docs pages** for the `Cdn` and the `Router`. `AnyBucket` (`helpers/bucket.ts`) takes either `Bucket`, for `routeBucket()`.

**Checked** (all 2,063 platform tests, `tsc`, both pages, the docs site's build):

- **Against what 4.x really deployed:** the recorded state's router (`serverless-sites.json`) is what the 4.x `Router` gives, and the V5 one takes it over with nothing created, changed or left over.
- The `Cdn` and the `Router` take over 4.x's in every way they're set up, each run as it is, inside another component and with a provider of its own: a domain with aliases, redirects or a certificate of its own, `wait`, code at the edge with a store of the user's, each `protection`, a WAF with and without logging, routes to URLs and to buckets of either kind with every route arg, args given as outputs, patterns of each kind, transforms, and `get`. A switch takes the 4.x route components out of the state and nothing else.
- A 4.x `Function` served through a V5 `Router` deploys as it did through the 4.x one, and so does a router and its function switched together.
- A new stage's preview plans everything the `Router` creates but its domain's DNS records (below), and a function's URL permissions behind it, directly.
- The router's CloudFront code test reads it from both files.

**Checked in the lab** (stage `router`, `LAB_ONLY=sites`, with a CLI built from the branch):

- Deployed with the 4.x `Router`, its sites (`Nextjs`, `Astro`, `SvelteKit`, `StaticSite`), a route to a URL and one to a bucket. Switched with `LAB_ROUTER=v5`, the sites staying 4.x: `sst migrate --check` showed the router's 4 route entries at a new address, its 2 route components taken out of the state, and nothing of the router created, replaced or released. The check failed on the sites, which build again on every run: the same 10 updates and 11 replacements a plain 4.x diff of the stage shows, none of them from the switch.
- The deploy kept every resource with the same id but the sites' code, as in 4.x's own diff, the route entries under new names, and deleted only the two route components.
- The sites, the route to a URL and the route to a bucket answered as before, and the CloudFront URL is still refused. A diff after it showed nothing of the router changing.
- Removed, and cleaned up.

**Found, for `Nextjs`:** a 4.x site's build is a `command:local:Command` in the state, and a 5.0 site has none, so a move takes it out; `sst migrate --check` has to allow that, as it does a wrapper, since there's nothing in the cloud behind it. And the 4.x `Nextjs` runs its revalidation seeder on every deploy, triggered by the time; the V5 one can trigger it by the build.

**Reviewed** by a separate agent, which found nothing a switch loses, the store's entries the same byte for byte in every combination it tried, and every getter a 4.x site reads on the V5 `Router`. Its findings, fixed:

- **A 4.x `Function` that links a V5 `Router` and is routed to with `route()` waits on its own route**, and is never deployed: it waits for everything in what it links, and the route is in the router now. A V5 `Function` doesn't, and a test shows it. "Switch from" says to switch the function with the router, or serve it with `url.router`.
- **The 4.x sites and `Function` didn't type-check with a V5 `Router`**, though they work with one, and its page shows one. The 4.x route type takes either now, a change to types only. 4.x reads the router's distribution through `distributionID`, which waits for the deploy, as it did.
- The tests: a `Cdn` check that couldn't fail, a test that asserted nothing, no object `transform` case (4.x replaced the tags whole and dropped the ones `get` reads; the V5 one merges them back, said in "Switch from"), and no replay of the recorded router, all added.
- An empty `domain` is no domain, as in 4.x. The WAF's logging fields take outputs again; only `logging` decides what's created. A plain-value error for a router's domain names the router. The 4.x `HttpsRedirect` imports only the code it uses, and the 4.x route helpers use `router-code.ts`'s.

**Left:**

- **Domains the 5.0 way.** The DNS adapters (`sst.aws.dns()` and the Cloudflare and Vercel ones) create their records inside an `apply`, and the 4.x certificate and redirect the `Cdn` uses are built on them, so a new stage's preview doesn't show a domain's DNS records. Every component with a domain shares them. They're their own item: adapters that take the record's name as a plain value, and a 5.0 certificate whose validation records follow from its domain names. Until then the `Cdn` isn't on the list of components built the 5.0 way.
- **`Nextjs`**, next, on the V5 `Router` and `Cdn`, built once per deploy.
- A few args decide a part by whether they're set, and stay inputs, since they're often another resource's output: `edge.viewerRequest.kvStore`, `protection.edgeFunction.arn` and the domain's `cert`. One given as an output that turns out empty still counts as set, where 4.x would have left it out.

## 2026-11-01: step 4, the `Function` built the 5.0 way

The maintainer said to continue. The `Function` with its dev stubs is the gate's other hard component the recordings already check; what was left was building it the 5.0 way.

**Done, committed (not pushed):**

- **What an app creates once is made once in each run** (`perRun()` and `newRun()` in `util/lazy.ts`). The key links are encrypted with and the shared dev stub code were statics of the 4.x `Function`, which the V5 one reached into. They're in `aws/helpers/function-shared.ts` now, which both use, with the same names, so nothing changes in an app. The CLI's run and the mock's `reset()` start a new run, so a test sees what a run creates whatever ran before it; the takeover helpers no longer reset the 4.x `Function` by hand, and neither do the tests. The 4.x `Function`'s `reset()` is gone.
- **The V5 `Function` owns its args** (`FunctionArgs`, its types and its docs) and imports no 4.x component file. The 4.x `Efs` and `Router` are reached through `helpers/efs.ts` (`AnyEfs`, `isEfs()`) and `helpers/router.ts` (`RouteArgs`, `AnyRouter`, `routeOf()`), which take either kind, as `helpers/vpc.ts` does for the `Vpc`. A V5 `Router` joins `AnyRouter` when there is one.
- **What a build reads is a plain value**: `handler`, `bundle`, `runtime`, `architecture`, `nodejs` and `copyFiles`. They decide what's built, its handler and the source maps it writes, so a preview has to know them; an output fails with a message that says so. A runtime from `sst.runtime` in a function part's args that are themselves an output still works, since the part unwraps them first. `plain()` takes a reason for an arg like these, which doesn't decide which resources are created.
- **A URL behind a router has its permissions in a new stage's preview.** Who may call it was decided once the router's distribution existed, so a preview of a new stage had none. It's decided from whether the router signs its requests, which its settings say, and the distribution's ARN is passed in.
- **The clean break is checked**: `v5-components.test.ts` lists the components built the 5.0 way (`Vpc`, `Function`) and fails if one imports a 4.x component's file.
- **The docs page** has the args, with every example naming the V5 components; the rulebook says how a 5.0 component reaches a 4.x `Efs` or `Router`, and where what an app creates once lives.

**Checked** (all 1,962 platform tests, `tsc`, the generated page, the docs site's build):

- The takeover cases, the recorded states (the serverless group deployed and in `sst dev`) and the new stage's preview pass as before.
- A new stage's preview of a URL behind a router that signs its requests, and one behind a router that doesn't, has both permissions; the test fails with the old code.
- Each of the six build args in an output is turned down with its message.

**Checked in the lab** (stage `fn`, `LAB_ONLY=serverless`, with a CLI built from the branch):

- Deployed with the 4.x components, then switched with `LAB_V5=serverless`: `sst migrate --check` passed, with 166 kept (97 at a new address, 11 updated in place), 13 wrappers taken out of the state and the 9 functions' code replaced, as the `Function`'s map says. The deploy kept 118 of the 133 resources with the same ids, 69 under a new name; only the 9 code objects are new. A diff after it showed no changes.
- The function URL, the API's routes and its authorizer answered as before.
- `sst dev` deployed the stubs with the shared stub code, and the function URL, the routes and the authorizer ran on this machine through them.
- Removed, and cleaned up (below).

**Reviewed** by a separate agent, which found nothing a switch changes beyond what the docs say, the URL's permissions the same as before for each protection and authorization, and `perRun()` right. Its findings, fixed:

- Whether a router signs was read from the whole route, so a route's `path` or `domain` only known mid-deploy still left the permissions out of a preview. It's read from the router's protection alone now, and the preview test has such a path; it fails the old way.
- The V5 components still type the function args they're given as 4.x's, which allow outputs for what a build reads. The docs say those have to be plain there too; each component takes the V5 type when it's rebuilt.
- The 4.x `url.route.router` given as an output was reported as `url.router.instance`. The docs of a router's `instance` were the 4.x `Router`'s, about a distribution of its own. The clean-break test reads every kind of import.

**Left:**

- **A URL behind a router still creates its permissions inside an `apply`**, on the router's protection, which a preview knows unless an edge function's ARN in it is an output. A V5 `Router` gives its protection as a plain value, and then nothing waits.
- **A function part whose whole definition is an output** is created inside an `apply` (`functionPart()`), so a preview that doesn't know the definition doesn't see the function. Each component's 5.0 rebuild takes a plain definition.
- **The 4.x ways of writing `live`, `role`, `logging.logGroup` and `url.route`** are still taken, as the V5 components take 4.x's function args; they go with those types.
- `RouteArgs` is a copy of the 4.x `RouterRouteArgs` until the V5 `Router` owns it.

## 2026-11-01: step 4, the `Vpc`

The maintainer said to continue. The `Vpc` is the gate's hard component that the VPC recording can check right away, and the first built the 5.0 way.

**Done, committed (not pushed):**

- **The V5 `Vpc`** (`aws/v5/vpc.ts`, `sst.aws.v5.Vpc`, type `sst:aws:Vpc`). Its args, types and docs are its own, and it imports no 4.x component file: the clean break, read as no 4.x component file or its types, with the parts framework, `args`, `contract` and `error` as 5.0's own. Every resource keeps the name 4.x gave it. Nothing is created inside an `apply`: `az`, `nat` and `bastion` are plain, and a subnet, route table, Elastic IP and NAT in each AZ are parts keyed by the AZ's number, from a count a preview knows. The bastion is reported to the core for `sst tunnel`. No `registerVersion`; the version tags 4.x writes are kept.
- **The bastion's image is one image.** 4.x took the newest `al2023-ami-20*` for Arm, and Amazon releases one per kernel in the same second, so a diff could replace the bastion. The V5 `Vpc` reads Amazon's public parameter for the newest image with the default kernel. A switch replaces the bastion once if it doesn't run that image, which the state map lists, and the docs tell the user to start `sst tunnel` again.
- **`get`** looks up the VPC, its default security group, its Internet Gateway and its Cloud Map namespace as parts, and finds the subnets and the bastion with lookups that aren't resources: how many there are is only known once they're looked up. 4.x's other lookups leave the state, which changes nothing in AWS. A namespace id with a `0` in it is read whole; 4.x read it up to the `0`.
- **Its state map** gives the old address of a NAT instance's Elastic IP association, which older 4.x releases created at the top of the app, and lists the bastion's replacement.
- **Every V5 component takes either `Vpc`** (`AnyVpc`, `isVpc()`), and reads the subnets with `subnetsOf()` and whether there's a NAT with `hasNat()` where the two keep them differently.
- **The takeover suite checks a resource 4.x moved from the top of the app** against the graph from before the move, as it checks a rename. Without the map's old address, the `Vpc`'s NAT instance cases fail.
- **A report with nothing in it is read as no report** in the takeover suite, as the core reads it: a `Vpc` from `get` with no bastion reports an empty tunnel.
- **The docs generator builds again.** It had failed since `sst.cloudflare.binding()` was given an intersection type in step 3. It renders an intersection and a type parameter now, and no longer shows `ComponentArgs`' comment as the `Dsql`, `Service`, `Task` and `Vpc` args' own.

**Reviewed** by a separate agent, which compared the two resource by resource and found nothing a switch would change but the bastion's image. Its findings, fixed: `nat.ec2.role` and `bastion.instanceProfile` can be outputs again, since only whether they're given decides; a test catches the tunnel's key in plain text; a `get` with no bastion is a case; the docs say what in `nat` has to be plain, the permission the bastion's image needs, and what `get`'s `nodes` and an object `transform` do differently. A check I'd added for a default security group's `description` was dropped: the AWS SDK leaves it out before anything is sent.

**Checked** (all platform tests, `tsc`, the generated page, the docs site's build):

- **The V5 `Vpc` takes over the 4.x one** in 17 takeover cases, each run three ways (as it is, inside another component, with a provider of its own) and against the graph from before the move: two AZs, three, the AZs given, a managed NAT, one with its Elastic IPs given, an EC2 NAT, one with its instance, image, role and Elastic IPs given, an EC2 NAT that's the bastion, with and without its Elastic IPs given, a bastion, a managed NAT with a bastion on an instance profile of its own, transforms, and `get`, of a VPC with a bastion and of one without. Nothing updates; only 4.x's version marker goes, and for `get`, its lookups. An object `transform` that sets tags is merged, so the tags 4.x dropped come back, as the docs say. When Amazon's parameter names another image, a switch replaces only the bastion, and `sst migrate` is told the map lists it.
- **The tunnel's key stays secret** in what's reported, created or looked up, even where a lookup gives it in plain text; the test fails without that.
- **The V5 components take it**, created or from `get`: the `Cluster` and a `Service`, `Efs`, a `Function` and an API's VPC link.
- **The VPC recording, with the V5 `Vpc`**: it takes over the lab's `Net` (a managed NAT and a bastion) and the containers and databases in it, updating nothing. Only `NetVersion` goes, beside the markers that went before.
- **A new stage's preview plans everything a deploy creates**, for an EC2 NAT with a bastion and for a managed NAT with one.

**Checked in the lab** (stage `net`, `LAB_ONLY=net`, the VPC alone with a bastion, with a CLI built from the branch), the maintainer having said to continue:

- **An EC2 NAT that's the bastion.** Deployed with the 4.x `Vpc`, then switched: `sst diff` showed only 4.x's version marker going, and `sst migrate --check` passed (33 kept, the marker taken out of the state). The deploy kept all 28 resources in AWS with the same ids. The core was told the tunnel at the first NAT instance's Elastic IP, as 4.x told it.
- **A managed NAT and a bastion of its own**, as the recordings have it, on the same stage after a remove: the same diff and check (32 kept), all 27 resources kept by id, and nothing to change on the next diff. 4.x had found the image with the 6.18 kernel, which is the one Amazon's parameter names now, so the bastion was kept. SSH to the address the V5 `Vpc` reported, with the key it keeps in SSM, reached it.
- Removed, and cleaned up (below).

**Found:**

- **Going back to the 4.x `Vpc` after a deploy with the V5 one fails.** The V5 one doesn't keep 4.x's version marker, the core reads a component without one as its first version, and 4.x refuses to deploy with a message to rename it `Vpc.v1`, which would create the VPC again. It's the same for the V5 `Cluster`, `Postgres` and `Redis`. In 5.0 the way back is the copy of the state `sst migrate` saves, which has the markers, and the tombstone stops a 4.x deploy; the migration guide has to say not to follow that message. The rulebook no longer says going back keeps everything, and the `Vpc`'s docs warn of it.
- **4.x kept the whole tunnel secret**, address and subnets too, because the key was in it. The V5 `Vpc` keeps the key secret, and the rest, which isn't, in plain text.

**Not decided, for the maintainer:** the NAT instances and the bastion take the newest image on every deploy, as in 4.x, so a new fck-nat or Amazon Linux release replaces them, and replacing a NAT instance cuts the private subnets off for a while. Leaving changes to the image alone once an instance exists (`ignoreChanges`) would stop that, at the price of never updating it without a replace by hand.

**Left:** the V5 `Efs` still counts a VPC's subnets inside an `apply` and names each mount target after its subnet's id; its 5.0 form reads the `Vpc`'s subnets by AZ, which a preview can count, and moves the mount targets with a map. Then `Nextjs` with `Router`, the `Function`'s rebuild the 5.0 way, and releasing and adopting `BucketFiles` and `KvKeys`.

## 2026-11-01: step 4, the shared dev stub code is taken over

Looking into the `Function` with its dev stubs, the first of the gate's hard components, showed that the gap the recordings found there wasn't one.

**Done, committed (not pushed):**

- **Each run in the takeover helpers starts as a run of the program does** (`src/auto/run.ts`): with the 4.x `Function`'s dev stub code forgotten, which its functions share within a run. `takesOverState()` ran both programs in one process, so the V5 `Function` found the object the 4.x run had created, created nothing, and the stub code was listed as unclaimed. The `Function` suite already reset it by hand; `takesOver()` and `takeoverCases()` now do it for every suite.

**Checked** (`recorded.test.ts`, all platform tests and `tsc`): **the V5 `Function` takes over 4.x's shared dev stub code** (`DevBridgeCode<region>Bridge`) in the `sst dev` recording, with nothing to update. The earlier finding below was wrong.

## 2026-11-01: step 4, the VPC recording

The maintainer said yes to the VPC recording next: the lab's containers and databases, which v4.23.1 deployed in a VPC (`vpc-containers-databases.json`), checked as the serverless group is. `Vpc` has no V5 form yet, so both programs are given the 4.x one, as the lab does.

**Done, committed (not pushed):**

- **The lab's VPC groups are in the repo** (`test/recorded/v5-lab.ts`: `net`, `containers`, `databases`, and the web service's image folder), and in `recorded.test.ts`, with what the lab account answered the lookups the deploy made: its availability zones, the bastion's image, and the registry login an image is pushed with.
- **The replay reads the state as if the app were deployed from the test's folder:** a state names the app's folder (`/home/user/v5-lab`, scrubbed), and a service writes into its image's folder, so the folder has to be real.
- **An image is compared as the Docker build provider checks it** (`asChecked()`): the provider fills in its schema's defaults and Go's zero value for each field that isn't a pointer, without listing them (`__defaults`), and keeps a registry's password secret whatever it's given. Taken from the provider's source at the recorded version (0.0.22). The 4.x service creates its image inside an `apply`, so the password reaches the provider in plain text, and only the provider's schema keeps it secret.

**Checked** (`recorded.test.ts`, `state.test.ts`, all platform tests and `tsc`):

- **4.x gives what the state has**: every resource claimed and nothing more, the same inputs, options and outputs, the same values secret, nothing out of order.
- **V5 takes it over and changes nothing in AWS.** The `Cluster`, `Efs`, `Service` with its image, domain and scaling, the shared `Alb`, `Task`, `CronV2`, the `Function` in the VPC, `Postgres` with its proxy, `Mysql`, `Redis`, `Aurora` and `Dsql` update no resource. What goes: 4.x's version markers, and what `sst dev` runs for each service, which V5 keeps inside the service under another name. The orders 4.x removes things in that V5 doesn't keep are ones nothing in AWS needs: a function's URL and its permissions waited for all of what the function links, and the web service's load balancer for its cluster, file system and private subnets. Each V5 function in the VPC is still removed before its subnets. Nothing secret is in plain text but what's made from a function's ARN, as in the serverless group.

**Left:** the hard components: the `Function` with its dev stubs, `Nextjs` with `Router`, `Vpc`, and releasing and adopting `BucketFiles` and `KvKeys`.

## 2026-11-01: step 4, the maps against the recorded states

The maintainer asked to continue with step 4. Its first item after `--check` is checking each component's map, under the mock, against the states v4.23.1 really deployed (`testdata/states`), so CI catches what only the AWS run caught before.

**Done, committed (not pushed):**

- **The mock replays a recorded state** (`recorded` in `mockPulumi()`, `src/testing/state.ts`). A resource at an address the state has, or that answers to one through an alias, comes back with the id and outputs AWS gave, as the engine reads them from the state, a secret as `[secret]`. The answer is handed to the engine's mock as the request is sent, so two resources of the same type and name get their own. A lookup answers as the provider did where the state says: the region of the provider a resource is created with, and an IAM policy rendered as the AWS provider's source renders it (a set of one a string, a longer one sorted in reverse, a condition's values in order, keys in a fixed order, `&{` as `${`, HTML escaped as Go does). `cli` answers for the CLI, like the bucket the lab's code went to.
- **`stateGraph()`** reads a state into the graph `takeover()` compares, with what the provider adds taken off (the defaults it lists, `tagsAll`, a region that's the provider's), and what a state can't hold left out of the comparison (`deleteBeforeReplace`, what a function is built from). Against a state, a value is hidden only where the state has a secret (the provider can keep one on what holds it, like a list, or on the field itself), an asset or archive is compared only as one, and a build's hash, which the mock's build can't match, as the CLI's.
- **`takesOverState()`** (the platform's test helper) runs the program that deployed a state, then what replaces it. The first has to give what the state has: that proves the program is the one that deployed it. The second is checked against the first, with the state's ids and outputs. What the state can't hold, like a secret's value or a function's links, is compared as the first program gave it.
- **`compare()`** beside `takeover()`: what it checks, plus `hidden` (where a plain value is a secret now), `created` (what takes the place of nothing) and `pairs`.
- **`takeover()` says where a secret is in plain text now** (`revealed`: `"MyParameter.value"`), by the place in a resource's inputs or a component's outputs, as Pulumi stores it: a deploy updates nothing for it, but the state holds the value in plain text from then on. Every takeover case checks it's empty. Against a recorded state, a plain value with `[secret]` in it is listed too, wherever it's registered: a secret the state has, written in plain text.
- **What's compared is what the provider sees:** a secret by its value, an asset by what was in its file when it was registered (Pulumi compares assets by hash, not path, and a later build can write the same path again). When the mock runs against a state, nothing is rewritten under the names it had, in the inputs or in what a function is built from: the values came from the state, and rewriting them hid differences (below).
- **The mock's build answers as the CLI's Node.js build does:** `bundle.<the handler's export>`, like `bundle.handler`, not `index.handler`. **For the release notes:** a package's test that expects `index.handler` from `mock()` sees `bundle.handler`.
- **The lab app's serverless group is in the repo** (`test/recorded/v5-lab.ts`, with its schema), the program that deployed `serverless-sites` and `serverless-dev`.
- **The scrub makes again what it changes:** a name SST hashed from an ARN, like a queue's subscriber's, was made from the real account id, so the scrubbed ARN gave another name. The lab's `scrub-state.py` now checks each such name against the real ARN and makes it again from the scrubbed one, everywhere it's used, and the two serverless recordings were scrubbed again. The VPC recording had none.

**Checked** (`test/components/v5/recorded.test.ts`, `test/testing/state.test.ts`, all platform tests and `tsc`):

- **4.x gives what the state has**, for the serverless group deployed and as `sst dev` deploys it: every resource claimed and nothing more, nothing out of order, the same inputs, options and outputs as far as the state holds them, and the same values secret. The one difference is real: since v4.23.1, #214 names a subscriber's function without "Function" twice, so its code is uploaded under a new key, and in `sst dev` its id changes.
- **V5 takes it over.** Only the components 4.x wrapped things in leave the state, and V5 creates nothing that takes the place of nothing. What changes: four subscribers' functions' descriptions, and each function's code object, which is uploaded under its part's name, as the V5 `Function`'s map says (`replaced: code`). In `sst dev`, a function's id is its part's name, so its stub's `SST_FUNCTION_ID` changes and nothing else in its environment. The orders 4.x removes things in that V5 doesn't keep are ones nothing in AWS needs: a route waited for all of its API, domain included, and a function for all of each component it links. Nothing secret is in plain text but what's made from a function's ARN (below); with the `_live` fix undone, the check lists the client's secret in each function's `_live`.

**Found:**

- **The V5 `Function` wrote its links' values into the state in plain text in `sst dev`**, a Cognito client's secret among them, in the `_live` output (`unsecret`). 4.x writes only their names there, and nothing reads `_live`. Fixed: names only.
- **(Wrong, [corrected](#2026-11-01-step-4-the-shared-dev-stub-code-is-taken-over): the test reused 4.x's object.) V5 doesn't take over 4.x's shared dev stub code** (`DevBridgeCode<region>Bridge`), which is kept in the bucket when it leaves the state. `--check` would fail on it. For the `Function` with its dev stubs, at the gate: its map releases it, or it's kept.
- **The V5 `Function`'s code and source map keys are secrets**, because the code is built with the key the links are encrypted with. A deploy changes nothing for it, but `sst diff` shows the key as `[secret]`. For the 5.0 `Function`.
- **4.x makes everything made from a function's ARN a secret** (a permission's function, an integration's URI), because the function is created inside an apply that reads that key. V5 doesn't, which is better and changes nothing in AWS.
- **The mock's comparison hid renames in values.** It rewrote names in what's compared, for ids and ARNs it made up from them, and so a code object's key under a new name compared the same. Against a state it's off; the suites without one still do it.
- **The review** (an independent agent) found eight problems in the first version, all fixed above: a property holding a secret was hidden as a whole, so a plain field beside the secret could change unseen (a schedule's target role); unwrapping secrets meant no suite saw one become plain text; the replay queued its answers by type and name, which two resources share; names were still rewritten in what a function is built from; a file asset was read when compared, after a later build could write it again; a note on why the V5 function's order differs was wrong; the state's dependencies were used where the replay's are the same (now: the replay has to keep every order the state has, which it does); and nothing said what a program creates that the state doesn't have. The policy rendering didn't follow the provider for a condition's values or a principal of anyone.

**Left:** the VPC recording (`Vpc` from 4.x, the containers and databases with V5), and then the hard components.

## 2026-11-01: step 4 started, `sst migrate --check`

The maintainer asked for step 3's check against the recordings, then step 4. The recordings can't be replayed as step 1 did it: each stage's passphrase was deleted with the stage, and the state's secrets can't be read without it. So the check means deploying the stages again, and the maintainer left it for later. Step 4 starts with `sst migrate --check`, the gate for every component.

**Done, reviewed, committed (not pushed):**

- **`sst migrate --check --stage <stage>`** runs Pulumi's preview of the move (the path `sst diff` takes, which writes nothing) and sorts each step by [goals 1 to 3](goals.md) (`pkg/move`):
  - **kept**: the same resource, at its address or at a new one, maybe updated in place, with the fields that change;
  - **taken out of the state** or **created**: a component, a wrapper or a provider, which has nothing in the cloud behind it ([decision](plan.md#decisions));
  - **released**, **created** or **replaced**, when a component's map says so;
  - **a problem**, anything else: a create, delete or replace no map lists, and, whatever a map says, a delete or replace of what holds data (by what it is and by what it was), a release of it to a part that doesn't import it by its id, or an update that empties it (a `Vector`'s `dimension`), keeps what it holds for less time (a log group's, queue's, stream's or database's retention) or changes what expires (a table's TTL, a bucket's lifecycle rules). A delete the app's removal policy would keep in the cloud is still a problem: the app would lose it. So is a resource the app manages that it would only look up.
  It exits with an error when there's a problem, and `--json` prints what it found. `--dev` checks the stage as `sst dev` deploys it. Without `--check`, it says the move itself isn't built yet.
- **What holds data** is a list of types (`pkg/move/data.go`): goal 2's, plus Kinesis streams, OpenSearch domains, Cognito identity pools, backup vaults (`Dsql`'s), the key a 4.x `Auth` signs with, and Cloudflare's R2 buckets, D1 databases, KV namespaces and queues.
- **A state map says more:** `added` (parts the old component didn't have; what's inside one is new too), `replaced` (with what changes for the user) and `released` (the old addresses a part takes the place of, with their type) beside `moved`. While a stage moves, the program's `$cli.move` is set (`context().move` in the program contract), and each component tells the core what its map says about each part it creates, through the RPC (`Move.Part`). `mock({ move: true })` records the same, and `moved()` returns it.
- **The V5 `Function`'s map lists its code and source maps as replaced.** Each is an object keyed by what's in it, uploaded under a new key whenever the code changes, as when a subscriber's function is renamed.
- **No step goes unseen.** The command reads the steps on a subscription of its own, not the UI's, which drops events when it falls behind, fails if any was lost, and counts the steps of each kind against the preview's summary.
- **The CLI no longer loses a line of Pulumi's event log** it reads while Pulumi is still writing it. It dropped what it had read of the line, and then couldn't read the rest. That's older than this work, and every command reads the log that way.

**Checked:**

- **On the Floci stage, nothing in AWS.** The lab's target group deployed with the 4.x `Bucket`, `Dynamo`, `Queue` with a subscriber and `Function` (`LAB_TARGET=v4`). With the V5 ones, `sst migrate --check` passed: 29 kept, 6 at a new address, the subscriber's function updated in place, 4.x's wrapper taken out of the state, and the subscriber's code replaced, as the `Function`'s map says. A deploy with the V5 ones then did exactly that: compared by cloud id, 17 of 18 kept, 5 under a new name, and only the code object new. With the table renamed, the check failed on the old table's delete ("It holds data.") and the new one's create. The stage was removed, the container stopped on its own, and the stage's files were deleted.
- After the review's fixes, the same three runs on a new Floci stage gave the same results, with every step counted against the summary. Removed and cleaned up again.
- `pkg/move`'s tests for each rule, the platform's tests (1,839) and `tsc`, and all Go tests.
- **An independent review** reproduced three ways the check passed what loses data, each fixed and tested: the data rules looked only at what a resource is now, so one moved to a part of another type was replaced without a word; releasing what holds data was allowed with nothing to take it over, and a release that never happened still let the part in its place be created; and only a `Vector`'s `dimension` counted as an update that loses data. It also found the event log's lost line, a backup vault and an identity pool missing from the list, a resource left over from an earlier replace taken for a replace, and a managed resource that would only be looked up taken as kept, each fixed.

**Found:**

- **Pulumi reports the last step of a replace at the old address** when the resource moved, so the check groups a replace's steps by where the resource went. Without that, it showed one replace as two.
- **A preview can't see what's built from a value a move creates.** With the table renamed, the function that links it couldn't be built in the preview, so the source map it would upload never showed, and the old one looked deleted. It only happens when a move creates something a function links to, which fails the check already.
- **A part's address isn't set while its transformations run**, so it's read once they have.
- **What a preview can't see, the check can't either.** A resource created inside `.apply()` on a value the preview doesn't know isn't in the preview, so its create isn't checked. A release whose old address isn't known in the preview isn't reported, which fails the check rather than passing it.

**What a preview can't see, settled.** The maintainer asked whether the gap could be closed properly rather than patched. Options weighed: holding the move to its preview with Pulumi's update plans (`--plan` is still experimental in 3.267, and only stops a move partway), and comparing the move with the check after it ran (a report, not a guard). The proper fix is at the cause: a component creates nothing inside an `apply`, so a preview registers all of it ([decision](plan.md#decisions)). Goal 6 already asked it of every 5.0 component; what was checked is that it can be done:

- **Pulumi's docs** say to avoid creating resources inside `apply` because a preview won't show them, and to pass the output as an input instead. The case they call hard, a certificate's DNS validation records, isn't: how many there are follows from the domain names (a wildcard shares its domain's record), and only each record's name and value come from the certificate.
- **An inventory** of the V5 components and their helpers, and the 4.x `Nextjs`, `Router`, `Vpc`, sites and `Function`, found 69 places that create something inside an `apply`. Most wait on a value they only pass in (a build held for a lock, `Nextjs` waiting on its table's ARN), so the resource can be created directly. Some wait on an arg that decides what's created (a `Vpc`'s zones, how a function URL is protected), which becomes a plain value. `Efs` counts a new `Vpc`'s subnets from one output, so a `Vpc` gives its subnets as a list of known length. A function's source maps come from its bundle, which doesn't depend on its links (they're encrypted into a file of their own after the build). A site's servers, image optimizer and revalidation come from its code and framework config, not from the link values in the build's environment. None needs a value only known once something else in the same deploy is created.

**First applied: the V5 `Function`'s source maps.** They were created once the build was known, and on a new stage the build waits for the key and the links, so a preview had none. The preview now learns them from the build without the key and the links, which it already ran for the handler, and each one uploads the file the deploy's build wrote. A new test (`v5/function-preview.test.ts`) runs a new stage's preview, where nothing AWS gives back is known: it had 4 of the function's 6 resources before, and has the same 6 as a deploy now. On the Floci stage, the check of the move with the table renamed no longer shows the source map as deleted: it's replaced, as the `Function`'s map says, and only the table's delete and create are problems.

**Left:** the check under the mock against the recorded states, and the hard components, each built so a preview sees all it creates. The move itself (`sst migrate`) is step 5.

## 2026-11-01: step 3, four gaps closed

The maintainer asked what closes the gaps the last entry left, and chose for each ([decisions](plan.md#decisions)).

**Done, reviewed, committed (not pushed):**

- **Code that imports `sst` needs no `skipLibCheck`.** `sst` installs `@types/aws-lambda`, which three of its SDK's declarations use. Two declarations had type errors that a `@ts-expect-error` hid in the source, which a declaration drops: `VectorClient`'s and `event`'s. Both are written so they need none. A check in CI type-checks what an app imports from `sst` against the built SDK without `skipLibCheck`, under NodeNext and bundler, and that every package its declarations import is one `sst` installs, or one an app brings for the module that uses it (`hono` for `sst/auth`, `zod` or `valibot` for `sst/event`).
- **The target suite checks `sst dev`.** It runs `sst dev`, calls a function through the target, and checks that the worker on this machine answers with the target's credentials and region and nothing planted. A target that doesn't run functions turns it off. It also checks that the container stops once nothing is deployed on it, and that `sst target stop` stops it.
- **The first deploy of a stage with checks shows nothing of the run that stopped.** From where the program says it has checks, nothing of that run is shown or kept, its update is taken out of the history, and the run with a preview goes on under the same heading.
- **`sst target stop` and `sst target reset`**, and **`sst remove` stops a target's container** once no stage of any app has anything deployed on it, keeping its data. Both commands read the config without starting the target. `reset` lists the stages with something deployed, asks, and removes the container, its volumes and the target's home. A container of that name SST didn't start is left alone.
- **`sst dev`'s UI asks to deploy again** for a few seconds if the first request fails, and says so if it still fails. Once, in the suite, `sst dev` started and never deployed, with nothing said; it didn't happen again in ten tries, or in the suite after.

**Checked:**

- The SDK check passes, and fails when `@types/aws-lambda` is only a dev dependency. The SDK's own tests pass.
- **Against Floci, started new:** the target suite passed all 19 of its checks twice, `sst dev` among them, and the container stopped after the remove. The Floci package's tests passed. A first deploy of a stage with checks showed one heading, no error, and kept one update. `sst target reset` answered no left everything, and with `--yes` removed the container, its volume and its home.
- The platform's 1,835 tests and all Go tests.
- **An independent review** found these, each fixed: `sst target reset` stopped at a state it couldn't read, which is when it's needed most, so it says so and goes on; `sst remove` could stop the container under another stage's first deploy, which has nothing in its state yet, so a command running on any other stage keeps it going; the suite waited for `sst dev`'s output to close, which a process it started can hold open; `sst target stop` said the container wasn't running when Docker wasn't; `reset` without a terminal now says to pass `--yes`. The suite passed all its checks again after.

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
