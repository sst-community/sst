# Community packages

Planned 2026-10-22, on the branch `v5-community-packages`, from `v5`.

## Goal

An integration with another service or provider can live in a package of its own, written and released by whoever needs it, instead of in this repo. The core keeps SST's own components and the CLI, and fixes to them.

[Sharing components as packages](v5-sharing.md) already makes that work: a package builds on `sst/components`, an app installs it, and the deploy checks what it needs. This plan is what's missing before people can be told to send an integration as a package: something to start from, an API that holds still, a place to find packages, and runtimes.

## Why

SST had 114 open pull requests on 2026-10-22. About 57 change components, 49 of them AWS ones, and most of those fix a component that's already there. 46 change the CLI. About 12 add something new: a component (`Script`, serverless Redis, `Bastion`, `Image`, `Group`, a Lambda rollout, a custom auth site), a home (GCP), a runtime (Ruby #6630, .NET #6997) or an SDK (PHP #6187). SST's own plugin system (#5825, opened 2025-05-22) moves its AWS, Cloudflare and base components into packages of their own. Its last commit is from 2025-09-15.

So packages take new integrations out of the core. Fixes to the components everyone uses stay in it either way.

## Steps

### 0. The v5 docs on the site (waits for 5.0)

The docs site is built from `main` only, so "Write a Package Component" and the other v5 pages aren't on it. GitHub Pages publishes one build for the whole site, so a deploy from `v5` would replace the 4.x docs. Until 5.0 is released, link to a page's source on GitHub. Serving both, with `v5`'s under a path of its own, takes one build that puts out both branches. Not before 5.0.

### 1. A template package

`examples/component-package/`: a package to copy, with what "Write a Package Component" says, working.

- `package.json` with the peer, dev and runtime dependencies, the `google-protobuf` override, and the `sst-component` keyword (step 3).
- The guide's `tsconfig.json`, split in two so the tests are type-checked too.
- One component with a provider's resource and one of SST's V5 components as parts, a handler the package ships, and `link()`.
- Tests with `mock()` from `sst/testing`.
- A README: how to make it your own, test it, publish it and use it in an app.

It's not in `packages/`, which the release publishes. `www/generate.ts` reads only `examples/*/sst.config.ts`, so a folder without one isn't on the examples page.

`check.yml` runs on pushes and pull requests to `v5`. A step there packs `sst` from the branch, installs it in the template, and runs its build and tests, so a change to the platform that breaks a package fails there.

A GitHub template repo can come later. It's a new public repo, so it's decided separately.

**Built 2026-10-22,** on `v5-community-packages`. The component is `Webhook`: an `aws.sqs.Queue` and a `v5.Function` with a URL, running a handler the package ships, which puts each delivery on the queue. Linking it gives a function the URL and the queue, and permission to read it. `tsconfig.json` type-checks `src` and `test`, and `tsconfig.build.json` compiles `src`. "Write a Package Component" links to it.

Checked:

- `npm test` (type check, build, three tests) passes with `sst` from npm (`5.0.0-alpha.2`), and with `sst` packed from the branch, installed the way the CI step installs it.
- The `.d.ts` it emits names only `sst/components`, `sst/components/aws` and Pulumi. `npm pack` has `dist` and `package.json`.
- With `permission` taken out of the packed `sst/components/aws`, the type check fails, as the CI step should.
- One copy of `@pulumi/pulumi` is installed. `bun ./generate.ts examples` changes no page.

Found while building it:

- **TypeScript 7 can't be installed with Pulumi.** `@pulumi/pulumi`, 3.267.0 and the newest, 3.271.0, accepts TypeScript below 7, and npm stops an install that asks for 7. Without a version, npm picks 6. The template and the guide's install line ask for `^6`.
- **A function's build isn't on `app.resources`.** `RecordedResource` documents `build`, but only `app.graph()` has it. The template's tests read it there. The comment in `platform/src/testing/mock.ts` should say so, or `resources` should have it too.
- **`mock()` gives a function URL no address,** so a component whose `link()` reads one fails when it's linked. The template's test gives one with `state`. The mock could give `functionUrl`, as it gives every resource a `url`.

### 2. `sst/components` as a stable API

The rulebook already says it's a public API: adding is fine, and removing an export or changing what one accepts waits for a major version. Nothing checks that yet, and some of what it exports isn't meant for packages.

- **Decide what's public.** `core.ts` exports `takeover`, which is for porting 4.x components. It also exports the experimental `x`, the deprecated `linkable` and `V5Args`. Each group exports every component of its provider, the 4.x and V5 ones, with their args.
- **Leave `@internal` out of the types.** The core's files have 13, and `tsconfig.types.json` doesn't set `stripInternal`, so they're in the `.d.ts` a package reads. `declarations.test.ts` shows where a public type relies on one.
- **A check of the API.** The `.d.ts` of `sst/components` and of each group, checked in. A test fails when what's built differs, so every change to the API shows in a pull request.
- **Write down the promise** in `MAINTAINING.md`: within 5.x the API only changes in ways that don't break a package. A pre-release can still break it, and its notes say so.
- **Settle the import name** before 5.0 (an open question in [v5-sharing.md](v5-sharing.md)).

Before 5.0, and before many packages build on it.

### 3. Finding packages

- **A docs page that lists them,** from a data file in `www`: the package, its providers, what it does, its repo, and who wrote it. A package is added by a pull request, and the review checks it installs and has a peer dependency on `sst`. It's a list, not an endorsement. It's published with the v5 docs (step 0).
- **The `sst-component` keyword** on npm, which the template sets, so `npm search sst-component` finds them too.
- **The rule, in `CONTRIBUTING.md`:** a new integration goes in a package, and a fix to a component that's already here goes in the core.

### 4. Runtimes in packages

A runtime is Go code in the CLI: `pkg/runtime/{node,python,golang,rust,worker}`, listed in `pkg/project/project.go`. SST's Ruby and .NET pull requests each add one there and change `function.ts`. A package can't add one.

In `sst dev`, each of them starts a process with `AWS_LAMBDA_RUNTIME_API` pointing at the CLI. Ruby, .NET, Java and PHP each have a client that speaks that API. So one runtime in the CLI could run any of them:

- a function gives a build command, the folder it writes, and a command for `sst dev`
- a deploy runs the build and zips the folder
- `sst dev` runs the command against the CLI's API, and runs the build again when a file changes

A package then has a component, like a `RubyFunction`, that fills those in.

Open: which files a rebuild watches, whether the build can run in a container, and whether it's an arg of the V5 `Function` or a component of its own. It needs its own plan, and a function in each of two languages deployed and run in `sst dev`.

## Order

1, then 3 (the page waits for step 0, the rest doesn't), then 2 before 5.0. 4 has its own plan. 0 waits for the release.

## Status

| Step | Status |
| --- | --- |
| 0. The v5 docs on the site | Waits for 5.0 |
| 1. A template package | Built 2026-10-22 (`6ce09bd6d`), not merged. Not deployed to AWS. |
| 2. A stable API | Not started |
| 3. Finding packages | The rule in `CONTRIBUTING.md` (2026-10-22), and the keyword in the template. The page waits for step 0. |
| 4. Runtimes in packages | Not started |
