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

SvelteKit 3 takes it in the `sveltekit()` plugin in `vite.config.ts`:

```js
sveltekit({
  adapter: adapter({ streaming: true }),
});
```

SvelteKit 2 takes it in `kit.adapter` in `svelte.config.js`:

```js
export default {
  kit: {
    adapter: adapter({ streaming: true }),
  },
};
```

`sst.aws.SvelteKit` reads the option and sets up the function URL for [response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html). It's off by default.

The option needs a version of the `sst` CLI that reads it. With an older CLI the function URL isn't set up for streaming, and the option is ignored without a message. An older adapter (3.0.1 and earlier) ignores the option too.

Turning streaming on or off changes the function URL's invoke mode. In testing, Lambda kept using the old mode for about 20 seconds after the deploy finished, and requests in that window came back empty or as the handler's raw result. A deploy that keeps the mode the same isn't affected.

## Client address

In a route, `getClientAddress()` returns the visitor's IP address when requests come through CloudFront. It's read from the `CloudFront-Viewer-Address` header, which CloudFront sets and replaces when a client sends its own. `X-Forwarded-For` isn't used, because CloudFront passes on whatever the client sent in it. Without that header, it's the source IP of the request.

Only trust it when requests reach the function through CloudFront. The server function's URL is public unless the site's `protection` is `"oac"` or `"oac-with-edge-signing"`, and anyone who has the URL can send their own `CloudFront-Viewer-Address`. If you use the address for rate limiting or to allow or block clients, set `protection` on the `sst.aws.SvelteKit` component, or on the `sst.aws.Router` if the site is served through one (the component refuses its own `protection` then).

If another CDN sits in front of CloudFront, such as Cloudflare or Fastly, the address is that CDN's, as it was CloudFront's before. Read the header that CDN sets instead, such as `CF-Connecting-IP`, from `event.request.headers` in your route.

## Limitations

- `read` from `$app/server` isn't supported. The function only contains the server code and prerendered pages, and client assets are served from S3. A route that uses `read` fails the build with an error that says so.
- Server instrumentation (`instrumentation.server.js`) isn't supported yet.
