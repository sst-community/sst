<h1 align="center">sst-community</h1>

<p align="center">A community-maintained fork of <a href="https://github.com/anomalyco/sst">SST</a></p>

---

Build full-stack apps on your own infrastructure.

> [!NOTE]
> **sst-community** is a community-maintained fork of [SST](https://github.com/anomalyco/sst). It is not affiliated with SST or Anomaly. It tracks upstream releases and carries fixes that haven't landed upstream yet.
>
> Releases are numbered after the upstream line they're based on: `4.17.x` is based on upstream 4.17. Each release's notes list what it changes. Telemetry is off. Docs: [sst-community.github.io/sst](https://sst-community.github.io/sst/docs/).

## Installation

For JavaScript projects, install the fork locally under the name `sst`, so the CLI version is tracked with your app and `import ... from "sst"` keeps working. You can then run the CLI with the same package manager.

```bash
npm install sst@npm:@sst-community/sst
# pnpm add sst@npm:@sst-community/sst
# bun add sst@npm:@sst-community/sst
# yarn add sst@npm:@sst-community/sst
```

To switch an existing project from SST, change its dependency to `"sst": "npm:@sst-community/sst@<version>"` and reinstall. `sst upgrade` keeps it pointing at the fork.

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

Here's how you can contribute:

- Help us improve our docs
- Find a bug? Open an issue
- Feature request? Submit a PR 

## Running Locally

Run `bun run setup`. You need [Go](https://go.dev/) and [Bun](https://bun.sh/) installed.

Now you can run the CLI locally on any of the `examples/` apps.

```bash
cd examples/aws-api
go run ../../cmd/sst <command>
```

If you want to build the CLI binary, run `bun run build:cli`. This creates `dist/sst5`, a v5 development build that you can run next to a stable `sst`.

For building the docs, run `bun run docs:generate` and `bun run docs:dev`.

---

**Found a bug or have a question about the fork?** [Open an issue](https://github.com/sst-community/sst/issues). For SST itself, see [anomalyco/sst](https://github.com/anomalyco/sst).
