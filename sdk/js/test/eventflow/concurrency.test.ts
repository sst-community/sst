import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, finishRuns, waitFor } from "./harness.ts";
import { MemoryStore } from "./memory-store.ts";
import { backoffMs } from "../../src/aws/eventflow/worker.ts";
import type { LeaseWaiter, Limit } from "../../src/aws/eventflow/store.ts";

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

const waiter = (leaseId: string, tenant: string, at: number, limits: Limit[]): LeaseWaiter => ({
  leaseId,
  tenant,
  limits,
  callbackId: `cb-${leaseId}`,
  runId: `run-${leaseId}`,
  at,
  expiresAt: at + 300_000,
});

describe("leases", () => {
  it("takes every limit at once, or none", async () => {
    const store = new MemoryStore();
    const tenant = { item: "C#t", limit: 2 };
    const shared = { item: "C#s", limit: 1 };
    expect(await store.acquire([tenant, shared], "l1", "a", 60_000)).toBe("granted");
    // The shared limit is full: the tenant's lease isn't taken either.
    expect(await store.acquire([tenant, shared], "l2", "a", 60_000)).toBe("full");
    expect(store.active("C#t")).toBe(1);
    // Asking again for a lease it holds is fine.
    expect(await store.acquire([tenant, shared], "l1", "a", 60_000)).toBe("granted");
  });

  it("can't deadlock two steps that need two limits in opposite orders", async () => {
    // A transfer locks both accounts: A→B and B→A, each with a limit of 1.
    const store = new MemoryStore();
    const A = { item: "C#A", limit: 1 };
    const B = { item: "C#B", limit: 1 };
    expect(await store.acquire([A, B], "ab", "x", 60_000)).toBe("granted");
    expect(await store.acquire([B, A], "ba", "x", 60_000)).toBe("full");
    // B→A holds nothing while it waits.
    expect(store.active("C#B")).toBe(1);
    await store.enqueue(waiter("ba", "x", 1, [B, A]));
    await store.release([A, B], "ab", "x");
    const woken: string[] = [];
    for (const l of [A, B]) await store.dispatch(l, async (w) => (woken.push(w.leaseId), true));
    expect(woken).toEqual(["ba"]);
    expect(store.active("C#A") + store.active("C#B")).toBe(2);
  });

  it("holds a limit, and a newcomer can't jump the line", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#a", limit: 2 };
    expect(await store.acquire([limit], "a1", "a", 60_000)).toBe("granted");
    expect(await store.acquire([limit], "a2", "a", 60_000)).toBe("granted");
    expect(await store.acquire([limit], "a3", "a", 60_000)).toBe("full");
    await store.enqueue(waiter("a3", "a", 1, [limit]));
    await store.release([limit], "a1", "a");
    expect(await store.acquire([limit], "b1", "b", 60_000)).toBe("full");
    const woken: string[] = [];
    await store.dispatch(limit, async (w) => (woken.push(w.leaseId), true));
    expect(woken).toEqual(["a3"]);
  });

  it("wakes the tenant with the fewest leases first, then the oldest", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#shared", limit: 3 };
    for (const id of ["a1", "a2", "b1"]) await store.acquire([limit], id, id[0], 60_000);
    for (const [id, t, at] of [["a3", "a", 1], ["a4", "a", 2], ["c1", "c", 3], ["b2", "b", 4]] as const)
      await store.enqueue(waiter(id, t, at, [limit]));
    const woken: string[] = [];
    for (const id of ["a1", "a2", "b1"]) {
      await store.release([limit], id, id[0]);
      await store.dispatch(limit, async (w) => (woken.push(w.leaseId), true));
    }
    expect(woken).toEqual(["c1", "a3", "b2"]);
  });

  it("finds a quiet tenant behind more than 50 steps of a busy one", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#busy", limit: 2 };
    await store.acquire([limit], "held", "a", 60_000);
    await store.acquire([limit], "still", "a", 60_000);
    for (let i = 0; i < 200; i++) await store.enqueue(waiter(`a${i}`, "a", i, [limit]));
    await store.enqueue(waiter("b0", "b", 1000, [limit]));
    // a still holds a lease, and b none: b is next, though 200 of a's asked first.
    await store.release([limit], "held", "a");
    const woken: string[] = [];
    await store.dispatch(limit, async (w) => (woken.push(w.leaseId), true));
    expect(woken).toEqual(["b0"]);
  });

  it("gives the leases of a step that's gone to the next one", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#x", limit: 1 };
    await store.acquire([limit], "held", "a", 60_000);
    await store.enqueue(waiter("gone", "a", 1, [limit]));
    await store.enqueue(waiter("next", "b", 2, [limit]));
    await store.release([limit], "held", "a");
    const woken: string[] = [];
    await store.dispatch(limit, async (w) => {
      if (w.leaseId === "gone") return false;
      woken.push(w.leaseId);
      return true;
    });
    expect(woken).toEqual(["next"]);
    expect(store.active("C#x")).toBe(1);
  });

  it("gives back a lease that expired, and won't renew it", async () => {
    const store = new MemoryStore();
    let now = 1_000_000;
    store.now = () => now;
    const limit = { item: "C#f", limit: 1 };
    expect(await store.acquire([limit], "crashed", "a", 30_000)).toBe("granted");
    now += 30_001;
    expect(await store.renew([limit], "crashed", 30_000)).toBe(false);
    expect(await store.acquire([limit], "next", "a", 30_000)).toBe("granted");
  });

  it("keeps a step's place, and counts it once, when it asks again", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#q", limit: 1 };
    await store.acquire([limit], "held", "a", 60_000);
    await store.enqueue({ ...waiter("first", "b", 1, [limit]), callbackId: "cb-old" });
    await store.enqueue(waiter("second", "c", 2, [limit]));
    await store.enqueue({ ...waiter("first", "b", 1, [limit]), callbackId: "cb-new" });
    expect(store.queued("C#q")).toBe(2);
    await store.release([limit], "held", "a");
    const woken: string[] = [];
    await store.dispatch(limit, async (w) => (woken.push(w.callbackId), true));
    expect(woken).toEqual(["cb-new"]);
  });

  it("keeps no tenant with no leases", async () => {
    const store = new MemoryStore();
    const limit = { item: "C#t", limit: 100 };
    for (let i = 0; i < 50; i++) {
      await store.acquire([limit], `l${i}`, `tenant-${i}`, 60_000);
      await store.release([limit], `l${i}`, `tenant-${i}`);
    }
    expect(Object.keys(store.limits.get("C#t")!.tenants)).toHaveLength(0);
  });
});

async function runAll(cluster: Cluster, count: number) {
  await cluster.drain();
  const runs = await waitFor(() => (cluster.runs.size === count ? [...cluster.runs.values()] : undefined), 1000);
  return Promise.all(runs.map((r) => r.result));
}

describe("steps under a concurrency limit", () => {
  it("never runs more steps of a tenant at once than its limit, and frees the lease in a sleep", async () => {
    let active = 0;
    let most = 0;
    const work = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "limited", triggers: { event: "job" }, concurrency: { limit: 1, key: "event.tenant" } }, async ({ step }) => {
        await step.run("work", work);
        await step.sleep("rest", "1m");
        await step.run("again", work);
      }),
    ]);
    await cluster.flow.send([1, 2, 3].map((n) => ({ name: "job", data: { n }, tenant: "a" })));
    const results = await runAll(cluster, 3);
    expect(results.every((r) => r.getStatus() === ExecutionStatus.SUCCEEDED)).toBe(true);
    expect(most).toBe(1);
    expect(cluster.store.log.some(([, , , ok]) => !ok)).toBe(true);
    for (const k of cluster.store.limits.keys()) expect(cluster.store.active(k)).toBe(0);
  });

  it("finishes transfers that lock two accounts in opposite orders", async () => {
    let active = 0;
    let most = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        {
          id: "transfer",
          triggers: { event: "transfer" },
          concurrency: [
            { limit: 1, scope: "env", key: "event.data.from" },
            { limit: 1, scope: "env", key: "event.data.to" },
          ],
        },
        async ({ step }) => {
          await step.run("debit", async () => {
            active++;
            most = Math.max(most, active);
            await new Promise((r) => setTimeout(r, 10));
            active--;
          });
          await step.run("credit", () => "ok");
        },
      ),
    ]);
    await cluster.flow.send([
      { name: "transfer", data: { from: "A", to: "B" } },
      { name: "transfer", data: { from: "B", to: "A" } },
      { name: "transfer", data: { from: "A", to: "B" } },
      { name: "transfer", data: { from: "B", to: "A" } },
    ]);
    const results = await runAll(cluster, 4);
    expect(results.every((r) => r.getStatus() === ExecutionStatus.SUCCEEDED)).toBe(true);
    expect(most).toBe(1);
    for (const k of cluster.store.limits.keys()) expect(cluster.store.active(k)).toBe(0);
  });

  it("replays the same, with a step that isn't awaited before a sleep", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "unawaited", triggers: { event: "go" }, concurrency: 2 }, async ({ step }) => {
        const audit = step.run("audit", async () => {
          await new Promise((r) => setTimeout(r, 30));
          return "audited";
        });
        await step.run("charge", () => "charged");
        await step.sleep("cooldown", "2s");
        return [await audit, "done"];
      }),
    ]);
    await cluster.flow.send({ name: "go" });
    const [result] = await runAll(cluster, 1);
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(result.getResult()).toEqual(["audited", "done"]);
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
    const [result] = await runAll(cluster, 1);
    expect(result.getResult()).toBe(3);
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
    const [result] = await runAll(cluster, 1);
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
    const [result] = await runAll(cluster, 1);
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(calls).toBe(1);
  });

  it("finishes every run with a tenant limit and a shared limit", async () => {
    let active = 0;
    let most = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        { id: "two", triggers: { event: "job" }, concurrency: [{ limit: 1, key: "event.tenant" }, { limit: 1 }] },
        async ({ step }) => {
          for (const name of ["download", "save", "finish"])
            await step.run(name, async () => {
              active++;
              most = Math.max(most, active);
              await new Promise((r) => setTimeout(r, 5));
              active--;
            });
        },
      ),
    ]);
    await cluster.flow.send(["a", "a", "a", "b", "b", "b"].map((tenant, i) => ({ name: "job", data: { i }, tenant })));
    const results = await runAll(cluster, 6);
    expect(results.every((r) => r.getStatus() === ExecutionStatus.SUCCEEDED)).toBe(true);
    expect(most).toBe(1);
    for (const k of cluster.store.limits.keys()) expect(cluster.store.active(k)).toBe(0);
  });
});

// A burst, simulated with the same store: tenant A sends 25 jobs a second for 40
// seconds, and 10 seconds in, tenant B sends 10. Each job is one step of 1 second,
// under a shared limit of 20. A step that can't get a lease joins the line, and a
// release hands its lease to the next step, fairest first. The clock is simulated,
// so this checks the policy, not AWS.
async function simulate(options: { fair: boolean }) {
  const store = new MemoryStore();
  let now = 0;
  store.now = () => now;
  const limit = { item: "C#shared", limit: 20 };
  if (!options.fair) {
    // First come first served: the oldest step, whatever its tenant.
    store.dispatch = async (l, wake) => {
      const item = store.item(l);
      let woken = 0;
      for (;;) {
        if (Object.keys(item.leases).length >= l.limit) return woken;
        const next = [...item.lines.values()].flat().sort((a, b) => a.at - b.at)[0];
        if (!next) return woken;
        const line = item.lines.get(next.tenant)!;
        line.splice(line.indexOf(next), 1);
        item.leases[next.leaseId] = { expires: now + 60, tenant: next.tenant };
        if (await wake(next)) woken++;
      }
    };
  }
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
      if ((await store.acquire([limit], e.job.id, e.job.tenant, 60)) === "granted") {
        e.job.started = now;
        events.push({ at: now + 1, kind: "end", job: e.job });
      } else {
        await store.enqueue(waiter(e.job.id, e.job.tenant, now, [limit]));
        await store.dispatch(limit, wake);
      }
    } else {
      e.job.done = now;
      await store.release([limit], e.job.id, e.job.tenant);
      await store.dispatch(limit, wake);
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
    expect(fair.aDone).toBeLessThan(52);
    expect(fair.bWorst).toBeLessThanOrEqual(1);
    expect(fair.bDone).toBeLessThan(fair.aDone / 2);
  });

  it("is fairer than first come first served", async () => {
    const fair = await simulate({ fair: true });
    const fifo = await simulate({ fair: false });
    console.log("burst simulation", { fair, fifo });
    expect(fair.bWorst).toBeLessThan(fifo.bWorst);
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
    expect(delays[0]).toBeLessThanOrEqual(2000);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[4]).toBeLessThanOrEqual(600_000);
    expect(backoffMs(3, "seed")).toBe(delays[2]);
  });
});
