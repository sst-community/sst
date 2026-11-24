import { results } from "./results";

// Turns the Results table into the numbers in the EventFlow docs.
//
//   { "test": "t1" }
export async function handler(input: { test: string }) {
  const items = await results(input.test);
  const tenants = [...new Set(items.map((i) => i.tenantId as string))].sort();

  const byTenant = Object.fromEntries(
    tenants.map((tenant) => {
      const mine = items.filter((i) => i.tenantId === tenant && i.saveStart);
      // From when the event was sent to when its protected step started.
      const startDelay = mine.map((i) => i.saveStart - i.sentAt);
      return [
        tenant,
        {
          runs: mine.length,
          startDelayMs: stats(startDelay),
          mostAtOnce: mostAtOnce(intervals(mine)),
          lastDoneAfterMs: Math.max(...mine.map((i) => (i.finishEnd ?? i.saveEnd) - minSent(items))),
          notifyPerMinute: perMinute(mine.filter((i) => i.notifiedAt).map((i) => i.notifiedAt)),
        },
      ];
    }),
  );

  const resumed = items.filter((i) => i.resumedAt && i.confirmSentAt);
  return {
    test: input.test,
    runs: items.length,
    tenants: byTenant,
    mostAtOnce: mostAtOnce(intervals(items)),
    waitResumeMs: resumed.length ? stats(resumed.map((i) => i.resumedAt - i.confirmSentAt)) : undefined,
  };
}

function minSent(items: Record<string, any>[]) {
  return Math.min(...items.filter((i) => i.sentAt).map((i) => i.sentAt));
}

// The protected steps: "save" and "finish".
function intervals(items: Record<string, any>[]) {
  return items.flatMap((i) => [
    ...(i.saveStart ? [[i.saveStart, i.saveEnd] as const] : []),
    ...(i.finishStart ? [[i.finishStart, i.finishEnd] as const] : []),
  ]);
}

function mostAtOnce(spans: readonly (readonly [number, number])[]) {
  const edges = spans.flatMap(([a, b]) => [
    [a, 1],
    [b, -1],
  ]) as [number, number][];
  // An end before a start at the same time.
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let now = 0;
  let most = 0;
  for (const [, d] of edges) most = Math.max(most, (now += d));
  return most;
}

function stats(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1], n: values.length };
}

function perMinute(times: number[]) {
  if (!times.length) return undefined;
  const start = Math.min(...times);
  const buckets = new Map<number, number>();
  for (const t of times) {
    const m = Math.floor((t - start) / 60_000);
    buckets.set(m, (buckets.get(m) ?? 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}
