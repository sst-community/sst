# A component package

A package to copy when you write an SST component for others to install. It works with SST 5, which is in pre-release. How a package component works is in [Write a Package Component](https://github.com/sst-community/sst/blob/v5/www/src/content/docs/docs/write-a-package-component.mdx).

The component is `Webhook`: a function URL that takes webhook deliveries and puts each on an SQS queue. A function that links it can read the queue.

```ts title="sst.config.ts"
const { Webhook } = await import("@acme/webhook");

const hook = new Webhook("Payments");
new sst.aws.v5.Function("Worker", {
  handler: "src/worker.handler",
  link: [hook],
});
```

## What's in it

| File | What it is |
| --- | --- |
| `src/index.ts` | The component. Its parts are a provider's resource (`aws.sqs.Queue`) and one of SST's components (`v5.Function`). |
| `src/receiver.ts` | The handler the package ships, which the function runs |
| `test/webhook.test.ts` | Tests with `mock()` from `sst/testing`. Nothing is deployed. |
| `tsconfig.json` | Type-checks `src` and `test`. It's what your editor reads. |
| `tsconfig.build.json` | Compiles `src` to `dist`, with its types |

## Make it yours

1. Copy this folder into a repo of its own and run `npm install`.
2. In `package.json`, change `name`, `description` and the `./receiver` export, or remove it if your component ships no code. Keep the `sst-component` keyword so the package can be found.
3. In `src/index.ts`, give the component a type with your package's name in it, like `yourname:index:Thing`. An app's state knows the component by it, so two packages shouldn't share one. Change the name the handler is found by to your package's.
4. List the providers your component uses in `peerDependencies`, marked optional in `peerDependenciesMeta`, and in `devDependencies`.

Commit your lockfile.

## Versions

- **Pulumi and the providers** in `devDependencies` are the versions SST 5 installs for an app. Your tests then run against what an app deploys with. `node_modules/sst/platform/package.json` lists them, and which providers each of SST's groups loads, under `groups`. Importing `sst/components/aws` loads all five of its providers.
- **TypeScript stays on 6.** `@pulumi/pulumi` accepts only versions below 7, and npm stops an install that asks for 7.
- **`google-protobuf` is pinned to 3.21.2**, as SST pins it. With the version `@pulumi/pulumi` gets otherwise, every resource `mock()` registers fails.

## Test it

```bash
npm test
```

It type-checks, compiles, then runs the tests. The component finds its handler in `dist`, as it does in an app, so the tests need it compiled.

## Publish it

```bash
npm run build
npm publish --access public
```

## Use it in an app

```bash
npm install -D @acme/webhook
```

The app needs each provider the component uses. A deploy checks the package's `peerDependencies`, and says what to add with `sst add` when one is missing. An app without a `package.json` lists the package in its config instead, under `packages`.
