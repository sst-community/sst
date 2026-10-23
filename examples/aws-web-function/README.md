# Lambda Web Functions HTTP server

This example deploys a Node.js 24 HTTP server with `sst.aws.WebFunction`. It starts a listener on the **host and port** supplied by `AWS_LAMBDA_HTTP_ENDPOINT`, without a Lambda event handler or Lambda Web Adapter.

**This component and example have not been validated against real AWS.** Component tests use mocked Pulumi and AWS APIs, and HTTP checks run locally. Deployment, IAM authorization, revision updates, streaming through AWS, and billing still require real AWS validation.

## Run locally

Use Node.js 24. The HTTP server uses only Node built-ins, so testing it locally does not require installing dependencies.

```sh
npm run start
```

From another terminal:

```sh
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/json
curl -N http://127.0.0.1:3000/events
```

`/events` sends three `tick` events, 200ms apart, followed by `done`. The `/wait` endpoint demonstrates overlapping requests in the same server process:

```sh
curl 'http://127.0.0.1:3000/wait?ms=1000&id=A' &
curl 'http://127.0.0.1:3000/wait?ms=1000&id=B' &
wait
```

You can also test the runtime's listen-address configuration:

```sh
AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3005 npm run start
```

## Configure SST

```ts
const api = new sst.aws.WebFunction("Api", {
  entrypoint: "src/server.ts",
  timeout: "30 seconds",
  maxConcurrencyPerEnvironment: 64,
  environment: { GREETING: "Hello" },
  url: { authorization: "none" },
  dev: { command: "npm run dev", url: "http://127.0.0.1:3000" },
});
```

This example uses `us-east-1` for its HomeRegion endpoint. Confirm that Lambda Web Functions are available in your target region. `sst dev` runs the local command without creating a cloud web function revision or endpoint. Setting `dev: false` deploys cloud resources even during `sst dev`.

To try the example on AWS, first prepare the SST CLI containing this change and AWS credentials. Then use the usual example workflow:

```sh
bun install
go run ../../cmd/sst dev --mode=basic
go run ../../cmd/sst deploy --stage test
```

`url.authorization: "none"` creates a public endpoint. Use `"iam"` when callers must authenticate with SigV4-signed HTTP requests; an unsigned `curl` request will not pass IAM authorization.

An AWS revision reaching `Active` does not verify that the application is listening correctly. Check the deployed HTTP endpoint before directing traffic to it.

## Benefits and migration considerations

- Deploy a Node HTTP server, including frameworks such as Hono or Express, without adapting requests to Lambda events.
- Handle concurrent requests within an execution environment and implement HTTP streaming, including SSE.
- Use SST's `environment`, `link`, and `permissions` arguments. Linked properties are available through the `Resource` SDK, and linked AWS permissions are added to the execution role.
- Store code in a dedicated private, versioned S3 bucket, with each revision pinned to an object version.

The supported configuration is Node.js 24 on Arm64 with fixed 2 vCPU and 2GB memory. Existing Lambda memory/CPU choices and event-source handlers cannot be carried over directly. Applications that mutate shared logging context or other process-level data must isolate request state. The `/json` response's `activeRequests` field observes this server process only; it is neither a global AWS concurrency count nor durable state.

Treat important background work, such as email delivery, as a separate delivery requirement and use a queue when durable execution is needed. Before migrating, validate DB and external API quotas, concurrency limits, cookies and headers through proxies or CloudFront, streaming behavior, and costs in the real environment.
