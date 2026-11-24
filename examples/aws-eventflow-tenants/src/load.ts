import { flow, importConfirmed, importRequested } from "./flow";
import { results } from "./results";

// Sends the load, from a Lambda in the same region, so the laptop's network isn't
// part of what's measured.
//
//   { "action": "burst", "test": "t1", "tenant": "a", "count": 1000, "rows": 10 }
//   { "action": "confirm", "test": "t1" }
export async function handler(input: {
  action: "burst" | "confirm";
  test: string;
  tenant?: string;
  count?: number;
  rows?: number;
}) {
  if (input.action === "confirm") {
    const waiting = (await results(input.test)).filter((r) => r.saveEnd && !r.resumedAt && r.waits);
    const sentAt = Date.now();
    await sendAll(
      waiting.map((r) =>
        importConfirmed.create(
          { test: input.test, tenantId: r.tenantId, importId: r.importId, sentAt },
          { tenant: r.tenantId },
        ),
      ),
    );
    return { confirmed: waiting.length };
  }

  const tenant = input.tenant ?? "a";
  const count = input.count ?? 1;
  const rows = input.rows ?? 10;
  const started = Date.now();
  const events = Array.from({ length: count }, (_, i) => {
    const importId = `${tenant}-${i}`;
    return importRequested.create(
      { test: input.test, tenantId: tenant, importId, rows, sentAt: 0 },
      { id: `${input.test}-${importId}`, tenant },
    );
  });
  await sendAll(events, (e) => {
    (e.data as any).sentAt = Date.now();
  });
  return { sent: count, ms: Date.now() - started };
}

// 25 sends of 10 at a time.
async function sendAll<T extends { data: any }>(events: T[], before?: (e: T) => void) {
  const chunks: T[][] = [];
  for (let i = 0; i < events.length; i += 10) chunks.push(events.slice(i, i + 10));
  let next = 0;
  await Promise.all(
    Array.from({ length: 25 }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        chunk.forEach((e) => before?.(e));
        await flow.send(chunk as any);
      }
    }),
  );
}
