import { Agent, request } from "node:http";
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { DynamoStore, tenantKey, type LeaseWaiter, type Limit, type Store } from "../../src/aws/eventflow/store.ts";
import { AwsError } from "../../src/aws/eventflow/aws.ts";
import { MemoryStore } from "./memory-store.ts";

// The lease rules, held to by both stores: the one in memory that the other tests
// use, and the one on DynamoDB that runs in AWS. The DynamoDB one runs against a real
// table when EVENTFLOW_TEST_TABLE names one, with a `pk` and `sk` string key:
//
//   EVENTFLOW_TEST_TABLE=my-table AWS_REGION=ca-central-1 bun test test/eventflow/store-contract.test.ts
//
// EVENTFLOW_TEST_ENDPOINT sends its calls to DynamoDB Local instead.

const table = process.env.EVENTFLOW_TEST_TABLE;
const endpoint = process.env.EVENTFLOW_TEST_ENDPOINT;
const stores: [string, () => Store][] = [["memory", () => new MemoryStore()]];
if (table) stores.push(["dynamodb", () => (endpoint ? local(table, endpoint) : new DynamoStore(table))]);

function local(table: string, endpoint: string) {
  const store = new DynamoStore(table);
  (store as any).db = async (action: string, body: any) => {
    // Some latency, so writes of different steps fall between each other.
    await new Promise((r) => setTimeout(r, Math.random() * Number(process.env.EVENTFLOW_TEST_LATENCY ?? 8)));
    const { status, data } = await post(endpoint, action, { TableName: table, ...body });
    if (status !== 200)
      throw new AwsError("dynamodb", action, status, String(data.__type).split("#").pop()!, data.message ?? "", [], data);
    return data;
  };
  return store;
}

const agent = new Agent({ keepAlive: true, maxSockets: 48 });
function post(endpoint: string, action: string, body: any) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request(
      endpoint,
      {
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "X-Amz-Target": `DynamoDB_20120810.${action}`,
          Authorization: "AWS4-HMAC-SHA256 Credential=local/20260101/local/dynamodb/aws4_request, SignedHeaders=host, Signature=0",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(text || "{}") }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`DynamoDB Local didn't answer ${action}`)));
    req.end(JSON.stringify(body));
  });
}

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

    it("leaves nothing held, and no step waiting, when steps need a shared limit and their tenant's", async () => {
      // As in a burst: 6 tenants, each with a limit of 3, and one of 8 for all. Three
      // steps of each run follow each other, and the first is short.
      const store = make();
      const shared = limit(8);
      const tenants = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, own: limit(3) }));
      const active: Record<string, number> = {};
      const most: Record<string, number> = {};
      const wakes = new Map<string, () => void>();
      let late = 0;
      const wake = async (w: LeaseWaiter) => {
        const resolve = wakes.get(w.callbackId);
        if (!resolve) return false;
        wakes.delete(w.callbackId);
        resolve();
        return true;
      };
      const step = async (leaseId: string, tenant: (typeof tenants)[number], ms: number) => {
        const limits = [tenant.own, shared];
        let joined: number | undefined;
        for (let round = 0; ; round++) {
          if ((await store.acquire(limits, leaseId, tenant.name, 60_000)) === "granted") break;
          const callbackId = `cb-${leaseId}-${round}`;
          const woken = new Promise<boolean>((resolve) => {
            wakes.set(callbackId, () => resolve(true));
            setTimeout(() => wakes.delete(callbackId) && resolve(false), 15_000);
          });
          joined ??= Date.now();
          const result = await store.enqueue({ ...waiter(leaseId, tenant.name, joined, limits), callbackId });
          let mine = result === "held";
          if (!mine)
            for (const l of limits)
              await store.dispatch(l, async (w) => {
                if (w.callbackId !== callbackId) return wake(w);
                mine = true;
                return true;
              });
          if (mine || (await woken)) break;
          late++;
        }
        for (const l of limits) most[l.item] = Math.max(most[l.item] ?? 0, (active[l.item] = (active[l.item] ?? 0) + 1));
        await new Promise((r) => setTimeout(r, ms));
        for (const l of limits) active[l.item]--;
        await store.handoff(limits, leaseId, tenant.name, wake);
      };
      await Promise.all(
        tenants.flatMap((tenant) =>
          Array.from({ length: 25 }, async (_, i) => {
            for (const [n, ms] of [2, 20, 20].entries()) await step(`${tenant.name}-${i}.${n}`, tenant, ms);
          }),
        ),
      );
      for (const l of [shared, ...tenants.map((t) => t.own)]) {
        expect(most[l.item]).toBeLessThanOrEqual(l.limit);
        expect(await state(store, l)).toEqual({ active: 0, queued: 0, tenants: {} });
        if (store instanceof DynamoStore) {
          const item = await (store as any).readLimit(l.item);
          expect(item.waiting).toEqual({});
        }
      }
      expect(late).toBe(0);
    }, 180_000);

    if (name === "dynamodb") {
      // Run something between two writes of the store: before the first call that matches.
      const before = (store: DynamoStore, match: (action: string, body: any) => boolean, act: () => Promise<unknown>) => {
        const db = (store as any).db.bind(store);
        let done = false;
        (store as any).db = async (action: string, body: any) => {
          if (!done && match(action, body)) {
            done = true;
            await act();
          }
          return db(action, body);
        };
      };
      const nothing = async (store: DynamoStore, ...limits: Limit[]) => {
        for (const l of limits) {
          expect(await state(store, l)).toEqual({ active: 0, queued: 0, tenants: {} });
          expect((await (store as any).readLimit(l.item)).waiting).toEqual({});
        }
      };

      it("gives back the lease of a step that's done when the next took one of its own", async () => {
        // The next step is given a lease by someone else as it's passed this one, who
        // gives it back: the pass fails, and then there's room to take one.
        const store = make() as DynamoStore;
        const l = limit(2);
        await store.acquire([l], "done", "a", 60_000);
        await store.acquire([l], "other", "a", 60_000);
        const next = waiter("next", "a", Date.now(), [l]);
        await store.enqueue(next);
        await store.release([l], "other", "a");
        const raw = (store as any).db.bind(store);
        (store as any).db = async (action: string, body: any) => {
          if (String(body.UpdateExpression).startsWith("REMOVE leases.#o"))
            throw new AwsError("dynamodb", action, 400, "ConditionalCheckFailedException", "");
          return raw(action, body);
        };
        const woken: string[] = [];
        await store.handoff([l], "done", "a", collect(woken));
        expect(woken).toEqual(["next"]);
        expect((await state(store, l)).active).toBe(1);
        await store.release([l], "next", "a");
        await nothing(store, l);
      });

      it("keeps the counts right for a step that's given its leases between its two lines", async () => {
        const store = make() as DynamoStore;
        const limits = [limit(1), limit(1)].sort((a, b) => (a.item < b.item ? -1 : 1));
        await store.acquire(limits, "held", "a", 60_000);
        const woken: string[] = [];
        let puts = 0;
        // Its entry is in the first line. Before the second, it's given its leases.
        before(
          store,
          (action, body) => action === "PutItem" && !!body.Item.lease && ++puts === 2,
          () => store.handoff(limits, "held", "a", collect(woken)),
        );
        expect(await store.enqueue(waiter("early", "a", Date.now(), limits))).toBe("held");
        expect(woken).toEqual(["early"]);
        expect(await state(store, limits[1])).toEqual({ active: 1, queued: 0, tenants: { a: 1 } });
        // Another joins, and isn't hidden by the count.
        await store.enqueue(waiter("real", "a", Date.now() + 1, limits));
        const closed = new Set(["early"]);
        const wake = async (w: LeaseWaiter) => !closed.has(w.leaseId) && !!woken.push(w.leaseId);
        await store.handoff(limits, "early", "a", wake);
        expect(woken).toEqual(["early", "real"]);
        await store.handoff(limits, "real", "a", wake);
        await nothing(store, ...limits);
      });

      it("doesn't give leases to a step that's done since it was seen in line", async () => {
        // Its callback is open, as when it found its leases itself: a wake would do.
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.enqueue(waiter("x", "a", Date.now(), [l]));
        before(
          store,
          (action, body) => action === "UpdateItem" && String(body.ConditionExpression).includes("active < :cap"),
          async () => {
            const other = make() as DynamoStore;
            await other.dispatch(l, async () => true);
            await other.handoff([l], "x", "a", async () => true);
          },
        );
        const woken: string[] = [];
        await store.dispatch(l, collect(woken));
        expect(woken).toEqual([]);
        await nothing(store, l);
      });

      it("keeps the leases of a step that asks again while a grant to it is undone", async () => {
        const store = make() as DynamoStore;
        const limits = [limit(1), limit(1)].sort((a, b) => (a.item < b.item ? -1 : 1));
        await store.enqueue(waiter("x", "a", Date.now(), limits));
        let asked: string | undefined;
        // A dispatch has taken the first limit for it. Before the second, the step asks
        // again: it takes both, and the grant's undo must not take the first away.
        before(
          store,
          (action, body) => action === "UpdateItem" && body.Key.pk.S === limits[1].item && "cap" in body === false && String(body.UpdateExpression).includes(":cap"),
          async () => {
            for (const l of limits)
              await (store as any).db("DeleteItem", { Key: { pk: { S: l.item }, sk: { S: "w#a" } } });
            const plain = make() as DynamoStore;
            // Without this, the first limit is "full" with the step's own lease.
            asked = await plain.acquire(limits.map((l) => ({ ...l, limit: 2 })), "x", "a", 60_000);
          },
        );
        await store.dispatch(limits[0], async () => false);
        expect(asked).toBe("granted");
        expect((await state(store, limits[0])).active).toBe(1);
        expect((await state(store, limits[1])).active).toBe(1);
        expect(await store.renew(limits, "x", 60_000)).toBe(true);
      });

      it("gives back what a claim made its own when it loses another", async () => {
        const store = make() as DynamoStore;
        const limits = [limit(1), limit(1)].sort((a, b) => (a.item < b.item ? -1 : 1));
        await store.acquire(limits, "x", "a", 60_000);
        before(
          store,
          (action, body) => action === "UpdateItem" && body.Key.pk.S === limits[1].item && String(body.UpdateExpression).startsWith("SET leases"),
          () => (make() as DynamoStore).release([limits[1]], "x", "a"),
        );
        expect(await store.renew(limits, "x", 60_000, true)).toBe(false);
        await nothing(store, ...limits);
      });

      it("counts a step once when joining the line fails part way and is tried again", async () => {
        const store = make() as DynamoStore;
        const limits = [limit(1), limit(1)];
        await store.acquire(limits, "held", "a", 60_000);
        await store.enqueue(waiter("first", "a", Date.now(), limits));
        const second = waiter("second", "a", Date.now() + 1, limits);
        // Throttled at each write of the join, in turn, until it goes through.
        for (let fail = 1; fail <= 4; fail++) {
          const flaky = make() as DynamoStore;
          const db = (flaky as any).db.bind(flaky);
          let writes = 0;
          (flaky as any).db = async (action: string, body: any) => {
            if ((action === "PutItem" || action === "UpdateItem") && ++writes === fail)
              throw new AwsError("dynamodb", action, 400, "ThrottlingException", "");
            return db(action, body);
          };
          await expect(flaky.enqueue(second)).rejects.toThrow("ThrottlingException");
        }
        expect(await store.enqueue(second)).toBe("queued");
        const woken: string[] = [];
        for (const id of ["held", "first", "second"]) await store.handoff(limits, id, "a", collect(woken));
        expect(woken).toEqual(["first", "second"]);
        // At worst the count is high: no step is hidden, and nobody's left.
        for (const l of limits) {
          const item = await (store as any).readLimit(l.item);
          expect(Object.keys(item.leases)).toEqual([]);
          expect(Math.min(0, ...Object.values<number>(item.waiting))).toBe(0);
        }
      });

      it("finds a step whose count was taken off twice", async () => {
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.acquire([l], "held", "a", 60_000);
        await store.enqueue(waiter("w1", "a", Date.now(), [l]));
        await store.enqueue(waiter("w2", "a", Date.now() + 1, [l]));
        await (store as any).count(l.item, "a", -1);
        const woken: string[] = [];
        for (const id of ["held", "w1", "w2"]) await store.handoff([l], id, "a", collect(woken));
        expect(woken).toEqual(["w1", "w2"]);
        await nothing(store, l);
      });

      // From an adversarial review: each was a way for a step to run over the limit, a
      // lease to be left held, or a step to be left in line.
      it("doesn't give away the lease of a step that was woken when the wake's answer was lost", async () => {
        for (const lost of [async () => false, async () => Promise.reject(new Error("reset"))]) {
          const store = make() as DynamoStore;
          const l = limit(1);
          await store.acquire([l], "H", "a", 60_000);
          await store.enqueue(waiter("S", "a", 1, [l]));
          let running = false;
          await store.handoff([l], "H", "a", async (w) => {
            if (w.leaseId !== "S" || running) return false;
            // It resumes, and checks its lease before it runs, as the worker does.
            running = await (make() as DynamoStore).renew([l], "S", 60_000);
            return lost();
          });
          expect(running).toBe(true);
          await store.dispatch(l, async () => false);
          expect(await store.acquire([l], "X", "b", 60_000)).toBe("full");
          await store.handoff([l], "S", "a", async () => false);
          await nothing(store, l);
        }
      });

      it("keeps a lease it was given no longer than its invocation, once its code runs", async () => {
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.enqueue(waiter("S", "a", 1, [l]));
        await store.dispatch(l, async () => true);
        const before = (await (store as any).readLimit(l.item)).leases.S.expires - Date.now();
        expect(before).toBeGreaterThan(900_000);
        expect(await store.renew([l], "S", 60_000)).toBe(true);
        expect((await (store as any).readLimit(l.item)).leases.S.expires - Date.now()).toBeLessThanOrEqual(60_000);
      });

      it("gets past the steps of stopped runs, however many", async () => {
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.acquire([l], "H", "a", 60_000);
        for (let i = 0; i < 20; i++) await store.enqueue(waiter(`dead${i}`, "a", i, [l]));
        await store.enqueue(waiter("live", "a", 99, [l]));
        const woken: string[] = [];
        await store.handoff([l], "H", "a", async (w) => w.leaseId === "live" && !!woken.push(w.leaseId));
        expect(woken).toEqual(["live"]);
      });

      it("leaves no lease idle when handoffs race for the same steps", async () => {
        const l = limit(3);
        const [h1, h2, h3] = [make(), make(), make()] as DynamoStore[];
        const woken: string[] = [];
        const wake = collect(woken);
        for (const x of ["x1", "x2", "x3"]) await h1.acquire([l], x, "t", 60_000);
        for (const i of [1, 2, 3]) await h1.enqueue(waiter(`s${i}`, "t", i, [l]));
        before(
          h2,
          (action, body) => action === "UpdateItem" && String(body.UpdateExpression).startsWith("REMOVE leases.#o"),
          async () => {
            before(
              h2,
              (action, body) => action === "UpdateItem" && String(body.ConditionExpression).includes("active < :cap") && body.ExpressionAttributeNames["#l"] === "s2",
              () => h3.handoff([l], "x3", "t", wake),
            );
            await h1.handoff([l], "x1", "t", wake);
          },
        );
        await h2.handoff([l], "x2", "t", wake);
        expect(woken.sort()).toEqual(["s1", "s2", "s3"]);
        expect((await state(h1, l)).active).toBe(3);
      });

      it("keeps a step in line that asks again, with a new callback, during a grant", async () => {
        const store = make() as DynamoStore;
        const other = make() as DynamoStore;
        const l = limit(1);
        await store.acquire([l], "H", "a", 60_000);
        await store.enqueue({ ...waiter("S", "a", 1, [l]), callbackId: "cb0" });
        before(
          store,
          (action, body) => action === "UpdateItem" && String(body.UpdateExpression).startsWith("REMOVE leases.#o"),
          async () => {
            expect(await other.acquire([l], "S", "a", 60_000)).toBe("full");
            expect(await other.enqueue({ ...waiter("S", "a", 1, [l]), callbackId: "cb1" })).toBe("queued");
          },
        );
        const told: string[] = [];
        await store.handoff([l], "H", "a", async (w) => w.callbackId === "cb1" && !!told.push(w.callbackId));
        expect(told).toEqual(["cb1"]);
      });

      it("sees a step that joins after a count was taken off twice", async () => {
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.acquire([l], "H", "a", 60_000);
        await store.enqueue(waiter("w1", "a", 1, [l]));
        const db = (store as any).db.bind(store);
        let once = false;
        // Its answer is lost, and it's sent again.
        (store as any).db = async (action: string, body: any) => {
          if (!once && body.ExpressionAttributeValues?.[":n"]?.N === "-1") {
            once = true;
            await db(action, body);
          }
          return db(action, body);
        };
        const woken: string[] = [];
        await store.handoff([l], "H", "a", collect(woken));
        await store.enqueue(waiter("w2", "a", 2, [l]));
        expect(await store.acquire([l], "newcomer", "b", 60_000)).toBe("full");
        await store.handoff([l], "w1", "a", collect(woken));
        expect(woken).toEqual(["w1", "w2"]);
      });

      it("finds the one tenant that can go on, behind many whose own limit is full", async () => {
        const store = make() as DynamoStore;
        const shared = limit(1);
        await store.acquire([shared], "H", "z", 60_000);
        for (let i = 0; i < 60; i++) {
          const own = limit(1);
          await store.acquire([own], `g${i}`, `t${i}`, 60_000);
          await store.enqueue(waiter(`f${i}`, `t${i}`, i, [shared, own]));
        }
        await store.enqueue(waiter("ready", "u", 100, [shared, limit(1)]));
        const woken: string[] = [];
        await store.handoff([shared], "H", "z", collect(woken));
        expect(woken).toEqual(["ready"]);
      }, 60_000);

      it("leaves no entry in line of a step that asked again and found its leases", async () => {
        const store = make() as DynamoStore;
        const limits = [limit(1), limit(1)];
        await store.enqueue({ ...waiter("S", "a", 1, limits), callbackId: "cb0" });
        await store.dispatch(limits[0], async () => true);
        // Its entries are back, as when they went in between a grant's deletes.
        for (const l of limits) await (store as any).join(l, { ...waiter("S", "a", 1, limits), callbackId: "cb1" });
        expect(await store.enqueue({ ...waiter("S", "a", 1, limits), callbackId: "cb1" })).toBe("held");
        const woken: string[] = [];
        await store.handoff(limits, "S", "a", collect(woken));
        expect(woken).toEqual([]);
        await nothing(store, ...limits);
      });

      it("holds to a limit that was lowered, while steps wait", async () => {
        const store = make() as DynamoStore;
        const l = limit(4);
        for (let i = 0; i < 4; i++) await store.acquire([l], `h${i}`, "a", 60_000);
        for (let i = 0; i < 8; i++) await store.enqueue(waiter(`s${i}`, "a", i, [l]));
        const lower = { ...l, limit: 1 };
        for (let i = 0; i < 3; i++) await store.handoff([lower], `h${i}`, "a", async () => true);
        expect((await state(store, l)).active).toBe(1);
        const woken: string[] = [];
        await store.handoff([lower], "h3", "a", collect(woken));
        expect(woken).toEqual(["s0"]);
        expect((await state(store, l)).active).toBe(1);
      });

      it("wakes a step whose entry's delete got an error after it was made", async () => {
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.acquire([l], "H", "a", 60_000);
        await store.enqueue(waiter("S", "a", 1, [l]));
        const db = (store as any).db.bind(store);
        let once = false;
        (store as any).db = async (action: string, body: any, options: any) => {
          if (once || action !== "DeleteItem" || !body.ConditionExpression?.includes("callback")) return db(action, body, options);
          once = true;
          // It isn't sent again: it couldn't tell its own delete from another's.
          expect(options).toEqual({ retries: 0 });
          await db(action, body, options);
          throw new AwsError("dynamodb", action, 500, "InternalServerError", "");
        };
        const woken: string[] = [];
        await store.handoff([l], "H", "a", collect(woken));
        expect(woken).toEqual(["S"]);
      });

      it("gives back its leases when a handoff fails", async () => {
        const store = make() as DynamoStore;
        const limits = [limit(1), limit(1)];
        await store.acquire(limits, "H", "a", 60_000);
        await store.enqueue(waiter("S", "a", 1, limits));
        const db = (store as any).db.bind(store);
        let once = false;
        (store as any).db = async (action: string, body: any) => {
          if (!once && action === "Query") {
            once = true;
            throw new AwsError("dynamodb", action, 400, "ThrottlingException", "");
          }
          return db(action, body);
        };
        const woken: string[] = [];
        await expect(store.handoff(limits, "H", "a", collect(woken))).rejects.toThrow("ThrottlingException");
        expect(woken).toEqual(["S"]);
        await store.handoff(limits, "S", "a", collect(woken));
        await nothing(store, ...limits);
      });

      it("finds a step behind three that were put back in line and are running", async () => {
        const store = make() as DynamoStore;
        const l = limit(4);
        for (let i = 0; i < 4; i++) await store.acquire([l], `h${i}`, "a", 60_000);
        for (let i = 0; i < 4; i++) await store.enqueue(waiter(`s${i}`, "a", i, [l]));
        // Woken, but the answers are lost, so they're put back.
        for (let i = 0; i < 3; i++)
          await store.handoff([l], `h${i}`, "a", async (w) => {
            if (w.leaseId === "s3" || !(await (make() as DynamoStore).renew([l], w.leaseId, 60_000))) return false;
            throw new Error("reset");
          });
        const woken: string[] = [];
        await store.handoff([l], "h3", "a", collect(woken));
        expect(woken.length).toBeGreaterThan(0);
      });

      it("counts the steps in line for the admin API", async () => {
        const store = make() as DynamoStore;
        const l = { ...limit(1), label: "fn:x" };
        await store.acquire([l], "held", "a", 60_000);
        await store.enqueue(waiter("q1", "a", Date.now(), [l]));
        await store.enqueue(waiter("q2", "b", Date.now(), [l]));
        (store as any).scan = async () =>
          (await DynamoStore.prototype.scan.call(store, "C#", 100_000)).filter((i) => i.pk === l.item);
        const { handleAdmin } = await import("../../src/aws/eventflow/admin.ts");
        const answer: any = await handleAdmin({ op: "leases" }, new Map(), { store } as any);
        expect(answer.result).toEqual([expect.objectContaining({ label: "fn:x", limit: 1, active: 1, queued: 2 })]);
      });

      it("doesn't take another dispatch's grant of the same step for its own", async () => {
        // Two dispatches in the same millisecond.
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.enqueue(waiter("x", "a", Date.now(), [l]));
        const now = Date.now;
        const at = now();
        Date.now = () => at;
        const woken: string[] = [];
        try {
          before(
            store,
            (action, body) => action === "UpdateItem" && String(body.ConditionExpression).includes("active < :cap"),
            () => (make() as DynamoStore).dispatch(l, collect(woken)),
          );
          await store.dispatch(l, collect(woken));
        } finally {
          Date.now = now;
        }
        expect(woken).toEqual(["x"]);
        expect(await store.renew([l], "x", 60_000)).toBe(true);
      });

      it("knows its own lease when the answer to taking it was lost", async () => {
        const store = make() as DynamoStore;
        const l = limit(1);
        const raw = (store as any).db.bind(store);
        // As when a write is made, the answer is a 500, and it's sent again.
        (store as any).db = async (action: string, body: any) => {
          if (String(body.ConditionExpression).includes("active < :cap")) await raw(action, body);
          return raw(action, body);
        };
        expect(await store.acquire([l], "x", "a", 60_000)).toBe("granted");
        expect((await state(store, l)).active).toBe(1);
        await store.release([l], "x", "a");
        await nothing(store, l);
      });
    }

    if (name === "dynamodb")
      it("heals a count of steps in line that has no steps behind it", async () => {
        // As when entries expired, or an older version left its count.
        const store = make() as DynamoStore;
        const l = limit(1);
        await store.acquire([l], "held", "a", 60_000);
        await store.release([l], "held", "a");
        for (let i = 0; i < 25; i++)
          await (store as any).db("PutItem", {
            Item: { pk: { S: l.item }, sk: { S: `w#${tenantKey(`ghost-${i}`)}` }, n: { N: "3" }, at: { N: String(Date.now() - 120_000) } },
          });
        expect(await store.acquire([l], "blocked", "real", 60_000)).toBe("full");
        await store.enqueue(waiter("real", "real", Date.now(), [l]));
        const woken: string[] = [];
        await store.dispatch(l, collect(woken));
        expect(woken).toEqual(["real"]);
      }, 60_000);
  });
}
