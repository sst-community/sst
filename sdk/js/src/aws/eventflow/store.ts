import type { AwsOptions } from "../client.js";
import { AwsError, dynamo, isConditionFailure } from "./aws.js";
import { key as keyOf } from "./ids.js";
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
  tenant: string;
  callbackId: string;
  runId: string;
  at: number;
  expiresAt: number;
}

export type Admission =
  | { decision: "start" }
  | { decision: "skip"; reason: string }
  | { decision: "hold"; at: number };

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
  /** GCRA: 0 when allowed now, or how many ms until it would be. Takes the slot only when allowed. */
  take(item: string, intervalMs: number, toleranceMs: number): Promise<number>;
  /** GCRA: reserves the next slot, and returns when it starts. */
  reserve(item: string, intervalMs: number, toleranceMs: number): Promise<number>;
  /** Takes a lease, if the limit has room and no step is waiting for it. */
  acquire(limit: Limit, leaseId: string, tenant: string, leaseMs: number): Promise<boolean>;
  /** Extends a lease. False when the lease is gone. */
  renew(limit: Limit, leaseId: string, leaseMs: number): Promise<boolean>;
  release(limit: Limit, leaseId: string, tenant: string): Promise<void>;
  enqueue(limit: Limit, waiter: LeaseWaiter): Promise<void>;
  /**
   * Gives free leases to waiting steps, fairest first: the tenant with the fewest
   * leases, then the oldest. `wake` resumes a step with its lease, and returns false
   * if it can't, as when the run stopped. Returns how many it woke.
   */
  dispatch(limit: Limit, leaseMs: number, wake: (w: LeaseWaiter) => Promise<boolean>): Promise<number>;
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

/** A map key for a tenant. A map key can't be empty, and "" is "no tenant". */
export function tenantKey(tenant: string) {
  return tenant === "" ? "\u0000" : tenant;
}

function waiterSort(waiter: Pick<Waiter, "createdAt" | "callbackId">) {
  // The callback is part of it, so two waits of one run that register in the same
  // millisecond don't replace each other.
  return `${pad(waiter.createdAt)}#${waiter.callbackId.slice(-24)}`;
}

/** Errors that mean "try later", not "this is broken". */
export function isRetryable(error: unknown) {
  return (
    error instanceof AwsError &&
    (error.status >= 500 ||
      error.type === "ProvisionedThroughputExceededException" ||
      error.type === "ThrottlingException" ||
      error.type === "RequestLimitExceeded" ||
      error.type === "TransactionConflictException")
  );
}

/**
 * The waiter that's woken next: the tenant with the fewest leases on the limit, then
 * the one that has waited longest.
 */
export function fairest<T extends { tenant: string; at: number }>(
  waiters: T[],
  active: Record<string, number>,
) {
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
        Item: { pk: S(item), sk: S("-"), delivery: S(delivery), expires: { N: seconds(Date.now() + ttlMs) } },
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
      ExpressionAttributeValues: { ":t": { BOOL: true }, ":e": { N: seconds(Date.now() + ttlMs) } },
    });
  }

  async getAdmission(item: string) {
    const result = await this.db("GetItem", { Key: { pk: S(item), sk: S("-") }, ConsistentRead: true });
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
        Item: { pk: S(item), sk: S("-"), owner: S(owner), expires: { N: seconds(Date.now() + ttlMs) } },
        ConditionExpression: "attribute_not_exists(pk) OR #o = :o OR expires < :now",
        ExpressionAttributeNames: { "#o": "owner" },
        ExpressionAttributeValues: { ":o": S(owner), ":now": { N: seconds(Date.now()) } },
      });
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  // GCRA keeps one number per bucket: the time the next start is due.
  private async gcra(item: string, intervalMs: number, toleranceMs: number, reserve: boolean): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = Date.now();
      const result = await this.db("GetItem", { Key: { pk: S(item), sk: S("-") }, ConsistentRead: true });
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

  // A limit is one item: `active`, the number of leases; `leases`, each lease's
  // expiry and tenant; `tenants`, each tenant's count, with no zero counts kept; and
  // `queued`, how many steps wait. A lease is added with an update that only passes
  // while `active` is under the limit and nothing waits, so concurrent requests queue
  // at DynamoDB instead of conflicting, and a newcomer can't jump the queue.
  async acquire(limit: Limit, leaseId: string, tenant: string, leaseMs: number) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now();
      try {
        await this.db("UpdateItem", {
          Key: { pk: S(limit.item), sk: S("-") },
          UpdateExpression:
            "SET leases.#l = :lease, expires = :exp, cap = :limit, label = if_not_exists(label, :label) ADD active :one, tenants.#t :one",
          ConditionExpression:
            "attribute_exists(pk) AND attribute_not_exists(leases.#l) AND active < :limit AND (queued <= :zero OR attribute_not_exists(queued))",
          ExpressionAttributeNames: { "#l": leaseId, "#t": tenantKey(tenant) },
          ExpressionAttributeValues: {
            ":lease": S(`${now + leaseMs}|${tenant}`),
            ":one": N(1),
            ":zero": N(0),
            ":limit": N(limit.limit),
            ":exp": { N: seconds(now + DAY) },
            ":label": S(limit.label ?? limit.item),
          },
        });
        return true;
      } catch (error) {
        if (!isConditionFailure(error)) {
          if (isRetryable(error)) return false;
          throw error;
        }
        const item = await this.readLimit(limit.item);
        if (!item) {
          await this.createLimit(limit);
          continue;
        }
        // The lease is already ours: a retried step.
        if (item.leases[leaseId]) return true;
        const expired = Object.entries(item.leases).filter(([, v]) => v.expires <= now);
        if (!expired.length) return false;
        // Give back leases that expired, as when a run crashed, then try again.
        await Promise.all(expired.map(([id, v]) => this.releaseOne(limit.item, id, v.tenant)));
      }
    }
    return false;
  }

  async renew(limit: Limit, leaseId: string, leaseMs: number) {
    const item = await this.readLimit(limit.item);
    const lease = item?.leases[leaseId];
    if (!lease) return false;
    try {
      await this.db("UpdateItem", {
        Key: { pk: S(limit.item), sk: S("-") },
        UpdateExpression: "SET leases.#l = :lease",
        ConditionExpression: "attribute_exists(leases.#l)",
        ExpressionAttributeNames: { "#l": leaseId },
        ExpressionAttributeValues: { ":lease": S(`${Date.now() + leaseMs}|${lease.tenant}`) },
      });
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async release(limit: Limit, leaseId: string, tenant: string) {
    await this.releaseOne(limit.item, leaseId, tenant);
  }

  private async releaseOne(item: string, leaseId: string, tenant: string) {
    try {
      await this.db("UpdateItem", {
        Key: { pk: S(item), sk: S("-") },
        UpdateExpression: "REMOVE leases.#l ADD active :minus, tenants.#t :minus",
        ConditionExpression: "attribute_exists(leases.#l)",
        ExpressionAttributeNames: { "#l": leaseId, "#t": tenantKey(tenant) },
        ExpressionAttributeValues: { ":minus": N(-1) },
      });
    } catch (error) {
      // Already given back.
      if (isConditionFailure(error)) return;
      throw error;
    }
    // Don't keep a tenant with no leases, so the item stays as small as its leases.
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

  async enqueue(limit: Limit, waiter: LeaseWaiter) {
    const key = { pk: S(limit.item.replace(/^C#/, "Q#")), sk: S(`${pad(waiter.at)}#${waiter.leaseId}`) };
    // A step that asks again keeps its place: same time, same lease, same entry. Only
    // its callback changes, and it isn't counted twice.
    try {
      await this.db("UpdateItem", {
        Key: key,
        UpdateExpression: "SET callback = :cb, expires = :exp",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":cb": S(waiter.callbackId), ":exp": { N: seconds(waiter.expiresAt + DAY) } },
      });
      return;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
    // The waiter and the count go in together, so a release in between can't take
    // the count below what's waiting.
    await dynamo(
      "TransactWriteItems",
      {
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                ...key,
                lease: S(waiter.leaseId),
                tenant: S(waiter.tenant),
                callback: S(waiter.callbackId),
                run: S(waiter.runId),
                at: N(waiter.at),
                expires: { N: seconds(waiter.expiresAt + DAY) },
              },
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: { pk: S(limit.item), sk: S("-") },
              UpdateExpression: "ADD queued :one",
              ExpressionAttributeValues: { ":one": N(1) },
            },
          },
        ],
      },
      this.aws,
    );
  }

  async dispatch(limit: Limit, leaseMs: number, wake: (w: LeaseWaiter) => Promise<boolean>) {
    let woken = 0;
    for (let round = 0; round < limit.limit + 5; round++) {
      const item = await this.readLimit(limit.item);
      if (!item) return woken;
      const now = Date.now();
      const expired = Object.entries(item.leases).filter(([, v]) => v.expires <= now);
      if (expired.length) {
        await Promise.all(expired.map(([id, v]) => this.releaseOne(limit.item, id, v.tenant)));
        continue;
      }
      if (Object.keys(item.leases).length >= limit.limit) return woken;
      const page = await this.db("Query", {
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": S(limit.item.replace(/^C#/, "Q#")) },
        ConsistentRead: true,
        Limit: 50,
      });
      const waiters: (LeaseWaiter & { sk: string })[] = (page.Items ?? []).map((i: any) => ({
        sk: String(i.sk.S),
        leaseId: String(i.lease.S),
        tenant: String(i.tenant.S),
        callbackId: String(i.callback.S),
        runId: String(i.run.S),
        at: Number(i.at.N),
        expiresAt: 0,
      }));
      if (!waiters.length) {
        // Nothing waits. A count left over from a waiter that expired is reset, so
        // newcomers don't keep queuing.
        if (item.queued !== 0)
          await this.db("UpdateItem", {
            Key: { pk: S(limit.item), sk: S("-") },
            UpdateExpression: "SET queued = :zero",
            ConditionExpression: "queued = :q",
            ExpressionAttributeValues: { ":zero": N(0), ":q": N(item.queued) },
          }).catch(() => {});
        return woken;
      }
      const next = fairest(waiters, item.tenants)!;
      // Take the waiter off the queue and give it the lease, together.
      try {
        await dynamo(
          "TransactWriteItems",
          {
            TransactItems: [
              {
                Delete: {
                  TableName: this.table,
                  Key: { pk: S(limit.item.replace(/^C#/, "Q#")), sk: S(next.sk) },
                  ConditionExpression: "attribute_exists(pk)",
                },
              },
              {
                Update: {
                  TableName: this.table,
                  Key: { pk: S(limit.item), sk: S("-") },
                  UpdateExpression: "SET leases.#l = :lease ADD active :one, tenants.#t :one, queued :minus",
                  ConditionExpression: "active < :limit",
                  ExpressionAttributeNames: { "#l": next.leaseId, "#t": tenantKey(next.tenant) },
                  ExpressionAttributeValues: {
                    ":lease": S(`${now + leaseMs}|${next.tenant}`),
                    ":one": N(1),
                    ":minus": N(-1),
                    ":limit": N(limit.limit),
                  },
                },
              },
            ],
          },
          this.aws,
        );
      } catch (error) {
        if (isConditionFailure(error) || isRetryable(error)) continue;
        throw error;
      }
      if (await wake(next).catch(() => false)) woken++;
      // The step is gone, as when its run stopped, or its wait timed out and it asked
      // again. Give the lease back, and try the next one.
      else await this.releaseOne(limit.item, next.leaseId, next.tenant);
    }
    return woken;
  }

  private async readLimit(item: string) {
    const result = await this.db("GetItem", { Key: { pk: S(item), sk: S("-") }, ConsistentRead: true });
    if (!result.Item) return undefined;
    const leases: Record<string, { expires: number; tenant: string }> = Object.create(null);
    for (const [id, value] of Object.entries<any>(result.Item.leases?.M ?? {})) {
      const [expires, ...rest] = String(value.S).split("|");
      leases[id] = { expires: Number(expires), tenant: rest.join("|") };
    }
    const tenants: Record<string, number> = Object.create(null);
    for (const [t, value] of Object.entries<any>(result.Item.tenants?.M ?? {})) tenants[t] = Number(value.N);
    return { leases, tenants, queued: Number(result.Item.queued?.N ?? 0) };
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
      ExpressionAttributeValues: { ":pk": S(fieldsKey(name, tenant)), ":now": N(Date.now()) },
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
    return items.map((item): Waiter => ({
      callbackId: String(item.callback.S),
      runId: String(item.run.S),
      createdAt: Number(item.created.N),
      expiresAt: Number(item.until.N),
      condition: item.condition?.S,
      kind: item.kind?.S === "cancel" ? "cancel" : "wait",
      parent: item.parent?.S,
    }));
  }

  async deleteWaiter(key: string, waiter: Pick<Waiter, "createdAt" | "callbackId">) {
    await this.db("DeleteItem", { Key: { pk: S(key), sk: S(waiterSort(waiter)) } });
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
        out.push({ event: JSON.parse(item.event.S) as WireEvent, receivedAt: Number(String(item.sk.S).split("#")[0]) });
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
