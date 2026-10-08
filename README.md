<h1 align="center">sst-community</h1>

<p align="center">A community-maintained fork of <a href="https://github.com/anomalyco/sst">SST</a></p>

---

Build full-stack apps on your own infrastructure.

> [!NOTE]
> **sst-community** is a community-maintained fork of [SST](https://github.com/anomalyco/sst). It is not affiliated with SST or Anomaly. It tracks upstream releases and carries fixes that haven't landed upstream yet.
>
> **It needs Node.js 22 or later**, since 4.18.0.
>
> Releases have their own version numbers, because the fork moves faster than SST: up to 4.17.2 they followed SST's, and from there on the fork's 4.18.0 isn't SST's 4.18.0. Each release's notes say which SST release it's built on and list what it changes, and `sst version` shows the SST release too. Telemetry is off. Docs: [sst-community.github.io/sst](https://sst-community.github.io/sst/docs/). Chat: [Discord](https://discord.gg/DQWT3WGVm2).

## Installation

> [!IMPORTANT]
> **Node.js 22 or later is required**, since 4.18.0, everywhere you run `sst`, CI included. SST runs your `sst.config.ts` with Node, even when your app isn't written in JavaScript. On an older Node.js the CLI warns, and some features fail: on Node.js 20, inline Lambda callbacks do.

For JavaScript projects, install the fork locally under the name `sst`, so the CLI version is tracked with your app and `import ... from "sst"` keeps working. You can then run the CLI with the same package manager.

```bash
npm install sst@npm:@sst-community/sst
# pnpm add sst@npm:@sst-community/sst
# bun add sst@npm:@sst-community/sst
# yarn add sst@npm:@sst-community/sst
```

To switch an existing project from SST, change its dependency to `"sst": "npm:@sst-community/sst@<version>"` and reinstall. `sst upgrade` keeps it pointing at the fork.

If the project uses the Astro or SvelteKit adapter, switch it the same way, to `"astro-sst": "npm:@sst-community/astro-sst@<version>"` or `"svelte-kit-sst": "npm:@sst-community/svelte-kit-sst@<version>"`. Its imports stay the same. SST's own `astro-sst` 3.x doesn't support Astro 6 or later, and its `svelte-kit-sst` 2.x doesn't support SvelteKit 3. `sst upgrade` doesn't change the adapters.

If you are not using JavaScript, you can install the CLI globally.

```bash
curl -fsSL https://raw.githubusercontent.com/sst-community/sst/main/install | bash
```

To install a specific version.

```bash
curl -fsSL https://raw.githubusercontent.com/sst-community/sst/main/install | VERSION=4.17.2 bash
```

#### Manually

Download the pre-compiled binaries from the [releases](https://github.com/sst-community/sst/releases/latest) page and copy to the desired location. On Linux, the `.deb` and `.rpm` packages there install with `sudo dpkg -i` and `sudo rpm -i`.

## Get Started

Get started with your favorite framework:

- [Next.js](https://sst-community.github.io/sst/docs/start/aws/nextjs)
- [SvelteKit](https://sst-community.github.io/sst/docs/start/aws/svelte/)
- [Remix](https://sst-community.github.io/sst/docs/start/aws/remix)
- [Astro](https://sst-community.github.io/sst/docs/start/aws/astro)
- [Hono](https://sst-community.github.io/sst/docs/start/aws/hono)

## Learn More

Learn more about some of the key concepts:

- [Live](https://sst-community.github.io/sst/docs/live)
- [Linking](https://sst-community.github.io/sst/docs/linking)
- [Console](https://sst-community.github.io/sst/docs/console)
- [Components](https://sst-community.github.io/sst/docs/components)

## Contributing

Bug fixes, docs and help with issues are welcome. [CONTRIBUTING.md](https://github.com/sst-community/sst/blob/main/CONTRIBUTING.md) covers the setup, what to run before a pull request, and how pull requests are merged. For questions, ask on [Discord](https://discord.gg/DQWT3WGVm2).

To vote on what gets fixed next, add a 👍 to an issue. Here are the [open issues, most-wanted first](https://github.com/sst-community/sst/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc).

## Running Locally

Run `bun run setup`. You need [Go](https://go.dev/) and [Bun](https://bun.sh/) installed.

Now you can run the CLI locally on any of the `examples/` apps.

```bash
cd examples/aws-api
go run ../../cmd/sst <command>
```

If you want to build the CLI binary, run `bun run build:cli`. This will create a `sst` binary that you can use.

For building the docs, run `bun run docs:generate` and `bun run docs:dev`.

---

**Found a bug or have a question about the fork?** [Open an issue](https://github.com/sst-community/sst/issues) or ask on [Discord](https://discord.gg/DQWT3WGVm2). For SST itself, see [anomalyco/sst](https://github.com/anomalyco/sst).
