import type { AwsOptions } from "../client.js";
import { AwsError, dynamo, isConditionFailure, isTransient } from "./aws.js";
import { hash, key as keyOf } from "./ids.js";
import type { WireEvent } from "./types.js";

// The engine's state, in one DynamoDB table with a `pk` and `sk`, and `expires` as
// its TTL attribute. Every item expires, so the table doesn't grow without bound.
//
// Keys are built with `key()`, which hashes their parts, so a `#` or anything else in
// an event name, a tenant or a value can't make two keys the same. The parts are also
// kept as attributes, for the admin API.
//
//   E#…    an event ID of a tenant, while it's routed, and for 24 hours after
//   A#…    what the router decided for a function and an event: start, skip or hold
//   I#…    an idempotency key of a function and a tenant, for 24 hours
//   T#…    a throttle or rate limit bucket
//   C#…    one concurrency limit: its leases, and the count of each tenant
//   Q#…    the steps waiting for a lease on a limit, oldest first
//   WF#…   the fields that waits for an event of a tenant match on
//   W#…    the waits for an event, and the cancelOns
//   R#…    an event that a wait could match, for an hour

export interface Limit {
  /** The item's key. */
  item: string;
  limit: number;
  /** What it limits, for the admin API, like "fn:import-contacts:acme". */
  label?: string;
}

export interface Waiter {
  callbackId: string;
  runId: string;
  createdAt: number;
  expiresAt: number;
  // The wait's `if`, with the run's event bound, as JSON.
  condition?: string;
  /** "wait" for a waitForEvent, "cancel" for a cancelOn. */
  kind?: "wait" | "cancel";
  /** For a cancelOn of an invoked run, the callback of the run that invoked it. */
  parent?: string;
  /** For the admin API. */
  info?: { name: string; tenant?: string; field: string };
}

export interface LeaseWaiter {
  /** The lease the step gets when it's woken. */
  leaseId: string;
  /** Every limit the step needs. It's given them all at once. */
  limits: Limit[];
  tenant: string;
  callbackId: string;
  runId: string;
  at: number;
  expiresAt: number;
}

export type Admission = { decision: "start" } | { decision: "skip"; reason: string } | { decision: "hold"; at: number };

export interface Store {
  /**
   * Note that an event is being routed. "duplicate" when another message with the
   * same ID was routed in the last 24 hours. The same message delivered again, or a
   * message whose routing didn't finish, is routed again.
   */
  beginEvent(item: string, delivery: string, ttlMs: number): Promise<"route" | "duplicate">;
  /** Note that an event's routing finished. */
  finishEvent(item: string, ttlMs: number): Promise<void>;
  getAdmission(item: string): Promise<Admission | undefined>;
  /** Saves the decision, unless one was saved first. Returns the one that's saved. */
  putAdmission(item: string, admission: Admission, ttlMs: number): Promise<Admission>;
  /** True the first time the key is claimed in the window. */
  claim(item: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Records the owner of a key if it has none, and returns the owner it has. */
  successor(item: string, owner: string, ttlMs: number): Promise<string>;
  /** GCRA: 0 when allowed now, or how many ms until it would be. Takes the slot only when allowed. */
  take(item: string, intervalMs: number, toleranceMs: number): Promise<number>;
  /** GCRA: reserves the next slot, and returns when it starts. */
  reserve(item: string, intervalMs: number, toleranceMs: number): Promise<number>;
  /**
   * Takes a lease on every limit at once, or on none: "granted" when the step holds
   * them all, including when it already did; "full" when one has no room, or steps
   * wait for one.
   */
  acquire(limits: Limit[], leaseId: string, tenant: string, leaseMs: number): Promise<"granted" | "full">;
  /** Extends the leases. False when one is gone or expired. */
  renew(limits: Limit[], leaseId: string, leaseMs: number): Promise<boolean>;
  release(limits: Limit[], leaseId: string, tenant: string): Promise<void>;
  /**
   * Puts a step in line for every limit it needs. A step that asks again, with the
   * same time and lease, keeps its place. "held" when the step already holds them all.
   */
  enqueue(waiter: LeaseWaiter): Promise<"queued" | "held">;
  /**
   * Gives free leases on a limit to steps in line: the tenant with the fewest leases,
   * then the oldest step. A step gets every lease it needs at once, or waits. `wake`
   * resumes a step, and returns false if it can't, as when its run stopped; then its
   * leases are given back. Returns how many it woke.
   */
  dispatch(limit: Limit, wake: (w: LeaseWaiter) => Promise<boolean>): Promise<number>;
  /**
   * Give back a step's leases, handing them straight to the next step in line, in one
   * write where it can, and wake it. Then hand out what else is free.
   */
  handoff(limits: Limit[], leaseId: string, tenant: string, wake: (w: LeaseWaiter) => Promise<boolean>): Promise<void>;
  waitFields(name: string, tenant: string | undefined): Promise<string[]>;
  addWaitField(name: string, tenant: string | undefined, field: string, until: number): Promise<void>;
  putWaiter(key: string, waiter: Waiter): Promise<void>;
  waiters(key: string, now: number): Promise<Waiter[]>;
  deleteWaiter(key: string, waiter: Pick<Waiter, "createdAt" | "callbackId">): Promise<void>;
  putRecent(key: string, event: WireEvent, receivedAt: number, ttlMs: number): Promise<void>;
  recent(key: string, since: number): Promise<{ event: WireEvent; receivedAt: number }[]>;
  /** For the admin API: the items whose key starts with a prefix. */
  scan(prefix: string, limit: number): Promise<Record<string, any>[]>;
}

const seconds = (ms: number) => String(Math.ceil(ms / 1000));
const S = (value: string) => ({ S: value });
const N = (value: number) => ({ N: String(value) });
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(15, "0");
const DAY = 86_400_000;

/**
 * A map key for a tenant. A map key can't be empty, and "" is "no tenant". A long one
 * is hashed, so a limit's maps stay small.
 */
export function tenantKey(tenant: string) {
  if (tenant === "") return "\u0000";
  return tenant.length <= 24 ? tenant : `#${hash(tenant, 16)}`;
}

function waiterSort(waiter: Pick<Waiter, "createdAt" | "callbackId">) {
  // The callback is part of it, so two waits of one run that register in the same
  // millisecond don't replace each other.
  return `${pad(waiter.createdAt)}#${waiter.callbackId.slice(-24)}`;
}

/** Errors that mean "try later", not "this is broken". */
export function isRetryable(error: unknown) {
  return error instanceof AwsError && (error.status >= 500 || isTransient(error));
}

/**
 * The waiter that's woken next: the tenant with the fewest leases on the limit, then
 * the one that has waited longest.
 */
export function fairest<T extends { tenant: string; at: number }>(waiters: T[], active: Record<string, number>) {
  let best: T | undefined;
  for (const w of waiters) {
    if (!best) {
      best = w;
      continue;
    }
    const a = active[tenantKey(w.tenant)] ?? 0;
    const b = active[tenantKey(best.tenant)] ?? 0;
    if (a < b || (a === b && w.at < best.at)) best = w;
  }
  return best;
}

export class DynamoStore implements Store {
  constructor(
    private readonly table: string,
    private readonly aws?: AwsOptions,
  ) {}

  private db<T = any>(action: string, body: Record<string, unknown>) {
    return dynamo<T>(action, { TableName: this.table, ...body }, this.aws);
  }

  async beginEvent(item: string, delivery: string, ttlMs: number) {
    try {
      await this.db("PutItem", {
        Item: {
          pk: S(item),
          sk: S("-"),
          delivery: S(delivery),
          expires: { N: seconds(Date.now() + ttlMs) },
        },
        // A new ID, the same message again, or a message whose routing didn't finish.
        ConditionExpression: "attribute_not_exists(pk) OR delivery = :d OR attribute_not_exists(routed)",
        ExpressionAttributeValues: { ":d": S(delivery) },
      });
      return "route" as const;
    } catch (error) {
      if (isConditionFailure(error)) return "duplicate" as const;
      throw error;
    }
  }

  async finishEvent(item: string, ttlMs: number) {
    await this.db("UpdateItem", {
      Key: { pk: S(item), sk: S("-") },
      UpdateExpression: "SET routed = :t, expires = :e",
      ExpressionAttributeValues: {
        ":t": { BOOL: true },
        ":e": { N: seconds(Date.now() + ttlMs) },
      },
    });
  }

  async getAdmission(item: string) {
    const result = await this.db("GetItem", {
      Key: { pk: S(item), sk: S("-") },
      ConsistentRead: true,
    });
    return result.Item?.admission ? (JSON.parse(result.Item.admission.S) as Admission) : undefined;
  }

  async putAdmission(item: string, admission: Admission, ttlMs: number) {
    try {
      await this.db("PutItem", {
        Item: {
          pk: S(item),
          sk: S("-"),
          admission: S(JSON.stringify(admission)),
          expires: { N: seconds(Date.now() + ttlMs) },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      });
      return admission;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      return (await this.getAdmission(item)) ?? admission;
    }
  }

  async claim(item: string, owner: string, ttlMs: number) {
    try {
      await this.db("PutItem", {
        Item: {
          pk: S(item),
          sk: S("-"),
          owner: S(owner),
          expires: { N: seconds(Date.now() + ttlMs) },
        },
        ConditionExpression: "attribute_not_exists(pk) OR #o = :o OR expires < :now",
        ExpressionAttributeNames: { "#o": "owner" },
        ExpressionAttributeValues: {
          ":o": S(owner),
          ":now": { N: seconds(Date.now()) },
        },
      });
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async successor(item: string, owner: string, ttlMs: number) {
    if (await this.claim(item, owner, ttlMs)) return owner;
    const result = await this.db("GetItem", {
      Key: { pk: S(item), sk: S("-") },
      ConsistentRead: true,
    });
    return String(result.Item?.owner?.S ?? owner);
  }

  // GCRA keeps one number per bucket: the time the next start is due.
  private async gcra(item: string, intervalMs: number, toleranceMs: number, reserve: boolean): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = Date.now();
      const result = await this.db("GetItem", {
        Key: { pk: S(item), sk: S("-") },
        ConsistentRead: true,
      });
      const stored = result.Item?.tat ? Number(result.Item.tat.N) : undefined;
      const tat = Math.max(stored ?? now, now);
      const wait = Math.max(0, tat - toleranceMs - now);
      if (wait > 0 && !reserve) return wait;
      try {
        await this.db("PutItem", {
          Item: {
            pk: S(item),
            sk: S("-"),
            tat: N(tat + intervalMs),
            expires: { N: seconds(tat + intervalMs + toleranceMs + DAY) },
          },
          ConditionExpression: stored === undefined ? "attribute_not_exists(tat)" : "tat = :tat",
          ExpressionAttributeValues: stored === undefined ? undefined : { ":tat": N(stored) },
        });
        return reserve ? now + wait : 0;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    // Contended: say it's due one interval from now, and let the caller ask again.
    return reserve ? Date.now() + intervalMs : intervalMs;
  }

  take(item: string, intervalMs: number, toleranceMs: number) {
    return this.gcra(item, intervalMs, toleranceMs, false);
  }

  reserve(item: string, intervalMs: number, toleranceMs: number) {
    return this.gcra(item, intervalMs, toleranceMs, true);
  }

  // A limit is one item: `cap`, the limit; `active`, the number of leases; `leases`,
  // each lease's expiry and tenant; `tenants`, each tenant's leases, with no zero
  // counts kept; `queued`, the steps in line; and `waiting`, each tenant's steps in
  // line. A step's line entries are items of their own, one line per limit and tenant.
  //
  // A step takes every lease it needs in one transaction, or none, so it never holds
  // one while it waits for another: two steps can't each hold what the other waits
  // for. Each update is conditioned on the lease not being there yet, and the limit
  // having room, so the count can't go over the limit, or count a lease twice.

  async acquire(limits: Limit[], leaseId: string, tenant: string, leaseMs: number) {
    const unique = uniqueLimits(limits);
    // Look first: a read doesn't conflict with the transactions on a busy limit, and
    // most asks of one with a line, or with no room, would fail.
    const seen = await Promise.all(unique.map((l) => this.readLimit(l.item)));
    if (seen.every(Boolean)) {
      // Already ours, as given to it while it asked again: it claims it, so a wake of
      // its old callback that fails doesn't give it back.
      if (seen.every((item) => item!.leases[leaseId]) && (await this.renew(unique, leaseId, leaseMs, true)))
        return "granted" as const;
      const now = Date.now();
      const blocked = seen.some((item, i) => item!.queued > 0 || Object.keys(item!.leases).length >= unique[i].limit);
      const expired = seen.some((item) => Object.values(item!.leases).some((lease) => lease.expires <= now));
      if (blocked && !expired) return "full" as const;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = Date.now();
      try {
        await this.transact(
          unique.map((limit) => ({
            Update: {
              Key: { pk: S(limit.item), sk: S("-") },
              UpdateExpression:
                "SET leases.#l = :lease, expires = :exp, cap = :cap, label = if_not_exists(label, :label) ADD active :one, tenants.#t :one",
              ConditionExpression:
                "attribute_exists(pk) AND attribute_not_exists(leases.#l) AND active < :cap AND (attribute_not_exists(queued) OR queued <= :zero)",
              ExpressionAttributeNames: {
                "#l": leaseId,
                "#t": tenantKey(tenant),
              },
              ExpressionAttributeValues: {
                ":lease": S(`${now + leaseMs}|${tenant}`),
                ":one": N(1),
                ":zero": N(0),
                ":cap": N(limit.limit),
                ":exp": { N: seconds(now + DAY) },
                ":label": S(limit.label ?? limit.item),
              },
            },
          })),
        );
        return "granted" as const;
      } catch (error) {
        // A throttle or a lost response: look at what's there before saying anything.
        if (!isConditionFailure(error) && !isRetryable(error)) throw error;
      }
      const items = await Promise.all(unique.map((l) => this.readLimit(l.item)));
      const missing = unique.filter((_, i) => !items[i]);
      if (missing.length) {
        await Promise.all(missing.map((l) => this.createLimit(l)));
        continue;
      }
      // Already ours: a lease step that's retried, or a transaction that went
      // through though its response was lost.
      if (items.every((item) => item!.leases[leaseId]) && (await this.renew(unique, leaseId, leaseMs, true)))
        return "granted" as const;
      // Give back leases that expired, as when a run crashed, then try again.
      const reaped = await this.reap(unique, items as LimitState[], now);
      if (!reaped) return "full" as const;
    }
    return "full" as const;
  }

  async renew(limits: Limit[], leaseId: string, leaseMs: number, claim = false) {
    const now = Date.now();
    const unique = uniqueLimits(limits);
    const items = await Promise.all(unique.map((l) => this.readLimit(l.item)));
    for (const item of items) {
      const lease = item?.leases[leaseId];
      // An expired lease may be given back at any moment: it isn't renewed.
      if (!item?.raw[leaseId] || !lease || lease.expires <= now) return false;
    }
    // A lease that lasts past this invocation needs no write: a busy limit's writes
    // conflict. A step that claims a lease it found writes it, so it's its own.
    if (!claim && items.every((item) => item!.leases[leaseId].expires >= now + leaseMs)) return true;
    for (const [i, limit] of unique.entries()) {
      const raw = items[i]!.raw[leaseId];
      const lease = items[i]!.leases[leaseId];
      try {
        await this.db("UpdateItem", {
          Key: { pk: S(limit.item), sk: S("-") },
          UpdateExpression: "SET leases.#l = :lease, expires = :exp",
          ConditionExpression: "leases.#l = :old",
          ExpressionAttributeNames: { "#l": leaseId },
          ExpressionAttributeValues: {
            ":lease": S(`${now + leaseMs}|${lease.tenant}`),
            ":old": S(raw),
            ":exp": { N: seconds(now + DAY) },
          },
        });
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    }
    return true;
  }

  async release(limits: Limit[], leaseId: string, tenant: string, only?: string) {
    await Promise.all(uniqueLimits(limits).map((l) => this.releaseOne(l.item, leaseId, tenant, only)));
  }

  private async releaseOne(item: string, leaseId: string, tenant: string, only?: string) {
    try {
      await this.db("UpdateItem", {
        Key: { pk: S(item), sk: S("-") },
        UpdateExpression: "REMOVE leases.#l ADD active :minus, tenants.#t :minus",
        // To give back an expired lease, only the one that was read: its holder may
        // have renewed it since.
        ConditionExpression: only === undefined ? "attribute_exists(leases.#l)" : "leases.#l = :only",
        ExpressionAttributeNames: { "#l": leaseId, "#t": tenantKey(tenant) },
        ExpressionAttributeValues: {
          ":minus": N(-1),
          ...(only === undefined ? {} : { ":only": S(only) }),
        },
      });
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
    // Don't keep a tenant with no leases, so the item stays as small as its leases.
    await this.dropZero(item, "tenants", tenant);
    return true;
  }

  private async dropZero(item: string, map: "tenants" | "waiting", tenant: string) {
    await this.db("UpdateItem", {
      Key: { pk: S(item), sk: S("-") },
      UpdateExpression: map === "waiting" ? "REMOVE waiting.#t, waitingAt.#t" : `REMOVE ${map}.#t`,
      ConditionExpression: `${map}.#t <= :zero`,
      ExpressionAttributeNames: { "#t": tenantKey(tenant) },
      ExpressionAttributeValues: { ":zero": N(0) },
    }).catch((error) => {
      if (!isConditionFailure(error)) throw error;
    });
  }

  private async reap(limits: Limit[], items: LimitState[], now: number) {
    let reaped = false;
    for (const [i, limit] of limits.entries())
      for (const [id, lease] of Object.entries(items[i].leases))
        if (lease.expires <= now && (await this.releaseOne(limit.item, id, lease.tenant, items[i].raw[id])))
          reaped = true;
    return reaped;
  }

  private entryKey(limit: Limit, waiter: Pick<LeaseWaiter, "tenant" | "at" | "leaseId">) {
    return {
      pk: S(queueKey(limit.item, waiter.tenant)),
      sk: S(`${pad(waiter.at)}#${waiter.leaseId}`),
    };
  }

  async enqueue(waiter: LeaseWaiter) {
    const limits = uniqueLimits(waiter.limits);
    const items = await Promise.all(limits.map((l) => this.readLimit(l.item)));
    if (items.every((item) => item?.leases[waiter.leaseId]) && (await this.renew(limits, waiter.leaseId, GRANT_MS, true)))
      return "held" as const;
    await Promise.all(limits.filter((_, i) => !items[i]).map((l) => this.createLimit(l)));
    const entry = {
      lease: S(waiter.leaseId),
      tenant: S(waiter.tenant),
      callback: S(waiter.callbackId),
      run: S(waiter.runId),
      at: N(waiter.at),
      limits: S(JSON.stringify(limits)),
      expires: { N: seconds(waiter.expiresAt + DAY) },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // The entries and the counts go in together, so a release in between can't
        // take a count below what's in line.
        await this.transact(
          limits.flatMap((limit) => [
            {
              Put: {
                Item: { ...this.entryKey(limit, waiter), ...entry },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                Key: { pk: S(limit.item), sk: S("-") },
                // The limit lives while steps are in line, however long that is.
                UpdateExpression: "SET expires = :exp, waitingAt.#t = :now ADD queued :one, waiting.#t :one",
                ExpressionAttributeNames: { "#t": tenantKey(waiter.tenant) },
                ExpressionAttributeValues: {
                  ":one": N(1),
                  ":exp": { N: seconds(Date.now() + DAY) },
                  ":now": N(Date.now()),
                },
              },
            },
          ]),
        );
        return "queued" as const;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
      // Asking again: the step keeps its place, with its new callback.
      let gone = false;
      for (const limit of limits) {
        try {
          await this.db("UpdateItem", {
            Key: this.entryKey(limit, waiter),
            UpdateExpression: "SET callback = :cb, expires = :exp",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: {
              ":cb": entry.callback,
              ":exp": entry.expires,
            },
          });
        } catch (error) {
          if (!isConditionFailure(error)) throw error;
          gone = true;
        }
      }
      if (!gone) {
        // The tenant still has a step in line, so its count isn't taken for a stale one.
        await this.db("UpdateItem", {
          Key: { pk: S(limits[0].item), sk: S("-") },
          UpdateExpression: "SET waitingAt.#t = :now",
          ExpressionAttributeNames: { "#t": tenantKey(waiter.tenant) },
          ExpressionAttributeValues: { ":now": N(Date.now()) },
        }).catch(() => {});
        for (const limit of limits.slice(1))
          await this.db("UpdateItem", {
            Key: { pk: S(limit.item), sk: S("-") },
            UpdateExpression: "SET waitingAt.#t = :now",
            ExpressionAttributeNames: { "#t": tenantKey(waiter.tenant) },
            ExpressionAttributeValues: { ":now": N(Date.now()) },
          }).catch(() => {});
        return "queued" as const;
      }
      // Its entries are gone: it was given its leases in between, or given them and
      // they were given back, as its old callback had timed out. Then it joins again.
      const again = await Promise.all(limits.map((l) => this.readLimit(l.item)));
      if (again.every((item) => item?.leases[waiter.leaseId]) && (await this.renew(limits, waiter.leaseId, GRANT_MS, true)))
        return "held" as const;
    }
    return "queued" as const;
  }

  async dispatch(limit: Limit, wake: (w: LeaseWaiter) => Promise<boolean>) {
    let woken = 0;
    for (let round = 0; round < limit.limit + 5; round++) {
      const item = await this.readLimit(limit.item);
      if (!item) return woken;
      const now = Date.now();
      if (await this.reap([limit], [item], now)) continue;
      if (Object.keys(item.leases).length >= limit.limit) return woken;

      const { candidates, reset, empty } = await this.candidates(limit, item, now);
      if (empty) return woken;
      let granted: (typeof candidates)[number] | undefined;
      let value: string | undefined;
      for (const c of candidates) {
        value = await this.grant(c);
        if (value) {
          granted = c;
          break;
        }
      }
      // The tenants looked at had no step in line: look at the next ones.
      if (!candidates.length && reset) continue;
      // No step in line can have all it needs now. A release of the limit it's missing
      // gives it to it.
      if (!granted) return woken;
      if (await wake(granted).catch(() => false)) woken++;
      // The step is gone, as when its run stopped, or it asked again with a new
      // callback. Give back the leases this gave it, and try the next one: only those,
      // since a step that asked again may have found them and renewed them as its own.
      else await this.release(granted.limits, granted.leaseId, granted.tenant, value);
    }
    return woken;
  }

  // The next steps to give leases to: the oldest step of each of the fairest tenants.
  private async candidates(limit: Limit, item: LimitState, now: number) {
    // The tenants in line, fewest leases first.
    const tenants = Object.entries(item.waiting)
      .filter(([, n]) => n > 0)
      .map(([t]) => t)
      .sort((a, b) => (item.tenants[a] ?? 0) - (item.tenants[b] ?? 0));
    if (!tenants.length) {
      if (item.queued !== 0)
        await this.db("UpdateItem", {
          Key: { pk: S(limit.item), sk: S("-") },
          UpdateExpression: "SET queued = :zero",
          ConditionExpression: "queued = :q",
          ExpressionAttributeValues: { ":zero": N(0), ":q": N(item.queued) },
        }).catch(() => {});
      return { candidates: [], reset: false, empty: true };
    }
    // The oldest step of each of the fairest tenants. A tenant counted as waiting
    // with no step in line has its count reset.
    const fewest = item.tenants[tenants[0]] ?? 0;
    const candidates: (LeaseWaiter & { sk: string })[] = [];
    let reset = false;
    for (const t of tenants.slice(0, 20)) {
      if (candidates.length && (item.tenants[t] ?? 0) > fewest) break;
      const page = await this.db("Query", {
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": S(lineKey(limit.item, t)) },
        ConsistentRead: true,
        Limit: 1,
      });
      const e = page.Items?.[0];
      if (!e) {
        // A read isn't isolated from a transaction that's going on: the count of a
        // step joining the line can be seen before its entry. So a count is only
        // taken for a stale one, as when entries expired, if the tenant hasn't
        // joined or asked again in longer than a step waits before it asks again.
        if (now - (item.waitingAt[t] ?? 0) > STALE_LINE_MS) {
          await this.db("UpdateItem", {
            Key: { pk: S(limit.item), sk: S("-") },
            UpdateExpression: "REMOVE waiting.#t, waitingAt.#t ADD queued :minus",
            ConditionExpression: "waiting.#t = :n",
            ExpressionAttributeNames: { "#t": t },
            ExpressionAttributeValues: {
              ":n": N(item.waiting[t]),
              ":minus": N(-item.waiting[t]),
            },
          }).catch(() => {});
          reset = true;
        }
        continue;
      }
      candidates.push({
        sk: String(e.sk.S),
        leaseId: String(e.lease.S),
        tenant: String(e.tenant.S),
        callbackId: String(e.callback.S),
        runId: String(e.run.S),
        at: Number(e.at.N),
        expiresAt: 0,
        limits: JSON.parse(e.limits.S),
      });
    }
    candidates.sort(
      (a, b) => (item.tenants[tenantKey(a.tenant)] ?? 0) - (item.tenants[tenantKey(b.tenant)] ?? 0) || a.at - b.at,
    );
    return { candidates, reset, empty: false };
  }

  async handoff(limits: Limit[], leaseId: string, tenant: string, wake: (w: LeaseWaiter) => Promise<boolean>) {
    const unique = uniqueLimits(limits);
    // The limit with the most tenants in line first: that's where it's decided whose
    // turn is fair. A tenant's own limit has only its own steps in line.
    const items = await Promise.all(unique.map((l) => this.readLimit(l.item)));
    const tenantsInLine = (i: number) => Object.values(items[i]?.waiting ?? {}).filter((n) => n > 0).length;
    const order = unique.map((_, i) => i).sort((a, b) => tenantsInLine(b) - tenantsInLine(a) || unique[b].limit - unique[a].limit);
    for (const i of order) {
      const limit = unique[i];
      const item = items[i];
      if (!item?.leases[leaseId]) continue;
      const { candidates } = await this.candidates(limit, item, Date.now());
      for (const next of candidates.slice(0, 3)) {
        const value = await this.grant(next, {
          limits: unique,
          leaseId,
          tenant,
        });
        if (!value) continue;
        // The step's leases went to the next one, or back, in the same write.
        if (!(await wake(next).catch(() => false))) {
          await this.release(next.limits, next.leaseId, next.tenant, value);
          for (const l of uniqueLimits(next.limits)) await this.dispatch(l, wake);
        }
        // A limit the next step doesn't need was given back: hand it on.
        for (const l of unique) if (!next.limits.some((n) => n.item === l.item)) await this.dispatch(l, wake);
        return;
      }
      break;
    }
    await this.release(unique, leaseId, tenant);
    for (const i of order) await this.dispatch(unique[i], wake);
  }

  // Take a step out of every line it's in, and give it every lease it needs, together.
  // It returns the leases' value, to give back only those, or nothing.
  private async grant(w: LeaseWaiter, from?: { limits: Limit[]; leaseId: string; tenant: string }) {
    const now = Date.now();
    const value = `${now + GRANT_MS}|${w.tenant}`;
    const mine = uniqueLimits(w.limits);
    const theirs = from ? uniqueLimits(from.limits) : [];
    const all = new Map<string, { limit: Limit; give: boolean; take: boolean }>();
    for (const l of mine) all.set(l.item, { limit: l, give: true, take: false });
    for (const l of theirs) {
      const at = all.get(l.item);
      if (at) at.take = true;
      else all.set(l.item, { limit: l, give: false, take: true });
    }
    const t = tenantKey(w.tenant);
    const updates = [...all.values()].map(({ limit, give, take }) => {
      const key = { pk: S(limit.item), sk: S("-") };
      if (give && take) {
        // The lease goes from one step to the next: the count doesn't change.
        const ot = tenantKey(from!.tenant);
        const same = ot === t;
        return {
          Update: {
            Key: key,
            UpdateExpression: `REMOVE leases.#o SET leases.#l = :lease, expires = :exp ADD queued :minus, waiting.#t :minus${
              same ? "" : ", tenants.#t :one, tenants.#ot :minus"
            }`,
            ConditionExpression: "attribute_exists(leases.#o) AND attribute_not_exists(leases.#l)",
            ExpressionAttributeNames: {
              "#o": from!.leaseId,
              "#l": w.leaseId,
              "#t": t,
              ...(same ? {} : { "#ot": ot }),
            },
            ExpressionAttributeValues: {
              ":lease": S(value),
              ":exp": { N: seconds(now + DAY) },
              ":minus": N(-1),
              ...(same ? {} : { ":one": N(1) }),
            },
          },
        };
      }
      if (give)
        return {
          Update: {
            Key: key,
            UpdateExpression:
              "SET leases.#l = :lease, expires = :exp ADD active :one, tenants.#t :one, queued :minus, waiting.#t :minus",
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(leases.#l) AND active < :cap",
            ExpressionAttributeNames: { "#l": w.leaseId, "#t": t },
            ExpressionAttributeValues: {
              ":lease": S(value),
              ":exp": { N: seconds(now + DAY) },
              ":one": N(1),
              ":minus": N(-1),
              ":cap": N(limit.limit),
            },
          },
        };
      return {
        Update: {
          Key: key,
          UpdateExpression: "REMOVE leases.#o ADD active :minus, tenants.#ot :minus",
          ConditionExpression: "attribute_exists(leases.#o)",
          ExpressionAttributeNames: {
            "#o": from!.leaseId,
            "#ot": tenantKey(from!.tenant),
          },
          ExpressionAttributeValues: { ":minus": N(-1) },
        },
      };
    });
    try {
      await this.transact([
        ...mine.map((l) => ({
          Delete: {
            Key: this.entryKey(l, w),
            // Only the entry this was read from: a step that asked again has a new
            // callback, and is woken with that.
            ConditionExpression: "callback = :cb",
            ExpressionAttributeValues: { ":cb": S(w.callbackId) },
          },
        })),
        ...updates,
      ]);
    } catch (error) {
      if (isConditionFailure(error) || isRetryable(error)) return undefined;
      throw error;
    }
    for (const l of mine) await this.dropZero(l.item, "waiting", w.tenant);
    if (from) for (const l of theirs) await this.dropZero(l.item, "tenants", from.tenant);
    return value;
  }

  private async transact(items: Record<string, any>[]) {
    await dynamo(
      "TransactWriteItems",
      {
        TransactItems: items.map((op) => {
          const [kind, body] = Object.entries(op)[0] as [string, Record<string, any>];
          return { [kind]: { TableName: this.table, ...body } };
        }),
      },
      this.aws,
    );
  }

  private async readLimit(item: string): Promise<LimitState | undefined> {
    const result = await this.db("GetItem", {
      Key: { pk: S(item), sk: S("-") },
      ConsistentRead: true,
    });
    if (!result.Item) return undefined;
    const leases: LimitState["leases"] = Object.create(null);
    const raw: Record<string, string> = Object.create(null);
    for (const [id, value] of Object.entries<any>(result.Item.leases?.M ?? {})) {
      const [expires, ...rest] = String(value.S).split("|");
      leases[id] = { expires: Number(expires), tenant: rest.join("|") };
      raw[id] = String(value.S);
    }
    const counts = (m: any) => {
      const out: Record<string, number> = Object.create(null);
      for (const [t, v] of Object.entries<any>(m ?? {})) out[t] = Number(v.N);
      return out;
    };
    return {
      leases,
      raw,
      tenants: counts(result.Item.tenants?.M),
      waiting: counts(result.Item.waiting?.M),
      waitingAt: counts(result.Item.waitingAt?.M),
      queued: Number(result.Item.queued?.N ?? 0),
    };
  }

  private async createLimit(limit: Limit) {
    try {
      await this.db("PutItem", {
        Item: {
          pk: S(limit.item),
          sk: S("-"),
          active: N(0),
          queued: N(0),
          leases: { M: {} },
          tenants: { M: {} },
          waiting: { M: {} },
          waitingAt: { M: {} },
          label: S(limit.label ?? limit.item),
          cap: N(limit.limit),
          expires: { N: seconds(Date.now() + DAY) },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      });
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  async waitFields(name: string, tenant: string | undefined) {
    const result = await this.db("Query", {
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "#u > :now",
      ExpressionAttributeNames: { "#u": "until" },
      ExpressionAttributeValues: {
        ":pk": S(fieldsKey(name, tenant)),
        ":now": N(Date.now()),
      },
      ConsistentRead: true,
    });
    return (result.Items ?? []).map((item: any) => String(item.sk.S));
  }

  async addWaitField(name: string, tenant: string | undefined, field: string, until: number) {
    try {
      await this.db("PutItem", {
        Item: {
          pk: S(fieldsKey(name, tenant)),
          sk: S(field),
          until: N(until),
          expires: { N: seconds(until + 3_600_000) },
        },
        ConditionExpression: "attribute_not_exists(#u) OR #u < :until",
        ExpressionAttributeNames: { "#u": "until" },
        ExpressionAttributeValues: { ":until": N(until) },
      });
    } catch (error) {
      // A wait that lasts longer already keeps the field.
      if (!isConditionFailure(error)) throw error;
    }
  }

  async putWaiter(key: string, waiter: Waiter) {
    await this.db("PutItem", {
      Item: {
        pk: S(key),
        sk: S(waiterSort(waiter)),
        callback: S(waiter.callbackId),
        run: S(waiter.runId),
        created: N(waiter.createdAt),
        until: N(waiter.expiresAt),
        kind: S(waiter.kind ?? "wait"),
        ...(waiter.condition ? { condition: S(waiter.condition) } : {}),
        ...(waiter.parent ? { parent: S(waiter.parent) } : {}),
        ...(waiter.info ? { info: S(JSON.stringify(waiter.info)) } : {}),
        expires: { N: seconds(waiter.expiresAt + 3_600_000) },
      },
    });
  }

  async waiters(key: string, now: number) {
    const items: any[] = [];
    let start: any;
    do {
      const result = await this.db("Query", {
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "#u > :now",
        ExpressionAttributeNames: { "#u": "until" },
        ExpressionAttributeValues: { ":pk": S(key), ":now": N(now) },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      });
      items.push(...(result.Items ?? []));
      start = result.LastEvaluatedKey;
    } while (start);
    return items.map(
      (item): Waiter => ({
        callbackId: String(item.callback.S),
        runId: String(item.run.S),
        createdAt: Number(item.created.N),
        expiresAt: Number(item.until.N),
        condition: item.condition?.S,
        kind: item.kind?.S === "cancel" ? "cancel" : "wait",
        parent: item.parent?.S,
      }),
    );
  }

  async deleteWaiter(key: string, waiter: Pick<Waiter, "createdAt" | "callbackId">) {
    await this.db("DeleteItem", {
      Key: { pk: S(key), sk: S(waiterSort(waiter)) },
    });
  }

  async putRecent(key: string, event: WireEvent, receivedAt: number, ttlMs: number) {
    await this.db("PutItem", {
      Item: {
        pk: S(key),
        sk: S(`${pad(receivedAt)}#${event.id}`),
        event: S(JSON.stringify(event)),
        expires: { N: seconds(receivedAt + ttlMs) },
      },
    });
  }

  async recent(key: string, since: number) {
    const out: { event: WireEvent; receivedAt: number }[] = [];
    let start: any;
    do {
      const result = await this.db("Query", {
        KeyConditionExpression: "pk = :pk AND sk >= :since",
        ExpressionAttributeValues: { ":pk": S(key), ":since": S(pad(since)) },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      });
      for (const item of result.Items ?? [])
        out.push({
          event: JSON.parse(item.event.S) as WireEvent,
          receivedAt: Number(String(item.sk.S).split("#")[0]),
        });
      start = result.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async scan(prefix: string, limit: number) {
    const items: Record<string, any>[] = [];
    let start: any;
    do {
      const result = await this.db("Scan", {
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": S(prefix) },
        ExclusiveStartKey: start,
      });
      items.push(...(result.Items ?? []).map(unmarshal));
      start = result.LastEvaluatedKey;
    } while (start && items.length < limit);
    return items.slice(0, limit);
  }
}

interface LimitState {
  leases: Record<string, { expires: number; tenant: string }>;
  /** Each lease's stored value, to give back only the one that was read. */
  raw: Record<string, string>;
  tenants: Record<string, number>;
  waiting: Record<string, number>;
  /** When each tenant last joined the line, or asked again. */
  waitingAt: Record<string, number>;
  queued: number;
}

/**
 * How long a tenant counted in line, with no step in its line, goes without joining
 * or asking again before its count is taken for a stale one: longer than a step waits
 * before it asks again.
 */
const STALE_LINE_MS = 20 * 60_000;

/**
 * How long a lease given to a step in line lasts: as long as the longest invocation,
 * so the step it wakes doesn't have to write to renew it.
 */
export const GRANT_MS = 15 * 60_000 + 10_000;

/** The line of a limit, for one tenant. */
export function queueKey(item: string, tenant: string) {
  return lineKey(item, tenantKey(tenant));
}

function lineKey(item: string, mapKey: string) {
  return keyOf("Q", item, mapKey);
}

export function uniqueLimits(limits: Limit[]) {
  const seen = new Set<string>();
  return limits.filter((l) => !seen.has(l.item) && seen.add(l.item));
}

export function fieldsKey(name: string, tenant: string | undefined) {
  return keyOf("WF", name, tenant ?? null);
}

function unmarshal(item: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = Object.create(null);
  for (const [k, v] of Object.entries(item)) out[k] = value(v);
  return out;
  function value(v: any): any {
    if ("S" in v) return v.S;
    if ("N" in v) return Number(v.N);
    if ("BOOL" in v) return v.BOOL;
    if ("M" in v) return unmarshal(v.M);
    if ("L" in v) return v.L.map(value);
    if ("NULL" in v) return null;
    return v;
  }
}

export { AwsError };
