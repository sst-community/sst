# Plans

Where the fork's larger pieces of work are planned and tracked. `CLAUDE.md` holds how to work in the repo; what's been done, what's next and what's undecided goes here.

| File | What's in it |
| --- | --- |
| [v5-components.md](v5-components.md) | The v5 plan: the goal, the decisions it rests on, what's ported, the order from here, and the open questions. Start here. |
| [v5-progress.md](v5-progress.md) | The log: what landed on which day, in which commit, and what was learned on the way. |
| [v5-port-notes.md](v5-port-notes.md) | One section per ported component: its parts, what's plain, what changes on a switch, and what's deliberately different from version 4. |
| [v5-aws-test-2026-10-01.md](v5-aws-test-2026-10-01.md) | The first deploy of the v5 components to a real AWS account: what ran, what it found, what's still untested. |

The rules for writing a v5 component are not here. They're in [`platform/src/components/README.md`](../../platform/src/components/README.md), which ships with the CLI.

## Keeping it current

- When a piece of work lands, add it to the log and update the status in the plan. A commit hash says more than "done".
- Move a question out of "Open questions" when it's answered, and write the answer under "Decisions" with its date.
- Write dates in full (`2026-10-01`), and name things as they are now. When something is renamed, fix the older entries rather than leaving a note that they're stale.
- Nothing private goes in: no account ids, credentials, or paths on someone's machine.
