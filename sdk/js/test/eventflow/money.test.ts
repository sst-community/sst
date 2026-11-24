import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, waitFor } from "./harness.ts";
import { idempotencyKey, rootRunId } from "../../src/aws/eventflow/worker.ts";

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

describe("idempotency keys", () => {
  it("are the same for a run, its retries and replays, and differ per step and run", () => {
    const run = "order-ABC";
    expect(idempotencyKey(run, "charge")).toBe(idempotencyKey(`${run}_r0123456789`, "charge"));
    expect(idempotencyKey(`${run}_r0123456789_rABCDEFGHJK`, "charge")).toBe(idempotencyKey(run, "charge"));
    expect(rootRunId(`${run}_r0123456789`)).toBe(run);
    expect(idempotencyKey(run, "charge")).not.toBe(idempotencyKey(run, "refund"));
    expect(idempotencyKey(run, "charge")).not.toBe(idempotencyKey("order-XYZ", "charge"));
    expect(idempotencyKey(run, "charge")).toMatch(/^ef_[0-9A-Z]{26}$/);
  });

  it("charge once when the step is retried after the provider took the charge", async () => {
    const pay = provider();
    let attempts = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "pay", retries: 3, triggers: { event: "order/paid" } }, async ({ step, idempotencyKey }: any) =>
        step.run("charge", () => {
          const result = pay.charge(idempotencyKey("charge"), 100);
          // The charge went through, but the response was lost.
          if (++attempts < 3) throw new Error("connection reset");
          return result;
        }),
      ),
    ]);
    await cluster.flow.send({ name: "order/paid" });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    expect((await run.result).getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(pay.calls).toBe(3);
    expect(pay.charges.size).toBe(1);
  });
});

describe("a crash in the middle of a step", () => {
  async function crashDuringCharge(atMostOnce: boolean) {
    const pay = provider();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "pay", retries: 3, triggers: { event: "order/paid" } }, async ({ step, idempotencyKey }: any) => {
        const charge = await step.run({ id: "charge", atMostOnce }, async () => {
          calls++;
          pay.charge(idempotencyKey("charge"), 100);
          if (calls === 1) await gate; // the worker stops here, after the charge
          return "charged";
        });
        return charge;
      }),
    ]);
    await cluster.flow.send({ name: "order/paid" });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    // The charge has gone through, and the step hasn't saved its result.
    await waitFor(() => (calls === 1 ? true : undefined));
    // The invocation is abandoned part way, as when Lambda crashes or times out.
    // Its next checkpoint, the step's result, is refused, so its work is abandoned.
    const paused = run.runner.pauseExecution();
    release();
    await paused;
    await run.runner.resumeExecution();
    const result = await Promise.race([run.result, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    if (!result) {
      const ops = (run.runner as any).getOperations?.() ?? [];
      throw new Error(`The run didn't end. calls=${calls}, charges=${pay.charges.size}, ops=${JSON.stringify(ops.map?.((o: any) => [o.getName?.(), o.getStatus?.()]) ?? [])}`);
    }
    const status = result.getStatus();
    return { status, calls, charges: pay.charges.size, error: status === ExecutionStatus.FAILED ? result.getError()?.errorMessage : undefined };
  }

  it("runs the step again, and the idempotency key keeps it to one charge", async () => {
    const outcome = await crashDuringCharge(false);
    expect(outcome.status).toBe(ExecutionStatus.SUCCEEDED);
    expect(outcome.calls).toBe(2);
    expect(outcome.charges).toBe(1);
  });

  // A crash under atMostOnce can't be simulated here: the local runner keeps the
  // checkpoint it refuses, so the step's result is saved. It's proven on AWS with a
  // real crash: see the EventFlow PR.
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
      await cluster.drain();
      const run = await waitFor(() => [...cluster.runs.values()][0]);
      expect((await run.result).getStatus()).toBe(ExecutionStatus.FAILED);
      expect(calls).toBe(1);
    }
  });
});
