import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner, WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, settle, waitFor, finishRuns } from "./harness.ts";

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

function approvals(options: { match?: string; if?: string; timeout?: string } = { match: "data.invoiceId" }) {
  return new Cluster((flow) => [
    flow.createFunction({ id: "invoice", triggers: { event: "invoice/created" } }, async ({ step }) => {
      const approval = await step.waitForEvent("wait-for-approval", {
        event: "invoice/approved",
        timeout: options.timeout ?? "1h",
        ...(options.match ? { match: options.match } : {}),
        ...(options.if ? { if: options.if } : {}),
      });
      return approval ? approval.data.by : "timed out";
    }),
  ]);
}

async function listening(cluster: Cluster) {
  const run = await waitFor(() => [...cluster.runs.values()][0]);
  await waitFor(() => [...cluster.store.waiterItems.values()].flat().length > 0 || undefined);
  return run;
}

describe("waitForEvent", () => {
  it("resumes with the event that matches", async () => {
    const cluster = approvals();
    await cluster.flow.send({ name: "invoice/created", data: { invoiceId: "inv_1" }, tenant: "acme" });
    await cluster.drain();
    const run = await listening(cluster);

    await cluster.flow.send([
      { name: "invoice/approved", data: { invoiceId: "inv_2", by: "wrong invoice" }, tenant: "acme" },
      { name: "invoice/approved", data: { invoiceId: "inv_1", by: "wrong tenant" }, tenant: "globex" },
      { name: "invoice/approved", data: { invoiceId: "inv_1", by: "bob" }, tenant: "acme" },
    ]);
    await cluster.drain();
    const result = await run.result;
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(result.getResult()).toBe("bob");
  });

  it("doesn't see an event sent before it started waiting", async () => {
    const cluster = approvals({ match: "data.invoiceId", timeout: "2s" });
    await cluster.flow.send({ name: "invoice/approved", data: { invoiceId: "inv_1", by: "too early" } });
    await cluster.flow.send({ name: "invoice/created", data: { invoiceId: "inv_1" } });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    expect((await run.result).getResult()).toBe("timed out");
  });

  it("finds an event that comes while the wait registers", async () => {
    const cluster = approvals();
    // Deliver the event after the wait added its field and noted its start time,
    // and before it added the waiter. The router stores the event but sees no
    // waiter, and the wait finds the event when it reads what came since it started.
    const putWaiter = cluster.store.putWaiter.bind(cluster.store);
    let raced = false;
    cluster.store.putWaiter = async (key, waiter) => {
      if (!raced) {
        raced = true;
        await cluster.flow.send({ name: "invoice/approved", data: { invoiceId: "inv_1", by: "racer" } });
        await cluster.drain();
        expect(cluster.succeeded).toHaveLength(0);
      }
      return putWaiter(key, waiter);
    };
    await cluster.flow.send({ name: "invoice/created", data: { invoiceId: "inv_1" } });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    expect((await run.result).getResult()).toBe("racer");
    // The wait used the event it found, without a callback.
    expect(cluster.succeeded).toHaveLength(0);
  });

  it("resumes once when the event is delivered twice", async () => {
    const cluster = approvals();
    await cluster.flow.send({ name: "invoice/created", data: { invoiceId: "inv_1" } });
    await cluster.drain();
    const run = await listening(cluster);
    await cluster.flow.send({ name: "invoice/approved", data: { invoiceId: "inv_1", by: "bob" } });
    const [message] = cluster.queue.splice(0);
    await cluster.deliver([message]);
    const again = await cluster.deliver([message]);
    expect(again.batchItemFailures).toEqual([]);
    expect((await run.result).getResult()).toBe("bob");
    expect(cluster.succeeded).toHaveLength(1);
  });

  it("matches with an `if` expression", async () => {
    const cluster = approvals({
      match: undefined,
      if: 'async.data.invoiceId == event.data.invoiceId && async.data.amount >= 100 && async.data.by != "nobody"',
    });
    await cluster.flow.send({ name: "invoice/created", data: { invoiceId: "inv_1" } });
    await cluster.drain();
    const run = await listening(cluster);
    // The match field comes from the first ==, so these are looked up by invoice.
    expect([...cluster.store.waiterItems.values()][0][0].info?.field).toBe("data.invoiceId");
    await cluster.flow.send([
      { name: "invoice/approved", data: { invoiceId: "inv_1", amount: 50, by: "too small" } },
      { name: "invoice/approved", data: { invoiceId: "inv_1", amount: 500, by: "nobody" } },
      { name: "invoice/approved", data: { invoiceId: "inv_1", amount: 500, by: "carol" } },
    ]);
    await cluster.drain();
    expect((await run.result).getResult()).toBe("carol");
  });

  it("returns null after the timeout", async () => {
    const cluster = approvals({ match: "data.invoiceId", timeout: "1s" });
    await cluster.flow.send({ name: "invoice/created", data: { invoiceId: "inv_1" } });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    expect((await run.result).getResult()).toBe("timed out");
    // An event after the timeout is skipped without an error.
    await cluster.flow.send({ name: "invoice/approved", data: { invoiceId: "inv_1", by: "late" } });
    await settle();
    await cluster.drain();
    expect(cluster.queue).toHaveLength(0);
  });

  it("throws for a match path the run's event doesn't have", async () => {
    const cluster = approvals({ match: "data.missing" });
    await cluster.flow.send({ name: "invoice/created", data: { invoiceId: "inv_1" } });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    const result = await run.result;
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(result.getError().errorMessage).toContain("data.missing");
  });
});

void WaitingOperationStatus;
