# astro-sst

This adapter allows Astro to deploy your SSR or static site to [AWS](https://aws.amazon.com/) with SST's `sst.aws.Astro`. It's the sst-community build of SST's `astro-sst`, published as `@sst-community/astro-sst`.

## Installation

Install it under the name `astro-sst`, so `import aws from "astro-sst"` keeps working. `sst init` does this for you.

```bash
npm install astro-sst@npm:@sst-community/astro-sst
# pnpm add astro-sst@npm:@sst-community/astro-sst
# bun add astro-sst@npm:@sst-community/astro-sst
# yarn add astro-sst@npm:@sst-community/astro-sst
```

To switch an existing project from SST's adapter, change its dependency to `"astro-sst": "npm:@sst-community/astro-sst@<version>"` and reinstall. Nothing else changes.

One package works with Astro 5.6 and later, 6 and 7. It's tested with 5.18, 6.4 and 7.3. Astro 6 and 7 need Node.js 22.12 or later: the server function's default runtime, `nodejs24.x`, is fine, and so is `nodejs22.x`.

Then add the adapter to your `astro.config.mjs`.

```js title="astro.config.mjs" ins={2, 5-6}
import { defineConfig } from "astro/config";
import aws from "astro-sst";

export default defineConfig({
  output: "server",
  adapter: aws(),
});
```

### Response Mode

When utilizing `server` output, you can choose how responses are handled:

- `buffer`: Responses are buffered and sent as a single response. (_default_)
- `stream`: Responses are streamed as they are generated.

```js title="astro.config.mjs" ins={2, 5-6}
import { defineConfig } from "astro/config";
import aws from "astro-sst";

export default defineConfig({
  output: "server",
  adapter: aws({
    responseMode: "stream",
  }),
});
```

## Upgrading from v2

If you're upgrading from v2 of this adapter, here are the key changes to be aware of:

1. Remove the `deploymentStrategy` option from `astro.config.mjs`. Instead, the `output` setting in your Astro config is now used to determine the deployment type:
   - If you previously used `deploymentStrategy: "regional"`, now set `output: "server"` in `astro.config.mjs`.
   - If you previously used `deploymentStrategy: "edge"`, now set `output: "server"` in `astro.config.mjs`. Update SST to v3.9.25 or later. And configure [`regions`](https://sst.dev/docs/component/aws/astro#regions) on your Astro component.
   - If you previously used `deploymentStrategy: "static"`, now set `output: "static"` in `astro.config.mjs`.

2. Remove the `serverRoutes` option from `astro.config.mjs`
