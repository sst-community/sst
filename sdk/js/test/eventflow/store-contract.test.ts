import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { DynamoStore, tenantKey, type LeaseWaiter, type Limit, type Store } from "../../src/aws/eventflow/store.ts";
import { MemoryStore } from "./memory-store.ts";

// The lease rules, held to by both stores: the one in memory that the other tests
// use, and the one on DynamoDB that runs in AWS. The DynamoDB one runs against a real
// table when EVENTFLOW_TEST_TABLE names one, with a `pk` and `sk` string key:
//
//   EVENTFLOW_TEST_TABLE=my-table AWS_REGION=ca-central-1 bun test test/eventflow/store-contract.test.ts

const table = process.env.EVENTFLOW_TEST_TABLE;
const stores: [string, () => Store][] = [["memory", () => new MemoryStore()]];
if (table) stores.push(["dynamodb", () => new DynamoStore(table)]);
// Each call to DynamoDB is a round trip, and some of these make dozens.
if (table) setDefaultTimeout(30_000);

let n = 0;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const limit = (cap: number): Limit => ({ item: `C#contract-${run}-${n++}`, limit: cap });

const waiter = (leaseId: string, tenant: string, at: number, limits: Limit[]): LeaseWaiter => ({
  leaseId,
  tenant,
  limits,
  callbackId: `cb-${leaseId}`,
  runId: `run-${leaseId}`,
  at,
  expiresAt: Date.now() + 300_000,
});

async function state(store: Store, l: Limit) {
  if (store instanceof MemoryStore) {
    const item = store.limits.get(l.item);
    return { active: store.active(l.item), queued: store.queued(l.item), tenants: { ...(item?.tenants ?? {}) } };
  }
  const item = await (store as any).readLimit(l.item);
  const now = Date.now();
  return {
    active: Object.values<any>(item?.leases ?? {}).filter((v) => v.expires > now).length,
    queued: item?.queued ?? 0,
    tenants: { ...(item?.tenants ?? {}) },
  };
}

const collect = (into: string[]) => async (w: LeaseWaiter) => (into.push(w.leaseId), true);

for (const [name, make] of stores) {
  describe(`${name} store`, () => {
    it("takes every limit at once, or none", async () => {
      const store = make();
      const [t, s] = [limit(2), limit(1)];
      expect(await store.acquire([t, s], "l1", "a", 60_000)).toBe("granted");
      expect(await store.acquire([t, s], "l2", "a", 60_000)).toBe("full");
      expect((await state(store, t)).active).toBe(1);
      expect(await store.acquire([t, s], "l1", "a", 60_000)).toBe("granted");
    });

    it("grants a limit to exactly as many steps as it allows, when they ask at once", async () => {
      const store = make();
      const l = limit(5);
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.acquire([l], `p${i}`, `t${i % 3}`, 60_000)));
      expect(results.filter((r) => r === "granted")).toHaveLength(5);
      expect((await state(store, l)).active).toBe(5);
    });

    it("can't deadlock two steps that need two limits in opposite orders", async () => {
      const store = make();
      const [A, B] = [limit(1), limit(1)];
      expect(await store.acquire([A, B], "ab", "x", 60_000)).toBe("granted");
      expect(await store.acquire([B, A], "ba", "x", 60_000)).toBe("full");
      await store.enqueue(waiter("ba", "x", 1, [B, A]));
      await store.release([A, B], "ab", "x");
      const woken: string[] = [];
      for (const l of [A, B]) await store.dispatch(l, collect(woken));
      expect(woken).toEqual(["ba"]);
      expect((await state(store, A)).active + (await state(store, B)).active).toBe(2);
    });

    it("doesn't let a newcomer jump the line", async () => {
      const store = make();
      const l = limit(1);
      await store.acquire([l], "held", "a", 60_000);
      await store.enqueue(waiter("next", "a", 1, [l]));
      await store.release([l], "held", "a");
      expect(await store.acquire([l], "newcomer", "b", 60_000)).toBe("full");
      const woken: string[] = [];
      await store.dispatch(l, collect(woken));
      expect(woken).toEqual(["next"]);
    });

    it("wakes the tenant with the fewest leases first, behind a long line of another", async () => {
      const store = make();
      const l = limit(2);
      await store.acquire([l], "a-held", "a", 60_000);
      await store.acquire([l], "a-still", "a", 60_000);
      for (let i = 0; i < 40; i++) await store.enqueue(waiter(`a${i}`, "a", i, [l]));
      await store.enqueue(waiter("b0", "b", 1000, [l]));
      await store.release([l], "a-held", "a");
      const woken: string[] = [];
      await store.dispatch(l, collect(woken));
      expect(woken).toEqual(["b0"]);
    });

    it("gives the leases of a step that's gone to the next one", async () => {
      const store = make();
      const l = limit(1);
      await store.acquire([l], "held", "a", 60_000);
      await store.enqueue(waiter("gone", "a", 1, [l]));
      await store.enqueue(waiter("next", "b", 2, [l]));
      await store.release([l], "held", "a");
      const woken: string[] = [];
      await store.dispatch(l, async (w) => (w.leaseId === "gone" ? false : (woken.push(w.leaseId), true)));
      expect(woken).toEqual(["next"]);
      expect((await state(store, l)).active).toBe(1);
    });

    it("keeps a step in line, in its place, when its wake throws", async () => {
      // A throttle, or a timeout: the step may not have been told. It isn't taken for
      // gone, which would leave it waiting until it asks again.
      const store = make();
      const [t, s] = [limit(2), limit(1)];
      await store.acquire([t, s], "held", "a", 60_000);
      await store.enqueue(waiter("first", "a", 1, [t, s]));
      await store.enqueue(waiter("second", "a", 2, [t, s]));
      await store.release([t, s], "held", "a");
      const tried: string[] = [];
      await store.dispatch(s, async (w) => {
        tried.push(w.leaseId);
        throw new Error("429 TooManyRequestsException");
      });
      // Each is tried once in a dispatch, and nothing is held after.
      expect(tried).toEqual(["first", "second"]);
      expect((await state(store, s)).active).toBe(0);
      expect((await state(store, t)).active).toBe(0);
      expect((await state(store, s)).queued).toBe(2);
      expect((await state(store, t)).queued).toBe(2);
      // The next dispatch wakes it, ahead of the one behind it.
      const woken: string[] = [];
      await store.dispatch(s, collect(woken));
      expect(woken).toEqual(["first"]);
      expect((await state(store, s)).queued).toBe(1);
      expect((await state(store, t)).queued).toBe(1);
    });

    it("keeps a step in line when the wake of a handoff throws", async () => {
      const store = make();
      const l = limit(1);
      await store.acquire([l], "holder", "a", 60_000);
      await store.enqueue(waiter("next", "b", 1, [l]));
      await store.handoff([l], "holder", "a", async () => {
        throw new Error("503");
      });
      expect((await state(store, l)).active).toBe(0);
      expect((await state(store, l)).queued).toBe(1);
      // A newcomer still can't jump it.
      expect(await store.acquire([l], "newcomer", "c", 60_000)).toBe("full");
      const woken: string[] = [];
      await store.dispatch(l, collect(woken));
      expect(woken).toEqual(["next"]);
    });

    it("doesn't take back a lease that the step found and renewed while its wake failed", async () => {
      // Its old callback timed out as it was granted: it asks again, finds the lease,
      // and starts. The wake of the old callback fails after that.
      const store = make();
      const l = limit(1);
      await store.acquire([l], "holder", "a", 60_000);
      await store.acquire([l], "W", "a", 60_000);
      await store.enqueue(waiter("W", "a", 1, [l]));
      await store.release([l], "holder", "a");
      await store.dispatch(l, async () => {
        expect(await store.acquire([l], "W", "a", 60_000)).toBe("granted");
        expect(await store.renew([l], "W", 60_000)).toBe(true);
        return false;
      });
      expect(await store.acquire([l], "X", "b", 60_000)).toBe("full");
    });

    it("keeps a long tenant's counts under a short key", async () => {
      const store = make();
      const l = limit(2);
      const tenant = "t".repeat(128);
      await store.acquire([l], "long", tenant, 60_000);
      const keys = Object.keys((await state(store, l)).tenants);
      expect(keys).toHaveLength(1);
      expect(keys[0].length).toBeLessThan(30);
      await store.release([l], "long", tenant);
      expect(Object.keys((await state(store, l)).tenants)).toHaveLength(0);
    });

    it("hands a lease straight to the next step in line", async () => {
      const store = make();
      const l = limit(1);
      await store.acquire([l], "holder", "a", 60_000);
      await store.acquire([l], "next", "b", 60_000);
      await store.enqueue(waiter("next", "b", 1, [l]));
      const woken: string[] = [];
      await store.handoff([l], "holder", "a", collect(woken));
      expect(woken).toEqual(["next"]);
      const after = await state(store, l);
      expect(after.active).toBe(1);
      expect(after.queued).toBe(0);
      expect(Object.keys(after.tenants)).toEqual(["b"]);
    });

    it("hands on a shared lease to a step that needs its own tenant's too, and gives back the rest", async () => {
      const store = make();
      const shared = limit(1);
      const [ta, tb] = [limit(1), limit(1)];
      await store.acquire([ta, shared], "a1", "a", 60_000);
      await store.acquire([tb, shared], "b1", "b", 60_000);
      await store.enqueue(waiter("b1", "b", 1, [tb, shared]));
      const woken: string[] = [];
      await store.handoff([ta, shared], "a1", "a", collect(woken));
      expect(woken).toEqual(["b1"]);
      expect((await state(store, ta)).active).toBe(0);
      expect((await state(store, tb)).active).toBe(1);
      expect((await state(store, shared)).active).toBe(1);
    });

    it("hands a shared lease to the fairest tenant, not the next step of its own", async () => {
      const store = make();
      const shared = limit(1);
      const [ta, tb] = [limit(2), limit(2)];
      await store.acquire([ta, shared], "a1", "a", 60_000);
      await store.acquire([ta, shared], "a2", "a", 60_000);
      await store.enqueue(waiter("a2", "a", 1, [ta, shared]));
      await store.acquire([tb, shared], "b1", "b", 60_000);
      await store.enqueue(waiter("b1", "b", 2, [tb, shared]));
      const woken: string[] = [];
      await store.handoff([ta, shared], "a1", "a", collect(woken));
      expect(woken).toEqual(["b1"]);
    });

    it("gives back a lease with no step in line", async () => {
      const store = make();
      const l = limit(1);
      await store.acquire([l], "only", "a", 60_000);
      await store.handoff([l], "only", "a", collect([]));
      expect((await state(store, l)).active).toBe(0);
    });

    it("won't renew a lease that expired, and gives it to the next step", async () => {
      const store = make();
      const l = limit(1);
      expect(await store.acquire([l], "crashed", "a", 1000)).toBe("granted");
      await new Promise((r) => setTimeout(r, 1500));
      expect(await store.renew([l], "crashed", 60_000)).toBe(false);
      expect(await store.acquire([l], "next", "a", 60_000)).toBe("granted");
    });

    it("renews a lease that's held, so it isn't taken back", async () => {
      const store = make();
      const l = limit(1);
      expect(await store.acquire([l], "slow", "a", 1500)).toBe("granted");
      await new Promise((r) => setTimeout(r, 700));
      expect(await store.renew([l], "slow", 60_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 1200));
      expect(await store.acquire([l], "other", "a", 60_000)).toBe("full");
    });

    it("counts a step that asks again once, and keeps its place", async () => {
      const store = make();
      const l = limit(1);
      await store.acquire([l], "held", "a", 60_000);
      await store.enqueue({ ...waiter("first", "b", 1, [l]), callbackId: "old" });
      await store.enqueue(waiter("second", "c", 2, [l]));
      await store.enqueue({ ...waiter("first", "b", 1, [l]), callbackId: "new" });
      expect((await state(store, l)).queued).toBe(2);
      await store.release([l], "held", "a");
      const callbacks: string[] = [];
      await store.dispatch(l, async (w) => (callbacks.push(w.callbackId), true));
      expect(callbacks).toEqual(["new"]);
    });

    it("keeps no tenant with no leases", async () => {
      const store = make();
      const l = limit(100);
      for (let i = 0; i < 10; i++) {
        await store.acquire([l], `l${i}`, `tenant-${i}`, 60_000);
        await store.release([l], `l${i}`, `tenant-${i}`);
      }
      expect(Object.keys((await state(store, l)).tenants)).toHaveLength(0);
    });

    it("never goes over the limit, and ends with nothing held, under contention", async () => {
      // 40 steps at once, 3 times each, on one limit of 5: take a lease, or join the
      // line and be woken, work, give it back and hand it on.
      const store = make();
      const l = limit(5);
      let active = 0;
      let most = 0;
      const wakes = new Map<string, () => void>();
      const wake = async (w: LeaseWaiter) => {
        const resolve = wakes.get(w.callbackId);
        if (!resolve) return false;
        wakes.delete(w.callbackId);
        resolve();
        return true;
      };
      const step = async (id: string, tenant: string) => {
        const leaseId = `${id}`;
        if ((await store.acquire([l], leaseId, tenant, 60_000)) !== "granted") {
          const woken = new Promise<void>((resolve) => wakes.set(`cb-${leaseId}`, resolve));
          const result = await store.enqueue(waiter(leaseId, tenant, Date.now(), [l]));
          let mine = result === "held";
          if (!mine)
            await store.dispatch(l, async (w) => {
              if (w.callbackId !== `cb-${leaseId}`) return wake(w);
              mine = true;
              wakes.delete(w.callbackId);
              return true;
            });
          if (!mine) await woken;
        }
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
        active--;
        // Half give back and hand on in two writes, half hand straight on in one.
        if (Number(id.split(".")[1]) % 2) await store.handoff([l], leaseId, tenant, wake);
        else {
          await store.release([l], leaseId, tenant);
          await store.dispatch(l, wake);
        }
      };
      for (let round = 0; round < 3; round++)
        await Promise.all(Array.from({ length: 40 }, (_, i) => step(`s${round}.${i}`, `t${i % 4}`)));
      expect(most).toBeLessThanOrEqual(5);
      const end = await state(store, l);
      expect(end.active).toBe(0);
      expect(end.queued).toBe(0);
    }, 180_000);

    if (name === "dynamodb")
      it("heals a count of steps in line that has no steps behind it", async () => {
        // As when entries expired, or an older version left its count.
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.acquire([l], "held", "a", 60_000);
        await store.release([l], "held", "a");
        const ghosts = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [tenantKey(`ghost-${i}`), { N: "3" }]));
        await (store as any).db("UpdateItem", {
          Key: { pk: { S: l.item }, sk: { S: "w" } },
          UpdateExpression: "SET queued = :q, waiting = :w",
          ExpressionAttributeValues: { ":q": { N: "75" }, ":w": { M: ghosts } },
        });
        expect(await store.acquire([l], "blocked", "real", 60_000)).toBe("full");
        await store.enqueue(waiter("real", "real", Date.now(), [l]));
        const woken: string[] = [];
        await store.dispatch(l, collect(woken));
        expect(woken).toEqual(["real"]);
      }, 60_000);
  });
}
