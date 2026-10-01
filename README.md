<h1 align="center">sst-community v5</h1>

<p align="center">The next major version of <a href="https://github.com/sst-community/sst">sst-community</a>, in development</p>

---

> [!NOTE]
> This is the `v5` branch. **It isn't released**: there is no 5.x on npm. For the version you can install today, see the [`main` branch](https://github.com/sst-community/sst/tree/main).
>
> sst-community is a community-maintained fork of [SST](https://github.com/anomalyco/sst). It is not affiliated with SST or Anomaly.

## What v5 is for

In version 4, each component decides for itself which of its resources you can change. Some can be transformed and some can't. Some are in `nodes` and some aren't. Using a resource you already have is a different option on every component, where there is one.

v5 rebuilds the components on one foundation. A component declares every resource it creates as a **part**, and from that one list every component gives you the same three things:

```ts
const redis = new sst.aws.v5.Redis("MyRedis", {
  vpc,
  // Change how any resource is created
  transform: { cluster: { snapshotRetentionLimit: 7 } },
  // Use a resource you already have in place of one it would create
  existing: { subnetGroup: "my-subnet-group" },
});

// Read any resource it created
redis.nodes.parameterGroup.name;
```

## What it sets out to do

- **Every resource is yours to change.** `transform`, `existing` and `nodes` cover all of a component's resources, and they're typed and documented from the same list.
- **Switch without redeploying.** The v5 components sit next to the version 4 ones, as `sst.aws.v5.*`. Change `sst.aws.Queue` to `sst.aws.v5.Queue`, keep the name, and the resources you've deployed are kept. You switch one component at a time, and each component's docs list what's written differently.
- **Write your own components the same way.** `sst.component()` is what SST's own components are built on, so yours get `transform`, `existing`, `nodes`, naming and linking too.
- **Test components without AWS.** `mock()` stands in for the deploy engine, so a test can create a component and check what it would deploy.

## Status

- **Ported:** `Alb`, `ApiGatewayV2`, `AppSync`, `Aurora`, `Bucket`, `Cluster`, `CognitoUserPool`, `CronV2`, `Dsql`, `Dynamo`, `Efs`, `Function`, `Mysql`, `Postgres`, `Queue`, `Redis`, `Service`, `SnsTopic` and `Task`.
- **Not yet:** the sites (`Nextjs`, `Astro` and the rest), `Vpc`, `Router`, `StaticSite` and the others.
- **Version 4 components are untouched.** Everything in `sst.aws.*` works as it does on `main`, so an app can mix the two.
- **How it's been checked:** each port is tested against the component it replaces, under a mock of the deploy engine, to confirm a switch keeps what's deployed. It has not been deployed to a real AWS account yet.

## Try it

You need [Go](https://go.dev/) and [Bun](https://bun.sh/).

```bash
git clone -b v5 https://github.com/sst-community/sst
cd sst
bun run setup
bun run build:cli
```

That builds `dist/sst5`, which runs next to a stable `sst`. Use it in an app in place of `sst`, on a stage of its own:

```bash
/path/to/sst/dist/sst5 dev --stage v5
```

## Working on it

- [Writing V5 components](platform/src/components/README.md) is the guide: parts, args, tests, and how to port a version 4 component.
- [Write a Component](www/src/content/docs/docs/write-a-component.mdx) is the same for a component in your own app.

```bash
cd platform
npx tsc --noEmit -p tsconfig.json   # typecheck
npx vitest run --pool=forks         # tests
```

Three test files (`alb`, `bucket`, `service-alb`) fail to load, as they do on `main`.

For the docs, run `bun run docs:generate` and `bun run docs:dev` from the repo root.

---

**Found a bug or have a question?** [Open an issue](https://github.com/sst-community/sst/issues) or ask on [Discord](https://discord.gg/DQWT3WGVm2). For SST itself, see [anomalyco/sst](https://github.com/anomalyco/sst).
