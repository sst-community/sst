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

`.github/workflows/upstream.yml` runs every Monday. When SST's newest release isn't merged into `main`, it opens an issue titled "Upstream release vX.Y.Z" with the releases and commits involved, the files that conflict, the next fork version, and the commands. Closing the issue skips that release. To run it by hand:

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

The fork numbers its own releases, with semver, because it moves faster than SST. Up to 4.17.2 the numbers followed SST's. From here they're the fork's own, so the fork's 4.18.0 won't be SST's 4.18.0. Each release says which SST release it's built on.

| What's in the release | Version |
|---|---|
| Only fixes and changes users can't call, from the fork or a merged SST patch release | The next patch |
| Something new users can use (a component, arg, output, `nodes` member, CLI command or flag, or SDK function), or a merged SST minor release | The next minor |
| A breaking change | `main` doesn't take them for now |

- Count up from the fork's newest release on `main`. Never reuse a number or go back.
- **`.github/scripts/next-version.sh` works it out.** Run it on an up-to-date `main`. It takes the highest `semver:` label of the pull requests merged since the last release, and the SST release merged since then, if any. It lists what it didn't count: pull requests without the label, and commits pushed straight to `main`. Check those by hand.
- **The automatic review sets the `semver:` label** on each pull request (see [Who can merge and release](#who-can-merge-and-release)). Correct it before merging when it's wrong.
- **`sst version` names the SST release**, as `sst 4.18.0 (sst-community, built on SST 4.17.1)`. `release.yml` finds the newest SST tag in the release's history and `.goreleaser.yml` passes it in as `ui.Upstream`. Release notes name it too.
- Use plain `X.Y.Z`. A suffix such as `4.17.1-community.1` fails every `version` rule in a user's `sst.config.ts`, and npm ignores `+build` metadata. Nothing compares the CLI's version with SST's, so the fork's numbers don't have to match SST's.

## Releasing

1. Run `.github/scripts/next-version.sh` on an up-to-date `main` for the version (see [Versions](#versions)).
2. Write `.github/release-notes/vX.Y.Z.md`. Name the SST release it includes, and link each pull request users would notice. Keep `### Install` as the last section: the Discord post leaves out everything from that heading on.
3. Run `next-version.sh` again. It lists the pull requests in the release that the notes don't link.
4. Push the `vX.Y.Z` tag on a commit that's on `main`. Only an admin or a member of the `releasers` team can.

`release.yml` then:

- builds the CLI with goreleaser and creates the GitHub release, using your notes in place of a generated changelog
- pushes the `bridge-task` image, which `sst.aws.Task` runs in `sst dev`, to `ghcr.io/sst-community/sst/bridge-task`
- publishes `@sst-community/sst` and a `@sst-community/sst-<os>-<cpu>` package for each platform to npm
- publishes `@sst-community/svelte-kit-sst` when the version in `packages/svelte-kit-sst/package.json` isn't on npm yet
- posts the notes to the Discord announcements channel

Things to know:

- **The release job runs in the `release` environment.** Only `v*` tags can use it, and only admins and the `releasers` team can push those. Keep what a release needs in that environment and not on the repo: anyone with Write access can push a branch, and a workflow on a branch can read repo secrets and ask for an npm token.
- **npm publishing has no token.** It uses trusted publishing. Each package has to exist on npm with a trusted publisher for this repo's `release.yml` in the `release` environment. For a new package: `npm trust github <package> --repo sst-community/sst --file release.yml --env release --allow-publish` (npm 11.15 or later).
- **Releases are immutable**, every one after 4.17.2. Once a release is published, its files and its tag can't be changed, so `install` and `sst upgrade` download what the release built. goreleaser uploads to a draft and publishes it last. A release can still be deleted, and its tag name can't be used again.
- **The package is renamed at publish time.** `sdk/js/package.json` stays named `sst`, and `sdk/js/scripts/release.ts` publishes it as `@sst-community/sst`. Renaming it in the repo changes `bun.lockb` and breaks `bun install --frozen-lockfile`.
- **Users install it under the name `sst`**, as `sst@npm:@sst-community/sst`, so `import ... from "sst"` keeps working. `sst upgrade` and `sst init` write that alias. `pkg/global/distribution.go` holds the release repo and the package name.
- **The SvelteKit adapter has its own version.** To release it, bump the version in `packages/svelte-kit-sst/package.json` (`npm version <x.y.z> --no-git-tag-version` there, which updates the lockfile too) and add a `CHANGELOG.md` entry; the next release tag publishes it. A version with a suffix, such as `3.1.0-alpha.0`, goes out under the `next` tag instead of `latest`. Users install it as `svelte-kit-sst@npm:@sst-community/svelte-kit-sst`.
- **The container image has to be public.** GitHub may create the `sst/bridge-task` package as private on its first push. Until it's public, `sst dev` can't start a Task.
- **The environment doesn't cover the image.** A workflow on any branch can push `bridge-task:latest` with its own `GITHUB_TOKEN`, and `sst dev` runs whatever that tag points at. Every committer is a releaser today, so this gives nobody more than a release tag already does. Before adding a committer who isn't a releaser, have the release build the CLI with the digest of the image it pushed, so that a later push to the tag can't change what a released CLI runs.
- **The Discord webhook** is the `DISCORD_WEBHOOK_URL` secret of the `release` environment. Without it the step is skipped. `.github/scripts/announce-release.sh` is the script.
- **Fork builds are labelled.** `.goreleaser.yml` sets `ui.Distribution=sst-community`, which `sst version` and the `sst dev` banner show, and `ui.Upstream` to the SST release the build is on, which `sst version` shows. Keep both out of `main.version`.

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

## Updating Pulumi and the providers

The versions are pinned in two places: the `@pulumi/*` packages in `platform/package.json`, and `pulumi/pkg/v3` and `pulumi/sdk/v3` in `go.mod`.

```bash
go get github.com/pulumi/pulumi/pkg/v3@v<new> github.com/pulumi/pulumi/sdk/v3@v<new>
go mod tidy
# edit the versions in platform/package.json, then
bun install
```

- **`@pulumi/pulumi` and the two Go modules are one version.** The CLI downloads the Pulumi binary of its Go SDK's version (`pkg/global/pulumi.go`) and writes that same version into an app's `.sst/platform/package.json` (`pkg/project/install.go`).
- **A newer Pulumi can raise the `go` line in `go.mod`.** CI installs the newest Go, so the workflows don't change.
- **Leave `platform/bun.lockb` alone.** Only the root `bun.lockb` changes, as in SST's own bumps.
- **Typecheck first.** A provider can change its types within a major version, and `cd platform && bun tsc --noEmit` is where that shows.
- **Check the Node version `@pulumi/pulumi` needs** (`npm view @pulumi/pulumi@<new> engines`). The user's own `node` runs their config. Since 3.249 it has to be Node 22 or later. A change there goes in the release notes.
- **An app that doesn't pin a provider's version gets the one in `platform/package.json`.** An existing app moves to it on the first deploy after the CLI is upgraded. `sst diff` shows that as the provider entries being replaced, and it should show nothing else.
- **A docker-build update can rebuild every image once.** docker-build is built on pulumi-go-provider, which replaces its provider on any config change except `version` ([pulumi-go-provider#409](https://github.com/pulumi/pulumi-go-provider/issues/409)) and stores its own version in that config. When that version changes, every image SST builds is rebuilt on the next deploy, and each Service, Task or container Function using one is redeployed. Say so in the release notes.

### Testing a bump

The tests run without a real provider, so deploy an app with a site, a database, and a Service whose image is built from a Dockerfile:

1. Deploy it with the current release.
2. Switch to the new build and run `sst diff`. Only the provider entries should change.
3. Deploy, call what it deployed, and run `sst diff` again. It should say no changes.
4. Run `sst dev --mode=basic` and invoke a function. This is what exercises the bridge, which is built with the new Go modules.
5. Roll back: run `sst diff` and deploy with the current release. It should read the state the new build wrote and change only the provider entries.
6. Remove it, then deploy it from scratch with the new build and remove it again.

**A build replaces the installed Pulumi.** Every command, `sst version` included, checks the Pulumi binary in the `sst/bin` folder of your user config directory and downloads its own version when that differs. So a test build swaps the binary your installed CLI uses, and so does the docs build, which runs `go run ../cmd/sst`. Run the test build with `HOME` set to an empty folder and it installs Pulumi, Bun and the provider plugins there instead. It then can't read `~/.aws`, so give it credentials as environment variables. To put the binary back, run your installed CLI once.

## The docs site

`www/` is published to GitHub Pages at https://sst-community.github.io/sst/ by `.github/workflows/docs.yml`. It runs on a push to `main` that touches `www/`, `platform/src/`, `cmd/sst/` or `examples/`.

- **The site lives under `/sst`.** `www/src/fork-links.mjs` adds that base to root-relative links in Markdown and MDX. Components, redirects, favicons and hero actions add it themselves.
- **SST's own pages aren't published.** The workflow deletes SST's blog, about and legal pages before it builds. The repo keeps them, and links to them go to sst.dev.
- **The home page is `www/src/components/ForkLanding.astro`**, which `Hero.astro` renders for the site root. It names no versions and no fixes, so a release doesn't need an edit there. What a release changes goes in its notes.
- **Two Discord links.** `forkDiscord` in `www/config.ts` is this project's server. `discord` stays SST's, because the migration guides send readers to channels there.

## Who can merge and release

Three rulesets on the repo set this. Admins bypass the first two. The `releasers` team bypasses the first, and the second when they merge a pull request.

- **`Release tags`:** only an admin or a member of `releasers` can create, move or delete a `v*` tag.
- **`main`:** a change needs a pull request, an approval from someone other than its author, and a passing `check` run. The approval has to cover the latest push. Force-pushes and deletion are blocked. An admin pushes a merge of an SST release directly.
- **`v5`:** the branch can't be deleted, by anyone. Merged branches are deleted automatically, and this keeps `v5` when it's merged into `main`. To delete it on purpose, remove the ruleset first.

Also:

- **`.github/CODEOWNERS`** makes the `committers` team the owner of every file, so every pull request needs a committer's approval, unless an admin or a releaser merges it. Below that, it lists the files that decide what's built, released and run when the package is installed; a pull request that touches one needs its owner's review instead. When you add such a file, add it there.
- **An automatic review runs first** on every pull request to `main` that isn't a draft, and again on each push or edit to its title or description. `.github/workflows/review.yml` posts one comment, kept up to date, with:
  - a `risk: low`, `risk: medium` or `risk: high` label, from the paths changed (`.github/scripts/review-prepare.sh` has the rules)
  - checks that don't need a model: the title, no edits to generated docs, no version changes, and a description that says how a change to code was tested
  - a review by opencode with a free model (`MODEL` in the workflow), following `.github/review/prompt.md`
  - a `semver: patch`, `semver: minor` or `semver: major` label, from the review's Version section. A run whose review has no version leaves the label as it was.

  It sets a `review` status: failure when a check fails, the review tags a finding `[blocking]`, or the version is `major`, since `main` doesn't take breaking changes for now. The prompt lists what counts as blocking (bugs, security, docs made wrong, a doc comment not updated, replaced resources); everything else is a `[suggestion]`, and the script, not the model, turns the tags into the status, so the verdict holds steady between runs. A finding that depends on what AWS or another outside service accepts is a `[suggestion]` too, since the model can't read their docs. The model runs at temperature 0, as the `review` agent in `opencode.json`, with 60 tool calls (`steps`). A review that runs out of them before it writes its findings says so, with what it did write folded away, and nothing in it counts. Pick up the pull requests where it passes, or where the author has answered it. The status isn't required, so you can merge over it when the review is wrong. If the free model is down or its free period ends, the comment says so and the checks still run; change `MODEL` to another free model (`opencode models opencode` lists them).
- **The automatic review is safe for forks because nothing from the pull request runs.** It uses `pull_request_target`, which runs the workflow from `main` with a token that can comment. It checks out `main` only, fetches the diff as text, and gives opencode no token and no tools but reading files (`.github/review/opencode.json`). Never make it check out or run the pull request's code.
- **Merge methods:** squash for a contributor's pull request, a merge commit for an SST release. Rebase-merge is off.
- **Committers** are the members of the `committers` team, which has Write access and owns every file in CODEOWNERS. Two committers can land a change between them: one opens the pull request, the other approves it. They can't release unless they're also in `releasers`, and a change to a file in CODEOWNERS still needs its owner. They can push branches other than `main` and `v5` and run workflows on them, which is why releasing goes through the `release` environment.
- **Releasers** are the members of the `releasers` team, who are committers as well. They can push a release tag. A tag can point at any commit, and the release builds whatever it points at, with the `release.yml` of that commit, so the person who pushes the tag decides what's published. Tag only a commit that's on `main`.
- **Moderators** have the Triage role on the repo, given under Settings → Collaborators and teams. They label, close and reopen issues and pull requests, mark duplicates, hide comments, lock conversations and moderate Discussions. They can't push or merge, and their approval doesn't count. Blocking a user from the org takes an admin.
- **Admins and releasers bypass the `main` rule.** A releaser can merge a pull request without an approval, their own included, but can't push to `main` directly. An admin can do both, which is how an SST release merge lands.
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
