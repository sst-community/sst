# AWS EventFlow, step by step

An order pipeline on [`sst.aws.EventFlow`](https://sst-community.github.io/sst/docs/component/aws/eventflow): event-driven functions with an Inngest-shaped API, on Lambda durable functions in your AWS account. Read the files in this order.

## 1. The infrastructure: `sst.config.ts`

```ts
const flow = new sst.aws.EventFlow("Flow", {
  handler: "src/flow.handler",
});
```

That's all the infrastructure there is, and it's made once: a queue, a router that reads it, one durable worker for every function, a DynamoDB table, and a schedule for crons. Adding a function later doesn't change it.

- Anything you add to the EventFlow's `link` is linked to its worker, so every function can use it.
- Linking `flow` to the `Api` function lets it send events, and nothing more. Looking at runs, and retrying them, takes `link: [flow.admin]`, or the `sst eventflow` CLI with your own credentials.

## 2. The client and the events: `src/client.ts`

`new EventFlow({ id })` is the client. It finds the EventFlow it's linked to.

`eventType()` declares an event and its schema. A trigger with it types `event.data`, and the data is checked when it's sent.

## 3. A function: `src/functions/process-order.ts`

This is where the work is. Each `step.run` is saved when it succeeds, so when the run resumes after a sleep, a wait, or a crash, finished steps aren't run again.

| Line | What it shows |
|------|---------------|
| `retries: 5` | Each step is tried up to 6 times, with backoff |
| `step.run("charge-card", …)` | A call to an API that fails half the time (`src/payments.ts`). It's retried until it works |
| `idempotencyKey()` | A step that runs again, after a crash, a retry or a replay, doesn't charge twice |
| `NonRetriableError` | A declined card won't get better: stop now |
| `step.waitForEvent(…, { match: "data.orderId" })` | A large order waits up to an hour for its approval |
| `step.sleep("cool-off", "10s")` | A pause that costs nothing |
| `step.invoke("send-receipt", …)` | Runs another function, and waits for what it returns |

## 4. More functions

- `src/functions/send-receipt.ts` has no triggers: it's only invoked.
- `src/functions/hourly-report.ts` has a cron trigger. It lists the last hour's runs with `flow.runs`, so the EventFlow sets `functionAdmin: true`.

## 5. Serving them: `src/flow.ts`

```ts
export const handler = serve({ client: flow, functions: [processOrder, sendReceipt, hourlyReport] });
```

To add a function, write it, and add it to this list.

## 6. Sending events: `src/api.ts`

- `flow.send()` sends an event. Its ID is the order's, so sending it twice starts one run.
- `flow.runs.idFor(processOrder, eventId)` is the run's ID, known before the run starts.
- The approve route checks a token from a linked secret before it sends the approval. In your app, check the signed-in user.

## 7. Looking at runs, and fixing them: `sst eventflow`

```bash
npx sst eventflow                     # a live view: queue, functions, leases, waits, latest runs
npx sst eventflow run <runId>         # every step, its attempts, and the first that failed
npx sst eventflow retry <runId>       # after you deploy a fix: the steps that succeeded aren't run again
npx sst eventflow replay <runId>      # run every step again
npx sst eventflow retry --failed --function process-order --since 1h
npx sst eventflow dead-letters --redrive
```

The same data is in `flow.admin` and `flow.runs`, as JSON, for a function linked to `flow.admin`, to build your own page.

## Try it

```bash
npm install
npx sst secret set ApproverToken my-token
npx sst deploy

curl -X POST "$API/orders?amount=25"                                    # returns orderId and runId
npx sst eventflow run <runId>                                           # charge-card, cool-off, send-receipt

curl -X POST "$API/orders?amount=5000"                                  # waits for approval
curl -X POST "$API/orders/<orderId>/approve" -H "x-approver-token: my-token"

npx sst shell -- bun scripts/send.ts 25                                 # send an event from a script
```

Or run it locally with `npx sst dev`. The router and the worker run on your machine, and the queue and table stay in AWS.

## Next

- `examples/aws-eventflow-use-cases`: each of Inngest's use cases as one file.
- `examples/aws-eventflow-tenants`: a multi-tenant app moved from Inngest, side by side, with the burst measurements.
- The [EventFlow guide](https://sst-community.github.io/sst/docs/eventflow) and [Migrate from Inngest](https://sst-community.github.io/sst/docs/migrate-from-inngest).
