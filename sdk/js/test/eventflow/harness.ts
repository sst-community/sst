import { mock } from "bun:test";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { MemoryStore } from "./memory-store.ts";

// A fake engine for tests: the queue is an array, the store is in memory, and each
// run is a real durable execution in the local test runner.
//
// `awsFetch` is replaced before the SDK is imported, so the SDK's calls to SQS and
// Lambda come here.

export interface QueuedMessage {
  messageId: string;
  body: string;
  group?: string;
  delaySeconds?: number;
  receiveCount: number;
  sentAt: number;
}

export interface RunRecord {
  runId: string;
  payload: any;
  runner: LocalDurableTestRunner<any>;
  result: Promise<any>;
}

const state: { cluster?: Cluster; all: Cluster[] } = { all: [] };

// The router and the worker sign runs with this key.
process.env.SST_EVENTFLOW_KEY = "test-signing-key";

const actualClient = await import("../../src/aws/client.ts");
mock.module("../../src/aws/client.ts", () => ({
  ...actualClient,
  awsFetch: (service: string, path: string, init: RequestInit) => {
    if (!state.cluster) throw new Error("No test cluster");
    return state.cluster.fetch(service, path, init);
  },
}));

export const sdk = await import("../../src/aws/eventflow.ts");

let messageCounter = 0;

export class Cluster {
  store = new MemoryStore();
  queue: QueuedMessage[] = [];
  runs = new Map<string, RunRecord>();
  starts: any[] = [];
  succeeded: { id: string; body: any }[] = [];
  /** Messages that failed too often, as the dead-letter queue has them. */
  deadLetters: QueuedMessage[] = [];
  /** The ARNs of the runs that were stopped. The local runner can't stop them. */
  stopped: string[] = [];
  /** Finished runs that the run APIs list, with their history, for retry tests. */
  history = new Map<string, { status: string; payload: any; events: any[]; error?: any }>();
  /** Make a start fail, to test partial failures. */
  failStart?: (payload: any) => boolean;
  handler: (event: any, context: any) => Promise<any>;
  flow: InstanceType<typeof sdk.EventFlow>;

  constructor(build: (flow: InstanceType<typeof sdk.EventFlow>) => any[]) {
    state.cluster = this;
    state.all.push(this);
    this.flow = new sdk.EventFlow({
      id: "test",
      store: this.store,
      resource: {
        queueUrl: "https://sqs/queue",
        deadLetterQueueUrl: "https://sqs/dlq",
        routerName: "router",
        tableName: "table",
        workerName: "worker",
        workerQualifier: "1",
      },
    });
    this.handler = sdk.serve({ client: this.flow, functions: build(this.flow) }) as any;
  }

  async fetch(service: string, path: string, init: RequestInit): Promise<Response> {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const target = (init.headers as any)?.["X-Amz-Target"] as string | undefined;
    if (service === "sqs" && target === "AmazonSQS.SendMessageBatch") {
      for (const e of body.Entries)
        this.queue.push({
          messageId: `m${++messageCounter}`,
          body: e.MessageBody,
          group: e.MessageGroupId,
          delaySeconds: e.DelaySeconds,
          receiveCount: 0,
          sentAt: Date.now(),
        });
      return Response.json({ Successful: body.Entries.map((e: any) => ({ Id: e.Id })) });
    }
    if (service === "sqs" && target === "AmazonSQS.GetQueueAttributes")
      return Response.json({
        Attributes: {
          QueueArn: "arn:aws:sqs:us-east-1:1:dlq",
          ApproximateNumberOfMessages: String(body.QueueUrl.endsWith("dlq") ? this.deadLetters.length : this.queue.length),
          ApproximateNumberOfMessagesNotVisible: "0",
          ApproximateNumberOfMessagesDelayed: String(this.queue.filter((m) => m.delaySeconds).length),
        },
      });
    if (service === "sqs" && target === "AmazonSQS.ReceiveMessage")
      return Response.json({
        Messages: this.deadLetters.slice(0, body.MaxNumberOfMessages).map((m) => ({
          MessageId: m.messageId,
          Body: m.body,
          Attributes: { ApproximateReceiveCount: String(m.receiveCount), SentTimestamp: String(m.sentAt) },
        })),
      });
    if (service === "sqs" && target === "AmazonSQS.StartMessageMoveTask") {
      this.queue.push(...this.deadLetters.splice(0));
      return Response.json({ TaskHandle: "task-1" });
    }
    // The router, for the admin API.
    if (service === "lambda" && path === "/2015-03-31/functions/router/invocations")
      return Response.json(await this.handler(body, {}));
    if (service === "lambda" && path.startsWith("/2015-03-31/functions/")) {
      const name = (init.headers as any)["X-Amz-Durable-Execution-Name"];
      this.starts.push(body);
      if (this.failStart?.(body)) return new Response("TooManyRequestsException", { status: 429 });
      const existing = this.runs.get(name);
      if (existing) {
        if (JSON.stringify(existing.payload) !== JSON.stringify(body))
          return new Response('{"__type":"DurableExecutionAlreadyStartedException"}', { status: 409 });
        return new Response(null, { status: 202 });
      }
      const runner = new LocalDurableTestRunner({ handlerFunction: this.handler as any });
      const record: RunRecord = { runId: name, payload: body, runner, result: runner.run({ payload: body }) };
      this.runs.set(name, record);
      return new Response(null, { status: 202, headers: { "X-Amz-Durable-Execution-Arn": `arn/${name}` } });
    }
    const listed = path.match(/^\/2025-12-01\/functions\/[^/]+\/durable-executions\?(.*)$/);
    if (service === "lambda" && listed) {
      const name = new URLSearchParams(listed[1]).get("DurableExecutionName");
      return Response.json({
        DurableExecutions: [
          ...this.history.entries(),
          ...[...this.runs.keys()].filter((id) => !this.history.has(id)).map((id) => [id, { status: "RUNNING" }] as const),
        ]
          .filter(([id]) => !name || id === name)
          .map(([id, h]) => ({ DurableExecutionName: id, DurableExecutionArn: `arn/${id}`, Status: h.status, StartTimestamp: 1 })),
      });
    }
    const executions = path.match(/^\/2025-12-01\/durable-executions\/arn%2F([^/?]+)(\/history)?\?/);
    if (service === "lambda" && executions) {
      const h = this.history.get(decodeURIComponent(executions[1]));
      if (!h) return new Response("ResourceNotFoundException", { status: 404 });
      if (executions[2]) return Response.json({ Events: h.events });
      return Response.json({ Status: h.status, InputPayload: JSON.stringify(h.payload), Error: h.error });
    }
    const stop = path.match(/^\/2025-12-01\/durable-executions\/(.+)\/stop$/);
    if (service === "lambda" && stop) {
      this.stopped.push(decodeURIComponent(stop[1]));
      return Response.json({ StopTimestamp: Date.now() / 1000 });
    }
    const callback = path.match(/^\/2025-12-01\/durable-execution-callbacks\/([^/]+)\/succeed$/);
    if (service === "lambda" && callback) {
      const id = decodeURIComponent(callback[1]);
      const op = await this.findCallback(id);
      if (!op) return new Response('{"__type":"CallbackTimeoutException"}', { status: 400 });
      this.succeeded.push({ id, body });
      // Like the API, don't wait for the run. The local runner's call waits for the
      // invocation in progress, which may be the one making this call.
      setTimeout(() => void op.sendCallbackSuccess(JSON.stringify(body)).catch((e) => console.error("callback", e)), 50);
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected AWS call ${service} ${target ?? ""} ${path}`);
  }

  private closed = new Set<string>();

  private async findCallback(id: string) {
    if (this.closed.has(id)) return undefined;
    for (const run of this.runs.values()) {
      const names = ["event", "result"];
      for (let a = 1; a <= 3; a++)
        for (let l = 0; l <= 2; l++) for (let n = 0; n < 8; n++) names.push(`queued:${a}.${l}.${n}`);
      for (const name of names) {
        for (let i = 0; i < 4; i++) {
          try {
            const op = run.runner.getOperationByNameAndIndex(name, i);
            const details = op.getCallbackDetails();
            if (details?.callbackId === id) {
              this.closed.add(id);
              return op;
            }
          } catch (e) { if (process.env.DEBUG_HARNESS) console.log("findCallback", name, i, String(e).slice(0, 120)); }
        }
      }
    }
    return undefined;
  }

  /** Deliver the queued messages to the router, as SQS would, until none are left. */
  async drain(options: { maxRounds?: number; ignoreDelay?: boolean } = {}) {
    for (let round = 0; round < (options.maxRounds ?? 20) && this.queue.length; round++) {
      const batch = this.queue.splice(0, 10);
      const result = await this.deliver(batch);
      const failed = new Set(result.batchItemFailures.map((f: any) => f.itemIdentifier));
      for (const m of batch) if (failed.has(m.messageId)) this.queue.push(m);
    }
  }

  /** Keep delivering messages for a while, as runs send them, like an invoke. */
  async pump(ms = 1500) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.drain();
      await settle(20);
    }
  }

  async deliver(batch: QueuedMessage[]) {
    return this.handler(
      {
        Records: batch.map((m) => ({
          eventSource: "aws:sqs",
          messageId: m.messageId,
          body: m.body,
          attributes: {
            MessageGroupId: m.group,
            ApproximateReceiveCount: String(++m.receiveCount),
            SentTimestamp: String(m.sentAt),
          },
        })),
      },
      {},
    );
  }

  run(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`No run ${runId}. Runs: ${[...this.runs.keys()].join(", ")}`);
    return run;
  }

  /** The only run of a function. */
  runOf(fn: string) {
    const runs = [...this.runs.values()].filter((r) => r.payload.fn === fn);
    if (runs.length !== 1) throw new Error(`${runs.length} runs of ${fn}`);
    return runs[0];
  }
}

export async function settle(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(fn: () => T | undefined, tries = 200): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = fn();
    if (value) return value;
    await settle(10);
  }
  throw new Error("Timed out waiting");
}

/** Let every run of every cluster finish, before the test environment is torn down. */
export async function finishRuns() {
  await settle(100);
  // The test clock skips ahead, so a run left waiting times out soon. Wait for every
  // run to end, so none of them moves the clock on in the next file. A run that a
  // test stopped, which the local runner can't stop, is given up on after a while.
  await Promise.race([
    Promise.allSettled(state.all.flatMap((c) => [...c.runs.values()].map((r) => r.result))),
    settle(15_000),
  ]);
  state.all = [];
}
