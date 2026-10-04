# Maintaining sst-community

This is for maintainers and the agents working with them: how SST's releases are merged, how the fork is versioned and released, how the docs site is published, and who can merge. [CONTRIBUTING.md](CONTRIBUTING.md) is the guide for sending a change.

## Branches

- **`main`** is the 4.x line: an SST release plus the fork's commits. It is shared history. Merge SST into it. Never rebase it or force-push it.
- **`v5`** is the fork's own major version, a rewrite of the components. It releases as 5.x and doesn't follow SST's numbering. Its plans and progress are in `docs/plans/` on that branch. Don't tag a 5.x release yet: `release.yml` publishes any `vX.Y.Z` tag, from any branch, to npm as `latest`.

`git log upstream/v<the SST release main is on>..main --first-parent` lists every commit the fork adds.

## Your clone

SST's repo is the `upstream` remote. Its tags are fetched under `upstream/`, because plain `v*` tags are the fork's own releases:

```bash
git remote add upstream https://github.com/anomalyco/sst.git
git remote set-url --push upstream DISABLED-do-not-push-to-upstream
git config remote.upstream.tagOpt --no-tags
git config --add remote.upstream.fetch '+refs/tags/*:refs/tags/upstream/*'
git fetch upstream
```

Never run `git push --tags` or `git push --mirror`. A pushed `vX.Y.Z` tag is a release.

## Merging an SST release

`.github/workflows/upstream.yml` runs every Monday. When SST's newest release isn't merged into `main`, it opens an issue titled "Upstream release vX.Y.Z" with the releases and commits involved, the files that conflict, the next free fork version, and the commands. Closing the issue skips that release. To run it by hand:

```bash
gh workflow run upstream.yml --repo sst-community/sst
```

It opens an issue and not a pull request because the workflow's token can't push SST's workflow changes.

To merge:

```bash
git fetch upstream
git switch main
git merge upstream/v<new>
```

- Merge release tags, not `upstream/dev`, unless you're cherry-picking one fix.
- Use a merge commit. A rebase or a squash breaks the shared history.
- `.github/scripts/upstream-release.sh` is what the workflow runs. `BASE=upstream/v4.17.0 .github/scripts/upstream-release.sh` tries it locally against an older release.

### Conflicts in `www/`

SST edits `www/astro.config.mjs` often, mostly the sidebar. The fork's edits there are:

- `site` and `base`
- no `astro-sst` adapter
- the title and favicon
- `social` and `editLink`
- the Kapa script removed from `head`
- the redirects
- the `forkLinks` rehype plugin

The fork also edits `www/config.ts` (`fork`, `forkDiscord`), the Head, Header, HeaderLinks, Footer, Hero and TestimonialWall components, `index.mdx`, and the install commands in `docs/index.mdx` and `docs/reference/sdk.mdx`.

## Versions

The major and minor numbers are those of the SST release the fork is built on. The patch number is the fork's own counter: always the next free one in that line.

| What happened | Version |
|---|---|
| First release, on SST 4.17.1 | `4.17.2` |
| A fix in the fork | The next patch |
| SST releases `4.17.2`, a number the fork has used | The next free patch |
| SST releases `4.18.0` | `4.18.0`, or the next free `4.18.x` |

Use plain `X.Y.Z`. A suffix such as `4.17.1-community.1` fails every `version` rule in a user's `sst.config.ts`, and npm ignores `+build` metadata. Nothing compares the CLI's version with SST's, so the numbers only have to be free and in order.

## Releasing

1. Write `.github/release-notes/vX.Y.Z.md`. Name the SST release it includes. Keep `### Install` as the last section: the Discord post leaves out everything from that heading on.
2. Push the `vX.Y.Z` tag on a commit that's on `main`. Only an admin or a member of the `releasers` team can.

`release.yml` then:

- builds the CLI with goreleaser and creates the GitHub release, using your notes in place of a generated changelog
- pushes the `bridge-task` image, which `sst.aws.Task` runs in `sst dev`, to `ghcr.io/sst-community/sst/bridge-task`
- publishes `@sst-community/sst` and a `@sst-community/sst-<os>-<cpu>` package for each platform to npm
- posts the notes to the Discord announcements channel

Things to know:

- **The release job runs in the `release` environment.** Only `v*` tags can use it, and only admins and the `releasers` team can push those. Keep what a release needs in that environment and not on the repo: anyone with Write access can push a branch, and a workflow on a branch can read repo secrets and ask for an npm token.
- **npm publishing has no token.** It uses trusted publishing. Each package has to exist on npm with a trusted publisher for this repo's `release.yml` in the `release` environment. For a new package: `npm trust github <package> --repo sst-community/sst --file release.yml --env release --allow-publish` (npm 11.15 or later).
- **Releases are immutable**, every one after 4.17.2. Once a release is published, its files and its tag can't be changed, so `install` and `sst upgrade` download what the release built. goreleaser uploads to a draft and publishes it last. A release can still be deleted, and its tag name can't be used again.
- **The package is renamed at publish time.** `sdk/js/package.json` stays named `sst`, and `sdk/js/scripts/release.ts` publishes it as `@sst-community/sst`. Renaming it in the repo changes `bun.lockb` and breaks `bun install --frozen-lockfile`.
- **Users install it under the name `sst`**, as `sst@npm:@sst-community/sst`, so `import ... from "sst"` keeps working. `sst upgrade` and `sst init` write that alias. `pkg/global/distribution.go` holds the release repo and the package name.
- **The container image has to be public.** GitHub may create the `sst/bridge-task` package as private on its first push. Until it's public, `sst dev` can't start a Task.
- **The environment doesn't cover the image.** A workflow on any branch can push `bridge-task:latest` with its own `GITHUB_TOKEN`, and `sst dev` runs whatever that tag points at. Every committer is a releaser today, so this gives nobody more than a release tag already does. Before adding a committer who isn't a releaser, have the release build the CLI with the digest of the image it pushed, so that a later push to the tag can't change what a released CLI runs.
- **The Discord webhook** is the `DISCORD_WEBHOOK_URL` secret of the `release` environment. Without it the step is skipped. `.github/scripts/announce-release.sh` is the script.
- **Fork builds are labelled.** `.goreleaser.yml` sets `ui.Distribution=sst-community`, which `sst version` and the `sst dev` banner show. Keep it out of `main.version`.

## Building it yourself

```bash
bun install --frozen-lockfile
cd platform && bun run build && cd ..
go build -ldflags "-X main.version=<version> -X github.com/sst/sst/v3/cmd/sst/mosaic/ui.Distribution=sst-community" -o dist/sst ./cmd/sst
```

- Bun 1.1.x can't read the lockfile. Use a current one.
- `platform/scripts/build` ends with a Docker build of the `bridge-task` image. The steps before it are enough for a local CLI.
- Run `./dist/sst version` from outside the repo. Inside it, the binary hands off to the `sst` in `node_modules`.
- `.gitignore` matches `cmd/sst`. Stage changes there with `git add -u`, not by path.

## The docs site

`www/` is published to GitHub Pages at https://sst-community.github.io/sst/ by `.github/workflows/docs.yml`. It runs on a push to `main` that touches `www/`, `platform/src/`, `cmd/sst/` or `examples/`.

- **The site lives under `/sst`.** `www/src/fork-links.mjs` adds that base to root-relative links in Markdown and MDX. Components, redirects, favicons and hero actions add it themselves.
- **SST's own pages aren't published.** The workflow deletes SST's blog, about and legal pages before it builds. The repo keeps them, and links to them go to sst.dev.
- **The home page is `www/src/components/ForkLanding.astro`**, which `Hero.astro` renders for the site root. It names no versions and no fixes, so a release doesn't need an edit there. What a release changes goes in its notes.
- **Two Discord links.** `forkDiscord` in `www/config.ts` is this project's server. `discord` stays SST's, because the migration guides send readers to channels there.

## Who can merge and release

Three rulesets on the repo set this. Admins bypass the first two, and the `releasers` team bypasses the first.

- **`Release tags`:** only an admin or a member of `releasers` can create, move or delete a `v*` tag.
- **`main`:** a change needs a pull request, an approval from someone other than its author, and a passing `check` run. The approval has to cover the latest push. Force-pushes and deletion are blocked. An admin pushes a merge of an SST release directly.
- **`v5`:** the branch can't be deleted, by anyone. Merged branches are deleted automatically, and this keeps `v5` when it's merged into `main`. To delete it on purpose, remove the ruleset first.

Also:

- **`.github/CODEOWNERS`** makes the `committers` team the owner of every file, so every pull request needs a committer's approval. Below that, it lists the files that decide what's built, released and run when the package is installed; a pull request that touches one needs its owner's review instead. When you add such a file, add it there, and to the "Code owner files" check in `.coderabbit.yaml`.
- **CodeRabbit reviews first.** It reviews every pull request to `main`, not `v5`, with the rules in `.coderabbit.yaml`, labels it `risk: low`, `risk: medium` or `risk: high`, and asks the author for changes. It approves once its comments are resolved and none of its blocking checks fail. The app has write access, so GitHub counts its approval toward the one `main` needs, but it isn't a code owner, so a committer still has to approve. Pick up the pull requests it has approved and review them as usual. The author can't waive a failing check or approve with `@coderabbitai approve`; a member can.
- **Merge methods:** squash for a contributor's pull request, a merge commit for an SST release. Rebase-merge is off.
- **Committers** are the members of the `committers` team, which has Write access and owns every file in CODEOWNERS. Two committers can land a change between them: one opens the pull request, the other approves it. They can't release unless they're also in `releasers`, and a change to a file in CODEOWNERS still needs its owner. They can push branches other than `main` and `v5` and run workflows on them, which is why releasing goes through the `release` environment.
- **Releasers** are the members of the `releasers` team, who are committers as well. They can push a release tag. A tag can point at any commit, and the release builds whatever it points at, with the `release.yml` of that commit, so the person who pushes the tag decides what's published. Tag only a commit that's on `main`.
- **Moderators** have the Triage role on the repo, given under Settings → Collaborators and teams. They label, close and reopen issues and pull requests, mark duplicates, hide comments, lock conversations and moderate Discussions. They can't push or merge, and their approval doesn't count. Blocking a user from the org takes an admin.
- **Admins bypass the `main` rule.** While there is one maintainer, that is how their own changes land, since nobody else could approve them.
- **Pull requests from forks** run `check.yml` with a read-only token and no secrets. A first-time contributor's run waits for a maintainer's approval.

## Issues, ideas and votes

- **Issues** are for bugs, and for fixes to carry from SST's repo. `.github/ISSUE_TEMPLATE/` has a form for each: a bug report (label `bug`) and a request for an upstream fix (label `upstream fix`).
- **People vote with a 👍 on the issue.** [Open issues, most-wanted first](https://github.com/sst-community/sst/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc).
- **Ideas and direction** go in [Discussions](https://github.com/sst-community/sst/discussions), in the Ideas category, which has its own upvotes. Polls are there too.
- **Questions** go to Discord.
- Votes show what's wanted. Maintainers decide what's done, and in what order.

## Still SST's

These are used as SST publishes them. They read the `SST_RESOURCE_*` environment variables, which the fork hasn't changed.

- the Rust crate `sst_sdk`
- the Go SDK, imported as `github.com/sst/sst/v3/sdk/golang/resource`
- `sst-sdk` on PyPI. The docs and examples install the Python SDK from this repo's `main` instead.

The CLI's messages and the components' errors link to this docs site. Docs pages still link to SST's repo, mostly for the examples, and to the SST Console, SST's guide and its blog, which have no counterpart here.
