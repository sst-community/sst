import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, sdk, waitFor } from "./harness.ts";
import { evaluate, getPath, parseExpression } from "../../src/aws/eventflow/expression.ts";
import { matcher } from "../../src/aws/eventflow/worker.ts";
import { parseCron, cronMatches, localMinute } from "../../src/aws/eventflow/cron.ts";
import { checkEvent } from "../../src/aws/eventflow/engine.ts";
import { sign } from "../../src/aws/eventflow/sign.ts";

// Each test here is a finding of the security or correctness review, reproduced, so
// it stays fixed.

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

const noop = async () => "done";

describe("only the router starts runs", () => {
  it("refuses a run that isn't signed, as from a direct invoke", async () => {
    let ran = false;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "charge" }, async () => {
        ran = true;
      }),
    ]);
    const runner = new LocalDurableTestRunner({ handlerFunction: cluster.handler as any });
    const result = await runner.run({
      payload: { "sst:eventflow": 1, fn: "charge", runId: "x", event: { id: "e", name: "x", data: {}, ts: 0 }, parent: "victim" },
    });
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(result.getError().errorMessage).toContain("only runs what its router starts");
    expect(ran).toBe(false);
    expect(cluster.succeeded).toHaveLength(0);
  });

  it("refuses a run signed with another key", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "charge" }, noop)]);
    const signed = sign({ "sst:eventflow": 1, fn: "charge", runId: "x", event: { id: "e", name: "x", data: {}, ts: 0 } });
    const runner = new LocalDurableTestRunner({ handlerFunction: cluster.handler as any });
    const result = await runner.run({ payload: { ...signed, fn: "other" } });
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
  });

  it("drops a held or invoked run from the queue that isn't signed", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "charge", triggers: { event: "go" }, idempotency: "event.data.orderId" }, noop),
    ]);
    const forged = { kind: "start", fn: "charge", at: 0, event: { id: "e1", name: "go", data: { orderId: "1" }, ts: 0 } };
    cluster.queue.push(
      { messageId: "f1", body: JSON.stringify(forged), receiveCount: 0, sentAt: Date.now() },
      { messageId: "f2", body: JSON.stringify({ ...forged, kind: "invoke", parent: "victim", runId: "r" }), receiveCount: 0, sentAt: Date.now() },
    );
    const result = await cluster.deliver(cluster.queue.splice(0));
    // Dropped, not retried.
    expect(result.batchItemFailures).toEqual([]);
    expect(cluster.runs.size).toBe(0);
  });

  it("drops a signed message that expired", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "charge" }, async () => "charged")]);
    const { sign } = await import("../../src/aws/eventflow/sign.ts");
    const old = sign({
      kind: "invoke",
      fn: "charge",
      event: { id: "e1", name: "inngest/function.invoked", data: {}, ts: 0 },
      parent: "cb",
      runId: "r",
      root: "r",
      exp: Date.now() - 1,
    });
    cluster.queue.push({ messageId: "m", body: JSON.stringify(old), receiveCount: 0, sentAt: Date.now() });
    expect((await cluster.deliver(cluster.queue.splice(0))).batchItemFailures).toEqual([]);
    expect(cluster.runs.size).toBe(0);
  });

  it("drops an event whose tenant isn't its message group", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "a", triggers: { event: "go" } }, noop)]);
    cluster.queue.push({
      messageId: "m",
      body: JSON.stringify({ kind: "event", event: { id: "e", name: "go", data: {}, ts: 0, tenant: "victim" } }),
      group: "attacker",
      receiveCount: 0,
      sentAt: Date.now(),
    });
    const result = await cluster.deliver(cluster.queue.splice(0));
    expect(result.batchItemFailures).toEqual([]);
    expect(cluster.runs.size).toBe(0);
  });

  it("drops a message that isn't JSON instead of retrying it", async () => {
    const cluster = new Cluster(() => []);
    cluster.queue.push({ messageId: "m", body: "{nope", receiveCount: 0, sentAt: Date.now() });
    expect((await cluster.deliver(cluster.queue.splice(0))).batchItemFailures).toEqual([]);
  });
});

describe("tenants are kept apart", () => {
  it("scopes event IDs to the tenant", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "a", triggers: { event: "go" } }, noop)]);
    await cluster.flow.send({ name: "go", id: "import-42", tenant: "evil" });
    await cluster.flow.send({ name: "go", id: "import-42", tenant: "acme" });
    await cluster.drain();
    expect(cluster.runs.size).toBe(2);
  });

  it("scopes idempotency keys to the tenant", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "i", triggers: { event: "go" }, idempotency: "event.data.orderId" }, noop),
    ]);
    await cluster.flow.send([
      { name: "go", data: { orderId: "1001" }, tenant: "evil" },
      { name: "go", data: { orderId: "1001" }, tenant: "acme" },
    ]);
    await cluster.drain();
    expect(cluster.runs.size).toBe(2);
  });

  it("gives each tenant its own rate limit when it has no key", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "r", triggers: { event: "go" }, rateLimit: { limit: 1, period: "1h" } }, noop),
    ]);
    await cluster.flow.send([
      { name: "go", tenant: "evil" },
      { name: "go", tenant: "evil" },
      { name: "go", tenant: "acme" },
    ]);
    await cluster.drain();
    expect([...cluster.runs.values()].map((r) => r.payload.event.tenant).sort()).toEqual(["acme", "evil"]);
  });

  it("only resumes a wait with an event of the same tenant, with tenants that look alike", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "w", triggers: { event: "start" } }, async ({ step }) =>
        step.waitForEvent("wait", { event: "go", timeout: "5s" }),
      ),
    ]);
    await cluster.flow.send({ name: "start" });
    await cluster.drain();
    await waitFor(() => ([...cluster.store.waiterItems.values()].flat().length ? true : undefined));
    // "-" used to be the key of "no tenant".
    await cluster.flow.send({ name: "go", tenant: "-" });
    await cluster.drain();
    expect(cluster.succeeded).toHaveLength(0);
  });
});

describe("flow control", () => {
  it("gives held runs a slot each, so they don't come back together", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "t", triggers: { event: "go" }, throttle: { limit: 1, period: "10s" } }, noop),
    ]);
    await cluster.flow.send([1, 2, 3, 4].map((n) => ({ name: "go", data: { n } })));
    await cluster.deliver(cluster.queue.splice(0));
    const held = cluster.queue.map((m) => JSON.parse(m.body));
    expect(held.every((m) => m.kind === "start" && m.sig)).toBe(true);
    // A held run keeps its run ID and root, so it's the same run when it comes back.
    expect(held.every((m) => m.runId && m.root === m.runId && m.exp > m.at)).toBe(true);
    const ats = held.map((m) => m.at).sort();
    // About 10 seconds apart, one slot each.
    for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1]).toBeGreaterThanOrEqual(9_000);
  });

  it("doesn't lose a rate-limited run when its start failed and the event comes again", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "a", triggers: { event: "go" } }, noop),
      flow.createFunction({ id: "b", triggers: { event: "go" }, rateLimit: { limit: 1, period: "1h" } }, noop),
    ]);
    let fail = 1;
    cluster.failStart = (p) => p.fn === "b" && fail-- > 0;
    await cluster.flow.send({ name: "go" });
    const [message] = cluster.queue.splice(0);
    await cluster.deliver([message]);
    await cluster.deliver([message]);
    expect([...cluster.runs.values()].map((r) => r.payload.fn).sort()).toEqual(["a", "b"]);
  });

  it("routes an event again when its first message ended in the dead-letter queue", async () => {
    const cluster = new Cluster((flow) => [flow.createFunction({ id: "a", triggers: { event: "go" } }, noop)]);
    cluster.failStart = () => true;
    await cluster.flow.send({ name: "go", id: "job-1" });
    const [message] = cluster.queue.splice(0);
    await cluster.deliver([message]);
    cluster.failStart = undefined;
    // Moved back from the dead-letter queue, with a new message ID.
    await cluster.deliver([{ ...message, messageId: "redriven" }]);
    expect(cluster.runs.size).toBe(1);
  });
});

describe("expressions", () => {
  it("won't let an `if` with a field the run lacks match any event that sends null", () => {
    expect(() =>
      matcher("wait", { id: "e", name: "x", data: {}, ts: 0 }, { if: "async.data.postId == event.data.postId" }),
    ).toThrow("doesn't have");
  });

  it("only orders numbers with numbers, and strings with strings", () => {
    const amount = parseExpression("async.data.amount > 100", "test");
    expect(evaluate(amount, { async: { data: { amount: 500 } } })).toBe(true);
    expect(evaluate(amount, { async: { data: { amount: "1e9" } } })).toBe(false);
    expect(evaluate(amount, { async: { data: { amount: [1000] } } })).toBe(false);
  });

  it("can't reach a prototype through a path", () => {
    expect(getPath({ data: {} }, ["data", "constructor"])).toBeUndefined();
    expect(getPath({ data: {} }, ["data", "__proto__"])).toBeUndefined();
    expect(getPath({ data: { a: [1, 2] } }, ["data", "a", "1"])).toBe(2);
  });
});

describe("events", () => {
  it("checks tenants and IDs", () => {
    expect(() => checkEvent({ name: "x", tenant: "has space" })).toThrow("tenant");
    expect(() => checkEvent({ name: "x", tenant: "a".repeat(129) })).toThrow("tenant");
    expect(() => checkEvent({ name: "x", id: "x".repeat(129) })).toThrow("id");
    expect(() => checkEvent({ name: "bad\nname" })).toThrow("control");
    expect(() => checkEvent({ name: "ok", tenant: "acme-1:eu", id: "order#42" })).not.toThrow();
  });
});

describe("cron", () => {
  it("treats */2 in a day field as unrestricted, as Vixie cron does", () => {
    // Every other day of the month, AND on Mondays: Monday 2026-01-05 is day 5.
    const cron = parseCron("0 0 */2 * 1");
    expect(cronMatches(cron, new Date("2026-01-05T00:00:00Z"))).toBe(true);
    expect(cronMatches(cron, new Date("2026-01-07T00:00:00Z"))).toBe(false);
  });

  it("names a run by the minute on the cron's clock, so a repeated hour runs once", () => {
    const cron = parseCron("TZ=America/New_York 30 1 * * *");
    // 1:30 happens twice on 2026-11-01: at 05:30 and 06:30 UTC.
    const first = new Date("2026-11-01T05:30:00Z");
    const second = new Date("2026-11-01T06:30:00Z");
    expect(cronMatches(cron, first) && cronMatches(cron, second)).toBe(true);
    expect(localMinute(cron, first)).toBe(localMinute(cron, second));
  });
});

void sdk;

describe("Inngest options EventFlow doesn't have", () => {
  it("throw on the client, and accept the ones about Inngest's cloud", () => {
    expect(() => new sdk.EventFlow({ id: "x", logger: console } as any)).toThrow("logger");
    expect(() => new sdk.EventFlow({ id: "x", middleware: [] } as any)).toThrow("middleware");
    expect(() => new sdk.EventFlow({ id: "x", eventKey: "k", isDev: true, appVersion: "1" })).not.toThrow();
  });
});
