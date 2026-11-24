import {
  fairest,
  tenantKey,
  type Admission,
  type LeaseWaiter,
  type Limit,
  type Store,
  type Waiter,
} from "../../src/aws/eventflow/store.ts";
import type { WireEvent } from "../../src/aws/eventflow/types.ts";

interface LimitItem {
  leases: Record<string, { expires: number; tenant: string }>;
  tenants: Record<string, number>;
  queue: (LeaseWaiter & { seq: number })[];
  label: string;
  cap: number;
}

// The same contract as DynamoStore, in memory, with an injectable clock. The fair
// pick comes from the same function, so the policy under test is the one that ships.
export class MemoryStore implements Store {
  now = () => Date.now();
  events = new Map<string, { delivery: string; routed: boolean; expires: number }>();
  admissions = new Map<string, Admission>();
  claims = new Map<string, { owner: string; expires: number }>();
  limits = new Map<string, LimitItem>();
  buckets = new Map<string, number>();
  fields = new Map<string, Map<string, number>>();
  waiterItems = new Map<string, Waiter[]>();
  recentItems = new Map<string, { event: WireEvent; receivedAt: number }[]>();
  /** Every acquire, for assertions: [time, item, tenant, granted]. */
  log: [number, string, string, boolean][] = [];
  private seq = 0;

  async beginEvent(item: string, delivery: string) {
    const seen = this.events.get(item);
    if (seen && seen.routed && seen.delivery !== delivery && seen.expires > this.now()) return "duplicate" as const;
    this.events.set(item, { delivery, routed: false, expires: this.now() + 86_400_000 });
    return "route" as const;
  }

  async finishEvent(item: string) {
    const seen = this.events.get(item);
    if (seen) seen.routed = true;
  }

  async getAdmission(item: string) {
    return this.admissions.get(item);
  }

  async putAdmission(item: string, admission: Admission) {
    if (!this.admissions.has(item)) this.admissions.set(item, admission);
    return this.admissions.get(item)!;
  }

  async claim(item: string, owner: string, ttlMs: number) {
    const c = this.claims.get(item);
    if (c && c.owner !== owner && c.expires > this.now()) return false;
    this.claims.set(item, { owner, expires: this.now() + ttlMs });
    return true;
  }

  async take(item: string, intervalMs: number, toleranceMs: number) {
    const now = this.now();
    const tat = Math.max(this.buckets.get(item) ?? now, now);
    if (tat - now > toleranceMs) return tat - toleranceMs - now;
    this.buckets.set(item, tat + intervalMs);
    return 0;
  }

  async reserve(item: string, intervalMs: number, toleranceMs: number) {
    const now = this.now();
    const tat = Math.max(this.buckets.get(item) ?? now, now);
    this.buckets.set(item, tat + intervalMs);
    return now + Math.max(0, tat - toleranceMs - now);
  }

  item(limit: Limit) {
    let l = this.limits.get(limit.item);
    if (!l) this.limits.set(limit.item, (l = { leases: {}, tenants: {}, queue: [], label: limit.label ?? limit.item, cap: limit.limit }));
    return l;
  }

  active(itemKey: string, tenant?: string) {
    const l = this.limits.get(itemKey);
    if (!l) return 0;
    const now = this.now();
    return Object.values(l.leases).filter((v) => v.expires > now && (tenant === undefined || v.tenant === tenant)).length;
  }

  private reap(l: LimitItem) {
    const now = this.now();
    for (const [id, v] of Object.entries(l.leases))
      if (v.expires <= now) this.drop(l, id, v.tenant);
  }

  private drop(l: LimitItem, id: string, tenant: string) {
    if (!l.leases[id]) return;
    delete l.leases[id];
    const t = tenantKey(tenant);
    l.tenants[t] = (l.tenants[t] ?? 1) - 1;
    if (l.tenants[t] <= 0) delete l.tenants[t];
  }

  private grant(l: LimitItem, id: string, tenant: string, leaseMs: number) {
    l.leases[id] = { expires: this.now() + leaseMs, tenant };
    const t = tenantKey(tenant);
    l.tenants[t] = (l.tenants[t] ?? 0) + 1;
  }

  async acquire(limit: Limit, leaseId: string, tenant: string, leaseMs: number) {
    const l = this.item(limit);
    this.reap(l);
    const ok = Boolean(l.leases[leaseId]) || (Object.keys(l.leases).length < limit.limit && l.queue.length === 0);
    if (ok && !l.leases[leaseId]) this.grant(l, leaseId, tenant, leaseMs);
    this.log.push([this.now(), limit.item, tenant, ok]);
    return ok;
  }

  async renew(limit: Limit, leaseId: string, leaseMs: number) {
    const lease = this.item(limit).leases[leaseId];
    if (!lease || lease.expires <= this.now()) return false;
    lease.expires = this.now() + leaseMs;
    return true;
  }

  async release(limit: Limit, leaseId: string, tenant: string) {
    this.drop(this.item(limit), leaseId, tenant);
  }

  async enqueue(limit: Limit, waiter: LeaseWaiter) {
    const queue = this.item(limit).queue;
    const same = queue.find((w) => w.at === waiter.at && w.leaseId === waiter.leaseId);
    if (same) same.callbackId = waiter.callbackId;
    else queue.push({ ...waiter, seq: this.seq++ });
  }

  async dispatch(limit: Limit, leaseMs: number, wake: (w: LeaseWaiter) => Promise<boolean>) {
    const l = this.item(limit);
    let woken = 0;
    for (;;) {
      this.reap(l);
      if (Object.keys(l.leases).length >= limit.limit || !l.queue.length) return woken;
      const next = fairest(l.queue, l.tenants)!;
      l.queue.splice(l.queue.indexOf(next), 1);
      this.grant(l, next.leaseId, next.tenant, leaseMs);
      if (await wake(next).catch(() => false)) woken++;
      else this.drop(l, next.leaseId, next.tenant);
    }
  }

  private fieldKey(name: string, tenant: string | undefined) {
    return JSON.stringify([name, tenant ?? null]);
  }

  async waitFields(name: string, tenant: string | undefined) {
    const now = this.now();
    return [...(this.fields.get(this.fieldKey(name, tenant)) ?? new Map()).entries()].filter(([, u]) => u > now).map(([f]) => f);
  }

  async addWaitField(name: string, tenant: string | undefined, field: string, until: number) {
    const k = this.fieldKey(name, tenant);
    const m = this.fields.get(k) ?? new Map<string, number>();
    m.set(field, Math.max(until, m.get(field) ?? 0));
    this.fields.set(k, m);
  }

  async putWaiter(key: string, waiter: Waiter) {
    const list = (this.waiterItems.get(key) ?? []).filter(
      (w) => !(w.createdAt === waiter.createdAt && w.callbackId === waiter.callbackId),
    );
    list.push(waiter);
    this.waiterItems.set(key, list);
  }

  async waiters(key: string, now: number) {
    return (this.waiterItems.get(key) ?? []).filter((w) => w.expiresAt > now);
  }

  async deleteWaiter(key: string, waiter: Pick<Waiter, "createdAt" | "callbackId">) {
    this.waiterItems.set(
      key,
      (this.waiterItems.get(key) ?? []).filter((w) => !(w.createdAt === waiter.createdAt && w.callbackId === waiter.callbackId)),
    );
  }

  async putRecent(key: string, event: WireEvent, receivedAt: number) {
    const list = this.recentItems.get(key) ?? [];
    list.push({ event, receivedAt });
    this.recentItems.set(key, list);
  }

  async recent(key: string, since: number) {
    return (this.recentItems.get(key) ?? []).filter((r) => r.receivedAt >= since);
  }

  async scan(prefix: string) {
    if (prefix === "C#")
      return [...this.limits.entries()].map(([pk, l]) => ({
        pk,
        label: l.label,
        cap: l.cap,
        queued: l.queue.length,
        tenants: { ...l.tenants },
        leases: Object.fromEntries(Object.entries(l.leases).map(([id, v]) => [id, `${v.expires}|${v.tenant}`])),
      }));
    if (prefix === "W#")
      return [...this.waiterItems.entries()].flatMap(([pk, list]) =>
        list.map((w) => ({
          pk,
          run: w.runId,
          kind: w.kind ?? "wait",
          created: w.createdAt,
          until: w.expiresAt,
          info: w.info ? JSON.stringify(w.info) : undefined,
        })),
      );
    return [];
  }
}
