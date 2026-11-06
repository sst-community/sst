## Maintaining the fork

This is sst-community, a fork of SST. `MAINTAINING.md` covers merging an SST release, versions, releasing, updating Pulumi and the providers, the docs site, and who can merge. Read it before a merge from upstream, a release, a Pulumi or provider update, or a change under `.github/`. `CONTRIBUTING.md` is the guide for sending a change.

## Layout

- `platform/` — TS Pulumi components embedded via `//go:embed` (`platform/platform.go:16`)
- `examples/` — `component-package`, the package an author copies. SST 5's example apps come back one at a time, each deployed first
- `cmd/sst/` — Go CLI entry, orchestrates everything
- `cmd/sst/mosaic/` — live dev TUI
- `pkg/server/` — JSON-RPC bridge for custom Pulumi dynamic providers (`rpc/rpc.ts` ↔ `pkg/server`)
- `pkg/bus/` — pub/sub event bus
- `sdk/js/` — runtime SDK for reading linked resources
- `packages/svelte-kit-sst/` — SvelteKit adapter for AWS Lambda (SvelteKit 2 and 3). Not a Bun workspace: it has its own `package-lock.json` and uses npm. Run `npm test` in it.
- `packages/astro-sst/` — Astro adapter for AWS Lambda (Astro 5, 6 and 7), the same way: npm, its own lockfile, `npm test` in it.
- `www/` — docs site (auto-generated from JSDoc comments in platform and extracted from the Go CLI)
- `docs/plans/` — plans and progress for larger pieces of work (not the docs site)

## Commands

- **Setup**: `bun run setup`
- **Build platform**: `bun run build:platform`
- **Build CLI**: `bun run build:cli`
- **Run CLI locally**: in a test app, `go run <this repo>/cmd/sst <command>`
- **Go tests**: `bun run test:cli`
- **Typecheck**: `bun run typecheck`
- **Generate docs**: `bun run docs:generate`
- **Run docs locally**: `bun run docs:dev`

## Verification

1. Build the platform
2. In a test app, `bun install`
3. `go run <this repo>/cmd/sst deploy`
4. Verify with `curl` or AWS CLI
5. Don't clean up unless told to
6. `sst dev --mode=basic` for dev mode

## Components

`platform/src/components/README.md` is the guide to writing a component: parts, args, linking, dev mode, versions and tests. `platform/src/components/CONTRIBUTING.md` has the rules for changing or adding one of SST's own: the helpers they share, the takeover maps `sst migrate` uses, their tests, and a checklist. Read both before touching a component in `platform/src/components/`. SST 4's components are frozen in `platform/test/fixtures/v4/components/` for the tests: edit one only to keep it loading.

## Plans and progress

What's been done, what's next and what's undecided is in `docs/plans/`, not in this file. Every 5.0 change is held to the goals in `docs/plans/v5-rewrite/goals.md`. Then start with `docs/plans/v5-rewrite/plan.md`. When a piece of work lands, add it to `docs/plans/v5-rewrite/progress.md` and update the status in the plan. Keep this file to how to work in the repo.
