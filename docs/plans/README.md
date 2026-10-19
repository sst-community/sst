# Plans

Where the fork's larger pieces of work are planned and tracked. `CLAUDE.md` holds how to work in the repo; what's been done, what's next and what's undecided goes here.

| File | What's in it |
| --- | --- |
| [v5-goals.md](v5-goals.md) | What v5 holds to: six goals, how each is checked, and where each stands. Every change on `v5` is held to them. |
| [v5-components.md](v5-components.md) | The v5 plan: the goal, the decisions it rests on, what's ported, the order from here, and the open questions. Start here. |
| [v5-progress.md](v5-progress.md) | The log: what landed on which day, in which commit, and what was learned on the way. |
| [v5-port-notes.md](v5-port-notes.md) | One section per ported component: its parts, what's plain, what changes on a switch, and what's deliberately different from version 4. |
| [v5-aws-test-2026-10-01.md](v5-aws-test-2026-10-01.md) | The first deploy of the v5 components to a real AWS account: what ran, what it found, what's still untested. |
| [v5-sharing.md](v5-sharing.md) | Sharing components as npm packages: the design, what's been checked, what it takes, and the open questions. |
| [v5-sharing-host.md](v5-sharing-host.md) | How sharing was finished, step by step: SST keeps the runtime, a package builds against the `sst` npm package, and an app without a `package.json` can use one. |
| [v5-providers-in-package-json.md](v5-providers-in-package-json.md) | Installing the providers in the app's `package.json`. Tried, and not taken. |
| [policies-experiment.md](policies-experiment.md) | Policies made easier to use: rules in the config, exceptions, tests under `mock()`, and a CDK-NAG style rules package. Tried, not acted on. Also four policy bugs in SST today. |

The rules for writing a v5 component are not here. They're in [`platform/src/components/README.md`](../../platform/src/components/README.md), which ships with the CLI.

## Keeping it current

- When a piece of work lands, add it to the log and update the status in the plan. A commit hash says more than "done".
- Move a question out of "Open questions" when it's answered, and write the answer under "Decisions" with its date.
- Write dates in full (`2026-10-01`), and name things as they are now. When something is renamed, fix the older entries rather than leaving a note that they're stale.
- Nothing private goes in: no account ids, credentials, or paths on someone's machine.
