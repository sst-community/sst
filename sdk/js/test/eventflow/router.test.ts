import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns } from "./harness.ts";

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

const noop = async () => "done";

describe("routing", () => {
  it("fans an event out to every function it triggers, and none other", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "a", triggers: { event: "user/created" } }, noop),
      flow.createFunction({ id: "b", triggers: [{ event: "user/deleted" }, { event: "user/created" }] }, noop),
      flow.createFunction({ id: "c", triggers: { event: "user/deleted" } }, noop),
      flow.createFunction({ id: "pro", triggers: { event: "user/created", if: 'event.data.plan == "pro"' } }, noop),
    ]);
    await cluster.flow.send({ name: "user/created", data: { plan: "free" } });
    await cluster.drain();
    expect([...cluster.runs.values()].map((r) => r.payload.fn).sort()).toEqual(["a", "b"]);
  });

  it("starts one run when a message is delivered twice", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "a", triggers: { event: "go" } }, noop)]);
    await cluster.flow.send({ name: "go" });
    const [message] = cluster.queue.splice(0);
    await cluster.deliver([message]);
    await cluster.deliver([message]);
    expect(cluster.runs.size).toBe(1);
    expect(cluster.starts).toHaveLength(2);
  });

  it("skips a second send of an event ID", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "a", triggers: { event: "go" } }, noop)]);
    await cluster.flow.send({ name: "go", id: "job-1", data: { n: 1 } });
    await cluster.drain();
    await cluster.flow.send({ name: "go", id: "job-1", data: { n: 2 } });
    await cluster.drain();
    expect(cluster.runs.size).toBe(1);
    expect(cluster.starts).toHaveLength(1);
    expect(cluster.runOf("a").payload.event.data).toEqual({ n: 1 });
  });

  it("retries a message whose fan-out failed part way, and starts each run once", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "a", triggers: { event: "go" } }, noop),
      flow.createFunction({ id: "b", triggers: { event: "go" } }, noop),
      flow.createFunction({ id: "c", triggers: { event: "go" } }, noop),
    ]);
    let failures = 1;
    cluster.failStart = (p) => p.fn === "b" && failures-- > 0;
    await cluster.flow.send({ name: "go" });
    const [message] = cluster.queue.splice(0);
    const first = await cluster.deliver([message]);
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: message.messageId }]);
    expect([...cluster.runs.keys()].length).toBe(1);
    const second = await cluster.deliver([message]);
    expect(second.batchItemFailures).toEqual([]);
    expect([...cluster.runs.values()].map((r) => r.payload.fn).sort()).toEqual(["a", "b", "c"]);
  });

  it("reports only the messages that failed in a batch", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "a", triggers: { event: "go" } }, noop)]);
    cluster.failStart = (p) => p.event.data.n === 2;
    await cluster.flow.send([1, 2, 3].map((n) => ({ name: "go", data: { n } })));
    const batch = cluster.queue.splice(0);
    const result = await cluster.deliver(batch);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: batch[1].messageId }]);
    expect(cluster.runs.size).toBe(2);
  });

  it("sends the tenant as the message group", async () => {
    const cluster = new Cluster(() => []);
    await cluster.flow.send([
      { name: "go", tenant: "acme" },
      { name: "go" },
    ]);
    expect(cluster.queue.map((m) => m.group)).toEqual(["acme", undefined]);
  });
});

describe("flow control at the start", () => {
  it("holds runs over a throttle, and starts them later", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        { id: "t", triggers: { event: "go" }, throttle: { limit: 2, period: "1m", burst: 1, key: "event.data.tenant" } },
        noop,
      ),
    ]);
    await cluster.flow.send([1, 2, 3, 4, 5].map((n) => ({ name: "go", data: { n, tenant: "a" } })));
    await cluster.deliver(cluster.queue.splice(0));
    // A burst of 1, plus one for the start of the window.
    expect(cluster.runs.size).toBe(2);
    const held = cluster.queue.map((m) => JSON.parse(m.body));
    expect(held.map((m) => m.kind)).toEqual(["start", "start", "start"]);
    expect(cluster.queue.every((m) => m.delaySeconds! > 0 && m.delaySeconds! <= 900)).toBe(true);
    // Other keys aren't held back.
    await cluster.flow.send({ name: "go", data: { n: 6, tenant: "b" } });
    await cluster.deliver(cluster.queue.splice(-1));
    expect(cluster.runs.size).toBe(3);
  });

  it("skips runs over a rate limit", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "r", triggers: { event: "go" }, rateLimit: { limit: 1, period: "1h" } }, noop),
    ]);
    await cluster.flow.send([1, 2, 3].map((n) => ({ name: "go", data: { n } })));
    await cluster.drain();
    expect(cluster.runs.size).toBe(1);
    expect(cluster.queue).toHaveLength(0);
  });

  it("starts one run per idempotency key in 24 hours", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "i", triggers: { event: "go" }, idempotency: "event.data.orderId" }, noop),
    ]);
    await cluster.flow.send([
      { name: "go", data: { orderId: "o1" } },
      { name: "go", data: { orderId: "o1" } },
      { name: "go", data: { orderId: "o2" } },
    ]);
    await cluster.drain();
    expect(cluster.runs.size).toBe(2);
  });
});

describe("cron", () => {
  it("starts the functions that are due on a tick, once per minute", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "every-5", triggers: { cron: "*/5 * * * *" } }, noop),
      flow.createFunction({ id: "paris-9am", triggers: { cron: "TZ=Europe/Paris 0 9 * * *" } }, noop),
      flow.createFunction({ id: "never-now", triggers: { cron: "0 0 1 1 *" } }, noop),
    ]);
    // 08:00 UTC is 09:00 in Paris in winter.
    await cluster.handler({ "sst:eventflow:tick": "2026-01-15T08:00:00Z" }, {});
    await cluster.handler({ "sst:eventflow:tick": "2026-01-15T08:00:00Z" }, {});
    expect([...cluster.runs.values()].map((r) => r.payload.fn).sort()).toEqual(["every-5", "paris-9am"]);
    const run = cluster.runOf("every-5");
    expect(run.payload.event.name).toBe("inngest/scheduled.timer");
    expect(run.payload.event.data).toEqual({ cron: "*/5 * * * *" });
  });
});

describe("the handler", () => {
  it("refuses an event it doesn't know", async () => {
    const cluster = new Cluster(() => []);
    await expect(cluster.handler({ hello: "world" }, {})).rejects.toThrow("doesn't know");
  });
});
