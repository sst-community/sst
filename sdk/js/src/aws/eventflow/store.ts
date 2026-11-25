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

  // A limit is two items. Its leases, at sort key "-": `cap`; `active`, the number of
  // leases; `leases`, each lease's expiry and tenant; and `tenants`, each tenant's
  // leases, with no zero counts kept. And its line, at "w": `queued`, the steps in
  // line; `waiting`, each tenant's steps in line; and `waitingAt`, when each tenant
  // last joined or asked again. A step's entries in line are items of their own, one
  // line per limit and tenant.
  //
  // None of it is written in a transaction. On a busy limit, transactions on one item
  // fail each other, where plain writes take their turn. Each write is conditioned, so
  // a limit can't go over, or count a lease twice. A step takes the limits it needs
  // one at a time, always in the same order, and gives back the ones it took if the
  // next is full: it never waits holding a lease, so two steps can't each hold what
  // the other waits for.

  // Take one lease, if there's room and it isn't there yet.
  private async takeOne(limit: Limit, leaseId: string, tenant: string, value: string) {
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
      });
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  // Take every lease, in order, or give back the ones taken.
  private async takeAll(limits: Limit[], leaseId: string, tenant: string, value: string, held: Set<string>) {
    const taken: Limit[] = [];
    for (const limit of limits) {
      if (held.has(limit.item)) continue;
      if (await this.takeOne(limit, leaseId, tenant, value)) {
        taken.push(limit);
        continue;
      }
      for (const t of taken) await this.releaseOne(t.item, leaseId, tenant, value).catch(() => {});
      return false;
    }
    return true;
  }

  async acquire(limits: Limit[], leaseId: string, tenant: string, leaseMs: number) {
    const unique = ordered(limits);
    for (let attempt = 0; attempt < 4; attempt++) {
      const items = await Promise.all(unique.map((l) => this.readLimit(l.item)));
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
      const held = new Set(unique.filter((_, i) => items[i]!.leases[leaseId]).map((l) => l.item));
      if (await this.takeAll(unique, leaseId, tenant, `${now + leaseMs}|${tenant}`, held)) return "granted" as const;
      // Another step took the room first.
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
    // A lease that lasts past this invocation needs no write. A step that claims a
    // lease it found writes it, so it's its own.
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
            ":lease": S(`${Math.max(now + leaseMs, lease.expires) + jitter()}|${lease.tenant}`),
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
        ExpressionAttributeValues: { ":minus": N(-1), ...(only === undefined ? {} : { ":only": S(only) }) },
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
      Key: { pk: S(item), sk: S(map === "waiting" ? "w" : "-") },
      UpdateExpression: map === "waiting" ? "REMOVE waiting.#t, waitingAt.#t" : "REMOVE tenants.#t",
      // A step's count goes up after its entry goes in, and down after it comes out,
      // so a tenant's can be below zero for a moment: only a zero is taken out.
      ConditionExpression: map === "waiting" ? "waiting.#t = :zero" : "tenants.#t <= :zero",
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

  // Count a step in a limit's line, or more than one, and say the tenant is waiting.
  private async count(item: string, tenant: string, n: number) {
    await this.db("UpdateItem", {
      Key: { pk: S(item), sk: S("w") },
      UpdateExpression: n ? "SET waitingAt.#t = :now, expires = :exp ADD waiting.#t :n" : "SET waitingAt.#t = :now",
      ExpressionAttributeNames: { "#t": tenantKey(tenant) },
      ExpressionAttributeValues: {
        ":now": N(Date.now()),
        ...(n ? { ":n": N(n), ":exp": { N: seconds(Date.now() + DAY) } } : {}),
      },
    });
  }

  async enqueue(waiter: LeaseWaiter) {
    const limits = ordered(waiter.limits);
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
      let gone = false;
      for (const [i, limit] of limits.entries()) {
        // The entry goes in first, then its count. A count without an entry would
        // keep newcomers out until it's found stale; an entry without a count is
        // counted when the step asks again.
        try {
          await this.db("PutItem", {
            Item: { ...this.entryKey(limit, waiter), ...entry },
            ConditionExpression: "attribute_not_exists(pk)",
          });
          await this.count(limit.item, waiter.tenant, 1);
          continue;
        } catch (error) {
          if (!isConditionFailure(error)) throw error;
        }
        // Asking again: the step keeps its place, with its new callback.
        try {
          await this.db("UpdateItem", {
            Key: this.entryKey(limit, waiter),
            UpdateExpression: "SET callback = :cb, expires = :exp",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: { ":cb": entry.callback, ":exp": entry.expires },
          });
          // Count it if it isn't, as when the step stopped between its entry and its
          // count; and say the tenant still waits, so its count isn't taken for stale.
          await this.count(limit.item, waiter.tenant, (items[i]?.waiting[tenantKey(waiter.tenant)] ?? 0) > 0 ? 0 : 1);
        } catch (error) {
          if (!isConditionFailure(error)) throw error;
          gone = true;
        }
      }
      if (!gone) return "queued" as const;
      // An entry went in between: the step was given its leases, or given them and
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
      let granted: LeaseWaiter | undefined;
      let value: string | undefined;
      for await (const c of this.candidates(limit, item, now)) {
        value = await this.grant(c);
        if (value) {
          granted = c;
          break;
        }
      }
      // No step in line can have all it needs now. A release of the limit it's missing
      // gives it to it.
      if (!granted) return woken;
      if (await wake(granted).catch(() => false)) woken++;
      // The step is gone, as when its run stopped, or it asked again with a new
      // callback. Give back the leases this gave it, and try the next one: only those,
      // since a step that asked again may have found them and claimed them.
      else await this.release(granted.limits, granted.leaseId, granted.tenant, value);
    }
    return woken;
  }

  // The steps to give leases to, fairest first: the oldest step of each tenant in
  // line, the tenant with the fewest leases first. They're found one at a time, so a
  // step that can't have all it needs, as when its own tenant's limit is full,
  // doesn't keep the lease from the next.
  private async *candidates(limit: Limit, item: LimitState, now: number): AsyncGenerator<LeaseWaiter> {
    const tenants = Object.entries(item.waiting)
      .filter(([, n]) => n > 0)
      .map(([t]) => t)
      .sort((a, b) => (item.tenants[a] ?? 0) - (item.tenants[b] ?? 0));
    // At most 20 tenants looked at, not counting the stale ones taken out.
    let looked = 0;
    for (const t of tenants) {
      if (looked >= 20) return;
      const page = await this.db("Query", {
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": S(lineKey(limit.item, t)) },
        ConsistentRead: true,
        Limit: 3,
      });
      // A step that holds its lease here is being given it right now.
      const e = (page.Items ?? []).find((e: any) => !item.leases[String(e.lease.S)]);
      if (!e) {
        // A count goes up after its entry goes in, so one can be seen without its
        // entry for a moment. It's taken for a stale one, as when entries expired,
        // only if the tenant hasn't joined or asked again in longer than a step waits
        // before it asks again.
        if (!page.Items?.length && now - (item.waitingAt[t] ?? 0) > STALE_LINE_MS) {
          await this.db("UpdateItem", {
            Key: { pk: S(limit.item), sk: S("w") },
            UpdateExpression: "REMOVE waiting.#t, waitingAt.#t",
            ConditionExpression: "waiting.#t = :n",
            ExpressionAttributeNames: { "#t": t },
            ExpressionAttributeValues: { ":n": N(item.waiting[t]) },
          }).catch(() => {});
          continue;
        }
        looked++;
        continue;
      }
      looked++;
      yield {
        leaseId: String(e.lease.S),
        tenant: String(e.tenant.S),
        callbackId: String(e.callback.S),
        runId: String(e.run.S),
        at: Number(e.at.N),
        expiresAt: 0,
        limits: JSON.parse(e.limits.S),
      };
    }
  }

  async handoff(limits: Limit[], leaseId: string, tenant: string, wake: (w: LeaseWaiter) => Promise<boolean>) {
    const unique = uniqueLimits(limits);
    // The limit with the most tenants in line first: that's where it's decided whose
    // turn is fair. A tenant's own limit has only its own steps in line.
    const items = await Promise.all(unique.map((l) => this.readLimit(l.item)));
    const tenantsInLine = (i: number) => Object.values(items[i]?.waiting ?? {}).filter((n) => n > 0).length;
    const order = unique.map((_, i) => i).sort((a, b) => tenantsInLine(b) - tenantsInLine(a) || unique[b].limit - unique[a].limit);
    for (const i of order) {
      const item = items[i];
      if (!item?.leases[leaseId]) continue;
      for await (const next of this.candidates(unique[i], item, Date.now())) {
        const value = await this.grant(next, { limits: unique, leaseId, tenant });
        if (!value) continue;
        if (!(await wake(next).catch(() => false))) {
          await this.release(next.limits, next.leaseId, next.tenant, value);
          for (const l of uniqueLimits(next.limits)) await this.dispatch(l, wake);
        }
        // A limit the next step doesn't need was given back: hand it on.
        for (const j of order) if (!next.limits.some((n) => n.item === unique[j].item)) await this.dispatch(unique[j], wake);
        return;
      }
      break;
    }
    await this.release(unique, leaseId, tenant);
    for (const i of order) await this.dispatch(unique[i], wake);
  }

  // Give a step in line every lease it needs, one at a time, in order, or none. With
  // `from`, a step that's done gives its lease on a limit they share straight to it,
  // in one write. Then take the step out of its lines. It returns the leases' value,
  // to give back only those, or nothing.
  private async grant(w: LeaseWaiter, from?: { limits: Limit[]; leaseId: string; tenant: string }) {
    const value = `${Date.now() + GRANT_MS + jitter()}|${w.tenant}`;
    const mine = ordered(w.limits);
    const theirs = from ? uniqueLimits(from.limits) : [];
    const t = tenantKey(w.tenant);
    const passed: Limit[] = [];
    const taken: Limit[] = [];
    const undo = async () => {
      for (const l of [...passed, ...taken]) await this.releaseOne(l.item, w.leaseId, w.tenant, value).catch(() => {});
      return undefined;
    };
    for (const limit of mine) {
      if (from && theirs.some((l) => l.item === limit.item)) {
        const ot = tenantKey(from.tenant);
        const same = ot === t;
        try {
          await this.db("UpdateItem", {
            Key: { pk: S(limit.item), sk: S("-") },
            UpdateExpression: `REMOVE leases.#o SET leases.#l = :lease, expires = :exp${same ? "" : " ADD tenants.#t :one, tenants.#ot :minus"}`,
            ConditionExpression: "attribute_exists(leases.#o) AND attribute_not_exists(leases.#l)",
            ExpressionAttributeNames: { "#o": from.leaseId, "#l": w.leaseId, ...(same ? {} : { "#t": t, "#ot": ot }) },
            ExpressionAttributeValues: {
              ":lease": S(value),
              ":exp": { N: seconds(Date.now() + DAY) },
              ...(same ? {} : { ":one": N(1), ":minus": N(-1) }),
            },
          });
          passed.push(limit);
          if (!same) await this.dropZero(limit.item, "tenants", from.tenant);
          continue;
        } catch (error) {
          if (!isConditionFailure(error)) {
            await undo();
            throw error;
          }
          // The step that's done no longer holds it, or the next one does already:
          // take it like any other.
        }
      }
      if (await this.takeOne(limit, w.leaseId, w.tenant, value).catch(async (error) => (await undo(), Promise.reject(error)))) {
        taken.push(limit);
        continue;
      }
      return undo();
    }
    // The step that's done gives back what the next one doesn't need.
    if (from)
      for (const l of theirs)
        if (!mine.some((m) => m.item === l.item)) await this.releaseOne(l.item, from.leaseId, from.tenant).catch(() => {});
    // Out of every line, then off the counts. A step that asked again in between finds
    // its entries gone and its leases held, and claims them.
    for (const l of mine) {
      await this.db("DeleteItem", { Key: this.entryKey(l, w) }).catch(() => {});
      await this.count(l.item, w.tenant, -1).catch(() => {});
      await this.dropZero(l.item, "waiting", w.tenant).catch(() => {});
    }
    return value;
  }

  private async readLimit(item: string): Promise<LimitState | undefined> {
    const [leasesItem, lineItem] = await Promise.all(
      ["-", "w"].map((sk) => this.db("GetItem", { Key: { pk: S(item), sk: S(sk) }, ConsistentRead: true })),
    );
    if (!leasesItem.Item || !lineItem.Item) return undefined;
    const leases: LimitState["leases"] = Object.create(null);
    const raw: Record<string, string> = Object.create(null);
    for (const [id, value] of Object.entries<any>(leasesItem.Item.leases?.M ?? {})) {
      const [expires, ...rest] = String(value.S).split("|");
      leases[id] = { expires: Number(expires), tenant: rest.join("|") };
      raw[id] = String(value.S);
    }
    const counts = (m: any) => {
      const out: Record<string, number> = Object.create(null);
      for (const [t, v] of Object.entries<any>(m ?? {})) out[t] = Number(v.N);
      return out;
    };
    const waiting = counts(lineItem.Item.waiting?.M);
    return {
      leases,
      raw,
      tenants: counts(leasesItem.Item.tenants?.M),
      waiting,
      waitingAt: counts(lineItem.Item.waitingAt?.M),
      queued: Object.values(waiting).reduce((n, v) => n + Math.max(0, v), 0),
    };
  }

  private async createLimit(limit: Limit) {
    const expires = { N: seconds(Date.now() + DAY) };
    const items = [
      {
        pk: S(limit.item),
        sk: S("-"),
        active: N(0),
        leases: { M: {} },
        tenants: { M: {} },
        label: S(limit.label ?? limit.item),
        cap: N(limit.limit),
        expires,
      },
      { pk: S(limit.item), sk: S("w"), waiting: { M: {} }, waitingAt: { M: {} }, expires },
    ];
    for (const Item of items)
      try {
        await this.db("PutItem", { Item, ConditionExpression: "attribute_not_exists(pk)" });
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

/** A step's limits, each once, in the order every step takes them. */
function ordered(limits: Limit[]) {
  return uniqueLimits(limits).sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

/** Up to a second, so two leases given in the same millisecond have different values. */
function jitter() {
  return Math.floor(Math.random() * 1000);
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
