<h1 align="center">sst-community 5.0</h1>

<p align="center">The next major version of <a href="https://github.com/sst-community/sst">sst-community</a>, in development</p>

<p align="center">
  <a href="https://discord.gg/DQWT3WGVm2"><img alt="Discord" src="https://img.shields.io/discord/1555318753917407362?style=flat-square&label=Discord" /></a>
  <a href="https://www.npmjs.com/package/@sst-community/sst"><img alt="npm" src="https://img.shields.io/npm/v/@sst-community/sst?style=flat-square" /></a>
  <a href="https://github.com/sst-community/sst/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/sst-community/sst/check.yml?style=flat-square&branch=main&label=build" /></a>
</p>

---

> [!NOTE]
> This is the `v5` branch, where 5.0 is being built. **It isn't released yet**: an install without a version gets 4.x, and the `next-experimental` tag on npm is still `5.0.0-alpha.2`, from before the rewrite on this branch. For the stable version, see the [`main` branch](https://github.com/sst-community/sst/tree/main).
>
> sst-community is a community-maintained fork of [SST](https://github.com/anomalyco/sst). It is not affiliated with SST or Anomaly.

## What 5.0 is for

5.0 rebuilds the components on one foundation. Every component lets you transform, replace and read each resource it creates, the same way; `sst diff` shows what a deploy will do; and your own components are built the way SST's are, from any provider. [Why SST 5](www/src/content/docs/docs/why-sst-5.mdx) says what that changes for your app, and what it costs.

## Moving an app

SST 5 doesn't run SST 4's components, so an app moves in one step, a stage at a time, and keeps what it has deployed:

```bash
sst migrate --codemod   # rewrite the config for SST 5's components
sst migrate --check     # preview the move of a stage, and what it changes
sst migrate             # move it, in one deploy
```

The check stops a move that would delete or replace anything that holds data, and names anything the stage has that SST 5 doesn't. [Migrate From v4](www/src/content/docs/docs/migrate-from-v4.mdx) has the steps, and every change the codemod can't make for you.

## Goals

1. **Every resource keeps its identity.**
2. **Moving never loses data.**
3. **What moves is mapped.**
4. **The home stays compatible.**
5. **Deployed code keeps working.**
6. **`sst diff` shows what the deploy will do.**
7. **Every breaking change has a way across.**
8. **What a package builds on holds still within 5.x.**

Every change to 5.0 is held to these. [goals.md](docs/plans/v5-rewrite/goals.md) says what each means, how it's checked, and where it stands, and [the plan](docs/plans/v5-rewrite/plan.md) has the rest.

## Status

- **Every component of SST 4 has a 5.0 form,** under the same name, but for three that are renamed (`ApiGatewayV1` and `ApiGatewayV2` are `ApiGatewayRest` and `ApiGatewayHttp`, and Cloudflare's `StaticSiteV2` is `StaticSite`) and a few that are left out, like `Vector`, `OpenControl` and the `.v1`s. The guide says what to do with each before a move.
- **How it's been checked:** each component's move is tested against the SST 4 component it replaces, under a mock of the deploy engine, and against states recorded from real deploys. Each was also moved from SST 4 in a real AWS or Cloudflare account as it was ported, but Cloudflare's `Bucket` and `Hyperdrive`, which need R2, checked under the mock only.
- **Left before 5.0.0:** moving an app in daily use in a real account (every recorded app has been moved, with every resource compared by its cloud id), and releasing 5.0 next to 4.x.

## Try it

There's no pre-release of 5.0 on npm yet, so build it from this branch, and use it on a stage of its own. You need [Go](https://go.dev/) and [Bun](https://bun.sh/), and the app needs Node.js 22 or later:

```bash
git clone -b v5 https://github.com/sst-community/sst
cd sst
bun run setup
bun run build:cli
```

That builds `dist/sst5`, which runs next to a stable `sst`. Use it in an app in place of `sst`, on a stage of its own:

```bash
/path/to/sst/dist/sst5 migrate --check --stage v5
```

A stage deployed with SST 4 is moved with `sst migrate`: `sst deploy` and `sst dev` refuse it until then.

## Working on it

- [Writing components](platform/src/components/README.md) is the guide: parts, args and tests. [CONTRIBUTING.md](platform/src/components/CONTRIBUTING.md) beside it has the rules for changing or adding one of SST's own.
- [Write a Local Component](www/src/content/docs/docs/write-a-local-component.mdx) is the same for a component in your own app, and [Write a Package Component](www/src/content/docs/docs/write-a-package-component.mdx) for one published to npm.

```bash
cd platform
npx tsc --noEmit -p tsconfig.json   # typecheck
npx vitest run --pool=forks         # tests
```

The Go tests are `bun run test:cli`, from the repo root.

For the docs, run `bun run docs:generate` and `bun run docs:dev` from the repo root.

---

**Found a bug or have a question?** [Open an issue](https://github.com/sst-community/sst/issues) or ask on [Discord](https://discord.gg/DQWT3WGVm2). For SST itself, see [anomalyco/sst](https://github.com/anomalyco/sst).
