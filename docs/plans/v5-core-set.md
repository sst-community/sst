# The components this repo owns

**A draft, 2026-10-22. Nothing here is decided yet.** It's step A of [v5-community-packages.md](v5-community-packages.md): which components this repo keeps up, and which it leaves to packages.

## Why

The goal of community packages is that this repo carries less. New integrations are a small part of what it carries:

- **SST has gone quiet.** Its `dev` branch had one commit in the 90 days to 2026-10-22, the 4.17.2 release on 2026-10-08, and two pull requests were merged there since 2026-07-01. 114 are open. So this repo is where SST's components are kept up now.
- **What comes in here is mostly upkeep.** From 2026-10-03, when this repo started, to 2026-10-22, 66 issues and 105 pull requests were opened. 26 of the issues ask to carry a fix or a feature that's open in SST. About 5 issues and 7 pull requests add a component or an option that wasn't there. The rest fix `sst dev` and components that are already here, or are docs, release notes and the repo's own tooling.
- **v5 adds a second copy of each component it ports.** The 4.x components stay through 5.x, beside their ports. The 4.x AWS components are 55,414 lines in 96 files. The 21 ports so far are 13,977 more, and [v5-components.md](v5-components.md) ports "the rest" after the sites, `Vpc` and `Router`.

So what bounds the work is which components this repo owns, more than where new ones go.

## The tiers

| Tier | What this repo does |
| --- | --- |
| **Core** | Ports it to v5. Carries SST's fixes to it. Tests it in AWS. Packages can build on it, and its API is promised to them (step 2 of the plan). |
| **Kept** | Keeps the 4.x component through 5.x. Takes a fix when someone needs one, as a pull request with a test. No v5 port unless someone needs one and sends it. |
| **Community** | Keeps the 4.x component through 5.x, with fixes only for security or a deploy that breaks. A v5 version is welcome as a package. |

A component can move up when people need it. Moving one down is announced, and takes effect in a major version.

## How they were chosen

Four signals, each rough:

- **Public files:** GitHub code search for `"sst.aws.<Name>"` in TypeScript, less the files in SST's own repo. It counts files, not apps, and private apps don't show.
- **SST issues:** SST's issues with the name in the title. A common word in a name, like `Function`, `Auth` or `Router`, counts issues that aren't about the component.
- **Examples:** SST's examples that use it.
- **Here:** this repo's issues and pull requests that name it in the title.

And what depends on what: `Service` takes a `Vpc` and creates an `Alb`, a function can mount an `Efs`, and the sites and `Router` create a `Cdn`. The components already ported are kept in Core, since the port is done.

Core has 28 components and about 87% of the public files. 7 of them are left to port: `Vpc`, `Router`, `Cdn`, `Nextjs`, `StaticSite`, `Astro` and `SvelteKit`, with what the sites share (`ssr-site.ts`). Kept has 15, about 12%. Community has 4, about 1%.

| Component | Tier | Public files | SST issues | Examples | Here | Lines | V5 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `Bucket` | Core | 1,466 | 69 | 41 | 3 | 2,046 | yes |
| `Function` | Core | 1,276 | 346 | 82 | 10 | 3,300 | yes |
| `Nextjs` | Core | 1,033 | 114 | 7 | 0 | 1,052 |  |
| `ApiGatewayV2` | Core | 1,025 | 23 | 7 | 1 | 1,439 | yes |
| `Dynamo` | Core | 973 | 14 | 5 | 0 | 929 | yes |
| `Vpc` | Core | 703 | 72 | 58 | 0 | 1,641 |  |
| `StaticSite` | Core | 583 | 108 | 8 | 5 | 1,389 |  |
| `Router` | Core | 424 | 62 | 6 | 9 | 3,305 |  |
| `Service` | Core | 391 | 68 | 38 | 2 | 2,994 | yes |
| `Cluster` | Core | 385 | 40 | 41 | 0 | 584 | yes |
| `Queue` | Core | 305 | 38 | 8 | 0 | 712 | yes |
| `CognitoUserPool` | Core | 295 | 3 | 1 | 0 | 1,089 | yes |
| `Postgres` | Core | 277 | 30 | 11 | 0 | 1,074 | yes |
| `Email` | Core | 184 | 14 | 3 | 0 | 673 | yes |
| `Astro` | Core | 151 | 48 | 3 | 8 | 580 |  |
| `Task` | Core | 132 | 34 | 2 | 0 | 575 | yes |
| `Bus` | Core | 119 | 18 | 3 | 1 | 630 | yes |
| `SnsTopic` | Core | 119 | 2 | 2 | 0 | 700 | yes |
| `Redis` | Core | 110 | 11 | 15 | 2 | 1,078 | yes |
| `SvelteKit` | Core | 110 | 23 | 2 | 9 | 563 |  |
| `Efs` | Core | 93 | 13 | 3 | 0 | 410 | yes |
| `Aurora` | Core | 85 | 16 | 3 | 0 | 1,356 | yes |
| `CronV2` | Core | 43 | 3 | 2 | 0 | 555 | yes |
| `AppSync` | Core | 41 | 26 | 1 | 5 | 849 | yes |
| `Mysql` | Core | 32 | 5 | 2 | 2 | 1,050 | yes |
| `Cdn` | Core | 26 | 8 | 0 | 0 | 561 |  |
| `Dsql` | Core | 24 | 2 | 4 | 0 | 741 | yes |
| `Alb` | Core | 12 | 3 | 2 | 2 | 577 | yes |
| `StepFunctions` | Kept | 186 | 13 | 2 | 3 | 804 |  |
| `Cron` | Kept | 179 | 24 | 1 | 0 | 435 |  |
| `CognitoIdentityPool` | Kept | 176 | 1 | 1 | 0 | 433 |  |
| `Auth` | Kept | 144 | 70 | 2 | 0 | 417 |  |
| `TanStackStart` | Kept | 120 | 2 | 1 | 0 | 479 |  |
| `Remix` | Kept | 102 | 45 | 2 | 0 | 576 |  |
| `ApiGatewayWebSocket` | Kept | 93 | 9 | 1 | 2 | 894 |  |
| `Realtime` | Kept | 86 | 5 | 2 | 0 | 345 |  |
| `React` | Kept | 84 | 17 | 1 | 0 | 510 |  |
| `ApiGatewayV1` | Kept | 57 | 17 | 2 | 0 | 1,691 |  |
| `Nuxt` | Kept | 53 | 4 | 2 | 0 | 527 |  |
| `SolidStart` | Kept | 49 | 8 | 1 | 0 | 467 |  |
| `Analog` | Kept | 30 | 0 | 1 | 0 | 462 |  |
| `Workflow` | Kept | 13 | 8 | 4 | 1 | 421 |  |
| `MicroVm` | Kept | 3 | 2 | 0 | 1 | 988 |  |
| `Vector` | Community | 65 | 6 | 1 | 0 | 316 |  |
| `KinesisStream` | Community | 38 | 6 | 1 | 0 | 416 |  |
| `OpenSearch` | Community | 28 | 8 | 2 | 0 | 603 |  |
| `OpenControl` | Community | 27 | 3 | 0 | 0 | 235 |  |

| Cloudflare component | Public files | SST issues |
| --- | ---: | ---: |
| `Worker` | 636 | 23 |
| `Bucket` | 547 | 2 |
| `Astro` | 435 | 2 |
| `Kv` | 380 | 0 |
| `D1` | 85 | 4 |
| `Cron` | 45 | 1 |
| `StaticSiteV2` | 22 | 0 |
| `Queue` | 20 | 2 |
| `Hyperdrive` | 14 | 2 |
| `TanStackStart` | 11 | 1 |
| `Workflow` | 9 | 2 |
| `ReactRouter` | 8 | 1 |
| `RateLimit` | 8 | 0 |
| `Ai` | 8 | 0 |

Searched 2026-10-22. The Cloudflare components are counted as `"sst.cloudflare.<Name>"`, and their issues with "cloudflare" and the name in the title. Vercel has only `dns`.

## Cloudflare

Cloudflare's components are used a lot: `Worker`, `Bucket`, `Astro` and `Kv` each have more public files than most of the AWS components. Every test here in a real account so far has been in AWS. So the proposal is to keep them as 4.x, as Kept, until someone who uses Cloudflare looks after them, here or as packages.

## What it changes

- **The v5 ports.** After the seven left in Core, the plan stops porting. A Kept component is ported when someone needs it.
- **Carrying SST's fixes.** Core: carried when they're found, with a test. Kept: when someone asks, in an issue, with a test. Community: security, or a deploy that breaks.
- **The API promised to packages** covers the framework and the Core components (step 2).
- **New integrations** are packages ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

## Open questions

1. **The borderline ones.** `StepFunctions` (186 public files, and two requests here this week) could be Core. `CognitoIdentityPool` and `Auth` could be Core. `AppSync`, `Mysql` and `Dsql` are in Core only because they're ported.
2. **Cloudflare**, as above.
3. **The new sites.** `TanStackStart` and the other frameworks share `ssr-site.ts` with the Core sites, so a port of one is cheap once it's done. Kept, or Core once `ssr-site.ts` is ported?
