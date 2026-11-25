import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, waitFor } from "./harness.ts";
import { ONCE } from "../../src/aws/eventflow/worker.ts";
import { memoFrom, toSteps } from "../../src/aws/eventflow/runs.ts";

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

describe("the admin API", () => {
  it("lists the functions, with their triggers and flow control", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        {
          id: "import",
          triggers: [{ event: "import/requested", if: 'event.data.plan == "pro"' }, { cron: "TZ=Europe/Paris 0 3 * * *" }],
          concurrency: [{ limit: 5, key: "event.tenant" }, { limit: 50 }],
          throttle: { limit: 60, period: "1m" },
          cancelOn: [{ event: "import/cancelled", match: "data.id" }],
        },
        async () => {},
      ),
    ]);
    const [fn] = await cluster.flow.admin.functions();
    expect(fn.id).toBe("import");
    expect(fn.triggers).toEqual([
      { event: "import/requested", if: 'event.data.plan == "pro"' },
      { cron: "TZ=Europe/Paris 0 3 * * *", timezone: "Europe/Paris" },
    ]);
    expect(fn.concurrency).toEqual([
      { limit: 5, scope: "fn", key: "event.tenant" },
      { limit: 50, scope: "fn" },
    ]);
    expect(fn.throttle?.perSecond).toBe(1);
    expect(fn.cancelOn).toEqual([{ event: "import/cancelled", match: "data.id" }]);
  });

  it("shows the queue, leases and waits", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "w", triggers: { event: "start" }, concurrency: { limit: 1, key: "event.tenant" } }, async ({ step }) => {
        await step.run("a", () => 1);
        await step.waitForEvent("approval", { event: "approved", timeout: "1h", match: "data.id" });
      }),
    ]);
    await cluster.flow.send({ name: "start", data: { id: "x" }, tenant: "acme" });
    await cluster.flow.send({ name: "start", data: { id: "y" }, tenant: "acme" });
    const before = await cluster.flow.admin.overview();
    expect(before.queue.waiting).toBe(2);
    await cluster.drain();
    await waitFor(() => ([...cluster.store.waiterItems.values()].flat().length >= 2 ? true : undefined));
    const waits = await cluster.flow.admin.waits();
    expect(waits.map((w) => [w.kind, w.event, w.tenant, w.field])).toEqual([
      ["wait", "approved", "acme", "data.id"],
      ["wait", "approved", "acme", "data.id"],
    ]);
    const leases = await cluster.flow.admin.leases();
    expect(leases[0].label).toBe("fn:w:acme");
    expect(leases[0].limit).toBe(1);
    const after = await cluster.flow.admin.overview();
    expect(after.functions).toBe(1);
    expect(after.waits.waits).toBe(2);
  });

  it("looks at the dead letters, and moves them back", async () => {
    const cluster = new Cluster(() => []);
    cluster.deadLetters.push({
      messageId: "d1",
      body: JSON.stringify({ kind: "event", event: { id: "e1", name: "order/placed", data: {}, ts: 0, tenant: "acme" } }),
      receiveCount: 6,
      sentAt: Date.now(),
    });
    const dead = await cluster.flow.admin.deadLetters();
    expect(dead).toEqual([
      expect.objectContaining({ messageId: "d1", receiveCount: 6, kind: "event", event: { id: "e1", name: "order/placed", tenant: "acme" } }),
    ]);
    // Peeking leaves them where they are.
    expect(cluster.deadLetters).toHaveLength(1);
    await cluster.flow.admin.redrive();
    expect(cluster.deadLetters).toHaveLength(0);
    expect(cluster.queue).toHaveLength(1);
  });

  it("lists the latest runs, when there are more than a page", async () => {
    const cluster = new Cluster(() => []);
    for (let i = 0; i < 1500; i++) cluster.history.set(`pay-${i}`, { status: "FAILED", payload: {}, events: [], startedAt: i + 1 });
    const runs = await cluster.flow.runs.list({ limit: 3 });
    expect(runs.map((r) => r.id)).toEqual(["pay-1499", "pay-1498", "pay-1497"]);
  });

  it("refuses an operation it doesn't know", async () => {
    const cluster = new Cluster(() => []);
    await expect(cluster.flow.getEngine().admin("drop-table")).rejects.toThrow("Unknown admin operation");
  });
});

describe("retry", () => {
  it("doesn't run again the steps that succeeded, and runs the rest", async () => {
    const calls: string[] = [];
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "order", concurrency: 2 }, async ({ step }) => {
        const charge = await step.run("charge", () => (calls.push("charge"), "ch_1"));
        await step.sleep("cool-off", "1h");
        const receipt = await step.run("receipt", () => (calls.push("receipt"), `receipt for ${charge}`));
        return receipt;
      }),
    ]);
    // A retry's run, as the router starts it: the saved results of the first run.
    await cluster.flow.getEngine().startRun({
      "sst:eventflow": 1,
      fn: "order",
      runId: "order-retry",
      event: { id: "e", name: "order/placed", data: {}, ts: 0 },
      replayOf: "order-first",
      memo: { charge: "ch_1", "cool-off": true },
    });
    const result = await cluster.run("order-retry").result;
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(result.getResult()).toBe("receipt for ch_1");
    expect(calls).toEqual(["receipt"]);
  });

  it("takes the saved results from a failed run's history", () => {
    const events = [
      { EventType: "ExecutionStarted", Id: "0" },
      { EventType: "StepStarted", Id: "1", Name: "load" },
      { EventType: "StepSucceeded", Id: "1", Name: "load", StepSucceededDetails: { Result: { Payload: '{"rows":3}' } } },
      { EventType: "WaitStarted", Id: "2", Name: "pause" },
      { EventType: "WaitSucceeded", Id: "2", Name: "pause" },
      { EventType: "ContextStarted", Id: "3", Name: "charge", SubType: "EventFlowStep" },
      { EventType: "StepSucceeded", Id: "3a", ParentId: "3", Name: "run", StepSucceededDetails: { Result: { Payload: "{}" } } },
      { EventType: "ContextSucceeded", Id: "3", Name: "charge", SubType: "EventFlowStep", ContextSucceededDetails: { Result: { Payload: '{"ok":true,"value":"ch_1"}' } } },
      { EventType: "ContextSucceeded", Id: "4", Name: "approval", SubType: "EventFlowWait", ContextSucceededDetails: { Result: { Payload: '{"id":"e2","name":"approved"}' } } },
      { EventType: "ContextSucceeded", Id: "5", Name: "receipt", SubType: "EventFlowInvoke", ContextSucceededDetails: { Result: { Payload: '{"ok":false,"error":{}}' } } },
      { EventType: "StepFailed", Id: "6", Name: "ship", StepFailedDetails: { Error: { Payload: { ErrorMessage: "down" } } } },
      { EventType: "StepSucceeded", Id: "7", Name: "sst:cancelOn", StepSucceededDetails: { Result: { Payload: "[]" } } },
    ];
    expect(memoFrom(events)).toEqual({
      load: { rows: 3 },
      pause: true,
      charge: "ch_1",
      approval: { id: "e2", name: "approved" },
    });
    const steps = toSteps(events);
    expect(steps.find((s) => s.id === "ship")).toEqual(expect.objectContaining({ status: "failed", error: { name: undefined, message: "down" } }));
  });

  it("won't reuse a result AWS truncated", () => {
    expect(() =>
      memoFrom([{ EventType: "StepSucceeded", Id: "1", Name: "big", StepSucceededDetails: { Result: { Truncated: true } } }]),
    ).toThrow("too large");
  });
});


describe("a run's steps", () => {
  it("shows a step with a concurrency limit that failed as failed", () => {
    const steps = toSteps([
      { EventType: "ContextStarted", Id: "1", Name: "ship", SubType: "EventFlowStep" },
      { EventType: "StepStarted", Id: "1a", ParentId: "1", Name: "run" },
      { EventType: "StepSucceeded", Id: "1a", ParentId: "1", Name: "run" },
      {
        EventType: "ContextSucceeded",
        Id: "1",
        Name: "ship",
        SubType: "EventFlowStep",
        ContextSucceededDetails: { Result: { Payload: '{"ok":false,"error":{"name":"Error","message":"carrier API changed"}}' } },
      },
    ]);
    const ship = steps.find((s) => s.id === "ship")!;
    expect(ship.status).toBe("failed");
    expect(ship.error?.message).toBe("carrier API changed");
    expect(ship.attempts).toBe(1);
  });
});

describe("rerunning a run", () => {
  const payload = {
    "sst:eventflow": 1,
    fn: "pay",
    runId: "pay-01",
    root: "pay-01",
    event: { id: "e", name: "order/paid", data: {}, ts: 0 },
  };
  const step = (type: string, id: string, name: string, subType?: string) => ({
    EventType: type,
    Id: id,
    Name: name,
    ...(subType ? { SubType: subType } : {}),
  });
  const flow = () =>
    new Cluster((flow) => [flow.createFunction({ id: "pay", triggers: { event: "order/paid" } }, async () => "paid")]);

  it("starts one run for two retries of the same run, unless asked again", async () => {
    const cluster = flow();
    cluster.history.set("pay-01", { status: "FAILED", payload, events: [] });
    const first = await cluster.flow.runs.retry("pay-01");
    const second = await cluster.flow.runs.retry("pay-01");
    expect(second.id).toBe(first.id);
    expect((second as any).existing).toBe(true);
    expect(cluster.starts.filter((s) => s.replayOf === "pay-01")).toHaveLength(1);
    const again = await (cluster.flow.getEngine() as any).admin("runs.retry", { runId: "pay-01", again: true });
    expect(again.id).not.toBe(first.id);
    // Every one keeps the root, so their idempotency keys are the first run's.
    expect(cluster.starts.filter((s) => s.replayOf === "pay-01").every((s) => s.root === "pay-01")).toBe(true);
  });

  it("won't retry a run whose atMostOnce step didn't finish, whatever its error, without force", async () => {
    const cluster = flow();
    cluster.history.set("pay-01", {
      status: "TIMED_OUT",
      payload,
      error: { ErrorType: "Timeout", ErrorMessage: "The run timed out" },
      events: [step("StepStarted", "1", "wire", ONCE)],
    });
    await expect(cluster.flow.runs.retry("pay-01")).rejects.toThrow('"wire"');
    expect((await cluster.flow.runs.retry("pay-01", { force: true })).id).toBeDefined();
  });

  it("retries past an atMostOnce step that finished, but won't replay it without force", async () => {
    const cluster = flow();
    cluster.history.set("pay-01", {
      status: "FAILED",
      payload,
      events: [step("StepStarted", "1", "wire", ONCE), step("StepSucceeded", "1", "wire", ONCE)],
    });
    expect((await cluster.flow.runs.retry("pay-01")).id).toBeDefined();
    await expect(cluster.flow.runs.replay("pay-01")).rejects.toThrow("would run again");
  });
});

describe("a retry that didn't start", () => {
  it("is started by the next retry, with the same run ID", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "pay" }, async () => "paid")]);
    cluster.history.set("pay-01", {
      status: "FAILED",
      payload: { "sst:eventflow": 1, fn: "pay", runId: "pay-01", root: "pay-01", event: { id: "e", name: "x", data: {}, ts: 0 } },
      events: [],
    });
    let fail = true;
    cluster.failStart = () => fail;
    await expect(cluster.flow.runs.retry("pay-01")).rejects.toThrow();
    const claimed = cluster.store.claims.get([...cluster.store.claims.keys()].find((k) => k.startsWith("RR#"))!)!.owner;
    fail = false;
    const result = await cluster.flow.runs.retry("pay-01");
    expect(result.id).toBe(claimed);
    expect(result.existing).toBeUndefined();
  });
});
