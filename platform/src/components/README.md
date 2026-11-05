# Writing components

A component is built from **parts**: a declared list of the resources it creates. From
that one list the component gets a typed `transform`, `existing` and `nodes`, consistent
resource names, and a check that nothing is created outside the list.

This guide is for writing **your own component**, in an app or as a package. SST's own
components are written the same way. **Changing or adding one of SST's**, as a person or
an agent, has rules of its own on top of these, in `CONTRIBUTING.md` beside this file,
with a checklist: the helpers they share, the takeover maps `sst migrate` uses, and
their tests.

This file ships with the CLI, so in an app it's at `.sst/platform/src/components/README.md`.
The first half is also on the docs site as "Write a Local Component"
(`www/src/content/docs/docs/write-a-local-component.mdx`), and publishing one as a package
is "Write a Package Component". Keep them in step. What the local page shows working is
tested in `component.test.ts` under "the component in the docs".

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

class Uploads extends sst.component("acme:index:Uploads", parts) {
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

new sst.aws.Function("Api", { handler: "src/api.handler", link: [uploads] });
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
  - `deferred(sst.aws.Function)`: a function that's built later, or not at all when the
    user passes an ARN. Create it with `sst.aws.functionPart(this, key, definition,
    defaults)`, or with an id for `many(deferred(sst.aws.Function))`. Its `nodes` entry is
    an `Output`. The user's `transform` for it takes the function's args, including the
    function's own `transform` and `existing`. Any part can be deferred: one that's made
    from a build is created with `this.part()` in what `this.after()` runs (below).
    `deferred(optional(...))` is one that may not be created: its `nodes` entry is an
    `Output` that may be `undefined`.
  - `named(part, "Name")`: the resource is named `<ComponentName><Name>` in place of the
    key. The key is what's written in `transform`, `existing` and `nodes`; the name is
    how a deployed app knows the resource, so it's permanent. It wraps a class or
    another marker: `named(optional(aws.ec2.SecurityGroup), "NatInstanceSecurityGroup")`.
    Use it when the name a resource has to keep isn't the key you want.
- **An SST component can be a part**, like `sst.aws.Function` or a certificate. If the
  component's own file imports yours, declare the parts in a function so they're read
  late: `component("acme:index:Uploads", () => ({ ... }))`.
- **A part is never created inside an `.apply()`.** A preview skips an `.apply()` whose
  input it doesn't know yet, so what's created inside one is missing from `sst diff` and
  `sst migrate --check`. Decide whether a part exists, and how many there are, only from
  what a preview knows: plain args, lookups whose inputs are known, and the code and
  config on disk. A value that's only known on deploy, like another component's output
  or a link's value, is only ever passed in, as an input.
  - Where a build decides it (a function's source maps, a site's servers), take it from
    a build that doesn't need what isn't known. A function's build doesn't read its links,
    so it's built once either way. A site's does: it's built once per deploy, with the
    values it's deployed with, and a preview builds it without the values it doesn't know
    (`buildSite()` in `helpers/site-build.ts`). The parts made from it are created in
    `this.after(build, (built) => { ... })`, which keeps the program running until they
    are, and fails it if the build fails. Until then their `nodes` entries are outputs
    that resolve to what was created, or fail with the build. A `many(deferred(...))`
    part is listed by id as it's created; when the ids are known before, like a site's
    regions, name them with `this.willCreate(key, ids)` so `nodes` has them from the
    start.
  - A failure the user should read is a `VisibleError`, from `sst/components`. Its
    message is shown once and as it's written, however many resources wait on what
    failed. It names the component the way the rest do, `the "${name}" queue`, with the
    kind in lower case and args in double quotes, so an app with several knows which
    one failed. An option that's refused says what to write instead.
  - A list another component counts, like a `Vpc`'s subnets, is a list of known length
    with an output in each place, not one output of a list.
  - Some of SST's components still create parts inside `.apply()` with `optional`,
    `many` or `deferred` (the `Service`'s Cloud Map service, for a VPC given by its
    ids, through `this.partHandle()` and `defer()`). Don't take them as the pattern.
  - Test it: a new stage's preview, where nothing AWS gives back is known yet,
    registers what a deploy does (`test/components/v5/function-preview.test.ts`).
- **A part is created once.** Creating it a second time is an error.
- **`this.existingPart(key)`** returns the resource the user passed in `existing`, when
  the component has to do something different for a resource it didn't create.
  `this.part()` already returns it instead of creating one.
- **`this.lookupPart(key, [id], resourceId)`** looks a part's resource up in place of
  creating it, when the component references something that's already deployed and
  works out the ids of its other parts itself: from a tag, or a data source. The
  `Aurora` is given a cluster and finds its instance, secret and proxy this way. A
  resource the user passed in `existing` for the part is used instead of the lookup.
  For an id passed there, write `this.existingPart(key) ?? this.lookupPart(...)`.
- **`this.assertNew(what, key, id, args, transforms?)`** goes at the top of a method that
  adds a named thing (`addRoute`, `subscribe`). It rejects a name that's taken and a
  `transform` passed to the method, with a message that points at the component's own
  `transform`.
- **`this.delegateOpts()`** is for resources something else creates on the component's
  behalf, like a DNS adapter creating records: `dns.alias(name, record,
  this.delegateOpts())`. They aren't parts. They're configured through what creates them.
  A DNS adapter (`DnsAdapter`, in `dns-adapter.ts`) creates its records directly and names
  them from plain values: a record whose name in DNS is only known once something is
  deployed, like a certificate's validation record, is given a `key` to be named after.
  Where such a resource had another name in SST 4, the takeover map's `delegated` gives
  its old address, by the name and type it has now.
- **An arg the user's `transform` must not change** goes in a Pulumi transformation on
  the part: `this.part(key, args, { transformations: [({ props, opts }) => ({ props: {
  ...props, runtime }, opts })] })`. It runs after the user's `transform`. The
  `Function` does this for the stub it deploys in `sst dev`.

## Args

- **Extend `sst.ComponentArgs<typeof parts>`.** It adds `transform` and `existing`.
- **Args that decide what gets created are plain values.** If whether a part exists
  depends on an arg, that arg can't be an output: the component has to know before it
  creates anything. Fields inside it can still be outputs. This is what lets parts be
  created directly instead of inside `.apply()`, and lets `nodes` hold resources, not
  outputs of resources.
  The same goes for a list with a part per item, and for the field each part is
  named after: the `Postgres` takes the proxy's `credentials` and each `username`
  as plain values, and the passwords as inputs.
- **A part the user can switch off gets its own arg** (`publicAccessBlock: false`).
  `transform` changes a part; it doesn't remove one.
- **For a resource the user already has, use `existing`**, not an arg of your own.
  A static `get` is one line: `return new Uploads(name, { existing: { bucket: id } }, opts)`.
  When the component has required args, return before reading them:
  `if (this.existingPart("table")) return;`. `get` then passes only `existing`, with a
  cast to the args type. Refuse args that would configure a resource given in
  `existing`: it's used the way it is, and they'd be dropped without a word. Refuse an
  `existing` entry the component wouldn't use, too.
- **A check that needs a deployed value** goes in the output that everything depending
  on it reads, so the error stops what would have used it. The `Dynamo` checks that
  the table's stream is enabled inside the stream ARN its subscribers are given, and
  the `Service` checks that an `Alb` is in the cluster's VPC inside the VPC id its
  target groups are given.
- **An arg a resource is named after is plain all the way down.** A rule of a service's
  load balancer is: its listener rule is named after its conditions. Refuse an output
  anywhere inside it, and say which arg it was.

## Linking, dev mode, naming

- **Linking.** Define `link()` and return `properties` (readable at runtime as
  `Resource.<Name>`) and `include` (`sst.aws.permission()`, `sst.cloudflare.binding()`,
  `sst.env()`). For compute SST doesn't manage, `sst.aws.iamStatements(links)` gives the
  IAM statements and `sst.Linkable.env(links)` the environment variables.
- **Dev mode.** If the component runs locally in `sst dev` and isn't deployed, handle
  that in one place in the constructor: call `this.runsLocally()` and return before
  creating the parts that aren't deployed. Do it before `existing`: given both, `sst dev`
  uses what runs locally. Reading `nodes` then explains why a resource is missing. A
  part that's created all the same is in `nodes` as usual, like the role a service's
  containers run as on the user's machine. Keep the values the getters return in one
  object so the getters don't branch on dev.
- **Telling the CLI.** What the CLI needs from a component it reads from what the
  component reported, through the program contract: a function it builds (`function`),
  a command `sst dev` runs (`dev`), a task `sst dev` runs locally (`task`), a bastion
  for `sst tunnel` (`tunnel`), and a URL to show after a deploy (`hint`). Call
  `this.report({ ... })` in the constructor, before `registerOutputs()`; a report after
  it is an error. Pulumi registers a component's outputs a moment after its
  constructor, so a report from a method can come too late once the config awaits. A
  component whose report waits on a method the app calls, like the `ApiGatewayRest`'s
  hint on `deploy()`, overrides `registerOutputs()` to do nothing until then, and the
  method reports and registers them. Don't name an output for the CLI. `context()`
  from `sst/components` gives the app, the stage, whether it's `sst dev`, the command
  and the paths. A component reads them there, not from `$app`, `$dev` or `$cli`,
  which are for an app's config. In a test, `app.reportOf(name)` is what a component
  reported.
  A component doesn't create a `DevCommand` for a command of its own: it reports
  `dev`. A report holds one pane, so a component with one per item, like the
  `Service`'s pane for each container, creates them as a `many(DevCommand)` part. The
  `DevCommand` (`sst.x.DevCommand`, in `experimental/`) is for an app's own commands,
  and reports the same way.
- **Physical names.** SST knows how to name the resource types its own components use.
  For another type, `sst.Component.naming("aws:athena/workgroup:Workgroup", { field:
  "name", max: 128 })`, or `false` to leave it to the provider. A resource that's looked
  up keeps the name it has.
- **Testing.** `mock()` from `.sst/platform/src/testing` stands in for the engine and
  gives a test the globals a config has. Create the component, `await app.settle()`, and
  read `app.resources`. `app.takeover(saved)` checks a change against a saved
  `app.graph()`: what a deploy would remove, what it would update, and what it would
  no longer remove in order. It works with vitest and with `bun test`. The docs page
  has the examples.
- **Renaming a part later.** A part's key is in the name of its resource, so a new key
  is a new resource. To change the key and keep what's deployed, declare the part with
  the name it had: `files: sst.named(aws.s3.Bucket, "Bucket")`, and nothing else changes.
  Or give the resource its new name and say where it was, in the component's next
  version: `sst.takeover(Uploads, { version: 2, moved: { files: "bucket" } })`. A
  component with no map is at version 1. Each stage records the version it has, so on
  one that has version 1 a deploy refuses version 2, and `sst migrate` moves it, checked
  first as `sst migrate --check` shows. A new stage starts at the latest. Each later
  change is the next version, and a stage further behind is moved through each. A
  key in `moved` is the old part's own name; for one declared with `sst.named()`, give
  its old address with a function. `app.takeover(saved)` tests a map under the mock.
- **Sharing it as a package.** A package imports `component` and the rest from
  `sst/components`, SST's components for a provider from its group, like
  `sst/components/aws`, and each provider from its package. Its repo installs `sst`,
  Pulumi and those providers as dev dependencies, and builds and tests with ordinary
  tools, with no `sst.config.ts`. In an app, the CLI resolves the same imports to the
  app's own platform, so together they're what the `sst` global is.
  `.sst/tsconfig.json`, which `sst install` writes, does the same for TypeScript, and
  the vitest `alias` for the app's tests. The package's peer dependencies say which SST
  and which providers it needs, and a deploy checks them. "Share it" on the docs page
  has the setup.
- **`sst/components` is a public API.** What `core.ts` and each group export is what
  packages build on. Adding to it is fine. Removing an export or changing what one
  accepts breaks them, so it waits for a major version. `component()` returns a named
  type (`ComponentClass`) so that a package's `.d.ts` can name it; keep it named.
  `declarations.test.ts` compiles a package both ways.
