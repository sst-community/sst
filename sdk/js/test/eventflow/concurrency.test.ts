import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, waitFor } from "./harness.ts";
import { MemoryStore } from "./memory-store.ts";
import { backoffMs } from "../../src/aws/eventflow/worker.ts";
import type { LeaseWaiter } from "../../src/aws/eventflow/store.ts";

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

const waiter = (leaseId: string, tenant: string, at: number): LeaseWaiter => ({
  leaseId,
  tenant,
  callbackId: `cb-${leaseId}`,
  runId: `run-${leaseId}`,
  at,
  expiresAt: at + 300_000,
});

describe("leases", () => {
  it("holds a limit, and a newcomer can't jump the line", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#a", limit: 2 };
    expect(await store.acquire(limit, "a1", "a", 60_000)).toBe(true);
    expect(await store.acquire(limit, "a2", "a", 60_000)).toBe(true);
    expect(await store.acquire(limit, "a3", "a", 60_000)).toBe(false);
    await store.enqueue(limit, waiter("a3", "a", 1));
    await store.release(limit, "a1", "a");
    // A lease is free, but a step waits for it, so a newcomer queues too.
    expect(await store.acquire(limit, "b1", "b", 60_000)).toBe(false);
    const woken: string[] = [];
    await store.dispatch(limit, 60_000, async (w) => (woken.push(w.leaseId), true));
    expect(woken).toEqual(["a3"]);
    expect(store.active("C#a")).toBe(2);
  });

  it("wakes the tenant with the fewest leases first, then the oldest", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#shared", limit: 3 };
    for (const id of ["a1", "a2", "b1"]) await store.acquire(limit, id, id[0], 60_000);
    await store.enqueue(limit, waiter("a3", "a", 1));
    await store.enqueue(limit, waiter("a4", "a", 2));
    await store.enqueue(limit, waiter("c1", "c", 3));
    await store.enqueue(limit, waiter("b2", "b", 4));
    const woken: string[] = [];
    const wake = async (w: LeaseWaiter) => (woken.push(w.leaseId), true);
    for (const id of ["a1", "a2", "b1"]) {
      await store.release(limit, id, id[0]);
      await store.dispatch(limit, 60_000, wake);
    }
    // Each time, the tenant with the fewest leases: c, which has none, though it
    // asked after a; then a, which is down to none; then b.
    expect(woken).toEqual(["c1", "a3", "b2"]);
  });

  it("gives the lease of a step that's gone to the next one", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#x", limit: 1 };
    await store.acquire(limit, "held", "a", 60_000);
    await store.enqueue(limit, waiter("gone", "a", 1));
    await store.enqueue(limit, waiter("next", "b", 2));
    await store.release(limit, "held", "a");
    const woken: string[] = [];
    await store.dispatch(limit, 60_000, async (w) => {
      if (w.leaseId === "gone") return false;
      woken.push(w.leaseId);
      return true;
    });
    expect(woken).toEqual(["next"]);
    expect(store.active("C#x")).toBe(1);
  });

  it("gives back a lease that expired, as when a run crashes holding it", async () => {
    const store = new MemoryStore();
    let now = 1_000_000;
    store.now = () => now;
    const limit = { item: "C#f", limit: 1 };
    expect(await store.acquire(limit, "crashed", "a", 30_000)).toBe(true);
    expect(await store.acquire(limit, "next", "a", 30_000)).toBe(false);
    now += 30_001;
    expect(await store.acquire(limit, "next", "a", 30_000)).toBe(true);
    expect(await store.renew(limit, "crashed", 30_000)).toBe(false);
  });

  it("keeps no tenant with no leases", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#t", limit: 100 };
    for (let i = 0; i < 50; i++) {
      await store.acquire(limit, `l${i}`, `tenant-${i}`, 60_000);
      await store.release(limit, `l${i}`, `tenant-${i}`);
    }
    expect(Object.keys(store.limits.get("C#t")!.tenants)).toHaveLength(0);
  });
});

describe("steps under a concurrency limit", () => {
  it("never runs more steps of a tenant at once than its limit, and frees the lease in a sleep", async () => {
    let active = 0;
    let most = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        { id: "limited", triggers: { event: "job" }, concurrency: { limit: 1, key: "event.data.tenant" } },
        async ({ step }) => {
          await step.run("work", async () => {
            active++;
            most = Math.max(most, active);
            await new Promise((r) => setTimeout(r, 30));
            active--;
            return "ok";
          });
          await step.sleep("rest", "1m");
          return step.run("again", () => "done");
        },
      ),
    ]);
    await cluster.flow.send([1, 2, 3].map((n) => ({ name: "job", data: { n, tenant: "a" } })));
    await cluster.drain();
    const runs = await waitFor(() => (cluster.runs.size === 3 ? [...cluster.runs.values()] : undefined));
    const results = await Promise.all(runs.map((r) => r.result));
    expect(results.map((r) => r.getStatus())).toEqual([
      ExecutionStatus.SUCCEEDED,
      ExecutionStatus.SUCCEEDED,
      ExecutionStatus.SUCCEEDED,
    ]);
    expect(most).toBe(1);
    // Some had to wait in line.
    expect(cluster.store.log.some(([, , , ok]) => !ok)).toBe(true);
    // Every lease was given back.
    for (const k of cluster.store.limits.keys()) expect(cluster.store.active(k)).toBe(0);
  });

  it("retries a limited step, taking a lease for each attempt", async () => {
    let attempts = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "retry-limited", retries: 2, triggers: { event: "job" }, concurrency: 2 }, async ({ step }) =>
        step.run("call", () => {
          if (++attempts < 3) throw new Error("flaky");
          return attempts;
        }),
      ),
    ]);
    await cluster.flow.send({ name: "job" });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    expect((await run.result).getResult()).toBe(3);
    expect(cluster.store.log.filter(([, , , ok]) => ok)).toHaveLength(3);
    for (const k of cluster.store.limits.keys()) expect(cluster.store.active(k)).toBe(0);
  });

  it("fails with the step's error once the retries are used up", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "fail-limited", retries: 1, triggers: { event: "job" }, concurrency: 2 }, async ({ step }) =>
        step.run("call", () => {
          throw new TypeError("bad input");
        }),
      ),
    ]);
    await cluster.flow.send({ name: "job" });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    const result = await run.result;
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(result.getError().errorMessage).toBe("bad input");
  });

  it("doesn't run a step again when giving back its lease fails", async () => {
    let calls = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "release-fails", triggers: { event: "job" }, concurrency: 1 }, async ({ step }) =>
        step.run("charge", () => ++calls),
      ),
    ]);
    cluster.store.release = async () => {
      throw new Error("DynamoDB is down");
    };
    await cluster.flow.send({ name: "job" });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    const result = await run.result;
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(calls).toBe(1);
  });
});

// A burst, simulated with the same store: tenant A sends 25 jobs a second for 40
// seconds, and 10 seconds in, tenant B sends 10. Each job is one step of 1 second,
// under a shared limit of 20. A step that can't get a lease joins the line, and a
// release hands its lease to the next step, fairest first. The clock is simulated,
// so this checks the policy, not AWS. The AWS numbers are in the EventFlow docs.
async function simulate(options: { fair: boolean }) {
  const store = new MemoryStore();
  let now = 0;
  store.now = () => now;
  if (!options.fair) {
    // The same, first come first served: the oldest waiter, whatever its tenant.
    store.dispatch = async (limit, leaseMs, wake) => {
      const l = store.item(limit);
      let woken = 0;
      while (Object.keys(l.leases).length < limit.limit && l.queue.length) {
        const next = l.queue.shift()!;
        l.leases[next.leaseId] = { expires: now + leaseMs, tenant: next.tenant };
        if (await wake(next)) woken++;
      }
      return woken;
    };
  }
  const limit = { item: "C#shared", limit: 20 };
  type Job = { id: string; tenant: string; arrive: number; started?: number; done?: number };
  const jobs: Job[] = [
    ...Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}`, tenant: "a", arrive: i * 0.04 })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, tenant: "b", arrive: 10 + i * 0.1 })),
  ];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const events: { at: number; kind: "arrive" | "end"; job: Job }[] = jobs.map((job) => ({ at: job.arrive, kind: "arrive", job }));
  const wake = async (w: LeaseWaiter) => {
    const job = byId.get(w.leaseId)!;
    job.started = now;
    events.push({ at: now + 1, kind: "end", job });
    return true;
  };
  while (events.length) {
    events.sort((x, y) => x.at - y.at);
    const e = events.shift()!;
    now = e.at;
    if (e.kind === "arrive") {
      if (await store.acquire(limit, e.job.id, e.job.tenant, 60)) {
        e.job.started = now;
        events.push({ at: now + 1, kind: "end", job: e.job });
      } else {
        await store.enqueue(limit, { leaseId: e.job.id, tenant: e.job.tenant, callbackId: e.job.id, runId: e.job.id, at: now, expiresAt: now + 300 });
        await store.dispatch(limit, 60, wake);
      }
    } else {
      e.job.done = now;
      await store.release(limit, e.job.id, e.job.tenant);
      await store.dispatch(limit, 60, wake);
    }
  }
  const b = jobs.filter((j) => j.tenant === "b");
  const a = jobs.filter((j) => j.tenant === "a");
  return {
    bWorst: Math.max(...b.map((j) => j.started! - j.arrive)),
    bDone: Math.max(...b.map((j) => j.done!)),
    aDone: Math.max(...a.map((j) => j.done!)),
  };
}

describe("a burst from one tenant", () => {
  it("lets the other tenant through long before the backlog drains, and keeps the limit busy", async () => {
    const fair = await simulate({ fair: true });
    // 1000 jobs at 20 at a time is 50 seconds, and nothing is left idle.
    expect(fair.aDone).toBeLessThan(52);
    // B's jobs start as soon as a lease frees up after they arrive.
    expect(fair.bWorst).toBeLessThanOrEqual(1);
    expect(fair.bDone).toBeLessThan(fair.aDone / 2);
  });

  it("is fairer than first come first served", async () => {
    const fair = await simulate({ fair: true });
    const fifo = await simulate({ fair: false });
    console.log("burst simulation", { fair, fifo });
    expect(fair.bWorst).toBeLessThan(fifo.bWorst);
    expect(fair.bDone).toBeLessThan(fifo.bDone);
  });
});

describe("backoff", () => {
  it("is a number for every seed", () => {
    for (let i = 0; i < 2000; i++) {
      const ms = backoffMs(1 + (i % 12), `run-${i}`);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(1000);
    }
  });

  it("doubles from 2 seconds to at most 10 minutes, with jitter from the seed", () => {
    const delays = [1, 2, 3, 10, 20].map((n) => backoffMs(n, "seed"));
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThanOrEqual(2000);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[4]).toBeLessThanOrEqual(600_000);
    expect(backoffMs(3, "seed")).toBe(delays[2]);
  });
});

describe("a run's steps one after another", () => {
  it("keep one lease, and give it back when the run sleeps or ends", async () => {
    let active = 0;
    let most = 0;
    const work = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "chain", triggers: { event: "go" }, concurrency: 1 }, async ({ step }) => {
        await step.run("a", work);
        await step.run("b", work);
        await step.run("c", work);
        await step.sleep("rest", "1m");
        // Two at once still need two leases, so with a limit of 1 they take turns.
        await Promise.all([step.run("d", work), step.run("e", work)]);
      }),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    const run = await waitFor(() => [...cluster.runs.values()][0]);
    expect((await run.result).getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    // a, b and c share one lease: before the sleep, the run asked for one once.
    const asked = cluster.store.log.map(([, , , ok]) => ok);
    expect(asked[0]).toBe(true);
    expect(asked.filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(most).toBe(1);
    for (const k of cluster.store.limits.keys()) expect(cluster.store.active(k)).toBe(0);
  });
});

describe("asking again", () => {
  it("keeps a step's place in line, and counts it once", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#q", limit: 1 };
    await store.acquire(limit, "held", "a", 60_000);
    await store.enqueue(limit, { ...waiter("first", "b", 1), callbackId: "cb-old" });
    await store.enqueue(limit, waiter("second", "c", 2));
    // "first" timed out waiting, and asks again, with its first time.
    await store.enqueue(limit, { ...waiter("first", "b", 1), callbackId: "cb-new" });
    expect(store.item(limit).queue).toHaveLength(2);
    await store.release(limit, "held", "a");
    const woken: string[] = [];
    await store.dispatch(limit, 60_000, async (w) => (woken.push(w.callbackId), true));
    expect(woken).toEqual(["cb-new"]);
  });
});
