# Writing V5 components

A V5 component is built from **parts**: a declared list of the resources it creates. From
that one list the component gets a typed `transform`, `existing` and `nodes`, consistent
resource names, and a check that nothing is created outside the list.

This guide is for two readers:

- You're writing **your own component** in an app. Read up to "Porting a 4.x component".
- You're **porting one of SST's 4.x components** to V5, as a person or an agent. Read all
  of it; the last sections are the rules and the checklist.

This file ships with the CLI, so in an app it's at `.sst/platform/src/components/README.md`.

## A component in one page

```ts title="sst.config.ts"
const parts = {
  bucket: aws.s3.Bucket,
  // Only created when it's asked for
  audit: sst.optional(aws.s3.Bucket),
  // One per team
  reader: sst.many(aws.iam.Role),
};

interface UploadsArgs extends sst.ComponentArgs<typeof parts> {
  teams: string[];
  audit?: boolean;
}

class Uploads extends sst.component("acme:Uploads", parts) {
  constructor(name: string, args: UploadsArgs, opts?: $util.ComponentResourceOptions) {
    super(name, args, opts);

    this.part("bucket", { forceDestroy: true });
    if (args.audit) this.part("audit", {});
    for (const team of args.teams)
      this.part("reader", team, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: "lambda.amazonaws.com",
        }),
      });
  }

  get name() {
    return this.nodes.bucket.bucket;
  }

  link() {
    return {
      properties: { name: this.name },
      include: [
        sst.aws.permission({
          actions: ["s3:GetObject"],
          resources: [$interpolate`${this.nodes.bucket.arn}/*`],
        }),
      ],
    };
  }
}
```

That is the whole pattern: declare `parts`, extend `sst.component(type, parts)`, call
`super(name, args, opts)` with the args as they are, and create each resource with
`this.part()`.

## What the people using your component get

```ts
const uploads = new Uploads("Docs", {
  teams: ["design", "legal"],
  // Change how any part is created. An object is merged into the defaults, deeply,
  // and it's typed that way: a nested object can be given in part.
  transform: {
    bucket: { tags: { team: "storage" } },
    // A function can change the args and the options. For a `many` part it's
    // also given which one it's looking at.
    reader: (args, opts, name, team) => {
      if (team === "legal") args.maxSessionDuration = 7200;
    },
  },
  // Use a resource they already have in place of one the component would
  // create: the resource itself, or the id to look it up by.
  existing: { bucket: "my-existing-bucket" },
});

uploads.nodes.bucket; // the aws.s3.Bucket
uploads.nodes.audit; // undefined when it wasn't created
uploads.nodes.reader.legal; // by id

new sst.aws.FunctionV5("Api", { handler: "src/api.handler", link: [uploads] });
```

A `transform` or `existing` key that isn't one of the parts is an error, with the list of
parts in the message. `$transform(Uploads, (args) => { ... })` works too, and runs before
the component reads its args.

## Parts

- **Names.** A part's resource is named `<ComponentName><Key>`, so `Docs` and `bucket`
  give `DocsBucket`. A `many` part adds its id: `DocsReaderLegal`.
- **Everything is a part.** A resource created directly under the component that isn't a
  declared part throws. That's what keeps `transform` and `nodes` complete.
- **Markers.**
  - `optional(Class)`: created only sometimes. Its `nodes` entry may be `undefined`.
  - `many(Class)`: several of one kind, created with an id: `this.part("reader", id, args)`.
    An id can be any string, like the route `"GET /users/{id}"`. A plain id is used in the
    name as it is; any other gets a short hash added so two similar ids don't collide.
    `id in this.nodes.reader` tells you whether one exists.
  - `deferred(sst.aws.FunctionV5)`: a function that's built later, or not at all when the
    user passes an ARN. Create it with `sst.aws.functionPart(this, key, definition,
    defaults)`, or with an id for `many(deferred(sst.aws.FunctionV5))`. Its `nodes` entry is
    an `Output`. The user's `transform` for it takes the function's args, including the
    function's own `transform` and `existing`.
- **An SST component can be a part**, like `sst.aws.FunctionV5` or a certificate. If the
  component's own file imports yours, declare the parts in a function so they're read
  late: `component("acme:Uploads", () => ({ ... }))`.
- **A part can be created later**, inside an `.apply()`, when whether it exists depends
  on something that's only known on deploy: another component's output, or the result of
  a build. Declare it `optional` or `many`. It's added to `nodes` when it's created, so
  say that in its doc comment. Do this only when a plain arg can't decide it.
- **A part is created once.** Creating it a second time is an error.
- **`this.existingPart(key)`** returns the resource the user passed in `existing`, when
  the component has to do something different for a resource it didn't create.
  `this.part()` already returns it instead of creating one.
- **`this.assertNew(what, key, id, args, transforms?)`** goes at the top of a method that
  adds a named thing (`addRoute`, `subscribe`). It rejects a name that's taken and a
  `transform` passed to the method, with a message that points at the component's own
  `transform`.
- **`this.delegateOpts()`** is for resources something else creates on the component's
  behalf, like a DNS adapter creating records: `dns.createAlias(name, record,
  this.delegateOpts())`. They aren't parts. They're configured through what creates them.
- **An arg the user's `transform` must not change** goes in a Pulumi transformation on
  the part: `this.part(key, args, { transformations: [({ props, opts }) => ({ props: {
  ...props, runtime }, opts })] })`. It runs after the user's `transform`. `FunctionV5`
  does this for the stub it deploys in `sst dev`.

## Args

- **Extend `sst.ComponentArgs<typeof parts>`.** It adds `transform` and `existing`.
- **Args that decide what gets created are plain values.** If whether a part exists
  depends on an arg, that arg can't be an output: the component has to know before it
  creates anything. Fields inside it can still be outputs. This is what lets parts be
  created directly instead of inside `.apply()`, and lets `nodes` hold resources, not
  outputs of resources.
  The same goes for a list with a part per item, and for the field each part is
  named after: `PostgresV5` takes the proxy's `credentials` and each `username` as
  plain values, and the passwords as inputs.
- **A part the user can switch off gets its own arg** (`publicAccessBlock: false`).
  `transform` changes a part; it doesn't remove one.
- **For a resource the user already has, use `existing`**, not an arg of your own.
  A static `get` is one line: `return new Uploads(name, { existing: { bucket: id } }, opts)`.
  When the component has required args, return before reading them:
  `if (this.existingPart("table")) return;`. `get` then passes only `existing`, with a
  cast to the args type.
- **A check that needs a deployed value** goes in the output that everything depending
  on it reads, so the error stops what would have used it. `DynamoV5` checks that the
  table's stream is enabled inside the stream ARN its subscribers are given.

## Linking, dev mode, naming

- **Linking.** Define `link()` and return `properties` (readable at runtime as
  `Resource.<Name>`) and `include` (`sst.aws.permission()`, `sst.cloudflare.binding()`,
  `sst.env()`). For compute SST doesn't manage, `sst.aws.iamStatements(links)` gives the
  IAM statements and `sst.Linkable.env(links)` the environment variables.
- **Dev mode.** If the component runs locally in `sst dev` and creates nothing, handle
  that in one place in the constructor: call `this.runsLocally()` and return before
  creating parts. Reading `nodes` then explains why the resource is missing. Keep the
  values the getters return in one object so the getters don't branch on dev.
- **Physical names.** SST knows how to name the resource types its own components use.
  For another type, `sst.Component.naming("aws:athena/workgroup:Workgroup", { field:
  "name", max: 128 })`, or `false` to leave it to the provider. A resource that's looked
  up keeps the name it has.
- **Renaming a part later.** `sst.takeover(Uploads, { from: "acme:Uploads", moved: {
  newKey: "oldKey" } })` keeps the deployed resource when a part's key changes.

---

## Porting a 4.x component

Everything above applies. The rest is specific to SST's own components in
`platform/src/components/aws/`.

### Ground rules

- **The V5 component sits next to the original.** `Queue` in `queue.ts` becomes `QueueV5`
  in `queue-v5.ts`, type `sst:aws:QueueV5`.
- **Don't edit any 4.x component file.** They keep merging cleanly from upstream.
- **Redesign, don't translate.** A V5 component doesn't have to mirror the original's
  structure.
- **Port what takes a component before the component itself.** 4.x components
  recognise a `Vpc`, a `Router` or a `Cluster` with `instanceof`, so the V5 one can't
  be passed to them. Port the components that take it first, and have each accept
  both the original and the V5 one. The component that's taken goes last: an app
  switches to it once everything it's passed to is V5.
- **No `registerVersion`.** Keep any tags the original writes at the same value.
- **Reuse the original's arg types**: `interface QueueV5Args extends V5Args<QueueArgs,
  typeof parts> {}`. `Omit` and re-declare only what has to change. For an arg that has
  to become a plain value, write `cors?: Plain<BucketArgs["cors"]>` (`Plain` is in
  `args.ts`): the docs generator follows it back to the original's docs.

### What becomes a part, and what stays a component

- Something that only **wires resources together** becomes parts of the parent, as `many`
  parts keyed by a name the user gives: a subscription, a route, an authorizer, a data
  source, an identity provider. 4.x usually kept these in a wrapper component of their
  own. The method that adds one returns the parent (so calls chain) or the AWS resource
  (when the user needs something off it, like `authorizer.id`).
- Something the user **names and links in its own right** stays a component of its own,
  returned by the method that adds it. `CognitoUserPoolV5.addClient("Web")` returns a
  `CognitoUserPoolClientV5`, so `link: [client]` still gives `Resource.Web.id`.
- A per-method `transform` moves to the component's `transform`. `this.assertNew()`
  rejects the old option with a message.
- A deprecated overload isn't carried over (`subscribe(handler)` with no name). Throw
  an error that shows the call to write instead; without one the user gets whatever
  the shifted arguments happen to fail on.
- A static method that adds something to a resource outside the app (`Dynamo.subscribe`
  with a stream ARN) becomes `get(...)` and the ordinary method. The takeover map can
  still find what the static method created: see `takeover/dynamo.ts`.

### Helpers

| For | Use |
| --- | --- |
| A function from a handler, args or ARN | `functionPart()` in `helpers/function-part.ts` |
| Letting a service invoke that function | `invokePermissionArgs(fn, principal, sourceArn)` in `helpers/function-permission.ts` |
| A custom domain (`name`, `dns`, `cert`) | `customDomain()` and `CustomDomainArgs` in `helpers/custom-domain.ts` |
| Event source mappings | `filterCriteria()`, `batchSettings()` in `helpers/event-source.ts` |
| Letting a service send to a queue | `sendPolicyArgs(queueArn)` in `helpers/queue-policy.ts` |
| An RDS database: storage limit, replicas, the proxy, a stored password | `maxStorage()`, `replicaArgs()`, `proxyCredentials()`, `proxyRoleArgs()`, `proxyArgs()`, `storedPassword()` in `helpers/rds.ts` |
| An arg with a default, then converted | `withDefault(value, fallback, convert?)` in `args.ts` |
| An arg that may be unset | `ifSet(value, convert?)` in `args.ts` |
| An arg that must not be an output | `plain(value, what)` in `args.ts` |
| An option a method no longer takes | `notAnOption(args, option, instead)` in `args.ts` |

A helper returns the args of a part, or checks an arg. The component still creates
each part with `this.part()`, so its constructor reads as the list of what it creates.
`PostgresV5` and `MysqlV5` are the same component but for a handful of settings, and
share everything else this way.

The types in a component's args stay in the component's file. The docs generator
renders an args type it finds there, and fails on one that's declared in a helper.

### Taking over what 4.x deployed

Changing `Queue` to `QueueV5` with the same name has to keep the deployed resources. The
component itself knows nothing about 4.x. All of that goes in a **takeover map**,
`aws/takeover/<name>.ts`, imported from `aws/takeover/index.ts`:

```ts
takeover(ApiGatewayV2V5, {
  from: "sst:aws:ApiGatewayV2",
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
  top (`Bucket.notify` does).
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
- A function's `description` usually changes, because 4.x named the wrapper in it. That's
  an in-place update. So does anything else made from the function's name when a
  function part gets a new one: a URL behind a `Router` is registered under a key made
  from it.
- A part that is a V5 component, like a function, changed its type as well as its place.
  You don't write that: the part's old address in `moved` is combined with the type its
  own takeover map names in `from`.
- A function definition can still be written the way `Function` takes it (`role`,
  `logging.logGroup`, `live`, `url.route`). `functionPart()` moves those to where
  `FunctionV5` takes them.
- One of SST's own provider resources (`KvKeys`, `BucketFiles`) adds its type to its
  name: `MyFunctionRouteKey.sst.aws.KvKeys`. As a part it's matched without that. If it
  moved, write its old name in full, as a function in `moved`.
- A resource 4.x created outside of any component got no name from SST. Add its type to
  `UNPREFIXED_TYPES` in `naming-rules.ts` so it keeps the name the provider gave it
  (`FunctionV5` does this for the alias of a durable function's URL).
- Reproduce what 4.x deploys, not what it means to. `Function` trusts the account in
  every role because a check never passes; `FunctionV5` writes the same policy, with a
  comment. Changing it is a decision of its own, not a side effect of a port.

Also check for an **ordering guarantee** the original makes with an
`x.apply(() => resource)` wrapper, and keep it. `Bucket` makes everything that reads
`bucket.name` wait for the bucket policy; `BucketV5` keeps that in its getters.

### Tests

`platform/test/helpers/graph.ts` mocks Pulumi and records every resource a component
registers. A port has a test file with two kinds of tests:

```ts
const pulumi = mockPulumi({
  // What 4.x wraps things in: nothing in AWS behind them, gone after takeover
  wrappers: /^sst:aws:QueueLambdaSubscriber::/,
});

// Deploys the original, then the V5 component, and expects everything kept with the
// same inputs, apart from one wrapper.
await pulumi.expectTakeover(
  () => new Queue("MyQueue").subscribe(FUNCTION_ARN),
  () => new QueueV5("MyQueue").subscribe(FUNCTION_ARN),
  1,
);
```

- Cover every realistic combination of args, and every kind of thing the component adds.
- Include the component inside another component (`{ parent }`) and with a `provider`.
  4.x often created a wrapper at the top of the app with only the provider, wherever
  the component was.
- When something is expected to change, use `pulumi.takesOver()` and assert exactly what:
  `changed.map((c) => [c.name, c.fields])`. Don't loosen the assertion.
- The check compares each resource's inputs and the options that change what a deploy
  does to it: `ignoreChanges`, `protect`, `retainOnDelete`, `deleteBeforeReplace`,
  `replaceOnChanges` and its provider. A difference there is reported as a field named
  `options.<name>`.
- `await pulumi.settle()` after creating resources in every test, or they leak into the
  next one.
- Give the mock extra `state` for outputs the code reads (see `apigatewayv2-v5.test.ts`).
  A resource that's looked up comes back with no name or ARN unless `state` gives it
  one. The region, partition, account and IAM policy lookups have defaults.
- Assert on what's created, too. A takeover test passes when both sides create nothing,
  which is what happens when a mock is missing and both sides fail the same way.
- `sst dev` behaviour is tested by setting `global.$dev = true` in a `beforeEach`.
- An error thrown inside `.apply()` can't be asserted: under the mock it's an
  unhandled rejection, which fails the run. Test the errors that are thrown directly.
- `v5-components.test.ts` runs over every `*-v5.ts` file. It fails when one has no
  takeover map, isn't exported from `aws/index.ts`, or names another component's type.

Run from `platform/`:

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run --pool=forks
```

Three test files (`bucket`, `alb`, `service-alb`) fail to load on `main` too.

### Checklist

1. Read the original and every wrapper component it creates. Note each resource's
   logical name, parent and options.
2. Write `aws/<name>-v5.ts`: parts, args, constructor, methods, `link()`, `static get`.
   Search `cmd/` and `pkg/` for the original's type (`"sst:aws:Function"`): the CLI
   finds some components by type, and the V5 type has to be added next to it.
3. Write `aws/takeover/<name>.ts` and import it from `aws/takeover/index.ts`.
4. Export the component from `aws/index.ts`.
5. Write `test/components/<name>-v5.test.ts`: takeover cases, then behaviour.
6. Write the class doc, including a "Switch from `<Name>`" section that lists what's
   written differently. Document each part where it's declared: those comments become
   the `transform`, `existing` and `nodes` docs.
7. Add the file to the `entryPoints` in `www/generate.ts` and to the "V5" group in
   `www/astro.config.mjs`. `cd www && bun ./generate.ts components` generates the page.
8. Typecheck, run the tests, and `bun run build:cli` from the repo root.

The existing ports are the reference: `apigatewayv2-v5.ts` for routes, authorizers and a
custom domain; `sns-topic-v5.ts` for named subscribers; `bucket-v5.ts` for one resource
built from many notifications; `cognito-user-pool-v5.ts` for triggers and a linkable
client; `redis-v5.ts` for dev mode and `get`; `postgres-v5.ts` for the same with an
optional group of parts (the proxy) and a part per item in a list; `dynamo-v5.ts` for
required args next to `get`, and a static method replaced by `get`; `function-v5.ts`
for a component 4.x built almost entirely inside `.apply()`, with parts that are
created later.
