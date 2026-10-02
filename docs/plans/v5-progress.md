# v5 progress log

What landed, in which commit, and what was learned on the way. The plan is in [v5-components.md](v5-components.md); the details of each port are in [v5-port-notes.md](v5-port-notes.md).

Components are named as they are now. Until 2026-10-01 they had a `V5` suffix (`QueueV5` in `aws/queue-v5.ts`, type `sst:aws:QueueV5`), which is why older commit subjects read that way.

## 2026-09-30

### The foundation

| Commit | What |
| --- | --- |
| `8160600c1` | `bun run build:cli` on `v5` writes `dist/sst5`, labelled `sst-community-v5`, next to the stable `dist/sst` built from `main`. |
| `ac09ec21e` | Components are built from declared parts: `component()`, `this.part()`, the markers, `existing`, `nodes`, the takeover registry, deep-merging transforms, naming rules as data. |
| `3796db97e` | `Queue`, `Redis`, `SnsTopic`, `ApiGatewayV2`, `Bucket`, `CognitoUserPool` (with its client) and `AppSync`. |
| `90bf9c04d` | `Function`, the test of whether the framework holds for the hardest component. It did. |
| `7ab67749f` | The docs generator renders v5 pages: `transform`, `existing` and `nodes` from the `parts` declaration, each with the part's doc comment. |
| `29cf0d2ed` | Fork-owned files import without `.js`. |
| `321891279` | Functions inside v5 components are v5 functions, created with `functionPart()`. |
| `2bb7d3b24` | `Dynamo`. |
| `ab664bf0a` | The object form of a part's `transform` is typed the way it merges (`PartialArgs<T>`). |

Where the files are, in `platform/src/components/`:

- `component.ts`: the base class every component extends (naming, `$transform`). Close to `main`.
- `parts-component.ts`: `component()` and the `PartsComponent` class it returns, which holds all the parts logic.
- `parts.ts`: the parts types and markers.
- `transform.ts`: `transform()` (4.x, shallow) and `transformPart()` / `mergeArgs()` (deep).
- `naming-rules.ts` and `naming.ts`: the built-in naming tables as data, and what applies them.
- `args.ts`: `withDefault`, `ifSet`, `plain`, `plainDeep`, `notAnOption`, `Plain<T>`, `withoutDependencies`.
- `takeover.ts` and `aws/takeover/`: the registry, and each component's map.

### The test harness

| Commit | What |
| --- | --- |
| `98715bd69` | URNs are built from the whole chain of parents. Pulumi's mock used only the immediate parent's type, so three levels deep a nested takeover looked like it deleted the function. |
| `13163848e` | `Dynamo` is checked inside another component and with a `provider`. An unknown field type is created as binary again, as 4.x does. |
| `8729f83b6` | The takeover check compares the options that change what a deploy does: `ignoreChanges`, `protect`, `retainOnDelete`, `deleteBeforeReplace`, `replaceOnChanges`, `additionalSecretOutputs` and the provider. Before this a port that dropped `ignoreChanges: ["engineVersion"]` would have passed. |
| `33335e5b1` | `Postgres`. |

Checked in the engine's source (`step_generator.go`): a resource's duplicate aliases are deduped, an alias equal to its own URN is skipped, and an alias that matches nothing is ignored.

`v5` was pushed for the first time at `ab664bf0a`.

## 2026-10-01

### Databases, schedules and tasks

| Commit | What |
| --- | --- |
| `3dd98284b` | `aws/helpers/rds.ts`: what any RDS database needs (storage limit, replicas, proxy credentials, role and args, the stored password). |
| `d05848b71` | `Mysql`. |
| `fb6c459b5` | `Aurora`. The framework gained `lookupPart()`, to look a part up by an id the component works out. |
| `d6ba8cc68` | The harness leaves a resource's own name alone in its own inputs. It had been rewriting a renamed resource's new name to the old one everywhere, which hid a `Name` tag made from the new logical name. |
| `3d4b553b2` | `Dsql`. |
| `bcd32ab62` | Every "Switch from" section says that an object `transform` is merged deeply now. |
| `64e2aa711` | `CronV2`. `functionPart()` takes a `Workflow`. |
| `0d39b487f` | `Task`, with `aws/helpers/fargate.ts`, the v5 form of `aws/fargate.ts`. |

A review of `Aurora`, `Mysql`, `Postgres` and `Dsql` against the originals, constructor by constructor, found that what they deploy matches and found two gaps in the docs of every port:

- **An object `transform` is merged deeply in v5 and was shallow in 4.x.** `transform: { instance: { tags } }` on a database had replaced SST's lookup tags; v5 puts them back, as an in-place tag update.
- **A `$transform` for a component is matched by type.** (Since the same-type change later that day, it applies to both.)

### Six things to make components easier to create

| Commit | What |
| --- | --- |
| `ecd2ebc0f` | `pulumi.takeoverCases({ original, v5, cases })`: each case runs three ways and has to pass its options on. The check also compares what a component registers as outputs. |
| `19d022f9c` | The docs generator and the sidebar find the v5 components by file. |
| `ca44f8f30` | The generator writes the two standard notes into every "Switch from" section, and fails when a v5 page names the original outside it. |
| `9e5ac2c9f` | `named(part, "Name")`: a part whose resource keeps another logical name than its key. |
| `b0fba2c76` | The docs page "Write a Component". What it shows working is tested. |
| `5d5b22b79` | The mock is published as `platform/src/testing`: `mock()` gives an app's test the globals a config has. Verified in a real app with vitest and with `bun test`. |

What the three-way suite turned up, all fixed or documented:

- `Function` didn't register the `_live` output that 4.x writes in `sst dev`.
- Notifications of a bucket from `Bucket.get(..., { parent })` would have been deleted and recreated.
- Things 4.x created without the component's `provider` are replaced on switch when the component has one. A port can't avoid it. See Open questions in the plan.

### Names and types

| Commit | What |
| --- | --- |
| `cf55dc265` | The `V5` suffix is dropped and the components move to `aws/v5/`, exported as `sst.aws.v5`. Where a file uses both, the 4.x one is imported as `Original<Name>`. |
| `7e02f4aec` | A v5 component has the type of the one it replaces. The takeover registry is keyed by class. `cmd/sst` is identical to `main` again. |

Going back from v5 to 4.x keeps the main resource. Tried under the mock, not pinned by a test: `Dynamo` and `Bucket` change nothing, `Queue` recreates its subscriber's resources, `Function` recreates its two URL permissions.

Because `$transform` is matched by type, a v5-only option set by a transform is silently ignored by a 4.x component. So the v5 `Function` takes the 4.x forms of four options itself (`live`, `role`, `logging.logGroup`, `url.route`); the v5 form wins when both are given.

`v5` was pushed at `7e02f4aec`.

### Containers

| Commit | What |
| --- | --- |
| `2b9e3f550` | `Service`. `plainDeep()` is new in `args.ts`. |
| `748e8c45a` | `Cluster`. No takeover map: nothing moved. |
| `6d50d9f03` | `Efs`. |
| `42d56d528` | `Alb`, with `aws/helpers/load-balancer-args.ts`, shared with the `Service`'s own load balancer. |
| `7261c8813` | `networkOf(cluster)` in `helpers/fargate.ts`: one place that reads a cluster's VPC, for `Task` and `Service`. |

A review pass over the four found no deployed difference.

### Shared types, examples, teardown order

| Commit | What |
| --- | --- |
| `3862786d7` | The docs generator reads `aws/helpers/*.ts`, so args several components take are declared once: `FargateArgs` and `ContainerArgs`, `ProxyArgs`. `aws/helpers/vpc.ts` has `AnyVpc`, `isVpc()` and `TakesVpc<>`. Inherited examples are rewritten to v5 names on v5 pages, which let `Queue` drop its re-declared `dlq`. |
| `05ebaa330` | The root `README.md` is rewritten for v5. |
| `64e9108ef` | The takeover check reports `unordered`: each dependency the original has must still be reachable. `needlessOrder` names the ones nothing needs; `pulumi.dependsOn()` is for behaviour tests. |

Teardown order came from upstream issues where `sst remove` fails because AWS won't delete what's still in use:

- anomalyco/sst#6934 (open): the certificate of an `Alb` or `Service`, because the load balancer that holds it has no dependency on it. v5 `Alb` and `Service` now make the load balancer depend on the certificate.
- Older and fixed upstream: #5678 / #5780 / #5931 (Cloud Map service and namespace), #5586 (authorizer and route), #4026 (Postgres subnet group). All hold in v5.

The check caught one regression: the v5 `Service` created its Cloud Map service inside `.apply()` with the plain namespace id, for a VPC given by its ids, so it no longer waited for the namespace. No takeover case had the namespace in the app. Fixed, with a case that has it.

`v5` was pushed at `64e9108ef`. `main` has since been merged in; `origin/v5` is at `a075e1bdb`.

### The first real AWS deploy

See [the report](v5-aws-test-2026-10-01.md). It found three bugs that every test under the mock had passed, and one that isn't v5's. The fixes are not committed yet:

| File | What |
| --- | --- |
| `platform/package.json` | `sideEffects` lists `aws/takeover/*.ts`. The bundler was dropping every takeover map from a real build. |
| `aws/v5/function.ts`, `args.ts` | A function's links are read with `all()`, and its build result is passed through the new `withoutDependencies()`. |
| `testing/mock.ts` | The mock records what each function is built from, and the takeover check compares it. |
| `test/components/v5-components.test.ts` | Bundles the components the way the CLI does and checks every takeover map is in the output. |

The root `README.md` also gained "Your own components, from any provider", with an example that's pinned by a test (`component.test.ts`, "the component in the README").

## What the harness can and can't see

It records what's registered with the engine and compares, between a 4.x component and its v5 port: each resource's address (through aliases, as Pulumi resolves them), inputs, deploy options, registered outputs, what a function is built from, and what depends on what.

Things worth knowing when a test surprises you:

- A takeover test also passes when both sides fail the same way and create nothing. Assert on what's created.
- Mock ids and ARNs are made from resource names, so the check rewrites new names to old ones before comparing. A renamed function's code key looks unchanged for that reason; in AWS the code is uploaded again under the new name.
- `useProvider()` registers its provider once per process, so only the first test has it in the graph.
- A mocked Lambda function needs `qualifiedArn`, `invokeArn`, `qualifiedInvokeArn` and `responseStreamingInvokeArn` in `state` when the function publishes versions.
- A secret spreads. The built image's reference is a secret, and reading the volumes from the same output made a task definition's `volumes` a secret. Keep what's read next to a secret in its own output.
- A getter typed `Output<UnwrappedArray<string>>` renders as `string` in the docs. Give it an explicit `Output<string[]>`.
- It never bundles a config, builds a function, or calls AWS. For that, deploy.
