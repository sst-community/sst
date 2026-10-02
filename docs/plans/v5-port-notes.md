# v5 port notes

One section per ported component: its parts, what's plain, what a switch changes, and what's deliberately different from version 4. What a user has to write differently is in each component's own docs, under "Switch from". This file is for whoever works on the components.

All of them are in `platform/src/components/aws/v5/`, with a takeover map in `aws/takeover/` where something moved, and tests in `platform/test/components/v5/`.

## Function

The hardest component, and the test of whether the framework holds.

- **Parts:** `role`, `logGroup`, `code`, `sourcemap` (many), `image`, `function`, `url`, `urlAlias`, `urlAccess`, `urlInvoke`, `routeKey`, `routesUpdate`, `provisioned`, `eventInvokeConfig`, `environmentUpdate`.
- **Plain:** `dev`, `logging`, `url`, `url.authorization`, `python.container`, `concurrency.provisioned`.
- **Moved to `existing`:** `role` and `logging.logGroup`. The 4.x forms of `live`, `role`, `logging.logGroup` and `url.route` are still taken, in the constructor, because a `$transform` written for `sst.aws.Function` applies here too.
- The build, wrapper and zip logic is copied into `aws/helpers/function-code.ts`, because the 4.x constructor can't be edited.
- **Parts created late**, inside `.apply()`, when a plain arg can't decide them: source maps (known after the build) and the URL permissions behind a `Router` (its protection mode is an output).
- **SST's own provider resources are parts** (`KvKeys`, `KvRoutesUpdate`, `FunctionEnvironmentUpdate`). They add `.sst.aws.<Type>` to their name; a `moved` entry for one needs the old name in full.
- An arg the user's transform must not change goes in a Pulumi `transformations` entry on the part's options (the dev stub's runtime, architecture and description).
- **It shares two app-wide resources with 4.x** through the 4.x class's private statics: `LambdaEncryptionKey` and the dev bridge code object.
- **It reproduces the 4.x trust policy on purpose** (see Decisions in the plan).
- **The built code depends on nothing.** It's built from the function's links, and a link's name is read from the linked component; depending on a component is depending on everything in it. The build result is passed through `withoutDependencies()`. Without it a function part that links its own component waits for itself.
- **What's made from a function's name changes when a function part is renamed:** its description, the key its code is uploaded under, and the router namespace of a URL behind a `Router`.
- A function part's class can't be told by `constructor.name` (both are `Function`). Tests use `toBeInstanceOf`.

Function parts in other components are declared `deferred(Function)` and created with `functionPart()` in `aws/helpers/function-part.ts`. A definition written for the 4.x `Function` still works there. `aws/helpers/function-builder.ts` is identical to `main` and only 4.x components use it.

## Queue

- **Parts:** `queue`, `subscriber` (a function), `eventSourceMapping`.
- The subscriber is parts of the queue. There's no separate subscriber component and no static `subscribe`.
- **On switch:** the 4.x `QueueLambdaSubscriber` wrapper goes, and the subscriber function's description changes.

## SnsTopic

- **Parts:** `topic`, and by subscriber name `subscriber`, `permission`, `subscription`, `queuePolicy`.
- Subscribers need names to be kept.
- A queue subscriber is created with the topic's `provider` (4.x used the app's).

## Bucket

- **Parts:** `bucket`, `versioning`, `publicAccessBlock`, `policy`, `cors`, `lifecycle`, `notification`, and by subscriber name `subscriber`, `permission`, `queuePolicy`, `topicPolicy`.
- **Plain:** `versioning`, `cors`, `lifecycle`.
- A part the user can switch off gets its own arg: `publicAccessBlock: false`. `transform: { part: false }` isn't a thing in v5.
- **A 4.x ordering guarantee is kept:** everything that reads `bucket.name` waits for the bucket policy, in the `name` / `arn` / `domain` getters.
- `subscribe`, `subscribeQueue` and `subscribeTopic` are gone; `notify` keeps the subscriber.
- The takeover map also gives the top-level address of notifications from `Bucket.get(..., { parent })`.

## CognitoUserPool

- **Parts:** `userPool`, `trigger` (many functions), `permission` (many), `certificate`, `domain`, `identityProvider` (many).
- **Plain:** `domain`, `domain.dns`, `triggers`.
- `addClient("Web")` returns a `CognitoUserPoolClient`, a component of its own, so `link: [client]` still gives `Resource.Web.id`. A raw AWS resource returned from a method can't be linked under the user's name.
- The client has nothing that moved, so it has no takeover map.
- A lookup at the top of the app (`CognitoUserPool.get`) can't be carried over, because lookups take no aliases. The old one is dropped from the state and the same resource is looked up again.

## AppSync

- **Parts:** `api`, `certificate`, `domainName`, `domainAssociation`, and by name `dataSource`, `dataSourceFunction`, `serviceRole`, `function`, `resolver`.
- **Plain:** `domain`, `domain.dns`.
- `addDataSource` returns the AppSync data source and `addFunction` the AppSync function.
- 4.x created the domain association at the top of the app; the map says it had no parent.
- The function of a Lambda data source was a top-level function in 4.x, so it had a link reference in the state. As a part it has none. Nothing in AWS changes.

## ApiGatewayV2

- **Parts:** `api`, `stage`, `logGroup`, `vpcLink`, `certificate`, `domainName`, `domainMapping`, and by route `handler`, `permission`, `integration`, `route`, and by name `authorizer`, `authorizerFunction`, `authorizerPermission`.
- **Plain:** `domain`, `domain.dns`. `domain.nameId` became `existing: { domainName }`.
- Every route's parts are keyed by the route (`"GET /users/{id}"`) or by the route's `name`. An id that isn't letters, numbers, `-` or `_` gets a 6-letter hash added to the resource name.
- A route's own `transform` and the API's `transform.route.handler` became the API's `transform` for `handler`, `integration` and `route`. A dropped option throws with `notAnOption()`.
- **Needless 4.x order:** a route's or authorizer's function depended on the API. Named in `needlessOrder`.

## Redis

- **Parts:** `authToken`, `secret`, `secretVersion`, `subnetGroup`, `parameterGroup`, `cluster`.
- The cluster is created directly, with the cluster-mode settings as outputs. Nothing is deferred.
- In `sst dev` with `dev` set, nothing is deployed: `runsLocally()`, and the getters read from one `connection` object.
- `get` is `existing: { cluster }`.

## Dynamo

- **Parts:** `table`, and by subscriber name `subscriber`, `eventSourceMapping`.
- The table is created directly (4.x created it inside `.apply()`), so `nodes.table` is the resource and a `transform` function for it is given outputs.
- `subscribe()` returns the table. The nameless `subscribe(handler)` is rejected with an error that shows the named call.
- The static `Dynamo.subscribe(name, streamArn, ...)` became `Dynamo.get(name, tableName).subscribe(...)`. The map finds what the static method created by the table's own name.
- `fields` and `primaryIndex` stay required in the type; the constructor returns before reading them when `existing.table` is set.
- An unknown field type is created as binary, as 4.x does.

## Postgres

- **Parts:** `password` (only when no `password` arg), `secret`, `secretVersion`, `subnetGroup`, `parameterGroup`, `instance`, `replica` (many, from `0`), `proxySecret` and `proxySecretVersion` (many, by username), `proxyRole`, `proxyRoleLookup`, `proxy`, `proxyTargetGroup`, `proxyTarget`.
- **Plain:** `proxy`, `proxy.credentials`, each credential's `username`, and `replicas` (internal).
- 4.x called the master secret `ProxySecret`, though it's created without a proxy. The map moves it.
- 4.x named a credential's secret after the username as written, so the map gives the old name in full.
- `get(name, { id, proxyId })` is `existing: { instance, proxy }`. An existing instance's password comes from the secret its `sst:lookup:password` tag names, or from the `password` arg.
- `proxyId` throws when read with no proxy. An output that rejects can't be created up front without failing every deploy.
- No 4.x version marker is written, so the old one goes on switch.

## Mysql

`Postgres` with different defaults (user `root`, port `3306`), parameter group and tags (`sst:component-version: "1"`, `sst:ref:password`), performance insights only on larger instances, and no 4.x version marker. Both use `aws/helpers/rds.ts`.

The default version, `8.0.40`, is no longer offered by RDS. See Open questions in the plan.

## Aurora

- **Parts:** as `Postgres`, plus `cluster`, `clusterParameterGroup`, `instanceParameterGroup` (4.x named the resource `ParameterGroup`), and `replica` as cluster instances.
- **Plain:** `replicas`, `proxy`, its `credentials` and each `username`. `engine`, `scaling` and `dataApi` stay inputs.
- The proxy is created before the cluster, which is tagged with it.
- **`transform.instance` applies to each replica as well**, as 4.x does, so a deployed config keeps its replicas unchanged. `transform.replica` is applied after.
- `get(name, id)` is `existing: { cluster }`. The instance, the secret and the proxy are found with `lookupPart()`; the proxy lookup is inside `.apply()`, so it's a late part. `existing` also takes `instance`, `secret`, `proxy` and `password`, for a cluster SST didn't create.
- `reader` and the link's `reader` are computed when read.

## Dsql

- **Parts:** `cluster`, `peerCluster`, `clusterPeering`, `peerClusterPeering`, `endpointSecurityGroup`, `managementEndpoint`, `connectionEndpoint`, `backupRole`, `backupVault`, `peerBackupVault`, `backupPlan`, `backupSelection`. Everything in the peer region starts with `peer`.
- **Plain:** `regions`, `regions.peer` (it picks the provider), `backup`, `vpc`, and the two endpoint switches.
- `endpointSecurityGroup` uses `named()`, so its resource keeps the 4.x name and nothing changes on switch.
- `transform.backupVault` applies to the peer region's vault too, as 4.x does. `transform.peerBackupVault` is applied after.
- `get(name, { id, peer })` is `existing: { cluster, peerCluster }` plus `regions.peer`. An existing cluster means nothing else is created.
- It re-declares `vpc`, so it names `AnyVpc` itself.

**Types named by tag get a tag update when a part is renamed** (security groups, VPC endpoints, subnets, the DSQL cluster). Types named by a `name` field keep the deployed name. This matters for `Vpc`.

## CronV2

- **Parts:** `function` (4.x named it `Handler`), `role`, `schedule`.
- `job` and `nodes.job`, both deprecated, are gone, with an error that points at `function`. `nodes.function` is `undefined` for a job that runs a task.
- It takes either kind of `Task`. A 4.x `Cron` or `CronV2` given a v5 `Task` works at runtime but not in the types.

## Task

- **Parts:** `executionRole`, `taskRole`, `image` and `logGroup` (many, by container), `taskDefinition` (4.x named it `Task`), `publicSecurityGroup`.
- **Plain:** the `containers` list, each container and its `name`. `taskRole` and `executionRole` became `existing`.
- **`image` stays an input.** The image is built behind the build semaphore, so it's created inside `.apply()` anyway. `containerImage()` creates it through `partHandle()` and applies the user's transform before the args resolve, as 4.x does.
- 4.x used a container's name as written, so the map gives the old names of images and log groups in full.
- `existing.image` is rejected with a pointer.
- Registered as `_task`, which the CLI reads by output name (`pkg/project/completed.go`), not by type.
- `publicIp`, deprecated, is kept: it isn't the same as `public`.

## Service

- **Parts:** `executionRole`, `taskRole`, `image` and `logGroup` (many, by container), `taskDefinition`, `loadBalancerSecurityGroup`, `loadBalancer`, `certificate` (4.x `Ssl`), `target` (many, `<container><PROTOCOL><port>`), `listener` (many, `HTTP80`), `listenerRule` (many), `cloudmapService`, `service`, `autoScalingTarget`, three scaling policies, `devCommand` (many, by container).
- **Plain:** `loadBalancer`, its `domain` and `aliases`, `rules` and each rule all the way down (`plainDeep`: the listener rule is named after its conditions), `scaling` and its three targets, `containers` and each `name`, `dev`.
- **Dropped with a pointer:** `taskRole` / `executionRole` (to `existing`), deprecated `public` (to `loadBalancer`), `ports` (to `rules`), a rule's `path` (to `conditions.path`).
- `cloudmapService` is deferred: it's created directly for an SST VPC, and inside `.apply()` for a VPC given by its ids, where it's given the namespace id as the output so that it's removed before the namespace.
- **Nothing in AWS changes on switch.** The 4.x `DevCommand`s sat at the top of the app; the v5 ones are parts with no old address, so a switch lists them removed and created.
- **Deliberate differences:**
  - The ECS service depends on its listeners and listener rules. 4.x left that order to the provider's retry.
  - The load balancer depends on its certificate, so it's removed first.
  - The `Alb` VPC check is in the `vpcId` the target groups get.
  - A redirect rule needs no `container`.
  - A rule naming a container the service doesn't have fails early.
- It takes either kind of `Cluster`, `Alb` and `Efs`.
- **Needless 4.x order:** its load balancer depended on the ECS cluster. Named in `needlessOrder`.
- Three behaviours carried over from 4.x are in Open questions in the plan.

## Cluster

- **Parts:** `cluster`, `capacityProviders`. Same names as 4.x, so no takeover map.
- `vpc` stays an input. `cluster.vpc` returns what the 4.x getter does.
- `get(name, { id, vpc })` is `existing: { cluster }`. The `sst:ref:version` tag check on `get` is dropped, so any ECS cluster can be passed; the tag is still written, so the 4.x `get` accepts a v5 cluster.
- `addService` and `addTask`, deprecated, exist only to throw with the call to write. There's no `Cluster.v1`.
- A 4.x `Service` or `Task` given the v5 cluster works at runtime but not in the types.

## Efs

- **Parts:** `fileSystem`, `securityGroup`, `mountTarget` (many, by subnet id, created inside `.apply()` because the subnets are an output), `accessPoint`.
- 4.x used the subnet id as written in a mount target's name; the map gives it.
- **Ordering kept with `dependsOn`:** the access point depends on the mount targets, and `id` waits for the access point, so a function isn't created before them.
- The VPC lookup for a VPC given by its ids is not a part. It's looked up with `delegateOpts()` under the same name, so it stays in the state as it was.
- `get(name, id)` is `existing: { fileSystem }`. The access point is `existing.accessPoint` or the file system's first, through `lookupPart()`.
- A 4.x `Function`, `Service` or `Task` given the v5 `Efs` does not work (they check `instanceof`), so what mounts a file system switches first.

## Alb

- **Parts:** `securityGroup`, `certificate` (4.x `Ssl`), `loadBalancer`, `listener` (many, `HTTPS443`).
- **Plain:** `listeners`, `domain` and its `aliases`.
- `get(name, arn)` is `existing: { loadBalancer }`. The security group is `existing.securityGroup` or the load balancer's first.
- `getListener()` returns a listener part, or looks one up as a part.
- The load balancer depends on its certificate, so it's removed first.
- `_certArn`, internal and read by nothing, is not carried over. `dns: false` without `cert` is refused; 4.x crashed.
- A 4.x `Service` refuses the v5 `Alb`.
