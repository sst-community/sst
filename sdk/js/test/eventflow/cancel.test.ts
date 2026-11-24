import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, settle, waitFor } from "./harness.ts";

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

// A reminder that waits, and is cancelled when the user acts first. The wait for an
// event that never comes stands in for a long sleep, since the test clock skips
// sleeps.
function reminders(cancelOn: any[]) {
  return new Cluster((flow) => [
    flow.createFunction(
      { id: "reminder", triggers: { event: "cart/item.added" }, cancelOn },
      async ({ step }) => {
        await step.waitForEvent("pause", { event: "never", timeout: "5s" });
        return step.run("remind", () => "reminded");
      },
    ),
  ]);
}

async function started(cluster: Cluster) {
  const run = await waitFor(() => [...cluster.runs.values()][0]);
  // Wait for the run to register its cancelOn and its pause.
  await waitFor(() => ([...cluster.store.waiterItems.values()].flat().length >= 2 ? true : undefined));
  return run;
}

describe("cancelOn", () => {
  it("stops the run when a matching event comes", async () => {
    const cluster = reminders([{ event: "cart/purchased", match: "data.cartId" }]);
    await cluster.flow.send({ name: "cart/item.added", data: { cartId: "c1" }, tenant: "acme" });
    await cluster.drain();
    await started(cluster);

    await cluster.flow.send([
      { name: "cart/purchased", data: { cartId: "c2" }, tenant: "acme" },
      { name: "cart/purchased", data: { cartId: "c1" }, tenant: "globex" },
    ]);
    await cluster.drain();
    expect(cluster.stopped).toHaveLength(0);

    await cluster.flow.send({ name: "cart/purchased", data: { cartId: "c1" }, tenant: "acme" });
    await cluster.drain();
    // The run's own ARN, from its durable context.
    expect(cluster.stopped).toHaveLength(1);
    expect(cluster.store.waiterItems.size).toBeGreaterThan(0);
  });

  it("cancels with an `if`", async () => {
    const cluster = reminders([
      { event: "cart/purchased", if: "async.data.cartId == event.data.cartId && async.data.total > 0" },
    ]);
    await cluster.flow.send({ name: "cart/item.added", data: { cartId: "c1" } });
    await cluster.drain();
    await started(cluster);
    await cluster.flow.send({ name: "cart/purchased", data: { cartId: "c1", total: 0 } });
    await cluster.drain();
    expect(cluster.stopped).toHaveLength(0);
    await cluster.flow.send({ name: "cart/purchased", data: { cartId: "c1", total: 10 } });
    await cluster.drain();
    expect(cluster.stopped).toHaveLength(1);
  });

  it("stops listening when the run ends", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        { id: "quick", triggers: { event: "go" }, cancelOn: [{ event: "stop", match: "data.id" }] },
        async ({ step }) => step.run("work", () => "done"),
      ),
    ]);
    await cluster.flow.send({ name: "go", data: { id: "x" } });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    expect((await run.result).getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect([...cluster.store.waiterItems.values()].flat()).toHaveLength(0);
    await cluster.flow.send({ name: "stop", data: { id: "x" } });
    await settle();
    await cluster.drain();
    expect(cluster.stopped).toHaveLength(0);
  });

  it("throws for a cancelOn with both match and if", () => {
    const cluster = new Cluster(() => []);
    expect(() =>
      cluster.flow.createFunction(
        { id: "bad", cancelOn: [{ event: "x", match: "data.id", if: "async.data.id == 1" }] },
        async () => {},
      ),
    ).toThrow('both "match" and "if"');
  });
});
