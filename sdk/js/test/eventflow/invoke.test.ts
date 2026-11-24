import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, settle, waitFor } from "./harness.ts";

// Invokes wait for a callback with a timeout as long as the run can last. The test
// clock's skipping would jump to that timeout, so these run in real time.
beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

describe("invoke", () => {
  it("invokes another function and gets what it returns", async () => {
    const cluster = new Cluster((flow) => {
      const double = flow.createFunction({ id: "double" }, async ({ event }) => event.data.n * 2);
      const caller = flow.createFunction({ id: "caller", triggers: { event: "go" } }, async ({ step }) =>
        step.invoke("double-it", { function: double, data: { n: 21 } }),
      );
      return [double, caller];
    });
    await cluster.flow.send({ name: "go" });
    // The child starts through the router, and returns through the parent's callback.
    await cluster.pump();
    const child = await waitFor(() => [...cluster.runs.values()].find((r) => r.payload.fn === "double"));
    expect((await child.result).getResult()).toBe(42);
    const result = await cluster.runOf("caller").result;
    if (result.getStatus() !== ExecutionStatus.SUCCEEDED) console.log("CALLER", JSON.stringify(result.getError()));
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(result.getResult()).toBe(42);
  });

  it("throws in the caller when the invoked function fails", async () => {
    const cluster = new Cluster((flow) => {
      const broken = flow.createFunction({ id: "broken", retries: 0 }, async ({ step }) =>
        step.run("x", () => { throw new Error("nope"); }),
      );
      const caller = flow.createFunction({ id: "caller", triggers: { event: "go" } }, async ({ step }) => {
        try {
          await step.invoke("call", { function: broken });
          return "no error";
        } catch (error: any) {
          return `${error.name}: ${error.message}`;
        }
      });
      return [broken, caller];
    });
    await cluster.flow.send({ name: "go" });
    await cluster.pump();
    const result = await cluster.runOf("caller").result;
    expect(result.getResult()).toBe("InvokeError: nope");
  });
});

describe("cancelling an invoked run", () => {
  it("tells the run that invoked it", async () => {
    const cluster = new Cluster((flow) => {
      const child = flow.createFunction(
        { id: "child", cancelOn: [{ event: "stop", match: "data.id" }] },
        async ({ step }) => step.waitForEvent("pause", { event: "never", timeout: "5s" }),
      );
      const parent = flow.createFunction({ id: "parent", triggers: { event: "go" } }, async ({ step }) => {
        try {
          await step.invoke("call", { function: child, data: { id: "c1" } });
          return "finished";
        } catch (error: any) {
          return error.message;
        }
      });
      return [child, parent];
    });
    await cluster.flow.send({ name: "go" });
    await cluster.pump(500);
    await waitFor(() => ([...cluster.store.waiterItems.values()].flat().some((w) => w.kind === "cancel") ? true : undefined));
    await cluster.flow.send({ name: "stop", data: { id: "c1" } });
    await cluster.pump(500);
    expect(cluster.stopped).toHaveLength(1);
    const result = await cluster.runOf("parent").result;
    expect(result.getResult()).toContain("cancelled");
  });
});

describe("an invoked run's keys", () => {
  it("are the same when the run that invoked it is retried", async () => {
    const keys: string[] = [];
    const cluster = new Cluster((flow) => {
      const charge = flow.createFunction({ id: "charge" }, async ({ step, idempotencyKey }: any) =>
        step.run("charge", () => keys.push(idempotencyKey())),
      );
      const order = flow.createFunction({ id: "order" }, async ({ step }) => step.invoke("pay", { function: charge }));
      return [charge, order];
    });
    const engine = cluster.flow.getEngine();
    const event = { id: "e", name: "inngest/function.invoked", data: {}, ts: 0 };
    // A run, and a retry of it after its child failed: a new run, the same root.
    await engine.startRun({ "sst:eventflow": 1, fn: "order", runId: "first", root: "first", event });
    await cluster.pump(1500);
    await engine.startRun({ "sst:eventflow": 1, fn: "order", runId: "first_rABCDEFGHJK", root: "first", event });
    await cluster.pump(1500);
    await waitFor(() => (keys.length === 2 ? true : undefined));
    // Two child runs, one for each run that invoked it, with the same key.
    expect([...cluster.runs.values()].filter((r) => r.payload.fn === "charge")).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
