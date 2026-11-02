## Maintaining the fork

This is sst-community, a fork of SST. `MAINTAINING.md` covers merging an SST release, versions, releasing, updating Pulumi and the providers, the docs site, and who can merge. Read it before a merge from upstream, a release, a Pulumi or provider update, or a change under `.github/`. `CONTRIBUTING.md` is the guide for sending a change.

## Layout

- `platform/` — TS Pulumi components embedded via `//go:embed` (`platform/platform.go:16`)
- `examples/` — sample apps
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
- **Run CLI locally**: `cd examples/<app> && go run ../../cmd/sst <command>`
- **Go tests**: `bun run test:cli`
- **Typecheck**: `bun run typecheck`
- **Generate docs**: `bun run docs:generate`
- **Run docs locally**: `bun run docs:dev`

## Verification

1. Build the platform
2. `cd examples/<app> && bun install`
3. `go run ../../cmd/sst deploy`
4. Verify with `curl` or AWS CLI
5. Don't clean up unless told to
6. `sst dev --mode=basic` for dev mode

## V5 components

`platform/src/components/README.md` is the guide to writing a V5 component: parts, args, linking, dev mode, versions and tests. `platform/src/components/PORTING.md` has the rules for porting one of SST's 4.x components: takeover maps, helpers, tests and a checklist. Read both before touching a file in `platform/src/components/aws/v5/`. Edit a 4.x component file only where it changes nothing for an app that uses it (see the rulebook).

## Plans and progress

What's been done, what's next and what's undecided is in `docs/plans/`, not in this file. Every v5 change is held to the goals in `docs/plans/v5-goals.md`. Then start with `docs/plans/v5-components.md`. When a piece of work lands, add it to `docs/plans/v5-progress.md` and update the status in the plan. Keep this file to how to work in the repo.
