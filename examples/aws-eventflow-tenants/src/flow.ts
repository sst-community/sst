// The app after it moved: the same functions as inngest/functions.ts, on EventFlow.
// Each step also records when it ran, in the Results table, so the burst can be
// measured. Take those lines out in your own app.

import { EventFlow, eventType, NonRetriableError, serve, staticSchema } from "sst/aws/eventflow";
import { record } from "./results";

export const flow = new EventFlow({ id: "contacts" });

export const importRequested = eventType("contacts/import.requested", {
  schema: staticSchema<{ test: string; tenantId: string; importId: string; rows: number; sentAt: number }>(),
});
export const importConfirmed = eventType("contacts/import.confirmed", {
  schema: staticSchema<{ test: string; tenantId: string; importId: string; sentAt: number }>(),
});

export const importContacts = flow.createFunction(
  {
    id: "import-contacts",
    triggers: { event: importRequested },
    retries: 4,
    // At most 5 steps of each tenant at once, and 20 of all tenants. A sleep or a
    // wait holds no lease. The key is the event's tenant, which the sender sets from
    // who's signed in, and not a field of the data anyone could send.
    concurrency: [
      { limit: 5, key: "event.tenant" },
      { limit: 20 },
    ],
  },
  async ({ event, step }) => {
    const { test, tenantId, importId } = event.data;

    const rows = await step.run("download", async () => {
      if (event.data.rows < 0) throw new NonRetriableError("Bad file");
      return event.data.rows;
    });

    // The protected work: a second of an external API.
    await step.run("save", async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 1000));
      await record(test, importId, {
        tenantId,
        sentAt: event.data.sentAt,
        waits: rows > 1000,
        saveStart: start,
        saveEnd: Date.now(),
      });
    });

    if (rows > 1000) {
      const confirmed = await step.waitForEvent("wait-for-confirmation", {
        event: importConfirmed,
        timeout: "1h",
        match: "data.importId",
      });
      if (!confirmed) return { status: "expired" };
      await step.run("record-confirmed", () =>
        record(test, importId, { confirmSentAt: confirmed.data.sentAt, resumedAt: Date.now() }),
      );
    }

    // Resumed work takes a lease again.
    await step.run("finish", async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 1000));
      await record(test, importId, { finishStart: start, finishEnd: Date.now() });
    });

    await step.sendEvent("done", {
      name: "contacts/import.completed",
      data: { test, tenantId, importId },
    });
    return { status: "done", rows };
  },
);

// Tell each tenant, at most once a second. Runs over the throttle are held, not
// dropped.
export const notifyTenant = flow.createFunction(
  {
    id: "notify-tenant",
    triggers: { event: "contacts/import.completed" },
    // Without a key, a throttle is per tenant.
    throttle: { limit: 60, period: "1m" },
  },
  async ({ event, step }) => {
    await step.run("notify", () =>
      record(event.data.test, event.data.importId, { notifiedAt: Date.now() }),
    );
  },
);

export const handler = serve({ client: flow, functions: [importContacts, notifyTenant] });
