import type { AwsOptions } from "../client.js";
import { randomInt } from "node:crypto";
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
   * leases are given back. A wake that throws may not have reached the step: its
   * leases are given back and it's put back in line, in its place, for a later
   * dispatch. Returns how many it woke.
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

/** The value of a lease in the item of a condition that wasn't met. */
const leaseIn = (error: unknown, leaseId: string) => (error as AwsError).body?.Item?.leases?.M?.[leaseId]?.S;

export class DynamoStore implements Store {
  constructor(
    private readonly table: string,
    private readonly aws?: AwsOptions,
  ) {}

  private db<T = any>(action: string, body: Record<string, unknown>, options?: { retries?: number }) {
    return dynamo<T>(action, { TableName: this.table, ...body }, this.aws, options);
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

  // A limit is an item with its leases, at sort key "-": `cap`; `active`, the number of
  // leases; `leases`, each lease's expiry and tenant; and `tenants`, each tenant's
  // leases, with no zero counts kept. And an item for each tenant in its line, at
  // "w#<tenant>": `n`, its steps in line; and `at`, when that last changed. They're apart
  // so that many tenants, or a burst, don't make one item large or hot. A step's entries
  // in line are items of their own, one line per limit and tenant.
  //
  // None of it is written in a transaction. On a busy limit, transactions on one item
  // fail each other, where plain writes take their turn. Each write is conditioned, so
  // a limit can't go over, or count a lease twice. A step takes the limits it needs
  // one at a time, always in the same order, and gives back the ones it took if the
  // next is full: it never waits holding a lease, so two steps can't each hold what
  // the other waits for.

  // Take one lease, if there's room and it isn't there yet. A write that was made, but
  // whose answer was lost, is tried again and finds its own lease: that's a lease taken.
  private async takeOne(limit: Limit, leaseId: string, tenant: string, value: string): Promise<"taken" | "held" | "full"> {
    try {
      await this.db("UpdateItem", {
        Key: { pk: S(limit.item), sk: S("-") },
        UpdateExpression:
          "SET leases.#l = :lease, expires = :exp, cap = :cap, label = if_not_exists(label, :label) ADD active :one, tenants.#t :one",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(leases.#l) AND active < :cap",
        ExpressionAttributeNames: { "#l": leaseId, "#t": tenantKey(tenant) },
        ExpressionAttributeValues: {
          ":lease": S(value),
          ":one": N(1),
          ":cap": N(limit.limit),
          ":exp": { N: seconds(Date.now() + DAY) },
          ":label": S(limit.label ?? limit.item),
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      });
      return "taken";
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const there = leaseIn(error, leaseId);
      return there === value ? "taken" : there === undefined ? "full" : "held";
    }
  }

  // Take every lease, in order, or give back the ones taken. One the step has already,
  // as from a grant in progress that may yet be undone, is made this step's own, so
  // undoing the grant doesn't give it back.
  private async takeAll(limits: Limit[], leaseId: string, tenant: string, value: string, held: Map<string, string>) {
    const taken: Limit[] = [];
    const undo = async () => {
      for (const t of taken) await this.releaseOne(t.item, leaseId, tenant, value).catch(() => {});
    };
    for (const limit of limits) {
      const old = held.get(limit.item);
      // Given back by its value if the next is full, or if this one fails, which may
      // be after it was written.
      taken.push(limit);
      try {
        if (old === undefined ? (await this.takeOne(limit, leaseId, tenant, value)) === "taken" : await this.setLease(limit.item, leaseId, old, value))
          continue;
      } catch (error) {
        await undo();
        throw error;
      }
      taken.pop();
      await undo();
      return false;
    }
    return true;
  }

  // Replace a lease's value, if it's still the one that was read.
  private async setLease(item: string, leaseId: string, old: string, value: string) {
    try {
      await this.db("UpdateItem", {
        Key: { pk: S(item), sk: S("-") },
        UpdateExpression: "SET leases.#l = :lease, expires = :exp",
        ConditionExpression: "leases.#l = :old",
        ExpressionAttributeNames: { "#l": leaseId },
        ExpressionAttributeValues: { ":lease": S(value), ":old": S(old), ":exp": { N: seconds(Date.now() + DAY) } },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      });
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return leaseIn(error, leaseId) === value;
      throw error;
    }
  }

  async acquire(limits: Limit[], leaseId: string, tenant: string, leaseMs: number) {
    const unique = ordered(limits);
    for (let attempt = 0; attempt < 4; attempt++) {
      const items = await Promise.all(unique.map((l) => this.readLimit(l.item, "any")));
      const missing = unique.filter((_, i) => !items[i]);
      if (missing.length) {
        await Promise.all(missing.map((l) => this.createLimit(l)));
        continue;
      }
      // Already ours, as given to it while it asked again: it claims it, so a wake of
      // its old callback that fails doesn't give it back.
      if (items.every((item) => item!.leases[leaseId]) && (await this.renew(unique, leaseId, leaseMs, true)))
        return "granted" as const;
      const now = Date.now();
      // Give back leases that expired, as when a run crashed, then look again.
      if (await this.reap(unique, items as LimitState[], now)) continue;
      // A step in line goes first, and a full limit has no room: don't ask.
      if (items.some((item, i) => item!.queued > 0 || Object.keys(item!.leases).length >= unique[i].limit))
        return "full" as const;
      const held = new Map(unique.flatMap((l, i) => (items[i]!.raw[leaseId] ? [[l.item, items[i]!.raw[leaseId]] as const] : [])));
      if (await this.takeAll(unique, leaseId, tenant, leaseValue(now + leaseMs, tenant, "own"), held)) return "granted" as const;
      // Another step took the room first.
    }
    return "full" as const;
  }

  async renew(limits: Limit[], leaseId: string, leaseMs: number, claim = false) {
    const now = Date.now();
    const unique = uniqueLimits(limits);
    const items = await Promise.all(unique.map((l) => this.readLimit(l.item, "none")));
    for (const item of items) {
      const lease = item?.leases[leaseId];
      // An expired lease may be given back at any moment: it isn't renewed.
      if (!item?.raw[leaseId] || !lease || lease.expires <= now) return false;
    }
    // A lease the step took itself, that lasts past this invocation, needs no write. One
    // it was given is made its own, so whoever gave it can't give it back any more, as
    // when the wake reached the step but its answer was lost.
    if (!claim && items.every((item) => !item!.leases[leaseId].granted && item!.leases[leaseId].expires >= now + leaseMs))
      return true;
    const renewed: [Limit, string, string][] = [];
    try {
      for (const [i, limit] of unique.entries()) {
        const lease = items[i]!.leases[leaseId];
        const value = leaseValue(Math.max(now + leaseMs, lease.expires), lease.tenant, "own");
        renewed.push([limit, lease.tenant, value]);
        if (await this.setLease(limit.item, leaseId, items[i]!.raw[leaseId], value)) continue;
        renewed.pop();
        await this.giveBackAll(renewed, leaseId);
        return false;
      }
    } catch (error) {
      await this.giveBackAll(renewed, leaseId);
      throw error;
    }
    return true;
  }

  // A claim that lost one of its leases gives back the ones it made its own: whoever
  // granted them no longer can.
  private async giveBackAll(leases: [Limit, string, string][], leaseId: string) {
    for (const [limit, tenant, value] of leases) await this.releaseOne(limit.item, leaseId, tenant, value).catch(() => {});
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
        ExpressionAttributeValues: { ":minus": N(-1), ...(only === undefined ? {} : { ":only": S(only) }) },
      });
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
    // Don't keep a tenant with no leases, so the item stays as small as its leases.
    await this.dropTenant(item, tenant);
    return true;
  }

  private async dropTenant(item: string, tenant: string) {
    await this.db("UpdateItem", {
      Key: { pk: S(item), sk: S("-") },
      UpdateExpression: "REMOVE tenants.#t",
      ConditionExpression: "tenants.#t <= :zero",
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
    return { pk: S(queueKey(limit.item, waiter.tenant)), sk: S(`${pad(waiter.at)}#${waiter.leaseId}`) };
  }

  private entry(waiter: LeaseWaiter) {
    return {
      lease: S(waiter.leaseId),
      tenant: S(waiter.tenant),
      callback: S(waiter.callbackId),
      run: S(waiter.runId),
      at: N(waiter.at),
      limits: S(JSON.stringify(ordered(waiter.limits))),
      expires: { N: seconds(waiter.expiresAt + DAY) },
    };
  }

  // Put a step that was taken out of line back in, in its place, as when it was given
  // its leases but couldn't be told. Where it's in line already, as when it asked
  // again in between, it's left as it is.
  private async requeue(waiter: LeaseWaiter) {
    for (const limit of ordered(waiter.limits)) await this.join(limit, waiter);
  }

  // Put a step in a limit's line, or say it's there already. It's counted before its
  // entry goes in, so wherever this stops, the count isn't one short: that would hide a
  // step that waits. One too many is found with no step behind it, and taken out.
  private async join(limit: Limit, waiter: LeaseWaiter) {
    await this.count(limit.item, waiter.tenant, 1);
    try {
      await this.db("PutItem", {
        Item: { ...this.entryKey(limit, waiter), ...this.entry(waiter) },
        ConditionExpression: "attribute_not_exists(pk)",
      });
      return true;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      await this.count(limit.item, waiter.tenant, -1);
      return false;
    }
  }

  // Wake a step that was given its leases. If it can't be woken, give them back: only
  // those, since a step that asked again may have found them and claimed them. One
  // that may not have been told goes back in line, and isn't tried again in this
  // dispatch, so an outage doesn't keep it busy.
  private async tell(w: LeaseWaiter, value: string, wake: (w: LeaseWaiter) => Promise<boolean>, skip: Set<string>) {
    let woken: boolean | undefined;
    try {
      woken = await wake(w);
    } catch {}
    if (woken) return true;
    if (woken === undefined) {
      skip.add(w.leaseId);
      await this.requeue(w).catch(() => {});
    }
    await this.release(w.limits, w.leaseId, w.tenant, value);
    return false;
  }

  // Count a step in, or out of, a limit's line. One counted out twice, as when an answer
  // was lost, doesn't go below zero.
  private async count(item: string, tenant: string, n: 1 | -1) {
    const Key = { pk: S(item), sk: S(`w#${tenantKey(tenant)}`) };
    let left = 0;
    try {
      const result = await this.db("UpdateItem", {
        Key,
        UpdateExpression: "SET #at = :now, expires = :exp ADD #n :n",
        ...(n < 0 ? { ConditionExpression: "#n > :zero" } : {}),
        ExpressionAttributeNames: { "#n": "n", "#at": "at" },
        ExpressionAttributeValues: {
          ":now": N(Date.now()),
          ":exp": { N: seconds(Date.now() + DAY) },
          ":n": N(n),
          ...(n < 0 ? { ":zero": N(0) } : {}),
        },
        ReturnValues: "UPDATED_NEW",
      });
      left = Number(result.Attributes?.n?.N ?? 1);
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
    if (n > 0 || left > 0) return;
    await this.dropLine(Key, 0);
    // A step is counted before it's in line, so one in line here isn't counted. Count
    // it, so it's seen.
    const page = await this.db("Query", {
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": S(queueKey(item, tenant)) },
      ConsistentRead: true,
      Limit: 1,
    });
    if (!page.Items?.length) return;
    await this.db("UpdateItem", {
      Key,
      UpdateExpression: "SET #n = :one, #at = :now, expires = :exp",
      ConditionExpression: "attribute_not_exists(#n) OR #n <= :zero",
      ExpressionAttributeNames: { "#n": "n", "#at": "at" },
      ExpressionAttributeValues: {
        ":one": N(1),
        ":zero": N(0),
        ":now": N(Date.now()),
        ":exp": { N: seconds(Date.now() + DAY) },
      },
    }).catch((error) => {
      if (!isConditionFailure(error)) throw error;
    });
  }

  // Take a tenant out of a limit's line, if its count is still this, and if given, hasn't
  // changed since.
  private async dropLine(Key: Record<string, unknown>, n: number, at?: number) {
    await this.db("DeleteItem", {
      Key,
      ConditionExpression: at === undefined ? "#n = :n" : "#n = :n AND #at = :at",
      ExpressionAttributeNames: { "#n": "n", ...(at === undefined ? {} : { "#at": "at" }) },
      ExpressionAttributeValues: { ":n": N(n), ...(at === undefined ? {} : { ":at": N(at) }) },
    }).catch((error) => {
      if (!isConditionFailure(error)) throw error;
    });
  }

  async enqueue(waiter: LeaseWaiter) {
    const limits = ordered(waiter.limits);
    // A step that goes on isn't in line. An entry of it left there, whose callback it
    // won't wait for, would be given leases that no step gives back.
    const held = async () => {
      for (const l of limits) await this.leave(l, waiter);
      return "held" as const;
    };
    const items = await Promise.all(limits.map((l) => this.readLimit(l.item, "none")));
    if (items.every((item) => item?.leases[waiter.leaseId]) && (await this.renew(limits, waiter.leaseId, GRANT_MS, true)))
      return held();
    await Promise.all(limits.filter((_, i) => !items[i]).map((l) => this.createLimit(l)));
    const entry = this.entry(waiter);
    for (let attempt = 0; attempt < 3; attempt++) {
      let gone = false;
      for (const limit of limits) {
        if (await this.join(limit, waiter)) continue;
        // Asking again: the step keeps its place, with its new callback.
        try {
          await this.db("UpdateItem", {
            Key: this.entryKey(limit, waiter),
            UpdateExpression: "SET callback = :cb, expires = :exp",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: { ":cb": entry.callback, ":exp": entry.expires },
          });
        } catch (error) {
          if (!isConditionFailure(error)) throw error;
          gone = true;
        }
      }
      // A step can be given its leases once it's in its first line. A grant takes it out
      // of its lines in the order it joined them, so if it's still in the first, it's
      // taken out of the rest too. If it isn't, an entry that came after is left over.
      if (!gone && limits.length > 1) {
        const { Item } = await this.db("GetItem", {
          Key: this.entryKey(limits[0], waiter),
          ProjectionExpression: "pk",
          ConsistentRead: true,
        });
        if (!Item) {
          gone = true;
          for (const l of limits.slice(1)) await this.leave(l, waiter);
        }
      }
      if (!gone) return "queued" as const;
      // An entry went in between: the step was given its leases, or given them and
      // they were given back, as its old callback had timed out. Then it joins again.
      const again = await Promise.all(limits.map((l) => this.readLimit(l.item, "none")));
      if (again.every((item) => item?.leases[waiter.leaseId]) && (await this.renew(limits, waiter.leaseId, GRANT_MS, true)))
        return held();
    }
    return "queued" as const;
  }

  async dispatch(limit: Limit, wake: (w: LeaseWaiter) => Promise<boolean>, skip = new Set<string>()) {
    let woken = 0;
    let again = false;
    // Bounded by time, not by tries: a step that's gone, as when its run was stopped, is
    // taken out of line, and a step that another dispatch got to first is being woken.
    const end = Date.now() + DISPATCH_MS;
    while (woken < limit.limit + 5 && Date.now() < end) {
      const item = await this.readLimit(limit.item);
      if (!item) return woken;
      if (await this.reap([limit], [item], Date.now())) continue;
      if (Object.keys(item.leases).length >= limit.limit) return woken;
      let granted: LeaseWaiter | undefined;
      let value: string | undefined;
      let undone = false;
      let raced = false;
      for await (const c of this.candidates(limit, item, skip)) {
        if (!(await this.hasRoom(c.limits.filter((l) => l.item !== limit.item)))) continue;
        const grant = await this.grant(c, [limit]);
        undone ||= grant.undone;
        raced ||= grant.raced;
        value = grant.value;
        if (value) {
          granted = c;
          break;
        }
      }
      if (granted) {
        // A step that's gone, or asked again with a new callback, gives its leases back
        // to the next one.
        if (await this.tell(granted, value!, wake, skip)) woken++;
        continue;
      }
      // Another dispatch got to a step first: there may be room, and another step.
      if (raced) {
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
        continue;
      }
      // No step in line can have all it needs now. A release of the limit it's missing
      // gives it to it. A lease that was taken and given back was gone for a moment,
      // and another step may have found the limit full then: look again, once.
      if (!undone || again) return woken;
      again = true;
    }
    return woken;
  }

  // The steps to give leases to, fairest first: each tenant's oldest step in line, the
  // tenant with the fewest leases first, then the oldest step. A step that can't have all
  // it needs, as when its own tenant's limit is full, doesn't keep the lease from the
  // next. Tenants are looked at 16 at a time, at random among those with as many leases,
  // up to MAX_TENANTS in all.
  private async *candidates(limit: Limit, item: LimitState, skip: Set<string>): AsyncGenerator<LeaseWaiter> {
    const held = (t: string) => item.tenants[t] ?? 0;
    // Any that's counted, even at zero: its line says if a step waits.
    const tenants = Object.keys(item.waiting)
      .map((t) => ({ t, tie: Math.random() }))
      .sort((a, b) => held(a.t) - held(b.t) || a.tie - b.tie)
      .slice(0, MAX_TENANTS);
    for (let from = 0; from < tenants.length; from += 16) {
      const heads = await Promise.all(tenants.slice(from, from + 16).map(({ t }) => this.head(limit, item, t, skip)));
      const steps = heads.filter((w) => w !== undefined);
      yield* steps.sort((a, b) => held(tenantKey(a.tenant)) - held(tenantKey(b.tenant)) || a.at - b.at);
    }
  }

  // A tenant's oldest step in line that can be given a lease.
  private async head(limit: Limit, item: LimitState, t: string, skip: Set<string>): Promise<LeaseWaiter | undefined> {
    let start: any;
    let empty = true;
    for (let pages = 0; pages < 10; pages++) {
      const page = await this.db("Query", {
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": S(lineKey(limit.item, t)) },
        ConsistentRead: true,
        Limit: pages ? 25 : 3,
        ExclusiveStartKey: start,
      });
      if (page.Items?.length) empty = false;
      // A step that holds its lease here is being given it right now, or was put back in
      // line and had been told after all. One that couldn't be told it was given one
      // waits for the next dispatch.
      const e = (page.Items ?? []).find((e: any) => !item.leases[String(e.lease.S)] && !skip.has(String(e.lease.S)));
      if (e)
        return {
          leaseId: String(e.lease.S),
          tenant: String(e.tenant.S),
          callbackId: String(e.callback.S),
          runId: String(e.run.S),
          at: Number(e.at.N),
          // As it was put in line, so it keeps it if it's put back.
          expiresAt: Number(e.expires.N) * 1000 - DAY,
          limits: JSON.parse(e.limits.S),
        };
      start = page.LastEvaluatedKey;
      if (!start) break;
    }
    // A count goes up before its entry goes in, and down after it comes out, so one can
    // be seen without its entry for a moment. It's taken for a stale one, as when entries
    // expired, only if it hasn't changed in a while.
    if (empty && Date.now() - (item.waitingAt[t] ?? 0) > STALE_LINE_MS)
      await this.dropLine({ pk: S(limit.item), sk: S(`w#${t}`) }, item.waiting[t], item.waitingAt[t]).catch(() => {});
    return undefined;
  }

  async handoff(limits: Limit[], leaseId: string, tenant: string, wake: (w: LeaseWaiter) => Promise<boolean>) {
    const unique = uniqueLimits(limits);
    const skip = new Set<string>();
    try {
      await this.pass(unique, leaseId, tenant, wake, skip);
    } catch (error) {
      // Give back what it still holds, so an error doesn't keep it until it expires.
      for (const l of unique) await this.releaseOne(l.item, leaseId, tenant).catch(() => {});
      for (const l of unique) await this.dispatch(l, wake, skip).catch(() => {});
      throw error;
    }
  }

  private async pass(
    unique: Limit[],
    leaseId: string,
    tenant: string,
    wake: (w: LeaseWaiter) => Promise<boolean>,
    skip: Set<string>,
  ) {
    // The limit with the most tenants in line first: that's where it's decided whose
    // turn is fair. A tenant's own limit has only its own steps in line.
    const items = await Promise.all(unique.map((l) => this.readLimit(l.item)));
    const tenantsInLine = (i: number) => Object.keys(items[i]?.waiting ?? {}).length;
    const order = unique.map((_, i) => i).sort((a, b) => tenantsInLine(b) - tenantsInLine(a) || unique[b].limit - unique[a].limit);
    for (const i of order) {
      const item = items[i];
      if (!item?.leases[leaseId]) continue;
      // Over the limit, as when it was lowered: give it back.
      if (Object.keys(item.leases).length > unique[i].limit) break;
      for await (const next of this.candidates(unique[i], item, skip)) {
        const { value, passed } = await this.grant(next, unique, { limits: unique, leaseId, tenant });
        if (!value) continue;
        // Give back what wasn't passed: a limit the next step doesn't need, or one it
        // got a lease of its own on.
        const kept = unique.filter((l) => !passed.some((p) => p.item === l.item));
        await this.release(kept, leaseId, tenant);
        if (!(await this.tell(next, value, wake, skip)))
          for (const l of uniqueLimits(next.limits)) await this.dispatch(l, wake, skip);
        for (const l of kept) await this.dispatch(l, wake, skip);
        return;
      }
      break;
    }
    await this.release(unique, leaseId, tenant);
    for (const i of order) await this.dispatch(unique[i], wake, skip);
  }

  // Whether each limit has room, or didn't when it was looked at. Looking first saves
  // taking one lease to give it back, as when a tenant's own limit is full.
  private async hasRoom(limits: Limit[]) {
    const rooms = await Promise.all(
      uniqueLimits(limits).map(async (l) => {
        const { Item } = await this.db("GetItem", {
          Key: { pk: S(l.item), sk: S("-") },
          ProjectionExpression: "active",
          ConsistentRead: true,
        });
        return !!Item && Number(Item.active?.N ?? 0) < l.limit;
      }),
    );
    return rooms.every(Boolean);
  }

  // Give a step in line every lease it needs, one at a time, in order, or none. With
  // `from`, a step that's done gives its lease on a limit they share straight to it,
  // in one write. Then take the step out of its lines. It returns the leases' value,
  // to give back only those, or none; and which leases were passed. The step that's
  // done still holds the others.
  // `current` are the limits as the caller has them: a step's are as it joined the line,
  // and a limit that was lowered since is held to.
  private async grant(w: LeaseWaiter, current: Limit[], from?: { limits: Limit[]; leaseId: string; tenant: string }) {
    const value = leaseValue(Date.now() + GRANT_MS, w.tenant, "granted");
    const mine = ordered(w.limits).map((l) => ({
      ...l,
      limit: Math.min(l.limit, current.find((c) => c.item === l.item)?.limit ?? l.limit),
    }));
    const theirs = from ? uniqueLimits(from.limits) : [];
    const passed: Limit[] = [];
    const taken: Limit[] = [];
    const undo = async (raced: boolean) => {
      for (const l of [...passed, ...taken]) await this.releaseOne(l.item, w.leaseId, w.tenant, value).catch(() => {});
      return { value: undefined, passed, undone: passed.length + taken.length > 0, raced };
    };
    for (const limit of mine) {
      // Given back by its value on an error, which may come after it was written.
      taken.push(limit);
      try {
        if (from && theirs.some((l) => l.item === limit.item) && (await this.passOne(limit, from, w, value))) {
          taken.pop();
          passed.push(limit);
          continue;
        }
        // The step that's done no longer holds it, or it isn't one it has: take it
        // like any other.
        const took = await this.takeOne(limit, w.leaseId, w.tenant, value);
        if (took === "taken") continue;
        taken.pop();
        return undo(took === "held");
      } catch (error) {
        await undo(false);
        throw error;
      }
    }
    // Out of every line. Its entry in the first, as it was read, is taken out by one
    // grant only. One that finds it gone read it before another grant took it out, and
    // the step may be done by now. Its callback may still be open, as when it found its
    // leases itself, so waking it wouldn't tell. One that finds it changed read it before
    // the step asked again with a new callback. An error leaves an entry or a count
    // that's found stale later.
    const [first, ...rest] = mine;
    const left = await this.leave(first, w, w.callbackId).catch(() => "left" as const);
    if (left === "left") {
      for (const l of rest) await this.leave(l, w).catch(() => {});
      return { value, passed, undone: false, raced: false };
    }
    if (left === "gone") for (const l of rest) await this.leave(l, w, w.callbackId).catch(() => {});
    return undo(true);
  }

  // Take a step out of a line: with `callbackId`, if its entry still has that callback.
  // Only an entry that was there is counted out, so the count isn't one short, which
  // would hide a step that waits.
  private async leave(limit: Limit, waiter: Pick<LeaseWaiter, "tenant" | "at" | "leaseId">, callbackId?: string) {
    try {
      await this.db(
        "DeleteItem",
        {
          Key: this.entryKey(limit, waiter),
          ConditionExpression: `attribute_exists(pk)${callbackId === undefined ? "" : " AND callback = :cb"}`,
          ...(callbackId === undefined ? {} : { ExpressionAttributeValues: { ":cb": S(callbackId) } }),
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
        // Sent again after a lost answer, it would find its own entry gone, and take it
        // for another grant's.
        { retries: 0 },
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      return (error as AwsError).body?.Item ? ("rejoined" as const) : ("gone" as const);
    }
    await this.count(limit.item, waiter.tenant, -1);
    return "left" as const;
  }

  // Pass a lease from a step that's done to the next, in one write.
  private async passOne(limit: Limit, from: { leaseId: string; tenant: string }, w: LeaseWaiter, value: string) {
    const t = tenantKey(w.tenant);
    const ot = tenantKey(from.tenant);
    const same = ot === t;
    try {
      await this.db("UpdateItem", {
        Key: { pk: S(limit.item), sk: S("-") },
        UpdateExpression: `REMOVE leases.#o SET leases.#l = :lease, expires = :exp${same ? "" : " ADD tenants.#t :one, tenants.#ot :minus"}`,
        ConditionExpression: "attribute_exists(leases.#o) AND attribute_not_exists(leases.#l) AND active <= :cap",
        ExpressionAttributeNames: { "#o": from.leaseId, "#l": w.leaseId, ...(same ? {} : { "#t": t, "#ot": ot }) },
        ExpressionAttributeValues: {
          ":lease": S(value),
          ":cap": N(limit.limit),
          ":exp": { N: seconds(Date.now() + DAY) },
          ...(same ? {} : { ":one": N(1), ":minus": N(-1) }),
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      });
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      if (leaseIn(error, w.leaseId) !== value) return false;
    }
    if (!same) await this.dropTenant(limit.item, from.tenant);
    return true;
  }

  // A limit's leases, and its line: each tenant in it, or whether there's any.
  private async readLimit(item: string, line: "all" | "any" | "none" = "all"): Promise<LimitState | undefined> {
    const [leasesItem, tenantsInLine] = await Promise.all([
      this.db("GetItem", { Key: { pk: S(item), sk: S("-") }, ConsistentRead: true }),
      line === "none" ? [] : this.readLine(item, line === "any"),
    ]);
    if (!leasesItem.Item) return undefined;
    const leases: LimitState["leases"] = Object.create(null);
    const raw: Record<string, string> = Object.create(null);
    for (const [id, value] of Object.entries<any>(leasesItem.Item.leases?.M ?? {})) {
      raw[id] = String(value.S);
      leases[id] = parseLease(raw[id]);
    }
    const tenants: Record<string, number> = Object.create(null);
    for (const [t, v] of Object.entries<any>(leasesItem.Item.tenants?.M ?? {})) tenants[t] = Number(v.N);
    const waiting: Record<string, number> = Object.create(null);
    const waitingAt: Record<string, number> = Object.create(null);
    for (const i of tenantsInLine) {
      const t = String(i.sk.S).slice(2);
      waiting[t] = Number(i.n?.N ?? 0);
      waitingAt[t] = Number(i.at?.N ?? 0);
    }
    return { leases, raw, tenants, waiting, waitingAt, queued: Object.values(waiting).reduce((n, v) => n + Math.max(0, v), 0) };
  }

  private async readLine(item: string, any: boolean) {
    const items: any[] = [];
    let start: any;
    do {
      const page = await this.db("Query", {
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :w)",
        ExpressionAttributeValues: { ":pk": S(item), ":w": S("w#") },
        ConsistentRead: true,
        ExclusiveStartKey: start,
        ...(any ? { Limit: 1 } : {}),
      });
      items.push(...(page.Items ?? []));
      start = any ? undefined : page.LastEvaluatedKey;
    } while (start);
    return items;
  }

  private async createLimit(limit: Limit) {
    try {
      await this.db("PutItem", {
        Item: {
          pk: S(limit.item),
          sk: S("-"),
          active: N(0),
          leases: { M: {} },
          tenants: { M: {} },
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
  leases: Record<string, { expires: number; tenant: string; granted: boolean }>;
  /** Each lease's stored value, to give back only the one that was read. */
  raw: Record<string, string>;
  tenants: Record<string, number>;
  waiting: Record<string, number>;
  /** When each tenant's count last changed. */
  waitingAt: Record<string, number>;
  queued: number;
}

/**
 * How long a tenant's count goes without a change, with no step in its line, before it's
 * taken for a stale one: far longer than it takes to join a line.
 */
const STALE_LINE_MS = 60_000;

/** How long a dispatch looks for steps to wake. */
const DISPATCH_MS = 10_000;

/** How many tenants in line a dispatch looks at, for each lease it gives. */
const MAX_TENANTS = 200;

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

/** A step's limits, each once, in the order every step takes them. */
function ordered(limits: Limit[]) {
  return uniqueLimits(limits).sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

/**
 * A lease's value: when it expires, whether the step took it itself or was given it and
 * hasn't made it its own, and its tenant. It's unique, so a lease is given back, or taken
 * for one's own, only by whoever wrote it: two dispatches can give one step its leases in
 * the same millisecond.
 */
function leaseValue(expires: number, tenant: string, kind: "own" | "granted") {
  return `${Math.floor(expires)}|${kind === "own" ? "o" : "g"}${randomInt(2 ** 48 - 1).toString(36)}|${tenant}`;
}

export function parseLease(value: string) {
  const [expires, kind, ...tenant] = value.split("|");
  return { expires: Number(expires), granted: kind.startsWith("g"), tenant: tenant.join("|") };
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
