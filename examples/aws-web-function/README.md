# Lambda Web Functions HTTP server

This example deploys a Node.js 24 HTTP server with `sst.aws.WebFunction`. It starts a listener on the **host and port** supplied by `AWS_LAMBDA_HTTP_ENDPOINT`, without a Lambda event handler or Lambda Web Adapter.

The component uses the classic `@pulumi/aws` provider's native `lambdaweb.Function`, `FunctionRevision`, and `FunctionEndpoint` resources, available from version 7.54.0. It creates an immutable revision and explicitly routes 100% of endpoint traffic to it.

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

The deployment identity needs permissions for the Lambda Web Function control plane, `iam:PassRole` on the execution role, and the component's IAM, versioned S3 code, and CloudWatch resources. The native provider internally uses Cloud Control to create the empty function before adding its revision, so the deployment identity also needs `cloudformation:CreateResource` and `cloudformation:GetResourceRequestStatus` on `Resource: "*"`. These are deployment permissions, not execution-role permissions. The component does not create a CloudFormation stack. See the [provider implementation](https://github.com/hashicorp/terraform-provider-aws/blob/v6.72.0/internal/service/lambdaweb/function.go) and [Cloud Control IAM guidance](https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/security.html).

To try the example on AWS, first prepare the SST CLI containing this change and AWS credentials. Then use the usual example workflow:

```sh
bun install
go run ../../cmd/sst dev --mode=basic
go run ../../cmd/sst deploy --stage test
```

`url.authorization: "none"` creates a public endpoint. Use `"iam"` when callers must authenticate with SigV4-signed HTTP requests; an unsigned `curl` request will not pass IAM authorization.

Code or service-configuration changes create a new immutable revision. The endpoint keeps its identity and moves its explicit revision weight to the new revision; the resource dependency graph is configured to update the endpoint before removing the old revision. Actual replacement ordering still requires AWS validation. The component adds no HTTP health gate or application-level rollback. An AWS revision reaching `Active` does not verify that the application is listening correctly. Check the deployed HTTP endpoint before directing traffic to it.

Validate creation, revision replacement, streaming, IAM requests, and removal against AWS before adopting the component. Also test setting `rateLimit` to `0` and then removing the limit: the native provider includes reset handling, but this component's AWS behavior has not been verified.

## Benefits and migration considerations

- Deploy a Node HTTP server, including frameworks such as Hono or Express, without adapting requests to Lambda events.
- Handle concurrent requests within an execution environment and implement HTTP streaming, including SSE.
- Use SST's `environment`, `link`, and `permissions` arguments. Linked properties are available through the `Resource` SDK, and linked AWS permissions are added to the execution role. Environment values remain secret Pulumi inputs. The CloudFormation parameter-count and per-value 4,096-byte limits do not apply to the native API. The component validates nonempty values and AWS's 32 KiB aggregate limit, including keys, linked values, and the managed entrypoint. Values above 4,096 bytes follow the published native API contract; their acceptance in AWS remains unverified.
- Store code in a dedicated private, versioned S3 bucket, with each revision pinned to an object version. Keep versions referenced by revisions.
- Manage the function, revision, and endpoint through `nodes.function`, `nodes.revision`, and `nodes.endpoint`, with matching `transform.function`, `transform.revision`, and `transform.endpoint` hooks.

The supported configuration is Node.js 24 on Arm64 with fixed 2 vCPU and 2GB memory. Existing Lambda memory/CPU choices and event-source handlers cannot be carried over directly. Applications that mutate shared logging context or other process-level data must isolate request state. The `/json` response's `activeRequests` field observes this server process only; it is neither a global AWS concurrency count nor durable state.

Treat important background work, such as email delivery, as a separate delivery requirement and use a queue when durable execution is needed. Before migrating, validate DB and external API quotas, concurrency limits, cookies and headers through proxies or CloudFront, streaming behavior, and costs in the real environment.
