# v5 goals

What v5 holds to, from the first pre-release to 5.0.0 and after. Every change on `v5` is held to them: a port, a fix, a merge from `main`, a release. Set on 2026-10-16.

1. **A switch leaves the state as it was, or close to it.**
2. **Moving to v5 never loses data.**
3. **Anyone can write a component, and share it as a package.**
4. **Installing v5 changes nothing until you switch a component.**
5. **Every resource a component creates is yours to change.**
6. **`sst diff` shows what the deploy will do.**

Each goal below says what it means, how it's checked, and where it stands. Update "Where it stands" when that changes, with the date. Change a goal itself only on purpose, and record it under [Changes to the goals](#changes-to-the-goals).

## 1. A switch leaves the state as it was, or close to it

Changing `sst.aws.X` to `sst.aws.v5.X`, with the same name, keeps every resource where it is in the state, with the same inputs. What a switch may change is short, and each item is written down: in the component's "Switch from" section, and in "What a switch can replace" in [Migrate From v4](../../www/src/content/docs/docs/migrate-from-v4.mdx). Most switches change only this:

- 4.x's wrapper components leave the state. Nothing in AWS is behind them.
- A part with a new name keeps its resource through an alias.
- A function whose part has a new name uploads its code again, and is updated in place.

The rest of that list only happens when a component is given a `provider`, or uses a resource looked up with `get`, or has a subscriber without a name.

**How it's checked:**

- **Each port's takeover suite** (`pulumi.takeoverCases()`, in the [rulebook](../../platform/src/components/README.md)) deploys the 4.x component, then the V5 one. It's run three ways: as it is, inside another component, and with a `provider`. Every resource has to be kept with the same inputs and options. The registered outputs, what a function is built from and the teardown order have to match too. What goes (`unclaimed`) or is updated (`changed`) is listed in the case, and a list isn't loosened to make a test pass.
- **In AWS:** deploy with 4.x, switch, export the state before and after, and compare them by resource id.

**Where it stands (2026-10-16):**

- 21 components are ported, each with its takeover suite. 1,712 tests pass (2026-10-18).
- In AWS on 2026-10-01, 19 components were deployed with 4.x and switched. Every AWS resource kept its id. Only the code of eleven renamed functions was uploaded again ([the report](v5-aws-test-2026-10-01.md)).
- In AWS on 2026-10-13, 62 of 65 resources kept their ids. Two subscribers' code was uploaded again, and a default bus 4.x had looked up left the state.

## 2. Moving to v5 never loses data

No switch replaces or deletes a resource that holds data, or changes one so that data is lost. Those are:

- S3 buckets and DynamoDB tables;
- RDS, Aurora and DSQL databases, and ElastiCache caches;
- EFS file systems, Cognito user pools and SQS queues;
- log groups;
- the secrets and generated passwords a database or a cache uses.

This is about moving to v5. Going back to 4.x isn't a goal (see [Not goals](#not-goals)).

**How it's checked:**

- **In the takeover suites,** a resource that holds data is never in `unclaimed`, and never in `changed` for a field that replaces it. A test that asserts it's kept is better still, as `redis.test.ts` does for the cache's secret.
- **In "What a switch can replace",** nothing listed holds data. A port that would add such a resource to that list has to be designed again.
- **In AWS:** write data before the switch and read it after.

**Where it stands (2026-10-16):**

- What a switch can replace is function code, a durable function's URL, `AppSync`'s Lambda data sources and domain association, subscribers, a bucket's notifications, and a user pool's clients, which get new IDs. None of it holds data.
- In AWS on 2026-10-01, every database, file system, bucket, table and user pool kept its id, and a file on EFS kept its contents. Data in a database or a bucket wasn't read back after the switch.
- Not checked yet: `get` and `existing` against real resources, and a custom `provider`, in AWS.

## 3. Anyone can write a component, and share it as a package

`sst.component()` is what SST's own components are built with, and it's there for every app. A part can be a resource from any provider the app uses. A component the app writes gets what SST's get: `transform`, `existing`, `nodes` and linking. It can be tested without AWS with `mock()`. It can live in the app, or be published as a package for others to install. [Write a Local Component](../../www/src/content/docs/docs/write-a-local-component.mdx) and [Write a Package Component](../../www/src/content/docs/docs/write-a-package-component.mdx) show how.

**How it's checked:**

- **The local page's example** is tested in `component.test.ts`, under "the component in the docs".
- **A package's types:** `declarations.test.ts` compiles a package's `.d.ts`.
- **A package's install and check** are covered by the Go tests in `pkg/project`.
- **In AWS:** an app that uses a package deploys, and runs in `sst dev`.

**Where it stands (2026-10-16):**

- On `v5` since 2026-10-12, and out since `5.0.0-alpha.1`. See [v5-sharing.md](v5-sharing.md) and [v5-sharing-host.md](v5-sharing-host.md).
- A package was deployed to AWS and run in `sst dev`. npm, pnpm and bun apps have each deployed one, and an app without a `package.json` used one from its config.
- Not done yet: Yarn and Windows, a review of `sst/components` as a public API, and a template package.

## 4. Installing v5 changes nothing until you switch a component

An app on the latest 4.x that installs v5 gets the same deploy. The 4.x components, `sst.aws.*`, create the same resources with the same inputs. `sst.config.ts` doesn't have to change, apart from a `version` rule that leaves out 5.x and three rare cases, which "Before you install" in the guide lists. From there, components are switched one at a time, and 4.x and v5 components work in the same app.

**How it's checked:**

- **A 4.x component file on `v5`** is edited only where an app that uses it wouldn't notice: its config reads the same and its state doesn't change. That's a rule in the rulebook. `git diff --stat main -- platform/src cmd/sst` lists what differs from `main`, and each difference has to meet it.
- **In AWS:** deploy an app with the latest 4.x, then run `sst5 diff`. It shows no changes.

**Where it stands (2026-10-16):**

- On 2026-10-13, an app in daily use, deployed with v4.15.2, was run with `sst5`. More than 530 resources weren't touched. What changed is what changes between those CLI versions: the providers, the code `sst dev` runs, and a layer, through a change on `main` since v4.15.2 (`v5-progress.md`).
- Not checked yet against the latest 4.x. That's the check to run before each pre-release.

## 5. Every resource a component creates is yours to change

A V5 component declares every resource it creates as a part. From that list it offers `transform`, `existing` and `nodes` for each of them, the same way in every component, typed and documented from the same list. It creates nothing outside the list.

**How it's checked:**

- **A part is the only way a V5 component creates a resource.** A resource created outside its list is refused.
- **`v5-components.test.ts`** checks every file in `aws/v5/`.
- **The docs generator** writes the `transform`, `existing` and `nodes` docs from each part's comment.

**Where it stands (2026-10-16):**

- It holds for the 21 ports (2026-10-18).
- Not ported yet: the sites, `Vpc`, `Router`, `Cdn`, `MicroVm`, the Cloudflare and Vercel components, and others. See the [plan](v5-components.md#status).
- `existing` hasn't been tried against real resources.

## 6. `sst diff` shows what the deploy will do

Before a switch, or any deploy, `sst diff` shows what the deploy will change. Nothing it shows doesn't happen, and nothing happens that it didn't show. It's how a user checks goals 1 and 2 for their own app.

**How it's checked:**

- **In AWS:** the diff before each deploy is compared with what the deploy did, and a second diff after it shows no changes.

**Where it stands (2026-10-16):**

- Fixed on 2026-10-14 (`2a5b579ec`): a V5 component's function was shown as deleted when its args held a value that's only known on deploy.
- **Known, not met:** a 4.x component's function can show as deleted, when the deploy then updates it. 4.x's `functionBuilder` creates the function inside an `apply`, as in SST, and a preview skips it. It was seen on 2026-10-13. A fix changes only the preview, so it can go in the 4.x file, and on `main` too.

## Not goals

- **Going back to 4.x** (decided 2026-10-16). It's best effort and documented: "Going back" in the guide says what to check. A V5 component keeps some resources under new names, which the 4.x one doesn't know, so it would create them again. It hasn't been tried in AWS.

## Where they're used

- **Porting a component:** the rulebook's ground rules and checklist point here.
- **A pre-release:** before tagging, update "Where it stands". Any goal the release doesn't meet is named under Known issues in its notes. See "Pre-releases of v5" in `MAINTAINING.md`.
- **The README** lists them, linking here.

## Changes to the goals

| Date | Change |
| --- | --- |
| 2026-10-16 | Set: goals 1 to 6. Going back to 4.x isn't a goal. |
