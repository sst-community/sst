# SST's own components

The rules for changing or adding one of SST's own components, in `aws/`, `cloudflare/`
and `experimental/` beside this file, as a person or an agent, with a checklist.
Everything in `README.md` applies: read it first. What's here is particular to SST's:
the helpers they share, the takeover maps `sst migrate` moves a stage with, and their
tests. It's written for AWS; for Cloudflare, read `cloudflare/` for `aws/` and
`sst.cloudflare` for `sst.aws`.

## Ground rules

- **Hold to the [goals](../../../docs/plans/v5-rewrite/goals.md).** A change keeps what
  a stage has deployed, never replaces or deletes a resource that holds data, declares
  every resource it creates as a part, and shows in `sst diff` what its deploy does.
- **Each component takes the place of one of SST 4's, with its type.** `Queue` in
  `aws/queue.ts` has SST 4's type, `sst:aws:Queue`, so a stage SST 4 deployed moves to
  it with `sst migrate`: the component, and each resource in it that has the name it
  had, are kept. A few have a clearer name than SST 4's, which the maintainer chose:
  `Cron` (SST 4's `CronV2`), `ApiGatewayRest` (`ApiGatewayV1`), `ApiGatewayHttp`
  (`ApiGatewayV2`), and Cloudflare's `StaticSite` (`StaticSiteV2`). Each keeps SST 4's
  type (`sst:aws:CronV2`), and is listed in `RENAMED` in
  `test/components/v5-components.test.ts`, by provider. That test expects each
  component to take the place of one of SST 4's, so a component SST 4 didn't have is
  added to it first.
- **SST 4's components are frozen** in `platform/test/fixtures/v4/components/`, laid
  out as they were. The takeover suites and the recorded states load them, and nothing
  else does: the platform has none of them and imports nothing from the tests
  (`v5-components.test.ts`). Edit one only to keep it loading, never to change what it
  creates: it's what SST 4 deployed. In prose, say "SST 4's `Queue`"; in what the docs
  are generated from, name SST 4's only in the "Switch from" section.
- **A component owns its args.** It builds on no type of SST 4's, docs included.
- **What a component refuses, SST's say with the helpers in `args.ts`.** They aren't
  exported, so a package's components say it their own way (`README.md`). An option
  that isn't taken: `notAnOption(args, option, instead, owner)`. Settings next to a
  resource given in `existing`: `usedAsItIs(args, keys, part, owner)`. An `existing`
  entry the component won't use: `notAnExistingPart(args.existing, part, owner,
  instead)`, or `onlyExisting()`. An output inside an arg a resource is named after:
  `plainDeep(value, what)`. A static `get` passes `getArgs({ existing })`, which marks
  what it passes: a `$transform` for the component runs on it too, and what that adds
  isn't refused.
- **What an app creates once is made once in each run** of the program. A resource
  its components share, like the key a function's links are encrypted with, is kept
  in a `perRun()` value (`src/util/lazy.ts`), not a static of a class: the CLI's run
  and the mock's `reset()` start a new run with `newRun()`, so a test sees what a run
  creates whatever ran before it. The functions' are in `helpers/function-shared.ts`.
- **Reproduce what SST 4 deployed, not what it meant to.** SST 4's `Function` trusted
  the account in every role because a check never passed, and SST 5's wrote the same
  policy until `main` fixed SST 4. Changing what a stage has is a decision of its own,
  not a side effect of another change.

## What becomes a part, and what stays a component

- Something that only **wires resources together** is a part of the parent, a `many`
  part keyed by a name the user gives: a subscription, a route, an authorizer, a data
  source, an identity provider. SST 4 usually kept these in a wrapper component of their
  own. The method that adds one returns the parent (so calls chain) or the AWS resource
  (when the user needs something off it, like `authorizer.id`).
- Something the user **names and links in its own right** stays a component of its own,
  returned by the method that adds it. `addClient("Web")` on a `CognitoUserPool` returns
  a `CognitoUserPoolClient`, so `link: [client]` still gives `Resource.Web.id`.
- A method takes no `transform` of its own: the component's `transform` has each part.
  `this.assertNew()` refuses one passed to the method, with a message.
- SST 4's deprecated forms aren't taken (`subscribe(handler)` with no name). Throw an
  error that shows the call to write instead; without one the user gets whatever the
  shifted arguments happen to fail on. The `Cluster` has `addService` and `addTask` only
  to say what to write, marked `@internal` so they stay off its page.
- A static method that adds something to a resource outside the app (SST 4's
  `Dynamo.subscribe` with a stream ARN) is `get(...)` and the ordinary method. The
  takeover map can still find what the static method created: see `takeover/dynamo.ts`.

## Helpers

| For | Use |
| --- | --- |
| A function from a handler, args, an ARN, a function or a `Workflow` | `functionPart()` in `helpers/function-part.ts` |
| A function arg: a handler or args as a plain value, or a function or its ARN, which can be an output | `FunctionInput`, and `plainFunction(definition, what)` before `functionPart()`, in `helpers/function-part.ts` |
| Letting a service invoke that function | `invokePermissionArgs(fn, principal, sourceArn)` in `helpers/function-permission.ts` |
| A custom domain (`name`, `dns`, `cert`): the certificate (`aws/dns-validated-certificate.ts`) as a part, and the records pointed at the service with the adapter's `alias()` | `DomainArgs` and `domainOf(domain, owner)` in `helpers/domain.ts` |
| Event source mappings, and a named subscriber with its function and mapping | `filterCriteria()`, `batchSettings()`, `assertNamedSubscriber()`, `eventSourceSubscriber()` in `helpers/event-source.ts` |
| Letting a service send to a queue | `sendPolicy(queueArn)` in `helpers/queue-policy.ts`, the args and options of the queue's one policy, kept on delete |
| An EventBridge rule's state, and a rule that calls a function | `enabledState()`, `ruleFunctionTarget()` in `helpers/eventbridge.ts` |
| A Fargate task: its containers, roles, images, log groups and task definition | `fargateTaskParts` (each component declares its own `taskDefinition`), `fargateTaskOf()` and `createTaskDefinition(builder, ...)`, which the `Task` and the `Service` share, `givenTaskDefinition()` for one given in `existing`, `rolesToPass(taskDefinition)` for what runs a task, and `containersOf()`, `sizeOf()`, `taskRoleArgs(args, parent, dev, additional)`, `executionRoleArgs(containers, parent)`, `containerImage()`, `logGroupArgs()`, `taskDefinitionArgs()` in `helpers/fargate.ts` |
| The VPC of a cluster, whichever way the cluster was given it | `networkOf(cluster)` in `helpers/fargate.ts` |
| A `cluster`, `alb` or `efs` arg: checking it's one | `isCluster(value)` in `helpers/cluster.ts`, `isAlb(value)` in `helpers/alb.ts`, `isEfs(value)` in `helpers/efs.ts` |
| A role's inline policy from permissions, and refusing `permissions` next to a role you have | `inlinePolicies()`, `noPermissionsFor()` in `helpers/iam.ts` |
| A `vpc` arg: a `Vpc`, or the ids of a VPC | `isVpc(vpc)`, `subnetsOf(vpc, kind)`, `hasNat(vpc)`, `assertVpcIds(vpc, what)`, `subnetsAndSecurityGroupsOf(vpc, what)`, and `privateNetworkOf(vpc, what, noNat)` for a resource in the private subnets, in `helpers/vpc.ts` |
| A resource for each private subnet of a VPC, kept by its AZ | `privateSubnetsOf(vpc, parent, what)` in `helpers/vpc.ts`: by the AZ's number for a `Vpc` the app creates, by its name for one from `get`; and `subnetsByAz(subnets, parent, what)` for subnet ids. Where it's a promise, of what a preview knows, create them with `after()` |
| Deciding from an output a preview knows, like a lookup's | `knownValue(output)` in `args.ts`, for `after()` |
| A load balancer: its security group, what a listener answers by default, a domain with aliases and its DNS records | `LoadBalancerDomainArgs`, `securityGroupArgs()`, `forbidden()`, `loadBalancerDomain()`, `certificateOf()`, `pointDomainAt()` in `helpers/load-balancer-args.ts`, on `domainOf()` and the adapters |
| A database or cache that runs on the user's machine in `sst dev`: the pane that says how to set up the local server | `localServerPane(server, using, listening)` in `helpers/local-server.ts`, given to `this.report({ dev })`, with a password in it shown by `shownPassword()`; `devValue()` for a `dev` value's default, and `localPassword()`, which refuses a missing one |
| An RDS database: storage limit, replicas, the proxy, a stored password, and a local one in `sst dev` | `rdsCredentialParts` and `rdsProxyParts`, with `createCredentials(builder, ...)`, `createRdsProxy(builder, ...)` and `createRdsProxyTarget(builder, ...)`, which the `Aurora` and the RDS-instance databases share, and `maxStorage()`, `replicaArgs()`, `localDatabase()` in `helpers/rds.ts` |
| A password kept in a secret a resource is tagged with | `tagOf(resource, tag, notFound)`, `secretField(secretId, field, parent)` in `helpers/secret.ts` |
| A database on an RDS instance, whole: what the `Postgres` and the `Mysql` share | `rdsInstanceParts`, `RdsInstanceArgs`, and `createRdsInstance(this.builder(), name, args, engine)` with the engine's `RdsEngine`, in `helpers/rds-instance.ts`; the tests in `test/components/v5/rds-instance.suite.ts` |
| A site with a server, whole: what the `Nextjs`, `Astro`, `SvelteKit`, `TanStackStart`, `Remix`, `React`, `Nuxt`, `SolidStart` and `Analog` share | `ssrSiteParts`, `SsrSiteArgs`, and `createSsrSite(this.builder(), name, args, framework)` with the framework's `SsrFramework`, in `helpers/ssr-site.ts`. The framework gives its build command, reads its build into a `SiteBuild` with the site's plan, says how its server is built (`ServerPlan`, which the site's own args are merged into) and creates what it adds, like `Nextjs`'s image optimizer. A framework with args of its own, like `Remix`'s `buildDirectory`, is made from the site's args and checks them in `check`. One whose build has no versioned folder says `versionedFiles: false`, so `invalidation.paths: "versioned"` makes no invalidation, as in SST 4. A framework without a build command of its own builds with `defaultBuildCommand(sitePath)` in `helpers/site-build.ts`, the `build` script by the app's package manager. `configText(sitePath, "vite.config")` there reads a config file in whichever extension it has, and `configValue(sitePath, file, key)` a value in it, like the base path. `nitroSite()` in `helpers/nitro.ts` loads a Nitro build, refusing one without the `aws-lambda` preset, for the four Nitro frameworks. A framework's `load(builtPath, owner)` gives a `SiteBuild`, with `server` when the site runs one; only a framework that creates parts for its server, like `Nextjs`, gives `server()`. What a site shares with the `StaticSite` (its path, `sst dev`, `router`) is in `helpers/site.ts`, and its distribution, which the `Router` shares too, in `helpers/distribution.ts`. `urlAccessArgs(fn, distributionArn)` gives the permissions to call a function's URL. The takeover map's shared part is `ssrSiteTakeover(label, warmedWhen)` in `takeover/ssr-site.ts`, and the tests every site passes are in `test/components/v5/ssr-site.suite.ts` |
| A site's viewer request function, which routes it with the key-value store | `siteRequestCode(namespace, injection, blocksCloudFrontUrl)` in `helpers/ssr-site.ts`, which the `StaticSite` shares. A site with no server isn't on `createSsrSite`: the `StaticSite` builds with `buildSite()` and uploads its folder as it is |
| What two components share, as more than args: their parts, built by a helper | `this.builder()`, which gives the helper the component's `part()`, `existingPart()`, `runsLocally()` and `report()`. Declare the shared parts as `const parts = sharedParts`; the docs follow it |
| An arg with a default, then converted | `withDefault(value, fallback, convert?)` in `args.ts` |
| An arg that may be unset | `ifSet(value, convert?)` in `args.ts` |
| An arg that must not be an output | `plain(value, what, why?)` in `args.ts`; `why` when it doesn't decide which resources are created, like what a build reads |
| An arg that must not have an output anywhere inside it | `plainDeep(value, what, why?)` in `args.ts` |
| Serving a component through a `Router` | `RouteArgs`, `SiteRouteArgs` (a site's: the instance, domain and path), and `routeOf(route, what)`, which checks the instance is plain and says whether the router signs its requests, in `helpers/router.ts` |
| A `queue` or `topic` arg: a `Queue` or `SnsTopic`, or an ARN | `queueArnOf()` in `helpers/queue.ts`, `topicArnOf()` in `helpers/sns-topic.ts` |
| An API Gateway API's custom domain, access log, routes and their permissions, and the account's logging role | `ApiGatewayDomainArgs`, `apiDomainOf()`, `createRegionalDomain()`, `ApiGatewayAccessLogArgs`, `accessLogGroup()`, `parseRoute()`, `routePermissionArgs()`, `authorizerPermissionArgs()` in `helpers/apigateway.ts`, and `apiGatewayAccount(builder, name)` in `helpers/apigateway-account.ts` |
| Building a site in the program, with what it links | `buildSite()` in `helpers/site-build.ts` |
| A site's files, key-value entries and invalidation, as SST 4's sites made them | `siteFiles()`, `siteKvEntries()`, `siteInvalidation()` in `site-code.ts` |
| An option that isn't taken, or one inside an arg | `notAnOption(args, option, instead, owner)`, `notAnOptionOf(value, option, instead, owner)` in `args.ts` |
| An `existing` entry the component won't use | `notAnExistingPart(args.existing, part, owner, instead)`, or `onlyExisting(args.existing, used, owner)` next to a main resource, in `args.ts` |
| Settings next to a resource given in `existing` | `usedAsItIs(args, keys, part, owner)` in `args.ts`; a `get` creates the component with `getArgs({ existing })`, which it doesn't check |
| A value made on this machine from things in AWS, like built code | `withoutDependencies(output)` in `args.ts` |
| Parts in another region | `useProvider()` in `helpers/provider.ts` |

A helper returns the args of a part, or checks an arg. The component still creates
each part with `this.part()`, so its constructor reads as the list of what it creates.
The `Postgres` and `Mysql` are the same component but for a handful of settings, and
share everything else this way.

One helper creates a part itself: `containerImage()` builds a container's image behind
the limit on how many builds run at once, so the image is created when its turn comes.
It gets the part's name, transform and old address from `component.partHandle(key, id)`,
the way `functionPart()` does. Reach for that only when `this.part()` can't do it.

Args that several components take are declared once, in a helper. The docs generator
reads every file in `aws/helpers/`, and a helper file gets no page of its own:

- An interface the components' args extend, for args they share. `FargateBaseArgs` in
  `helpers/fargate.ts` is what a task and a service both run, and with what;
  `FargateArgs`, which it extends, is their `cluster` and `volumes`. Their args show on
  each page as the component's own.
- A named type the args use. `ContainerArgs` in `helpers/fargate.ts` and `ProxyArgs` in
  `helpers/rds.ts` get a section on each page that uses them, as if the page's file
  declared them.
- A name for a type, like `FunctionInput`. A page shows what it stands for.

Write a helper's doc comments for any page: don't name a component in them. The
comment on an interface that's only extended isn't shown.

## Taking over what SST 4 deployed

`sst migrate` moves a stage SST 4 deployed to SST 5's components, and has to keep what
it deployed. The component and every part with the name it had are kept as they are,
because the type is the same. What moved goes in a **takeover map**,
`aws/takeover/<name>.ts`, imported from `aws/takeover/index.ts`. The component itself
knows nothing about SST 4. A component with nothing that moved still has a map, an
empty one, `takeover(Cdn, {})`: `v5-components.test.ts` checks each component has one.

A map is a file that's imported for what it does, not for what it exports. The CLI
bundles a config with esbuild, which leaves such a file out of a package that says it
has no side effects, so `sideEffects` in `platform/package.json` lists
`aws/takeover/*.ts` and `cloudflare/takeover/*.ts`. Without that line every map is
dropped from a real build and a move deletes and recreates whatever moved, while every
test under the mock passes. `v5-components.test.ts` bundles the components the way the
CLI does and checks the maps are in.

```ts
// From "../apigateway-http"
takeover(ApiGatewayHttp, {
  moved: {
    // A part whose key changed: it was `<Api>AccessLog`
    logGroup: "accessLog",
    // A part that lived in a wrapper component at the top of the app
    authorizer: (_, { name, id }) =>
      childOf(
        "sst:aws:ApiGatewayV2Authorizer",
        `${name}Authorizer${logicalName(id)}`,
        "Authorizer",
      ),
  },
});
```

- A part is matched by its key. List it under `moved` only when its old name or parent
  was different.
- `childOf(type, component, child)` is the old address of something inside a wrapper
  component. Pass the component as a fourth argument when SST 4 created the wrapper
  with the component's own options, so it sat beside the component rather than at the
  top (`Bucket.notify` does, and SST 4's `Nextjs` subscribing to its revalidation
  queue). `childWithin(type, component, child, owner)` is for a wrapper SST 4 created
  inside the component itself, like SST 4's `Nextjs`'s warmer in a `Cron`.
- `{ name, parent: false }` is something SST 4 created with no parent at all.
- A `moved` function can return several candidates. Addresses that don't exist are
  ignored. A candidate's name can be made from one of the component's outputs, like
  the table's own name.
- When SST 4 created a resource inside `.apply()`, a `transform` function for it was
  given plain values. Created directly, it's given outputs for whatever is made from
  the component's args. Say so in the "Switch from" section.
- A resource SST 4 **looked up** outside the component (`Bucket.get`) can't be carried
  over, because a lookup takes no old address. It's dropped from state and looked up
  again, which changes nothing in AWS.
- A resource SST 4 looked up under the component for a value isn't a part: it's not
  the component's to transform or replace. Look it up with a function instead, which a
  preview runs too: the `Efs` does this for the VPC whose CIDR block it reads
  (`ec2.getVpcOutput`), and the `StaticSite` for the bucket `assets.bucket` names. A
  move takes SST 4's lookup out of the state, which changes nothing in AWS; the
  takeover test lists it as unclaimed.
- A part that gets a new name keeps its physical name: a generated name is never
  changed once it's deployed. A resource that's named with a `Name` tag is the
  exception (a security group, a VPC endpoint, a subnet): the tag is made from the
  logical name, so a new name updates it. Declare such a part with the name SST 4 gave
  it, `named(optional(ec2.SecurityGroup), "DsqlEndpointSecurityGroup")`, as the `Dsql`
  does. It then needs no entry in the takeover map. The name goes in the declaration
  and not in the map because it has to outlive the map: once a stage has moved, the
  kept name is the one in its state.
- Something SST 4 created without the component's `provider` is given it on a move,
  because a part is always created with it. SST 4 did this for what it created with no
  parent (the alias of a durable function's URL, AppSync's domain association), for a
  wrapper it forgot to give the provider (`SnsTopic`'s queue subscribers), and for
  what's added to a component from a `get` that gave its options to the lookup alone
  (`Bucket.get`, `Dynamo.get`, `CognitoUserPool.get`). That alone replaces nothing:
  Pulumi asks the new provider whether a change of provider replaces what it manages,
  and AWS's and Cloudflare's say no, so it's kept, with that provider's default tags.
  The "with another provider" way of a takeover case finds it: expect it in the case,
  and say so in the "Switch from" section.
- A replace has to create the new resource before it deletes the old one, or the check
  refuses it: in between, what uses it goes without it, and the cloud can refuse the
  delete while it's in use. Pulumi's provider deletes first a resource given its name,
  as no two can have it. A part like that which a move replaces is given
  `deleteBeforeReplace: false`, and a new name on the move where the cloud keeps a
  name to one resource.
- An object in `transform` is merged into the defaults, nested objects included; SST 4
  replaced a nested object whole. So a config that sets a nested default this way
  (`transform: { instance: { tags: { team: "data" } } }`) deploys something different
  after the move: here SST's own tags come back. Find the nested defaults of each part,
  test one (`an object transform that sets tags` in `v5/rds-instance.suite.ts`), and name it
  in the "Switch from" section: "If you set `tags` on the instance with an object in
  `transform`, it keeps the tags SST sets next to yours." The docs generator writes the
  general note, that an object in `transform` is merged, as the last of every "Switch
  from" section; don't write it in the class doc.
- An app's `$transform(sst.aws.Queue, ...)` was written for SST 4's `Queue`, and after
  the move it applies to SST 5's: it's matched by type. So an option SST 4's takes and
  SST 5's doesn't can still arrive. Say where it went with `notAnOption()`. Where that
  would break configs people have, take the old form as well: the `Function` does, for
  `role`, `live`, `logging.logGroup` and `url.route`, because a `$transform` for
  functions reaches the ones inside every component.
- Something SST 4 created outside the component with nothing in AWS behind it needs no
  old address. SST 4's `Service` created a `DevCommand` at the top of the app for each
  container; in SST 5's they're parts, and a move lists the old ones as removed and the
  new ones as created. Expect them in `unclaimed`, and say so in the "Switch from"
  section.
- A function's `description` usually changes, because SST 4 named the wrapper in it.
  That's an in-place update. So does anything else made from the function's name when
  a function part gets a new one: a URL behind a `Router` is registered under a key
  made from it.
- A map from SST 4 is a component's version 1, so it takes no `version`. A change to a
  component after it's released that moves its resources ships version 2, as in
  "Renaming a part later" in `README.md`.
- `takeover()` also takes `from`, the type a component had, for one that takes over
  from a component of another type. Only version 1 can. None does yet.
- One of SST 4's provider resources (`KvKeys`, `BucketFiles`) added its kind to its
  name: `MyFunctionRouteKey.sst.aws.KvKeys`. The ones that take their place don't, and
  a move releases the old one (below).
- A resource SST 4 created outside of any component got no name from SST. Add its type
  to `UNPREFIXED_TYPES` in `naming-rules.ts` so it keeps the name the provider gave it
  (the `Function` does this for the alias of a durable function's URL).

`sst migrate --check --stage <stage>` previews the move of a deployed stage and checks
it. A component, a wrapper or a provider has nothing in the cloud behind it, so it may
leave the state or be created. Anything else the move would create, delete or replace
fails the check, unless the map lists it:

```ts
// A made-up site, to show each
takeover(Site, {
  // Parts SST 4 didn't have. What's inside one, if it's a component, is new too.
  added: ["logs"],
  // Parts a move replaces, with what changes for the user. Only a part that
  // holds no data. The `Function` lists its code and source maps.
  replaced: {
    code: "The site's server code is uploaded again, under a new key.",
  },
  // Parts that take the place of what SST 4 created and a move can't carry
  // over, as when the type changes. The old one leaves the state without its
  // delete being called; the part writes the same thing again, or adopts it by
  // its id.
  released: {
    files: (_, { name }) =>
      sstResource("aws.BucketFiles", { name: `${name}AssetFiles` }),
  },
});
```

SST's own resources, like a site's files (`BucketFiles`), a router's entries (`KvKeys`),
an invalidation or a Worker's URL, are served by the `sst` binary as a Pulumi provider:
use the classes in `aws/resources/`, `cloudflare/resources/` and `vercel/resources/`.
SST 4's were dynamic resources with their kind added to their name, so a part that
takes the place of one releases it with `sstResource(kind, address)` (`takeover.ts`),
the kind with its cloud: `"aws.BucketFiles"`. `sst migrate` marks what's released as
retained in the state, so Pulumi takes it out without calling its delete, which would
delete what it wrote. The takeover tests run SST 5's side as a move, and check that what
takes a released resource's place is given what it was, and that what depended on it
depends on what takes its place.

Most of them write the same thing again. One whose create would make a second thing in
the cloud is adopted instead: the core gives the program the ids of SST 4's origin
access controls while the stage moves (`move.Adoptable` in `pkg/move`), and the part
that releases one imports it by its id, which `sst migrate --check` requires. A
resource a DNS adapter creates for a component isn't a part: the map releases what it
takes the place of with `delegatedReleased`, as the certificate's does for its CAA
records on Cloudflare and Vercel.
A released resource with no `parent` is looked for in the component at each address it
answers to: its own, the type it takes over from, and a name a parent's map gave it
before, as with a subscriber's function. Under one of those, a name that starts with
the component's starts with that address's instead, as Pulumi names a child's alias.

Only a move releases, so only `sst migrate` moves a stage. A stage on SST 5's
components has a marker in its state (`sst:sst:Moved`, `components/move.ts`). The CLI
refuses to deploy or remove a stage that has something deployed and no marker: it's
deployed with `sst migrate`, and removed with SST 4, since some of what SST 4 created
can only be deleted by SST 4's code (`pkg/project/moved.go`). A run on a stage that has
moved, or a new one, leaves the marker before the app's program runs, so a deploy that
fails partway keeps it, and a remove that doesn't finish puts it back. `move.ts` also
refuses SST 4's form of a component on a stage that has SST 5's, and a move that keeps
part of a component in SST 4's form. An app can't create SST 4's forms any more, so
only the tests reach those, with the fixtures (`test/components/moved.test.ts`).

Whatever the map says, the check fails when something that holds data would be
deleted, replaced or emptied: a bucket, a table, a database, a cache, a file system, a
user pool, a queue, a log group, a backup vault, or the secrets a database uses
(`pkg/move/data.go`). It also fails when one would keep what it holds for less time (a
log group's retention), or when what expires would change (a table's TTL, a bucket's
lifecycle rules). Something that holds data can be released only to a part that
adopts it: imports the same resource by its id.
While the stage moves, each component tells the CLI what its map says about each part
it creates; `mock({ move: true })` records the same, and `moved()` returns it
(`test/components/move.test.ts`).

Where a component still creates a resource inside `.apply()`, it has to be given the
output, not the value the callback was called with: the output is what says the
resource depends on where the value came from, so that it's removed first. The
`Service` creates its Cloud Map service inside `.apply()` for a VPC given by its ids,
and gives it the namespace id as the output.

Where the resource that holds on to another isn't given anything of it, say so with
`dependsOn`. A load balancer holds on to its certificate, but only its listeners are
given it, so the `Alb` and `Service` make the load balancer depend on the certificate.
SST 4's didn't, and removing them could fail on a certificate that's still in use.

Also check for an **ordering guarantee** SST 4 made with an `x.apply(() => resource)`
wrapper, and keep it. SST 4's `Bucket` made everything that reads `bucket.name` wait
for the bucket policy; SST 5's keeps that in its getters. Where SST 4 left an order to
chance, and parts that are created directly make it easy to say, say it with
`dependsOn`: the `Service` makes the ECS service wait for the listeners that put its
target groups on the load balancer. That changes nothing a deploy does to what's
already there. `dependsOn` also takes an output of resources, so it works for parts
that are created later: SST 4's `Efs` made its ids wait for the mount targets, and in
SST 5's the access point depends on them.

## Tests

`platform/src/testing/mock.ts` mocks Pulumi and records every resource a component
registers. It ships with the platform, and `mock()` next to it is what an app tests its
own components with, so it imports no test runner. `platform/test/helpers/graph.ts` adds
the takeover suite, which is written for vitest. A component's test file,
`test/components/v5/<name>.test.ts`, starts with its takeover cases, then tests the
component's own behaviour:

```ts
const pulumi = mockPulumi();

describe("takes over a deployed Queue", () => {
  pulumi.takeoverCases({
    // SST 4's, from the fixtures, and SST 5's
    original: () => OriginalQueue,
    v5: () => Queue,
    cases: {
      // Written once, for both: it's given SST 4's, then SST 5's
      "fifo queue": (Queue, opts) => new Queue("MyQueue", { fifo: true }, opts),
      "a subscriber created from a handler": {
        create: (Queue, opts) =>
          new Queue("MyQueue", {}, opts).subscribe("src/subscriber.handler"),
        // What goes: the wrapper, which has nothing in AWS behind it
        unclaimed: ["sst:aws:QueueLambdaSubscriber::MyQueueSubscriberVkxuom"],
        // What a deploy updates: a resource and its fields
        changed: [["MyQueueSubscriberVkxuomFunction", ["description"]]],
        // Anything else to assert, once SST 5's is deployed
        check: () => expect(names()).toContain("MyQueueSubscriberFunction"),
      },
    },
  });
});
```

- Each case deploys SST 4's component, then moves to SST 5's, and expects everything
  SST 4's created to be kept as it is. It's run three ways: as it is, inside another
  component, and with a `provider` of its own. So a case has to pass its `opts` on to
  the component, and fails when it doesn't. A Cloudflare component's suite says
  `provider: "cloudflare"`, so that third way gives it a Cloudflare provider.
- What a case's component is given is each side's own: SST 4's `Vpc` for SST 4's
  `Service`, SST 5's for SST 5's, as an app has. `sidedClass(name, original, v5,
  takeover)` in `test/helpers/graph.ts` gives a class that's one or the other by the
  side being created (see `v5/alb.test.ts`). What it creates moves in its own suite, so
  a case leaves it out of what it compares.
- When SST 4 renamed one of its resources with an alias, or moved one into the
  component from the top of the app, each case is also checked against its graph as it
  was before: a stage deployed with an older SST 4 has the old addresses. SST 4's `Vpc`
  moved its NAT instances' Elastic IP associations, so its map gives their old
  address. SST 4's subscribers renamed their functions this way, so a takeover map
  gives both of a subscriber function's addresses with `subscriberFunction()` from
  `takeover/helpers.ts`.
- The second and third way are where SST 4 and SST 5 differ most. SST 4 often created a
  wrapper at the top of the app wherever the component was, gave a wrapper the provider
  but not the parent, or created something with no parent at all, so with the app's
  provider.
- Cover every realistic combination of args, and every kind of thing the component adds,
  `get` and what's added to a component from `get` included.
- A case says what's expected to go (`unclaimed`) or be updated (`changed`) when it isn't
  nothing, the same for every case or by the way it's run (`(way) => [...]`). Don't
  loosen it. A resource that holds data (a bucket, table, database, cache, file system,
  user pool, queue, log group, or a secret or password) is never in `unclaimed`, and
  never in `changed` for a field that replaces it. Where a move could lose one, assert
  that it's kept (see "keeps the secret under its new name" in `v5/redis.test.ts`).
  Where the two components aren't written the same way, give `original` and `v5` in
  place of `create`.
- Wrappers whose names aren't worth writing out can be counted: give the mock a
  `wrappers` pattern and the case a `wrappers` number (see `v5/apigateway-http.test.ts`).
- For a one-off, `pulumi.takesOver(original, v5)` returns `{ unclaimed, changed,
  unordered, revealed }`.
- **What was secret stays secret.** A value SST 4 kept secret that's in plain text now
  is listed in `revealed`, by where it is: "MyServiceTask.environment.variables.TOKEN",
  or "MyComponent.outputs.token" for a component's outputs. Every case expects it empty.
  A deploy updates nothing for it, so nothing else catches it: the state holds the value
  in plain text from then on.
- **The states SST 4 really deployed** (`testdata/states`) are checked too, under the
  mock: `test/components/v5/recorded.test.ts` runs the lab app that deployed them
  (`test/recorded`) with `pulumi.takesOverState()`, which replays a state's ids and
  outputs. SST 4's components, from the fixtures, have to give what the state has, and
  SST 5's have to take over what they gave. A change to a component in a recording
  updates what that test expects.
- **Teardown order is checked too.** A deploy removes resources in the reverse of the
  order they depend on each other, and AWS refuses to delete what's still in use. So
  every dependency SST 4's component has is expected of SST 5's, directly or through
  something in between. One that's missing is listed in `unordered`:
  "MyServiceCloudmapService before MyVpcCloudmapNamespace". Fix the component. Where
  SST 4's dependency is one nothing in AWS needs, name it in the suite's
  `needlessOrder`, with the reason next to it.
- A dependency is only there to lose when the case has both resources. Give ids from
  resources in the app, not just literal ones: a cluster whose VPC is given by the ids
  of a `Vpc` (see `v5/service.test.ts`).
- `pulumi.dependsOn(name, other)` says whether one resource is removed before another,
  for an order the component promises (see "when it's removed" in `v5/service.test.ts`).
- The check compares each resource's inputs and the options that change what a deploy
  does to it: `ignoreChanges`, `protect`, `retainOnDelete`, `deleteBeforeReplace`,
  `replaceOnChanges` and its provider. A difference there is reported as a field named
  `options.<name>`. For a component it compares what's registered as its outputs
  (`outputs`), as the CLI reads them: what SST 4's component named as an output, like
  `_task`, and what SST 5's reports, are the same when they say the same thing.
- For a function it also compares what the CLI is given to build the code from
  (`build`): the handler, runtime, copied files and **links**. A function's links go into
  its code, not into any resource's inputs, so this is the only place a wrong link
  shows. A takeover suite for a component with function parts needs a case with `link`.
- A resource's ids and ARNs are made from its name under the mock, so the check reads
  a renamed resource's new name as its old one wherever another resource refers to it.
  It doesn't in the resource's own inputs: its own name there is the name SST gave it,
  like a `Name` tag, and a new one is a change.
- A provider made with `useProvider()` is made once in each run, so each test that
  needs it has it in its graph. The check leaves providers themselves out of what it
  compares.
- A secret input is recorded as an object with the value under `value`. A value made
  from a secret is a secret too, so a change that reads something next to a secret (a
  task's volumes next to its built image) can turn a plain input into one. The check
  reports that as a change to the field.
- `pulumi.outputsOf(name)` is what a component registered as its outputs. The takeover
  check passes when neither side registers anything, so assert that the output the CLI
  reads is there (see `v5/task.test.ts`).
- `await pulumi.settle()` after creating resources in every test, or they leak into the
  next one.
- What a component is given can be the real one: a `Vpc`, `Cluster` and `Task` all
  deploy under the mock (see `v5/cron.test.ts`).
- Give the mock extra `state` for outputs the code reads (see `v5/apigateway-http.test.ts`).
  A resource that's looked up comes back with no name or ARN unless `state` gives it
  one. The region, partition, account and IAM policy lookups have defaults.
- Assert on what's created, too. A takeover test passes when both sides create nothing,
  which is what happens when a mock is missing and both sides fail the same way.
- `sst dev` behaviour is tested by setting `global.$dev = true` in a `beforeEach`.
- An error thrown inside `.apply()` can't be asserted: under the mock it's an
  unhandled rejection, which fails the run. Test the errors that are thrown directly.
- `v5-components.test.ts` runs over every component in `aws/` and `cloudflare/`. It
  fails when one doesn't have the name and type of SST 4's component it takes the place
  of, has no takeover map or one that isn't imported, isn't exported from its group's
  `index.ts`, or names another component's type or sets aliases itself. It also fails
  when the platform has one of SST 4's components or imports from the tests.

Run from `platform/`:

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run --pool=forks
```

**What the mock can't see.** It stands in for the engine and for the CLI, so a test
there never bundles a config, builds a function or calls AWS. The first deploy to a
real account found two bugs every test had passed: the takeover maps were missing from
a bundled config, and a function's links were written into its code under the wrong
names. Both have a test now. For a change that touches how a config is built, what the
CLI is told, or the order things are created in, deploy it. For a move: SST 4's
component first, with SST 4's CLI, then `sst migrate --check` and `sst migrate` with
this one, then call what's deployed, then `sst remove`.

**Depending on a component is depending on everything in it.** A value read from a
component itself, like its `urn`, makes whatever is given that value wait for every
resource the component has created. A part is inside its component, so a part given
such a value waits for itself and is never created, with no error. That's how a
subscriber that linked its own queue (`queue.subscribe({ handler, link: [queue] })`)
went missing: a function's code is built from its links, and a link's name is read
from the linked component. SST 4 didn't have the problem only because its subscriber
sat outside the queue. Give a part the outputs of the resources it needs, and where a
value is made on this machine from what's in AWS, pass it through
`withoutDependencies()`. For a component with function parts, test a function that
links the component.

## Checklist

1. Read the component, its takeover map and its test file, and SST 4's in
   `test/fixtures/v4/components/` when what the component creates changes. Note each
   resource's logical name, parent and options.
2. Change `aws/<name>.ts`: parts, args, constructor, methods, `link()`, `static get`.
   Keep its type. What it tells the CLI, it reports with `this.report()`. Search `cmd/`
   and `pkg/` for the type (`"sst:aws:Function"`) too, in case the CLI finds it by name.
3. If a part has another name or place than SST 4 gave it, say so in
   `aws/takeover/<name>.ts`. Once 5.0 is released, a change that moves a part of a
   released component is the next version of its map instead.
4. A new component is exported from `aws/index.ts`, which is `sst.aws`.
5. Update `test/components/v5/<name>.test.ts`: takeover cases with
   `pulumi.takeoverCases()`, then behaviour.
6. Update the class doc, including its "Switch from SST 4's `<Name>`" section, which
   lists what's written differently and what changes on the move. Document each part
   where it's declared: those comments become the `transform`, `existing` and `nodes`
   docs. Until 5.0 is released, add each breaking change, what a user writes or reads
   differently from SST 4, to the breaking changes so far in
   `docs/plans/v5-rewrite/plan.md`, with its way across: a codemod rule, a line in the
   guide, or the `sst migrate --check` refusal.
7. `cd www && bun ./generate.ts components` generates the page. The docs generator and
   the sidebar find every component in `aws/`, so there's nothing to add to either.
   For a component SST 4 named otherwise (`sst.aws.CronV2`), it fails when the page
   names SST 4's outside the "Switch from" section, other than as a link to its page.
8. Typecheck, run the tests, and `bun run build:cli` from the repo root.
9. Review before calling it done. Read SST 4's constructor and SST 5's side by side,
   resource by resource: args, options, names, what's read back. Then read the
   generated page, and check the change against the
   [goals](../../../docs/plans/v5-rewrite/goals.md).

The components are each other's reference, all in `aws/`: `alb.ts` for a custom domain
with aliases, and a method that looks a part up when it's asked for (`getListener`);
`apigateway-http.ts` for routes, authorizers and a custom domain; `sns-topic.ts` for
named subscribers; `bucket.ts` for one resource built from many notifications;
`cognito-user-pool.ts` for triggers and a linkable client; `redis.ts` for a component
that runs locally in `sst dev` and reports a pane for it, and `get`; `postgres.ts` and
`mysql.ts` for the same, built by one helper (`helpers/rds-instance.ts`), with an
optional group of parts (the proxy) and a part per item in a list; `aurora.ts` for a
`get` that finds the rest of what it references, and a transform that applies to more
than one part; `cluster.ts` for the smallest one: nothing moved, so its takeover map
is empty, and a `get` that takes args next to the id; `efs.ts` for a part per item of a
list that's only known on deploy (a mount target per subnet), and a `get` that finds
the other part it needs; `dsql.ts` for parts in another region, and features that each
add a group of parts; `task.ts` for parts per item of a plain list (containers), a part
that's built later, a stub in `sst dev`, and what it reports to the CLI; `service.ts`
for groups of parts that depend on an arg (a load balancer of its own, or one it
shares), parts made from a plain list of rules, a part that's read from `nodes` and
only exists sometimes, and a part that's created in `sst dev` too; `cron.ts` for a
function the component may be given or may create, next to another component it's
given (a `Task`); `dynamo.ts` for required args next to `get`, and a static method
replaced by `get`; `function.ts` for a component SST 4 built almost entirely inside
`.apply()`, with parts that are created later, args of its own, and what a build reads
kept plain so a preview knows its source maps; `vpc.ts` for args of its own, parts in
each AZ from a plain count with nothing inside `.apply()`, and a `get` that finds what
it can't count with lookups that aren't resources; `router.ts` for parts that SST 4
kept in wrapper components at the top of the app (each route's entries in the
key-value store), a component part (`Cdn`) that's looked up for `get`, and a setting
it gives as a plain value so the components served through it don't wait (`_signs`);
`nextjs.ts` for parts made from a build that runs in the program, created with
`after()`, and a wrapper SST 4 kept inside the component (the warmer's `Cron`). For
Cloudflare, `cloudflare/worker.ts`.
