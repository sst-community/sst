import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, waitFor } from "./harness.ts";
import { idempotencyKey, ONCE } from "../../src/aws/eventflow/worker.ts";
import { onceSteps } from "../../src/aws/eventflow/runs.ts";

// Moving money: a step with a side effect must happen once, through retries,
// crashes, and retries of the run after a fix.

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

// A payment provider that charges once per idempotency key, like Stripe.
function provider() {
  const charges = new Map<string, number>();
  let calls = 0;
  return {
    charges,
    get calls() {
      return calls;
    },
    charge(key: string, amount: number) {
      calls++;
      if (!charges.has(key)) charges.set(key, amount);
      return { id: `ch_${key}` };
    },
  };
}

async function runOne(cluster: Cluster) {
  await cluster.drain();
  const run = await waitFor(() => [...cluster.runs.values()][0]);
  return { run, result: await run.result };
}

describe("idempotency keys", () => {
  it("come from the run's root, the namespace and the step", () => {
    const key = idempotencyKey("order-ABC", "", "charge");
    expect(key).toMatch(/^ef_[0-9A-Z]{26}$/);
    expect(idempotencyKey("order-ABC", "", "charge")).toBe(key);
    expect(idempotencyKey("order-ABC", "", "charge:1")).not.toBe(key);
    expect(idempotencyKey("order-ABC", "onFailure", "charge")).not.toBe(key);
    expect(idempotencyKey("order-XYZ", "", "charge")).not.toBe(key);
  });

  it("are the step's own, in every occurrence of a loop", async () => {
    const keys: string[] = [];
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "payouts", triggers: { event: "go" } }, async ({ step, idempotencyKey }: any) => {
        for (const payee of ["a", "b", "c"]) await step.run("pay", () => keys.push(idempotencyKey()));
        void payee;
      }),
    ]);
    await cluster.flow.send({ name: "go" });
    await runOne(cluster);
    expect(new Set(keys).size).toBe(3);
  });

  it("are the same in a retry or replay of a run, whatever the function ID's length", async () => {
    // A run, and a retry of it: a new run ID, the same root, signed in the payload.
    const keys: string[] = [];
    const id = "reconcile-customer-payments-across-all-regions";
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id }, async ({ step, idempotencyKey }: any) => step.run("charge", () => keys.push(idempotencyKey()))),
    ]);
    const engine = cluster.flow.getEngine();
    const event = { id: "e", name: "inngest/function.invoked", data: {}, ts: 0 };
    await engine.startRun({ "sst:eventflow": 1, fn: id, runId: "first", root: "first", event });
    await engine.startRun({ "sst:eventflow": 1, fn: id, runId: "first_rABCDEFGHJK", root: "first", replayOf: "first", event });
    await Promise.all([...cluster.runs.values()].map((r) => r.result));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("differ in onFailure from the function's", async () => {
    const keys: Record<string, string> = {};
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        {
          id: "with-refund",
          retries: 0,
          triggers: { event: "go" },
          onFailure: async ({ step, idempotencyKey }: any) => step.run("charge", () => (keys.onFailure = idempotencyKey())),
        },
        async ({ step, idempotencyKey }: any) => {
          await step.run("charge", () => (keys.main = idempotencyKey()));
          await step.run("ship", () => {
            throw new Error("no carrier");
          });
        },
      ),
    ]);
    await cluster.flow.send({ name: "go" });
    await runOne(cluster);
    expect(keys.main).toBeDefined();
    expect(keys.onFailure).toBeDefined();
    expect(keys.onFailure).not.toBe(keys.main);
  });

  it("can only be had in a step, and take no arguments", async () => {
    const errors: string[] = [];
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "misuse", triggers: { event: "go" } }, async ({ step, idempotencyKey }: any) => {
        try {
          idempotencyKey();
        } catch (error: any) {
          errors.push(error.message);
        }
        await step.run("charge", () => {
          try {
            idempotencyKey("charge");
          } catch (error: any) {
            errors.push(error.message);
          }
        });
      }),
    ]);
    await cluster.flow.send({ name: "go" });
    await runOne(cluster);
    expect(errors[0]).toContain("inside step.run");
    expect(errors[1]).toContain("no arguments");
  });

  it("charge once when the step is retried after the provider took the charge", async () => {
    const pay = provider();
    let attempts = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "pay", retries: 3, triggers: { event: "order/paid" } }, async ({ step, idempotencyKey }: any) =>
        step.run("charge", () => {
          const result = pay.charge(idempotencyKey(), 100);
          if (++attempts < 3) throw new Error("connection reset");
          return result;
        }),
      ),
    ]);
    await cluster.flow.send({ name: "order/paid" });
    const { result } = await runOne(cluster);
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(pay.calls).toBe(3);
    expect(pay.charges.size).toBe(1);
  });
});

describe("sent events", () => {
  it("have the same IDs in a retry or replay of a run", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "notify" }, async ({ step }) => step.sendEvent("tell", { name: "paid", data: {} })),
    ]);
    const engine = cluster.flow.getEngine();
    const event = { id: "e", name: "inngest/function.invoked", data: {}, ts: 0 };
    await engine.startRun({ "sst:eventflow": 1, fn: "notify", runId: "first", root: "first", event });
    await engine.startRun({ "sst:eventflow": 1, fn: "notify", runId: "first_rABCDEFGHJK", root: "first", event });
    const results = await Promise.all([...cluster.runs.values()].map((r) => r.result));
    const ids = results.map((r) => r.getResult().ids[0]);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("a crash in the middle of a step", () => {
  it("runs the step again, and the idempotency key keeps it to one charge", async () => {
    const pay = provider();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "pay", retries: 3, triggers: { event: "order/paid" } }, async ({ step, idempotencyKey }: any) =>
        step.run("charge", async () => {
          calls++;
          pay.charge(idempotencyKey(), 100);
          if (calls === 1) await gate; // the worker stops here, after the charge
          return "charged";
        }),
      ),
    ]);
    await cluster.flow.send({ name: "order/paid" });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    await waitFor(() => (calls === 1 ? true : undefined));
    // Its next checkpoint, the step's result, is refused, so its work is abandoned.
    const paused = run.runner.pauseExecution();
    release();
    await paused;
    await run.runner.resumeExecution();
    const result = await run.result;
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(calls).toBe(2);
    expect(pay.charges.size).toBe(1);
  });
  // A crash under atMostOnce can't be simulated here: the local runner keeps the
  // checkpoint it refuses, so the step's result is saved. It's proven on AWS with a
  // real crash: see the EventFlow guide.
});

describe("atMostOnce", () => {
  it("isn't retried when it throws, with or without a concurrency limit", async () => {
    for (const concurrency of [undefined, 2]) {
      let calls = 0;
      const cluster = new Cluster((flow) => [
        flow.createFunction(
          { id: `once-${concurrency ?? "none"}`, retries: 4, triggers: { event: "go" }, ...(concurrency ? { concurrency } : {}) },
          async ({ step }) =>
            step.run({ id: "transfer", atMostOnce: true }, () => {
              calls++;
              throw new Error("bank timeout");
            }),
        ),
      ]);
      await cluster.flow.send({ name: "go" });
      const { result } = await runOne(cluster);
      expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
      expect(calls).toBe(1);
    }
  });

  it("is found in a run's history, whatever the run's error says", () => {
    const events = [
      { EventType: "StepStarted", Id: "1", Name: "wire", SubType: ONCE },
      { EventType: "StepSucceeded", Id: "1", Name: "wire", SubType: ONCE, StepSucceededDetails: { Result: { Payload: "1" } } },
      { EventType: "StepStarted", Id: "2", Name: "wire:1", SubType: ONCE },
      { EventType: "StepStarted", Id: "3", Name: "email" },
    ];
    // A replay reuses nothing; a retry reuses "wire", which succeeded.
    expect(onceSteps(events).risky).toEqual(["wire", "wire:1"]);
    expect(onceSteps(events, { wire: 1 }).risky).toEqual(["wire:1"]);
  });
});

describe("rerunning a run with an atMostOnce step", () => {
  const payload = (fn: string, runId: string) => ({
    "sst:eventflow": 1,
    fn,
    runId,
    root: runId,
    event: { id: "e", name: "go", data: {}, ts: 0 },
  });
  const ok = (value: unknown) => ({ Result: { Payload: JSON.stringify(value) } });
  const flow = () =>
    new Cluster((flow) => {
      const wire = flow.createFunction({ id: "wire" }, async () => "sent");
      return [wire, flow.createFunction({ id: "order" }, async () => "done")];
    });

  it("is refused when the step is in a run it invoked, which a retry starts again", async () => {
    const cluster = flow();
    cluster.history.set("order-1", {
      status: "FAILED",
      payload: payload("order", "order-1"),
      events: [
        { EventType: "ContextStarted", Id: "1", Name: "pay", SubType: "EventFlowInvoke" },
        { EventType: "StepStarted", Id: "2", ParentId: "1", Name: "start" },
        { EventType: "StepSucceeded", Id: "2", ParentId: "1", Name: "start", StepSucceededDetails: ok({ runId: "wire-1" }) },
        { EventType: "ContextSucceeded", Id: "1", Name: "pay", SubType: "EventFlowInvoke", ContextSucceededDetails: ok({ ok: false, error: { name: "StepError", message: "bank timed out" } }) },
      ],
    });
    cluster.history.set("wire-1", {
      status: "FAILED",
      payload: { ...payload("wire", "wire-1"), parent: "cb" },
      events: [
        { EventType: "StepStarted", Id: "1", Name: "send-wire", SubType: ONCE },
        { EventType: "StepFailed", Id: "1", Name: "send-wire", SubType: ONCE },
      ],
    });
    await expect(cluster.flow.runs.retry("order-1")).rejects.toThrow('"pay → send-wire"');
    expect((await cluster.flow.runs.retry("order-1", { force: true })).id).toBeDefined();
  });

  it("isn't refused when the run it invoked succeeded, and a retry reuses its result", async () => {
    const cluster = flow();
    cluster.history.set("order-2", {
      status: "FAILED",
      payload: payload("order", "order-2"),
      events: [
        { EventType: "ContextStarted", Id: "1", Name: "pay", SubType: "EventFlowInvoke" },
        { EventType: "StepSucceeded", Id: "2", ParentId: "1", Name: "start", StepSucceededDetails: ok({ runId: "wire-2" }) },
        { EventType: "ContextSucceeded", Id: "1", Name: "pay", SubType: "EventFlowInvoke", ContextSucceededDetails: ok({ ok: true, result: "sent" }) },
        { EventType: "StepFailed", Id: "3", Name: "ship" },
      ],
    });
    cluster.history.set("wire-2", {
      status: "SUCCEEDED",
      payload: { ...payload("wire", "wire-2"), parent: "cb" },
      events: [
        { EventType: "StepStarted", Id: "1", Name: "send-wire", SubType: ONCE },
        { EventType: "StepSucceeded", Id: "1", Name: "send-wire", SubType: ONCE, StepSucceededDetails: ok(1) },
      ],
    });
    expect((await cluster.flow.runs.retry("order-2")).reused).toContain("pay");
    // A replay starts the invoked run again, so it's refused.
    await expect(cluster.flow.runs.replay("order-2")).rejects.toThrow('"pay → send-wire"');
  });

  it("is refused when the step is in onFailure, whose results a retry doesn't reuse", async () => {
    const cluster = flow();
    cluster.history.set("order-3", {
      status: "FAILED",
      payload: payload("order", "order-3"),
      events: [
        { EventType: "StepFailed", Id: "1", Name: "ship" },
        { EventType: "ContextStarted", Id: "2", Name: "onFailure" },
        { EventType: "StepStarted", Id: "3", ParentId: "2", Name: "refund", SubType: ONCE },
        { EventType: "StepSucceeded", Id: "3", ParentId: "2", Name: "refund", SubType: ONCE, StepSucceededDetails: ok(null) },
      ],
    });
    await expect(cluster.flow.runs.retry("order-3")).rejects.toThrow('"refund"');
  });

  it("is refused when the step threw under a concurrency limit, which history has as succeeded", async () => {
    const cluster = flow();
    cluster.history.set("order-4", {
      status: "FAILED",
      payload: payload("order", "order-4"),
      events: [
        { EventType: "ContextStarted", Id: "1", Name: "transfer", SubType: "EventFlowStep" },
        { EventType: "StepStarted", Id: "2", ParentId: "1", Name: "run", SubType: ONCE },
        { EventType: "StepSucceeded", Id: "2", ParentId: "1", Name: "run", SubType: ONCE, StepSucceededDetails: ok({ ok: false, error: { name: "Error", message: "bank timeout" } }) },
        { EventType: "ContextSucceeded", Id: "1", Name: "transfer", SubType: "EventFlowStep", ContextSucceededDetails: ok({ ok: false, error: { name: "Error", message: "bank timeout" } }) },
      ],
    });
    await expect(cluster.flow.runs.retry("order-4")).rejects.toThrow('"run"');
  });

  it("is allowed when the step succeeded under a concurrency limit, and a retry reuses it", async () => {
    const cluster = flow();
    cluster.history.set("order-5", {
      status: "FAILED",
      payload: payload("order", "order-5"),
      events: [
        { EventType: "ContextStarted", Id: "1", Name: "transfer", SubType: "EventFlowStep" },
        { EventType: "StepStarted", Id: "2", ParentId: "1", Name: "run", SubType: ONCE },
        { EventType: "StepSucceeded", Id: "2", ParentId: "1", Name: "run", SubType: ONCE, StepSucceededDetails: ok({ ok: true, value: 1 }) },
        { EventType: "ContextSucceeded", Id: "1", Name: "transfer", SubType: "EventFlowStep", ContextSucceededDetails: ok({ ok: true, value: 1 }) },
        { EventType: "StepFailed", Id: "3", Name: "email" },
      ],
    });
    expect((await cluster.flow.runs.retry("order-5")).reused).toEqual(["transfer"]);
  });
});
