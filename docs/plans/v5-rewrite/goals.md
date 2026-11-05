# What 5.0 holds to

The goals of the 5.0 rewrite ([the plan](plan.md)). Every change on `v5-rewrite` is held to them: a component, a change to the core, a release. Set on 2026-10-31.

The maintainer's one hard rule for the rewrite: "as long as the state file works the same way, at the end of the day that's really the most important because it dictates what's created and removed." Goals 1 to 6 are what that means. Goals 7 and 8 are for the people who write and use code on 5.0.

1. **Every resource keeps its identity.**
2. **Moving never loses data.**
3. **What moves is mapped.**
4. **The home stays compatible.**
5. **Deployed code keeps working.**
6. **`sst diff` shows what the deploy will do.**
7. **Every breaking change has a way across.**
8. **What a package builds on holds still within 5.x.**

Each goal below says what it means, how it's checked, and where it stands. Update "Where it stands" when that changes, with the date. Change a goal itself only on purpose, and record it under [Changes to the goals](#changes-to-the-goals).

## 1. Every resource keeps its identity

Pulumi decides creates and deletes by each resource's URN: its type, its name and the chain of parents above it. When an app moves to 5.0, or a component changes in a 5.x release, every resource in the cloud keeps its id, and its inputs change only in place.

A breaking change may replace a resource that holds no data, only when the component's state map lists the replace and the migration guide says what changes for the user, such as a new URL.

**How it's checked:**

- `sst migrate --check` fails on any replace the map doesn't list, but a file uploaded again because it changed, under a key that follows from what's in it, as any deploy uploads a function's new code.
- In the lab, after a real deploy, the states before and after are compared by type and cloud id. The lab's `compare-state.py` does this today, and is brought into the CLI.

**Where it stands (2026-11-01):** `sst migrate --check` fails on a replace the map doesn't list, and on any replace of what holds data. v5's takeover maps kept every resource's id in AWS on 2026-10-01, 73 of them under new names ([the report](../v5-aws-test-2026-10-01.md)). The comparison by cloud id isn't in the CLI yet.

## 2. Moving never loses data

No move, and no later change to a component, deletes or replaces a resource that holds data, or changes one so that data is lost. Those are:

- S3 buckets and DynamoDB tables;
- RDS, Aurora and DSQL databases, and ElastiCache caches;
- EFS file systems, Cognito user pools and SQS queues;
- log groups;
- the secrets and generated passwords a database or a cache uses;
- the table a `Vector` creates in its database.

That's [v5's goal 2](../v5-goals.md#2-moving-to-v5-never-loses-data), with the `Vector` table added. The list `--check` holds to is `pkg/move/data.go`.

**How it's checked:**

- `--check` fails when one of those is deleted, replaced, or changed in a field that replaces or empties it, whatever the state map says. A `Vector`'s `dimension` is such a field: in 4.x, changing it drops the table and creates it again (`VectorTable.Update`).
- A takeover suite never lists one of them as going, and asserts it's kept where a component could lose it.
- In the lab, data is written before the move and read after.

**Where it stands (2026-11-01):** `sst migrate --check` fails on a delete or replace of what holds data, whatever the map says, judged by what a resource is and what it was; on a release of one that what takes its place doesn't adopt by its id; and on an update that empties one (a `Vector`'s `dimension`), shortens how long it keeps what it holds (retention), or changes what expires (a TTL, a bucket's lifecycle rules). Not yet: the takeover suites' assertion, and data written and read in the lab.

## 3. What moves is mapped

A resource whose URN changes, because a component was restructured, is carried from its old address to its new one by the component's state map, not deleted and created again. Anything that leaves the state either has nothing in the cloud behind it (a component, a wrapper, a `DevCommand`), or is released: taken out of the state without its delete being called, and written again or adopted by the new resource.

**How it's checked:**

- `--check` fails on any create or delete of something in the cloud that the map doesn't list, and on any such delete it doesn't release. A component, a wrapper or a provider has nothing in the cloud behind it, and needs no listing.
- Each component's map runs against every recorded state it's in, in CI, with no AWS.
- In the lab, a real deploy compared by cloud id (goal 1). For a released resource, what it held is checked after the move: the same files, the same routes, the same rows.

**Where it stands (2026-11-01):** `sst migrate --check` does the first, from Pulumi's preview of the move and what each component reports about its parts. On a Floci stage, it passed a move from the 4.x `Bucket`, `Dynamo`, `Queue` and `Function` to the V5 ones, a deploy then kept every id it said it would, and it failed a move with the table renamed. The second runs for every recording but the sites (`test/components/v5/recorded.test.ts`): the serverless group, deployed and in `sst dev`, and the containers and databases in a VPC, with the V5 `Vpc` since it was ported. The mock replays the state, 4.x gives what it has, and V5 takes it over. The third, for the `Vpc`: with an EC2 NAT and with a managed one, `--check` passed and a deploy kept every resource by id. Not yet: the sites, which have no V5 form, and the lab for the other components.

## 4. The home stays compatible

5.0 reads and locks state the old CLI wrote: the same bootstrap, the same keys, the same passphrase and the same secrets encryption ([today's home](reference.md#todays-home)). Until a stage moves, it takes the same lock, so 4.x and 5.0 refuse each other. It writes the lock with a conditional put where the store has one (S3 does), so two 5.0 CLIs can't both take it; between 4.x and 5.0 the race stays what it is today, a read then a write. After a move, a tombstone at the old lock key keeps 4.x CLIs off the stage.

A home that finds no state for a stage that was deployed refuses to deploy. The newest update that finished without errors says whether it was: a deploy says it is, a remove says it isn't, and with no such update, a snapshot says it is. A passphrase doesn't: `sst diff` in 4.x and `sst secret set` create one before a first deploy. This catches a home that reads the state from the wrong key; it can't catch one pointed at another account or region, where the history is missing too. Otherwise a home that read the wrong place would create everything again, then write over the real checkpoint.

**How it's checked** (step 2, and step 5 for the tombstone):

- During a deploy by 5.0, a 4.x deploy of the same stage is refused, and the other way round. Two 5.0 CLIs started at the same moment: one gets the lock.
- No second passphrase is created.
- After a deploy, the home holds only the kinds of objects a 4.x deploy writes.
- A home pointed at the wrong place, for a stage with history, refuses to deploy.
- After a move, a 4.x CLI is refused.

**Where it stands (2026-10-31):** checked for the new core in step 2, not committed. In the lab: 4.x and the new core refuse each other's deploys both ways, and two new cores racing for the lock in a real bucket leave one winner. No second passphrase was made, and the home holds only what 4.x writes. With the state hidden, a deploy is refused and nothing is created. Left: the tombstone (step 5).

## 5. Deployed code keeps working

A deployed function reads its links from the encrypted file (`SST_KEY`, `SST_KEY_FILE`), and a process on the developer's machine from `SST_RESOURCE_<Name>`. SST's JavaScript, Python, Go and Rust SDKs all read both ([linking today](reference.md#linking-today)). 5.0 writes those shapes, as one documented format ([Linking](plan.md#linking)), so a function and the SDK it uses keep working through a move.

**How it's checked:**

- A change to what a function reads is an in-place update, which `--check` lists.
- In the lab, a function in each runtime reads its links after the move.

**Where it stands (2026-10-31):** not started.

## 6. `sst diff` shows what the deploy will do

Nothing it shows doesn't happen, and nothing happens that it didn't show. `--check` and step 2's zero diff are previews, so they're only as good as this. It's [v5's goal 6](../v5-goals.md#6-sst-diff-shows-what-the-deploy-will-do).

**How it's checked:**

- In the lab, the diff before each deploy is compared with what the deploy did, and a second diff after it shows no changes.
- A 5.0 component never creates a resource inside an `apply` the preview skips. That's what makes a 4.x function show as deleted (v5 goal 6, unmet for 4.x), so step 2's test copy of the 4.x components gets the preview fix. Each component's test checks that a preview where nothing is known yet registers the same resources as a deploy.

**Where it stands (2026-10-31):** for the new core in step 2, its `sst diff` lists the same changes as 4.x's on every recorded stage. Three things in 4.x don't settle: the server-rendered sites, which build again on every diff, the `Vpc`'s bastion, whose AMI lookup can return any of three images, and, in a preview, a 4.x function whose args aren't known yet, which the test copy's preview fix covers.

## 7. Every breaking change has a way across

Breaking changes are allowed in 5.0: args, defaults, names, how a component is built ([Breaking changes](plan.md#breaking-changes)). Each one has a codemod rule where it's mechanical, and a line in the migration guide where it isn't. None of them may break goals 1 to 6.

**How it's checked:**

- The codemod moves the 196 examples and each recorded app, with only what the guide lists left to do by hand.
- Each breaking change is in the plan's [breaking changes so far](plan.md#breaking-changes-so-far), with its rule or its line in the guide.

**Where it stands (2026-11-02):** every breaking change of the components built the 5.0 way so far is in the plan's table, with its way across. The codemod and the guide aren't started.

## 8. What a package builds on holds still within 5.x

`sst/components` and its groups (`sst/components/aws` and the rest), `sst/testing`, the program contract, and `sst.target`, `sst.runtime` and `sst.check` change only in a major version (`sst/testing` added 2026-11-05: packages test with it). Adding to them is fine. Removing an export, or changing what one accepts, waits for a major. So 5.0's breaking changes happen once, at 5.0 ([Packages](plan.md#packages)).

**How it's checked:**

- A report of the API for each entry point, made with [API Extractor](https://api-extractor.com/), is checked in. A pull request shows each change to it, and CI fails on one nobody meant.
- The template package builds and tests against the branch in CI.

**Where it stands (2026-11-05):** the reports are made, one for each of the five entry points, in `platform/api/`, and `check.yml` fails on a change they don't have (`bun run api` in `platform/`). They show each component's parts and the types a package can't import too, so a change to those shows. The template package builds and tests against the branch in `check.yml`. Both wait on CI's first run on this branch.

## Not goals

- **Going back to 4.x after a move.** Best effort, as for v5 ([v5-goals.md](../v5-goals.md#not-goals)).
- **Containing a package.** Packages are trusted like any other dependency. The plan's [safety rules](plan.md#safety-rules) hold for every app; a package runs with the deploy's credentials.

## Where they're used

- **Each step's exit test** in the plan checks the goals it touches.
- **A release:** before tagging, update "Where it stands". A goal the release doesn't meet is named under Known issues in its notes.

## Changes to the goals

| Date | Change |
| --- | --- |
| 2026-10-31 | Set: goals 1 to 8. |
| 2026-10-31 | Goal 4: what says a stage was deployed is a snapshot or an update that deployed, not a passphrase, which a diff or a secret can create first. |
| 2026-11-01 | Goal 3: a component, a wrapper or a provider, with nothing in the cloud behind it, needs no listing in a map to leave the state or be created. The goal already said such a thing may leave. |
| 2026-11-02 | Goal 7: each breaking change is checked against the plan's table of breaking changes, which has each one's way across, in place of the Decisions table, which keeps the decisions behind them. The maintainer asked for the table. |
