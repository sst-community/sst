# Porting SST's 4.x components

The rules for porting one of SST's 4.x components to V5, as a person or an agent, and the
checklist. Everything in `README.md` beside this file applies: read it first. What's here
is specific to SST's own components in `platform/src/components/aws/`, and goes once 5.0
has no 4.x components.

## Ground rules

- **Hold to the [v5 goals](https://github.com/sst-community/sst/blob/v5/docs/plans/v5-goals.md).**
  A port keeps what the 4.x component deployed, never replaces or deletes a resource
  that holds data, declares every resource it creates as a part, and shows in
  `sst diff` what its deploy does. An edit to a 4.x file changes nothing for an app
  that hasn't switched.
- **The V5 component has the original's name, in the `v5` folder.** `Queue` in
  `aws/queue.ts` is ported as `Queue` in `aws/v5/queue.ts`, with the same type,
  `sst:aws:Queue`. An app uses it as `sst.aws.v5.Queue`, next to `sst.aws.Queue`.
  One SST 4 named with a version, because it replaced a first one that has no 5.0
  form, drops the version from its name and its file, and keeps its type: `CronV2` in
  `aws/cron-v2.ts` is ported as `Cron` in `aws/v5/cron.ts`, as `sst:aws:CronV2`. The
  tests and the docs generator find the original from the version in the type.
- **The same type is what makes it the same component.** A deployed `sst:aws:Queue`
  named `MyQueue` is the one `new sst.aws.v5.Queue("MyQueue")` creates, so it's kept, and
  so is each resource in it that has the name it had. A stage doesn't go back to the
  4.x component by a deploy: once it has moved, the CLI refuses SST 4's form of what
  moved (`move.ts`), and the way back is the copy of the state `sst migrate` saves.
  What links the component sees no change, and a `$transform` for either applies to
  both.
- **Where a file needs both, the 4.x one is `Original…`.** That goes for the class and
  for its types: `import type { Queue as OriginalQueue } from "../queue"`. In prose,
  say which one you mean: "the 4.x `Queue`" in a code comment, `sst.aws.Queue` and
  `sst.aws.v5.Queue` in what the docs are generated from.
- **Edit a 4.x component file only where it changes nothing for an app that uses it.**
  An app's config has to read the same, and its state can't change: imports, what a
  file reads when it loads, and types are fine. New behavior goes in the V5
  component. V5 components haven't been released, so they can still change in any
  way.
- **Redesign, don't translate.** A V5 component doesn't have to mirror the original's
  structure.
- **Port what takes a component before the component itself.** 4.x components
  recognise a `Vpc` or a `Router` with `instanceof`, and are typed for the 4.x
  `Cluster`, so the V5 one can't be passed to them. Port the components that take it
  first, and have each accept both the original and the V5 one. The component that's
  taken goes last: an app switches to it once everything it's passed to is V5.
  The V5 `Service` and `Task` take either `Cluster`. The arg is declared again in each
  (`cluster: OriginalCluster | Cluster`), and the V5 `Cluster` gives them the same
  `nodes.cluster` and `vpc` to read as the 4.x one. The V5 `Service` and `Task` take
  either `Efs` the same way, and the V5 `Service` either `Alb`. A component built the
  5.0 way names neither: it takes an `AnyEfs` and checks it with `isEfs()`
  (`helpers/efs.ts`), and is served through an `AnyRouter` with `routeOf()`
  (`helpers/router.ts`), which says whether the router signs its requests: as a plain
  value for a V5 `Router`, so what depends on it is created directly, and as an output
  for a 4.x one or one referenced with `get`.
  For a `Vpc`, the two kinds are already one thing to a V5 component: it wraps the
  original's args in `TakesVpc<>`, which gives `vpc` the type `AnyVpc` (either `Vpc`)
  in place of the 4.x one, and it checks with `isVpc()`, not `instanceof`. It reads the
  subnets with `subnetsOf()` where it needs them as one output, and whether there's a
  NAT with `hasNat()`, since the two `Vpc`s keep those differently. A component
  built the 5.0 way types `vpc` as `AnyVpc` or the ids, and refuses any other
  resource there with `assertVpcIds()`. `subnetsAndSecurityGroupsOf()` gives the
  subnets and security groups of either, each an output of its own. All are in
  `helpers/vpc.ts`.
- **No `registerVersion`.** Keep any tags the original writes at the same value.
- **A 5.0 component owns its args.** The 5.0 rewrite makes a clean break from 4.x
  code: a component imports no 4.x component file and builds on none of its types
  (`docs/plans/v5-rewrite/plan.md`). The V5 `Vpc` and `Function` are built that way;
  their args are their own, docs included, and `v5-components.test.ts` lists them and
  checks every 4.x file they reach, through the helpers they use too. A 4.x component
  they take is reached through a helper that takes either kind, as above, which the
  test lists with the 4.x file it may import. The `Router` is built that way too, on a V5 `Cdn`, with
  the CloudFront code it shares with the 4.x one and the sites in `router-code.ts`. So
  is the `Cdn`, with the 5.0 certificate and redirect, whose DNS records the adapters
  create directly. The `Nextjs` is built that way: it builds its site in the program
  and creates what the build makes with `after()`, and it shares what the 4.x sites
  work out from a build in `site-code.ts`. So are the `Bucket`, the `Queue`, the `SnsTopic`, the
  `Dynamo`, the `Bus` and the `Cron` (SST 4's `CronV2`): the 4.x `Queue` and `SnsTopic` a bucket, a topic
  or a bus sends to are reached through `AnyQueue` and `AnySnsTopic`, the 4.x `Task` a
  cron job runs through `AnyTask`, and a function any of them is given goes through
  `plainFunction()`, so only a function that's already there, or its ARN, can be an
  output. So is the `Cluster`, which takes either kind of `Vpc` through `AnyVpc` and
  refuses any other component in its place, and the `Task`, whose args a service
  shares are `FargateBaseArgs`, below. So is the `Efs`, which makes a mount target in
  each AZ, kept by the AZ's number in a `Vpc` the app creates, and by its name in any
  other VPC, looked up with `after()` once a preview knows the subnets. So are the
  `Redis`, the `Postgres`, the `Mysql` and the `Aurora`, which report the pane `sst dev`
  shows for a local server (`helpers/local-server.ts`), where 4.x created a
  `DevCommand` for it. So is the `Dsql`, whose parts in the peer region are created
  with a provider for that region (`useProvider()`). So is the `ApiGatewayV2`, whose
  domain is made with `domainOf()` (`helpers/domain.ts`), the 5.0 certificate and the
  adapters, as the `Cdn`'s is, and so are the `AppSync` and the `CognitoUserPool`. So is
  the `Email`, whose DKIM records, named in DNS after tokens SES gives once the identity
  is created, are created directly with a `key` and given their old names by a
  `delegated` map, as the certificate's validation records are. So are the `Alb` and the
  `Service`, whose load balancers' domains go through `loadBalancerDomain()`
  (`helpers/load-balancer-args.ts`); a service reaches a 4.x `Alb` through `AnyAlb`
  (`helpers/alb.ts`), and its panes in `sst dev` are SST 5's `DevCommand`, one for each
  container with a command, created directly.
  The ports before them reuse the original's, as below, until each is rebuilt and
  added to that list.
- **What an app creates once is made once in each run** of the program. A resource
  its components share, like the key a function's links are encrypted with, is kept
  in a `perRun()` value (`util/lazy.ts`), not a static of a class: the CLI's run and
  the mock's `reset()` start a new run with `newRun()`, so a test sees what a run
  creates whatever ran before it. Both `Function`s share theirs from
  `helpers/function-shared.ts`.
- **A port that isn't rebuilt yet reuses the original's arg types**: `interface
  EmailArgs extends V5Args<OriginalEmailArgs, typeof parts> {}`. `Omit` and re-declare
  only what has to change. For an arg that has to become a plain value, write
  `triggers?: Plain<OriginalCognitoUserPoolArgs["triggers"]>` (`Plain` is in
  `args.ts`): the docs generator follows it back to the original's docs.
  An arg's docs come with it, examples included. Where an example creates a component
  that has a V5 form (`new sst.aws.Queue("MyQueue", { dlq })`, `sst.aws.Vpc.get(...)`),
  the docs generator writes the V5 one on the V5 page. So declare an arg again only
  when its type changes, or when what its docs say no longer holds.

## What becomes a part, and what stays a component

- Something that only **wires resources together** becomes parts of the parent, as `many`
  parts keyed by a name the user gives: a subscription, a route, an authorizer, a data
  source, an identity provider. 4.x usually kept these in a wrapper component of their
  own. The method that adds one returns the parent (so calls chain) or the AWS resource
  (when the user needs something off it, like `authorizer.id`).
- Something the user **names and links in its own right** stays a component of its own,
  returned by the method that adds it. `addClient("Web")` on a V5 `CognitoUserPool`
  returns a `CognitoUserPoolClient`, so `link: [client]` still gives `Resource.Web.id`.
- A per-method `transform` moves to the component's `transform`. `this.assertNew()`
  rejects the old option with a message.
- A deprecated overload isn't carried over (`subscribe(handler)` with no name). Throw
  an error that shows the call to write instead; without one the user gets whatever
  the shifted arguments happen to fail on. The same goes for a deprecated method: the
  V5 `Cluster` has `addService` and `addTask` only to say what to write, marked
  `@internal` so they stay off its page.
- A static method that adds something to a resource outside the app (`Dynamo.subscribe`
  with a stream ARN) becomes `get(...)` and the ordinary method. The takeover map can
  still find what the static method created: see `takeover/dynamo.ts`.

## Helpers

| For | Use |
| --- | --- |
| A function from a handler, args, an ARN, a function or a `Workflow` | `functionPart()` in `helpers/function-part.ts` |
| A function arg, built the 5.0 way: a handler or args as a plain value, or a function or its ARN, which can be an output | `FunctionInput`, and `plainFunction(definition, what)` before `functionPart()`, in `helpers/function-part.ts` |
| Letting a service invoke that function | `invokePermissionArgs(fn, principal, sourceArn)` in `helpers/function-permission.ts` |
| A custom domain (`name`, `dns`, `cert`), built the 5.0 way: the 5.0 certificate (`aws/v5/dns-validated-certificate.ts`) as a part, and the records pointed at the service with the adapter's `alias()` | `DomainArgs` and `domainOf(domain, owner)` in `helpers/domain.ts` |
| Event source mappings | `filterCriteria()`, `batchSettings()` in `helpers/event-source.ts` |
| Letting a service send to a queue | `sendPolicyArgs(queueArn)` in `helpers/queue-policy.ts` |
| A Fargate task: its containers, roles, images, log groups and task definition | `containersOf()`, `taskRoleArgs()`, `executionRoleArgs()`, `containerImage()`, `logGroupArgs()`, `taskDefinitionArgs()` in `helpers/fargate.ts` |
| The VPC of a cluster, whichever way the cluster was given it | `networkOf(cluster)` in `helpers/fargate.ts` |
| A shared load balancer: either kind of `Alb` | `AnyAlb`, `isAlb(value)` in `helpers/alb.ts` |
| A `vpc` arg: either kind of `Vpc`, or the ids of a VPC | `TakesVpc<Args>`, `AnyVpc`, `isVpc(vpc)`, `subnetsOf(vpc, kind)`, `hasNat(vpc)`, `assertVpcIds(vpc, what)`, `subnetsAndSecurityGroupsOf(vpc, what)` in `helpers/vpc.ts` |
| A resource for each private subnet of a VPC, kept by its AZ | `privateSubnetsOf(vpc, parent, what)` in `helpers/vpc.ts`: by the AZ's number for a `Vpc` the app creates, by its name for one from `get`; and `subnetsByAz(subnets, parent, what)` for subnet ids. Where it's a promise, of what a preview knows, create them with `after()` |
| Deciding from an output a preview knows, like a lookup's | `knownValue(output)` in `args.ts`, for `after()` |
| A load balancer: its security group, what a listener answers by default, a domain with aliases and its DNS records | `securityGroupArgs()`, `forbidden()`, `loadBalancerDomain()`, `pointDomainAt()` in `helpers/load-balancer-args.ts`, on `domainOf()` and the 5.0 adapters |
| A database or cache that runs on the user's machine in `sst dev`: the pane that says how to set up the local server | `localServerPane(message)` in `helpers/local-server.ts`, given to `this.report({ dev })`, with a password in it shown by `shownPassword()` |
| An RDS database: storage limit, replicas, the proxy, a stored password, and a local one in `sst dev` | `maxStorage()`, `replicaArgs()`, `proxyCredentials()`, `proxyRoleArgs()`, `proxyArgs()`, `storedPassword()`, `localDatabase()` in `helpers/rds.ts` |
| A database on an RDS instance, whole: what the `Postgres` and the `Mysql` share | `rdsInstanceParts`, `RdsInstanceArgs`, and `createRdsInstance(this.builder(), name, args, engine)` with the engine's `RdsEngine`, in `helpers/rds-instance.ts`; the tests in `test/components/v5/rds-instance.suite.ts` |
| A site with a server, whole: what the `Nextjs`, `Astro`, `SvelteKit`, `TanStackStart`, `Remix`, `React`, `Nuxt`, `SolidStart` and `Analog` share | `ssrSiteParts`, `SsrSiteArgs`, and `createSsrSite(this.builder(), name, args, framework)` with the framework's `SsrFramework`, in `helpers/ssr-site.ts`. The framework gives its build command, reads its build into a `SiteBuild` with the site's plan, says how its server is built (`ServerPlan`, which the site's own args are merged into) and creates what it adds, like `Nextjs`'s image optimizer. A framework with args of its own, like `Remix`'s `buildDirectory`, is made from the site's args and checks them in `check`. One whose build has no versioned folder says `versionedFiles: false`, so `invalidation.paths: "versioned"` makes no invalidation, as in SST 4. A framework without a build command of its own builds with `defaultBuildCommand(sitePath)` in `helpers/site-build.ts`, the `build` script by the app's package manager. `configText(sitePath, "vite.config")` there reads a config file in whichever extension it has, and `readNitro(outputDir, framework, howToSet)` in `helpers/nitro.ts` reads a Nitro build, refusing one without the `aws-lambda` preset. `urlAccessArgs(fn, distributionArn)` gives the permissions to call a function's URL. The takeover map's shared part is `ssrSiteTakeover(label, warmedWhen)` in `takeover/ssr-site.ts`, and the tests every site passes are in `test/components/v5/ssr-site.suite.ts` |
| A site's viewer request function, which routes it with the key-value store | `siteRequestCode(namespace, injection, blocksCloudFrontUrl)` in `helpers/ssr-site.ts`, which the `StaticSite` shares. A site with no server isn't on `createSsrSite`: the `StaticSite` builds with `buildSite()` and uploads its folder as it is |
| What two components share, as more than args: their parts, built by a helper | `this.builder()`, which gives the helper the component's `part()`, `existingPart()`, `runsLocally()` and `report()`. Declare the shared parts as `const parts = sharedParts`; the docs follow it |
| An arg with a default, then converted | `withDefault(value, fallback, convert?)` in `args.ts` |
| An arg that may be unset | `ifSet(value, convert?)` in `args.ts` |
| An arg that must not be an output | `plain(value, what, why?)` in `args.ts`; `why` when it doesn't decide which resources are created, like what a build reads |
| An arg that must not have an output anywhere inside it | `plainDeep(value, what, why?)` in `args.ts` |
| An `efs` arg: either kind of `Efs`, or an access point's ARN | `AnyEfs`, `isEfs(value)` in `helpers/efs.ts` |
| Serving a component through a `Router` | `RouteArgs`, `AnyRouter`, `routeOf(route)` in `helpers/router.ts` |
| A `bucket` arg: either kind of `Bucket` | `AnyBucket` in `helpers/bucket.ts` |
| A `queue` or `topic` arg: either kind of `Queue` or `SnsTopic` | `AnyQueue` in `helpers/queue.ts`, `AnySnsTopic` in `helpers/sns-topic.ts` |
| A `task` arg: either kind of `Task` | `AnyTask` in `helpers/task.ts` |
| Building a site in the program, with what it links | `buildSite()` in `helpers/site-build.ts` |
| A site's files, key-value entries and invalidation, as the 4.x sites make them | `siteFiles()`, `siteKvEntries()`, `siteInvalidation()` in `site-code.ts` |
| An option a method no longer takes | `notAnOption(args, option, instead)` in `args.ts` |
| A value made on this machine from things in AWS, like built code | `withoutDependencies(output)` in `args.ts` |

A helper returns the args of a part, or checks an arg. The component still creates
each part with `this.part()`, so its constructor reads as the list of what it creates.
The V5 `Postgres` and `Mysql` are the same component but for a handful of settings,
and share everything else this way.

One helper creates a part itself: `containerImage()` builds a container's image behind
the limit on how many builds run at once, so the image is created when its turn comes.
It gets the part's name, transform and old address from `component.partHandle(key, id)`,
the way `functionPart()` does. Reach for that only when `this.part()` can't do it.

Args that several components take are declared once, in a helper. The docs generator
reads every file in `aws/helpers/`, and a helper file gets no page of its own:

- An interface the components' args extend, for args they share. `FargateBaseArgs` in
  `helpers/fargate.ts` is what a task and a service both run, and with what, built the
  5.0 way; `FargateArgs`, which it extends, is their `cluster` and `volumes`, which the
  `Service` takes alone until it's rebuilt. Their args show on each page as the
  component's own.
- A named type the args use. `ContainerArgs` in `helpers/fargate.ts` and `ProxyArgs` in
  `helpers/rds.ts` get a section on each page that uses them, as if the page's file
  declared them.
- A name for a type, like `AnyVpc`. A page shows what it stands for.

Write a helper's doc comments for any page: don't name a component in them. The
comment on an interface that's only extended isn't shown.

## Taking over what 4.x deployed

Changing `sst.aws.Queue` to `sst.aws.v5.Queue` with the same name has to keep the
deployed resources. The component and every part with the name it had are kept as they
are, because the type is the same. What moved goes in a **takeover map**,
`aws/takeover/<name>.ts`, imported from `aws/takeover/index.ts`. The component itself
knows nothing about 4.x. A component with nothing that moved still has a map, an empty
one, `takeover(Cdn, {})`: the maps are how the CLI knows a 4.x type has a 5.0 form, so
that a new stage refuses the 4.x one and only `sst migrate` switches a stage to it.
`v5-components.test.ts` checks each component has one.

A map is a file that's imported for what it does, not for what it exports. The CLI
bundles a config with esbuild, which leaves such a file out of a package that says it
has no side effects, so `sideEffects` in `platform/package.json` lists
`aws/takeover/*.ts`. Without that line every map is dropped from a real build and a
switch deletes and recreates whatever moved, while every test under the mock passes.
`v5-components.test.ts` bundles the components the way the CLI does and checks the maps
are in.

```ts
// The V5 one, from "../v5/apigatewayv2"
takeover(ApiGatewayV2, {
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
  component. Pass the V5 component as a fourth argument when 4.x created the wrapper
  with the component's own options, so it sat beside the component rather than at the
  top (`Bucket.notify` does, and the 4.x `Nextjs` subscribing to its revalidation queue).
  `childWithin(type, component, child, owner)` is for a wrapper 4.x created inside the
  component itself, like the 4.x `Nextjs`'s warmer in a `Cron`.
- `{ name, parent: false }` is something 4.x created with no parent at all.
- A `moved` function can return several candidates. Addresses that don't exist are
  ignored. A candidate's name can be made from one of the component's outputs, like
  the table's own name.
- When 4.x created a resource inside `.apply()`, a `transform` function for it was
  given plain values. Created directly, it's given outputs for whatever is made from
  the component's args. Say so in the "Switch from" section.
- A resource 4.x **looked up** outside the component (`Bucket.get`) can't be carried
  over, because a lookup takes no old address. It's dropped from state and looked up
  again, which changes nothing in AWS.
- A resource 4.x looked up under the component for a value isn't a part: it's not the
  component's to transform or replace. Look it up with a function instead, which a
  preview runs too: the V5 `Efs` does this for the VPC whose CIDR block it reads
  (`ec2.getVpcOutput`), and the V5 `StaticSite` for the bucket `assets.bucket` names. A
  move takes 4.x's lookup out of the state, which changes nothing in AWS; the takeover
  test lists it as unclaimed.
- A part that gets a new name keeps its physical name: a generated name is never
  changed once it's deployed. A resource that's named with a `Name` tag is the
  exception (a security group, a VPC endpoint, a subnet): the tag is made from the
  logical name, so a new name updates it. Declare such a part with the name 4.x gave
  it, `named(optional(ec2.SecurityGroup), "DsqlEndpointSecurityGroup")`, as the V5 `Dsql`
  does. It then needs no entry in the takeover map. The name goes in the declaration
  and not in the map because it has to outlive the map: once someone has switched, the
  kept name is the one in their state.
- Something 4.x created without the component's `provider` is replaced on switch when
  the component has one, because a part is always created with it. 4.x did this for
  what it created with no parent (the alias of a durable function's URL, AppSync's
  domain association), for a wrapper it forgot to give the provider (`SnsTopic`'s queue
  subscribers), and for what's added to a component from a `get` that gave its options
  to the lookup alone (`Bucket.get`, `Dynamo.get`, `CognitoUserPool.get`). A port can't
  avoid it. The "with another provider" way of a takeover case finds it: expect it in
  the case, and say so in the "Switch from" section.
- An object in `transform` is merged into the defaults, nested objects included; 4.x
  replaced a nested object whole. So a config that sets a nested default this way
  (`transform: { instance: { tags: { team: "data" } } }`) deploys something different
  after the switch: here SST's own tags come back. Find the nested defaults of each
  part, test one (`an object transform that sets tags` in `v5/postgres.test.ts`), and
  name it in the "Switch from" section: "If you set `tags` on the instance with an
  object in `transform`, it keeps the tags SST sets next to yours."
- `$transform(sst.aws.Queue, ...)` applies to `sst.aws.v5.Queue` too: it's matched by
  type. So an option the original takes and the V5 one doesn't can still arrive. Say
  where it went with `notAnOption()`. Where that would break configs people have, take
  the old form as well: the V5 `Function` does, for `role`, `live`, `logging.logGroup`
  and `url.route`, because a `$transform` for functions reaches the ones inside every
  V5 component.
- The docs generator writes those two as the last notes of every "Switch from" section:
  that an object in `transform` is merged, and that a `$transform` for the original
  applies. The original is the component of the same name, one folder up, or with
  the version its type has. Don't write
  them in the class doc.
- Something 4.x created outside the component with nothing in AWS behind it needs no
  old address. The 4.x `Service` creates a `DevCommand` at the top of the app for each
  container; in the V5 one they're parts, and a switch lists the old ones as removed
  and the new ones as created. Expect them in `unclaimed`, and say so in the "Switch
  from" section.
- A function's `description` usually changes, because 4.x named the wrapper in it. That's
  an in-place update. So does anything else made from the function's name when a
  function part gets a new one: a URL behind a `Router` is registered under a key made
  from it.
- A function definition can still be written the way the 4.x `Function` takes it
  (`role`, `logging.logGroup`, `live`, `url.route`). The V5 one takes those too.
- A map from 4.x is a component's version 1, so it takes no `version`. A change to a V5
  component after it's released that moves its resources ships version 2.
- `takeover()` also takes `from`, the type a component had, for one that takes over
  from a component of another type. Only version 1 can. No V5 component needs it.
- One of SST's own provider resources (`KvKeys`, `BucketFiles`) adds its type to its
  name: `MyFunctionRouteKey.sst.aws.KvKeys`. As a part it's matched without that. If it
  moved, write its old name in full, as a function in `moved`.
- A resource 4.x created outside of any component got no name from SST. Add its type to
  `UNPREFIXED_TYPES` in `naming-rules.ts` so it keeps the name the provider gave it
  (the V5 `Function` does this for the alias of a durable function's URL).
- Reproduce what 4.x deploys, not what it means to. The 4.x `Function` trusted the
  account in every role because a check never passed, and the V5 one wrote the same
  policy until `main` fixed 4.x. Changing it is a decision of its own, not a side
  effect of a port. When 4.x changes what it deploys, the port follows.

`sst migrate --check --stage <stage>` previews the move of a deployed stage and checks
it. A component, a wrapper or a provider has nothing in the cloud behind it, so it may
leave the state or be created. Anything else the move would create, delete or replace
fails the check, unless the map lists it:

```ts
// A made-up site, to show each
takeover(Site, {
  // Parts 4.x didn't have. What's inside one, if it's a component, is new too.
  added: ["logs"],
  // Parts a move replaces, with what changes for the user. Only a part that
  // holds no data. The V5 `Function` lists its code and source maps.
  replaced: {
    code: "The site's server code is uploaded again, under a new key.",
  },
  // Parts that take the place of what 4.x created and a move can't carry over,
  // as when the type changes. The old one leaves the state without its delete
  // being called; the part writes the same thing again, or adopts it by its id.
  released: {
    files: (_, { name }) => sstResource("BucketFiles", { name: `${name}AssetFiles` }),
  },
});
```

SST's own resources, like a site's files (`BucketFiles`) and a router's entries
(`KvKeys`), are served by the `sst` binary as a Pulumi provider: use the classes in
`aws/resources/`, not the 4.x dynamic ones in `aws/providers/`. 4.x's were dynamic
resources with their kind added to their name, so a part that takes the place of one
releases it with `sstResource(kind, address)` (`aws/takeover/helpers.ts`). `sst migrate`
marks what's released as retained in the state, so Pulumi takes it out without calling
its delete, which would delete what it wrote. The takeover tests run the V5 side as a
move, and check that what takes a released resource's place is given what it was.
A released resource with no `parent` is looked for in the component at each address it
answers to: its own, the type it takes over from, and a name a parent's map gave it
before, as with a subscriber's function. Under one of those, a name that starts with
the component's starts with that address's instead, as Pulumi names a child's alias.

Only a move releases, so only `sst migrate` switches a stage's components. A stage on
SST 5's components has a marker in its state (`sst:sst:Moved`), which lists the
components it has in their 5.0 form, and the CLI refuses to deploy a stage that has
something deployed and no marker, except with `sst migrate`. A run on a stage that has
moved, or a new one, leaves the marker before the app's program runs, so a deploy that
fails partway keeps it, and a remove that doesn't finish puts it back. A move leaves it
once the program has run, listing every component that has a 5.0 form but those the
stage kept in SST 4's form. A component counts as moved when the marker lists it, or
when the stage has none of it, so a new stage starts with all of them (`components/move.ts`):

- SST 4's form of a component that counts as moved is refused: on a stage that has the
  5.0 form, deploying it would delete what that wrote.
- Outside a move, the 5.0 form of a component the stage still has in SST 4's form is
  refused, with a message that says to run `sst migrate`. That's how a component that
  gains a 5.0 form after a stage moved is switched.
- A move switches all of a component at once: one that switches some and keeps others
  in SST 4's form is refused, since a later deploy could switch those back without a
  move.
- One inside another of SST's components moves with that one, and isn't counted. So
  a move that keeps the app's own `Bucket` in SST 4's form doesn't list `Bucket`, even
  when a 5.0 site has a 5.0 one inside it. Until a move switches the app's own, the
  site's is taken as at version 0 on each run, and gets its first map's aliases
  again: harmless while the map of a component that's nested only moves parts. One
  that lists a part as `replaced` or `added` would let that through a later move too.

`mock()` runs as a new stage's first deploy, so a package that still wraps SST 4's form
of such a component finds out in its tests.

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

Where a V5 component still creates a resource inside `.apply()`, it has to be given
the output, not the value the callback was called with: the output is what says the resource depends on
where the value came from, so that it's removed first. The V5 `Service` creates its
Cloud Map service inside `.apply()` for a VPC given by its ids, and gives it the
namespace id as the output.

Where the resource that holds on to another isn't given anything of it, say so with
`dependsOn`. A load balancer holds on to its certificate, but only its listeners are
given it, so the V5 `Alb` and `Service` make the load balancer depend on the
certificate. The 4.x ones don't, and removing them can fail on a certificate that's
still in use.

Also check for an **ordering guarantee** the original makes with an
`x.apply(() => resource)` wrapper, and keep it. The 4.x `Bucket` makes everything that
reads `bucket.name` wait for the bucket policy; the V5 one keeps that in its getters.
Where the original left an order to chance, and parts that are created directly make
it easy to say, say it with `dependsOn`: the V5 `Service` makes the ECS service wait
for the listeners that put its target groups on the load balancer. That changes
nothing a deploy does to what's already there. `dependsOn` also takes an output of
resources, so it works for parts that are created later: the 4.x `Efs` made its ids
wait for the mount targets, and in the V5 one the access point depends on them.

## Tests

`platform/src/testing/mock.ts` mocks Pulumi and records every resource a component
registers. It ships with the platform, and `mock()` next to it is what an app tests its
own components with, so it imports no test runner. `platform/test/helpers/graph.ts` adds
the takeover suite for the ports, which is written for vitest. A port's test file starts
with its takeover cases, then tests the component's own behaviour:

```ts
const pulumi = mockPulumi();

describe("takes over a deployed Queue", () => {
  pulumi.takeoverCases({
    original: () => OriginalQueue,
    v5: () => Queue,
    cases: {
      // Written once, for both: it's given the original, then the V5 component
      "fifo queue": (Queue, opts) => new Queue("MyQueue", { fifo: true }, opts),
      "a subscriber created from a handler": {
        create: (Queue, opts) =>
          new Queue("MyQueue", {}, opts).subscribe("src/subscriber.handler"),
        // What goes: the wrapper, which has nothing in AWS behind it
        unclaimed: ["sst:aws:QueueLambdaSubscriber::MyQueueSubscriberVkxuom"],
        // What a deploy updates: a resource and its fields
        changed: [["MyQueueSubscriberVkxuomFunction", ["description"]]],
        // Anything else to assert, once the V5 component is deployed
        check: () => expect(names()).toContain("MyQueueSubscriberFunction"),
      },
    },
  });
});
```

- Each case deploys the original, then the V5 component, and expects everything the
  original created to be kept as it is. It's run three ways: as it is, inside another
  component, and with a `provider` of its own. So a case has to pass its `opts` on to
  the component, and fails when it doesn't.
- When the original renamed one of its resources with an alias, or moved one into
  the component from the top of the app, each case is also checked against its graph
  as it was before: a stage deployed with an older 4.x has the old addresses. The 4.x
  `Vpc` moved its NAT instances' Elastic IP associations, so its map gives their old
  address. The 4.x subscribers renamed their functions this
  way, so a takeover map gives both of a subscriber function's addresses with
  `subscriberFunction()` from `takeover/helpers.ts`.
- The second and third way are where 4.x and a port differ most. 4.x often created a
  wrapper at the top of the app wherever the component was, gave a wrapper the provider
  but not the parent, or created something with no parent at all, so with the app's
  provider.
- Cover every realistic combination of args, and every kind of thing the component adds,
  `get` and what's added to a component from `get` included.
- A case says what's expected to go (`unclaimed`) or be updated (`changed`) when it isn't
  nothing, the same for every case or by the way it's run (`(way) => [...]`). Don't
  loosen it. A resource that holds data (a bucket, table, database, cache, file system,
  user pool, queue, log group, or a secret or password) is never in `unclaimed`, and
  never in `changed` for a field that replaces it. Where a port could lose one, assert
  that it's kept (see "keeps the secret under its new name" in `v5/redis.test.ts`).
  Where the two components aren't written the same way, give `original` and `v5` in
  place of `create`.
- Wrappers whose names aren't worth writing out can be counted: give the mock a
  `wrappers` pattern and the case a `wrappers` number (see `v5/apigatewayv2.test.ts`).
- For a one-off, `pulumi.takesOver(original, v5)` returns `{ unclaimed, changed,
  unordered, revealed }`.
- **What was secret stays secret.** A value the original kept secret that's in plain text
  now is listed in `revealed`, by where it is: "MyServiceTask.environment.variables.TOKEN",
  or "MyComponent.outputs.token" for a component's outputs. Every case expects it empty.
  A deploy updates nothing for it, so nothing else catches it: the state holds the value
  in plain text from then on.
- **The states 4.x really deployed** (`testdata/states`) are checked too, under the mock:
  `test/components/v5/recorded.test.ts` runs the lab app that deployed them
  (`test/recorded`) with `pulumi.takesOverState()`, which replays a state's ids and
  outputs. The 4.x components have to give what the state has, and the V5 ones have to
  take over what they gave. A port of a component in a recording updates what that test
  expects.
- **Teardown order is checked too.** A deploy removes resources in the reverse of the
  order they depend on each other, and AWS refuses to delete what's still in use. So
  every dependency the original has is expected of the V5 component, directly or
  through something in between. One that's missing is listed in `unordered`:
  "MyServiceCloudmapService before MyVpcCloudmapNamespace". Fix the component. Where the
  original's dependency is one nothing in AWS needs, name it in the suite's
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
  (`outputs`), as the CLI reads them: what a 4.x component named as an output, like
  `_task`, and what a V5 one reports, are the same when they say the same thing.
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
  from a secret is a secret too, so a port that reads something next to a secret (a
  task's volumes next to its built image) can turn a plain input into one. The check
  reports that as a change to the field.
- `pulumi.outputsOf(name)` is what a component registered as its outputs. The takeover
  check passes when neither side registers anything, so assert that the output the CLI
  reads is there (see `v5/task.test.ts`).
- `await pulumi.settle()` after creating resources in every test, or they leak into the
  next one.
- A 4.x component that's passed in can be the real one: a `Vpc`, `Cluster` and `Task`
  all deploy under the mock (see `v5/cron.test.ts`).
- Give the mock extra `state` for outputs the code reads (see `v5/apigatewayv2.test.ts`).
  A resource that's looked up comes back with no name or ARN unless `state` gives it
  one. The region, partition, account and IAM policy lookups have defaults.
- Assert on what's created, too. A takeover test passes when both sides create nothing,
  which is what happens when a mock is missing and both sides fail the same way.
- `sst dev` behaviour is tested by setting `global.$dev = true` in a `beforeEach`.
- An error thrown inside `.apply()` can't be asserted: under the mock it's an
  unhandled rejection, which fails the run. Test the errors that are thrown directly.
- `v5-components.test.ts` runs over every file in `aws/v5/`. It fails when one doesn't
  have the name and type of the component it replaces, isn't exported from
  `aws/v5/index.ts`, has a takeover map that isn't imported, or names another
  component's type.

Run from `platform/`:

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run --pool=forks
```

Three test files (`bucket`, `alb`, `service-alb`) fail to load on `main` too.

**What the mock can't see.** It stands in for the engine and for the CLI, so a test
there never bundles a config, builds a function or calls AWS. The first deploy to a
real account found two bugs every test had passed: the takeover maps were missing from
a bundled config, and a V5 function's links were written into its code under the wrong
names. Both have a test now. For a port that touches how a config is built, what the
CLI is told, or the order things are created in, deploy it: the 4.x component first,
then `sst diff` after the switch, then `sst deploy`, then `sst remove`.

**Depending on a component is depending on everything in it.** A value read from a
component itself, like its `urn`, makes whatever is given that value wait for every
resource the component has created. A part is inside its component, so a part given
such a value waits for itself and is never created, with no error. That's how a
subscriber that linked its own queue (`queue.subscribe({ handler, link: [queue] })`)
went missing: a function's code is built from its links, and a link's name is read
from the linked component. 4.x didn't have the problem only because its subscriber sat
outside the queue. Give a part the outputs of the resources it needs, and where a value
is made on this machine from what's in AWS, pass it through `withoutDependencies()`.
For a component with function parts, test a function that links the component.

## Checklist

1. Read the original and every wrapper component it creates. Note each resource's
   logical name, parent and options.
2. Write `aws/v5/<name>.ts`, with the original's file name and class name, less a
   version SST 4 put in them (see the top of this file): parts, args,
   constructor, methods, `link()`, `static get`.
   Give it the original's type. What the original registers for the CLI, as `_hint`,
   `_dev`, `_task`, `_tunnel` or `_metadata`, the V5 one reports with `this.report()`.
   Search `cmd/` and `pkg/` for the type (`"sst:aws:Function"`) too, in case the CLI
   finds it by name.
3. If a part has another name or place than it had, write `aws/takeover/<name>.ts` and
   import it from `aws/takeover/index.ts`.
4. Export the component from `aws/v5/index.ts`, which is `sst.aws.v5`.
5. Write `test/components/v5/<name>.test.ts`: takeover cases with
   `pulumi.takeoverCases()`, then behaviour.
6. Write the class doc, including a "Switch from `sst.aws.<Name>`" section that lists what's
   written differently and what changes on deploy. The docs generator adds the two notes
   every port has to its list. Document each part where it's declared: those comments
   become the `transform`, `existing` and `nodes` docs. Add each breaking change, what a
   user writes or reads differently, to the breaking changes so far in
   `docs/plans/v5-rewrite/plan.md`, with its way across: a codemod rule, a line in the
   guide, or the `sst migrate --check` refusal.
7. `cd www && bun ./generate.ts components` generates the page. The docs generator and
   the sidebar find every file in `aws/v5/`, so there's nothing to add to either.
   It fails when the page has `sst.aws.<Name>` outside the "Switch from" section, other
   than as a link to its page. An inherited example that creates the original is
   rewritten for you; what's left is prose that names it, in an arg's docs or your own.
8. Typecheck, run the tests, and `bun run build:cli` from the repo root.
9. Review before calling it done. Read the original's constructor and the new one side
   by side, resource by resource: args, options, names, what's read back. Then read the
   generated page, and check the port against the
   [v5 goals](https://github.com/sst-community/sst/blob/v5/docs/plans/v5-goals.md).

The existing ports are the reference, all in `aws/v5/`: `alb.ts` for a custom domain
with aliases, and a method that looks a part up when it's asked for (`getListener`);
`apigatewayv2.ts` for routes, authorizers and a custom domain; `sns-topic.ts` for named subscribers; `bucket.ts` for
one resource built from many notifications; `cognito-user-pool.ts` for triggers and a
linkable client; `redis.ts` for a component that runs locally in `sst dev` and reports a pane for it,
and `get`; `postgres.ts` and `mysql.ts` for the same, built by one helper
(`helpers/rds-instance.ts`), with an optional group of parts (the proxy) and a part
per item in a list; `aurora.ts` for a
`get` that finds the rest of what it references, and a transform that applies to more
than one part; `cluster.ts` for the smallest one: nothing moved, so no takeover map,
and a `get` that takes args next to the id; `efs.ts` for a part per item of a list
that's only known on deploy (a mount target per subnet), and a `get` that finds the
other part it needs; `dsql.ts` for parts in another region, and features that each add a
group of parts; `task.ts` for parts per item of a plain list (containers), a part
that's built later, a stub in `sst dev`, and what it reports to the CLI; `service.ts` for
groups of parts that depend on an arg (a load balancer of its own, or one it
shares), parts made from a plain list of rules, a part that's read from `nodes` and
only exists sometimes, and a part that's created in `sst dev` too; `cron.ts` for a
function the component may be given or may create, next to another component it's
given (a `Task`); `dynamo.ts` for required args next to `get`, and a static method
replaced by `get`; `function.ts` for a component 4.x built almost entirely inside
`.apply()`, with parts that are created later, args of its own, what a build reads
kept plain so a preview knows its source maps, and what an app creates once shared
with the 4.x one; `vpc.ts` for args of its own, parts in each AZ from a plain count
with nothing inside `.apply()`, and a `get` that finds what it can't count with
lookups that aren't resources; `router.ts` for parts that 4.x kept in wrapper
components at the top of the app (each route's entries in the key-value store), a
component part (`Cdn`) that's looked up for `get`, and a setting it gives as a plain
value so the components served through it don't wait (`_signs`); `nextjs.ts` for parts
made from a build that runs in the program, created with `after()`, and a wrapper 4.x
kept inside the component (the warmer's `Cron`).
