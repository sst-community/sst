import {
  GRANT_MS,
  tenantKey,
  uniqueLimits,
  type Admission,
  type LeaseWaiter,
  type Limit,
  type Store,
  type Waiter,
} from "../../src/aws/eventflow/store.ts";
import type { WireEvent } from "../../src/aws/eventflow/types.ts";

interface LimitItem {
  cap: number;
  label: string;
  leases: Record<string, { expires: number; tenant: string }>;
  tenants: Record<string, number>;
  /** Each tenant's line. */
  lines: Map<string, (LeaseWaiter & { seq: number })[]>;
}

// The same contract as DynamoStore, in memory, with an injectable clock: every limit
// at once or none, a line per tenant, and the fairest tenant first.
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
  /** Every acquire, for assertions: [time, items, tenant, granted]. */
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

  async successor(item: string, owner: string, ttlMs: number) {
    if (await this.claim(item, owner, ttlMs)) return owner;
    return this.claims.get(item)!.owner;
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
    if (!l)
      this.limits.set(limit.item, (l = { cap: limit.limit, label: limit.label ?? limit.item, leases: {}, tenants: {}, lines: new Map() }));
    return l;
  }

  active(itemKey: string, tenant?: string) {
    const l = this.limits.get(itemKey);
    if (!l) return 0;
    const now = this.now();
    return Object.values(l.leases).filter((v) => v.expires > now && (tenant === undefined || v.tenant === tenant)).length;
  }

  queued(itemKey: string) {
    const l = this.limits.get(itemKey);
    return l ? [...l.lines.values()].reduce((n, line) => n + line.length, 0) : 0;
  }

  private reap(l: LimitItem) {
    const now = this.now();
    for (const [id, v] of Object.entries(l.leases)) if (v.expires <= now) this.drop(l, id, v.tenant);
  }

  private drop(l: LimitItem, id: string, tenant: string) {
    if (!l.leases[id]) return;
    delete l.leases[id];
    const t = tenantKey(tenant);
    l.tenants[t] = (l.tenants[t] ?? 1) - 1;
    if (l.tenants[t] <= 0) delete l.tenants[t];
  }

  private give(l: LimitItem, id: string, tenant: string, ms: number) {
    l.leases[id] = { expires: this.now() + ms, tenant };
    const t = tenantKey(tenant);
    l.tenants[t] = (l.tenants[t] ?? 0) + 1;
  }

  async acquire(limits: Limit[], leaseId: string, tenant: string, leaseMs: number) {
    const items = uniqueLimits(limits).map((l) => ({ limit: l, item: this.item(l) }));
    items.forEach(({ item }) => this.reap(item));
    const held = items.every(({ item }) => item.leases[leaseId]) && (await this.renew(limits, leaseId, leaseMs, true));
    const room = items.every(
      ({ limit, item }) => Object.keys(item.leases).length < limit.limit && [...item.lines.values()].every((q) => !q.length),
    );
    const ok = held || room;
    if (ok && !held) items.forEach(({ item }) => this.give(item, leaseId, tenant, leaseMs));
    this.log.push([this.now(), items.map((i) => i.limit.item).join(","), tenant, ok]);
    return ok ? ("granted" as const) : ("full" as const);
  }

  async renew(limits: Limit[], leaseId: string, leaseMs: number, claim = false) {
    const now = this.now();
    for (const l of uniqueLimits(limits)) {
      const lease = this.item(l).leases[leaseId];
      if (!lease || lease.expires <= now) return false;
    }
    if (!claim && uniqueLimits(limits).every((l) => this.item(l).leases[leaseId].expires >= now + leaseMs)) return true;
    for (const l of uniqueLimits(limits)) this.item(l).leases[leaseId] = { ...this.item(l).leases[leaseId], expires: now + leaseMs };
    return true;
  }

  async release(limits: Limit[], leaseId: string, tenant: string) {
    for (const l of uniqueLimits(limits)) this.drop(this.item(l), leaseId, tenant);
  }

  async enqueue(waiter: LeaseWaiter) {
    const limits = uniqueLimits(waiter.limits);
    if (limits.every((l) => this.item(l).leases[waiter.leaseId]) && (await this.renew(limits, waiter.leaseId, GRANT_MS, true)))
      return "held" as const;
    for (const l of limits) {
      const lines = this.item(l).lines;
      const line = lines.get(waiter.tenant) ?? [];
      lines.set(waiter.tenant, line);
      const same = line.find((w) => w.at === waiter.at && w.leaseId === waiter.leaseId);
      if (same) same.callbackId = waiter.callbackId;
      else line.push({ ...waiter, limits, seq: this.seq++ });
    }
    return "queued" as const;
  }

  async dispatch(limit: Limit, wake: (w: LeaseWaiter) => Promise<boolean>, just?: string, skip = new Set<string>()) {
    const l = this.item(limit);
    let woken = 0;
    for (;;) {
      this.reap(l);
      if (Object.keys(l.leases).length >= limit.limit) return woken;
      // The oldest step of each tenant in line, fewest leases first, then oldest.
      const candidates = [...l.lines.values()]
        .map((line) => line.find((w) => !skip.has(w.leaseId)))
        .filter((w): w is NonNullable<typeof w> => !!w)
        // A tenant that just gave one back counts it, as DynamoStore picks the next step
        // before the lease is given back.
        .sort(
          (a, b) =>
            (l.tenants[tenantKey(a.tenant)] ?? 0) + (a.tenant === just ? 1 : 0) - (l.tenants[tenantKey(b.tenant)] ?? 0) - (b.tenant === just ? 1 : 0) ||
            a.at - b.at ||
            a.seq - b.seq,
        );
      const next = candidates.find((c) => this.canGrant(c));
      if (!next) return woken;
      const given = new Map<LimitItem, { expires: number; tenant: string }>();
      for (const other of uniqueLimits(next.limits)) {
        const item = this.item(other);
        const line = item.lines.get(next.tenant)!;
        line.splice(line.findIndex((w) => w.leaseId === next.leaseId && w.at === next.at), 1);
        this.give(item, next.leaseId, next.tenant, GRANT_MS);
        given.set(item, item.leases[next.leaseId]);
      }
      let told: boolean | undefined;
      try {
        told = await wake(next);
      } catch {}
      if (told) {
        woken++;
        continue;
      }
      // One that may not have been told goes back in line, in its place, unless it
      // asked again in between, and waits for the next dispatch.
      if (told === undefined) {
        skip.add(next.leaseId);
        for (const other of uniqueLimits(next.limits)) {
          const line = this.item(other).lines.get(next.tenant) ?? [];
          this.item(other).lines.set(next.tenant, line);
          if (!line.some((w) => w.leaseId === next.leaseId && w.at === next.at)) {
            line.push(next);
            line.sort((a, b) => a.at - b.at || a.seq - b.seq);
          }
        }
      }
      // Only the leases this gave: a step that renewed them holds them as its own.
      for (const [item, lease] of given) if (item.leases[next.leaseId] === lease) this.drop(item, next.leaseId, next.tenant);
    }
  }

  async handoff(limits: Limit[], leaseId: string, tenant: string, wake: (w: LeaseWaiter) => Promise<boolean>) {
    await this.release(limits, leaseId, tenant);
    // The limit with the most tenants in line first, as DynamoStore does.
    const inLine = (l: Limit) => [...this.item(l).lines.values()].filter((line) => line.length).length;
    const skip = new Set<string>();
    for (const l of uniqueLimits(limits).sort((a, b) => inLine(b) - inLine(a) || b.limit - a.limit))
      await this.dispatch(l, wake, tenant, skip);
  }

  private canGrant(w: LeaseWaiter) {
    return uniqueLimits(w.limits).every((other) => {
      const item = this.item(other);
      this.reap(item);
      return Object.keys(item.leases).length < other.limit && !item.leases[w.leaseId];
    });
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
    const list = (this.waiterItems.get(key) ?? []).filter((w) => !(w.createdAt === waiter.createdAt && w.callbackId === waiter.callbackId));
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
      return [...this.limits.entries()].flatMap(([pk, l]) => [{ pk, sk: "w#", n: this.queued(pk) }, {
        pk,
        sk: "-",
        label: l.label,
        cap: l.cap,
        tenants: { ...l.tenants },
        leases: Object.fromEntries(Object.entries(l.leases).map(([id, v]) => [id, `${v.expires}|o|${v.tenant}`])),
      }]);
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
