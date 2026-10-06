# svelte-kit-sst

This adapter allows SvelteKit to deploy your SSR site to [AWS](https://aws.amazon.com/). It's the sst-community build of SST's `svelte-kit-sst`, published as `@sst-community/svelte-kit-sst`.

## Installation

Install it under the name `svelte-kit-sst`, so `import adapter from "svelte-kit-sst"` keeps working.

```bash
npm install svelte-kit-sst@npm:@sst-community/svelte-kit-sst
# pnpm add svelte-kit-sst@npm:@sst-community/svelte-kit-sst
# bun add svelte-kit-sst@npm:@sst-community/svelte-kit-sst
# yarn add svelte-kit-sst@npm:@sst-community/svelte-kit-sst
```

To switch an existing project, change its dependency to `"svelte-kit-sst": "npm:@sst-community/svelte-kit-sst@<version>"` and reinstall.

One package works with SvelteKit 2 and 3. It's tested with 2.70 and 3.0.

### SvelteKit 3

SvelteKit 3 keeps its configuration in `vite.config.ts`. Add the adapter to the `sveltekit()` plugin.

```diff
+ import adapter from "svelte-kit-sst";
  import { sveltekit } from "@sveltejs/kit/vite";
  import { defineConfig } from "vite";

  export default defineConfig({
    plugins: [
      sveltekit({
+       adapter: adapter(),
      }),
    ],
  });
```

SvelteKit 3 itself requires Node 22.17 or newer.

### SvelteKit 2

SvelteKit 2 reads the adapter from `svelte.config.js`. The install and the import are the same.

```diff
+ import adapter from "svelte-kit-sst";
  import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

  const config = {
    preprocess: vitePreprocess(),
    kit: {
+     adapter: adapter(),
    },
  };

  export default config;
```

## Streaming

Set `streaming` to stream responses from the Lambda function. The page's HTML is sent right away, and the promises a `load` function returns without awaiting are sent as they resolve.

```js
adapter({ streaming: true });
```

`sst.aws.SvelteKit` reads the option and sets up the function URL for [response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html). It's off by default.

## Limitations

- `read` from `$app/server` isn't supported. The function only contains the server code and prerendered pages, and client assets are served from S3. A route that uses `read` fails the build with an error that says so.
- Server instrumentation (`instrumentation.server.js`) isn't supported yet.
