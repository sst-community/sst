# Contributing to sst-community

sst-community is a community-maintained fork of [SST](https://github.com/anomalyco/sst). It follows SST's releases and carries fixes that haven't landed upstream yet. Bug fixes, docs and help with issues are all welcome.

## Before you start

- **A bug:** open an [issue](https://github.com/sst-community/sst/issues), or pick one that's open. If the bug is in SST itself, link the upstream issue or pull request when there is one.
- **A larger change:** talk it through first, in an issue or on [Discord](https://discord.gg/DQWT3WGVm2), so the work isn't wasted.
- **A question:** ask on Discord.
- **A vote:** add a 👍 to an issue you want fixed. The [open issues, most-wanted first](https://github.com/sst-community/sst/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc) are a good place to pick up work. Votes show what's wanted, and maintainers decide what's done and in what order.

## Set up

You need [Go](https://go.dev/) and [Bun](https://bun.sh/).

```bash
bun run setup
```

Run the CLI from source in one of the `examples/` apps:

```bash
cd examples/aws-api
go run ../../cmd/sst <command>
```

For the docs site, run `bun run docs:generate` and then `bun run docs:dev`.

## Before you open a pull request

Run the type check and the Go tests:

```bash
bun run typecheck
bun run test:cli
```

If the change affects what gets deployed or how `sst dev` behaves, try it on an example app and say what you ran in the pull request.

## Pull requests

- Fork the repo and branch from `main`, which is the 4.x line. A rewrite of the components is in progress on the `v5` branch; ask on Discord before working on it.
- Keep one change to a pull request.
- Title it the way commits here are titled: the area, a colon, then what the change does. For example, `Function: retain the shared dev bridge code object on delete`.
- The `check` workflow has to pass. On your first pull request, a maintainer approves the run before it starts.
- An automatic review runs first, within a few minutes and again after each push or edit to the title or description. It posts one comment with a risk label, a few checks (the title format above, no edits to generated docs, no version changes, and a line in the description saying how you tested a change to the code) and a review by an AI model, which also labels the change `semver: patch`, `semver: minor` or `semver: major` and drafts its line for the release notes. Fix what it asks for, or reply if you disagree: it can be wrong. A committer reviews after that.
- `main` doesn't take breaking changes for now: removing or renaming an arg, output, component or CLI flag, changing a default, or replacing a user's existing resources when they update. Ask on Discord first if your change needs one.
- If your change raises a minimum requirement, such as a newer Node.js or framework version, or a new permission for the deploy role, say so in the description. It's released as a minor and listed first in the release notes, under Breaking changes.
- A committer or maintainer other than the author has to approve it. Anyone can review, and reviews from anyone are welcome, but only theirs count toward merging. If you push again after the approval, it needs approving again. A releaser can merge their own pull request without one.
- Pull requests are squash-merged, so the title becomes the commit.
- A change to how the fork is built, released or installed needs a review from a code owner. `.github/CODEOWNERS` lists those files.

## What to leave alone

- **Generated docs.** The component and CLI reference pages are generated from the doc comments in `platform/src` and `cmd/sst`. Change the comment, not the page.
- **Versions and tags.** Maintainers tag releases. A pull request doesn't need to change a version.
