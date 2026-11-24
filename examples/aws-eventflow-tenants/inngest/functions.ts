// The app before it moved: Inngest v4.27.0. It's here to compare with src/flow.ts,
// and isn't built or deployed. The differences are marked with "EventFlow:".

import { eventType, Inngest, NonRetriableError, staticSchema } from "inngest";
import { serve } from "inngest/lambda";

// EventFlow: `new EventFlow({ id })` from "sst/aws/eventflow". No event or signing key.
export const inngest = new Inngest({ id: "contacts" });

export const importRequested = eventType("contacts/import.requested", {
  schema: staticSchema<{ tenantId: string; importId: string; rows: number; sentAt: number }>(),
});
export const importConfirmed = eventType("contacts/import.confirmed", {
  schema: staticSchema<{ tenantId: string; importId: string }>(),
});

export const importContacts = inngest.createFunction(
  {
    id: "import-contacts",
    triggers: { event: importRequested },
    retries: 4,
    // EventFlow: key on "event.tenant", the tenant the event was sent with.
    concurrency: [
      { limit: 5, key: "event.data.tenantId" },
      { limit: 20 },
    ],
  },
  async ({ event, step }) => {
    const rows = await step.run("download", async () => {
      if (event.data.rows < 0) throw new NonRetriableError("Bad file");
      return event.data.rows;
    });

    await step.run("save", async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return { saved: rows };
    });

    if (rows > 1000) {
      const confirmed = await step.waitForEvent("wait-for-confirmation", {
        event: importConfirmed,
        timeout: "1h",
        match: "data.importId",
      });
      if (!confirmed) return { status: "expired" };
    }

    await step.run("finish", async () => {
      await new Promise((r) => setTimeout(r, 1000));
    });

    await step.sendEvent("done", {
      name: "contacts/import.completed",
      data: { tenantId: event.data.tenantId, importId: event.data.importId },
    });
    return { status: "done", rows };
  },
);

// Tell each tenant, at most once a second.
export const notifyTenant = inngest.createFunction(
  {
    id: "notify-tenant",
    triggers: { event: "contacts/import.completed" },
    throttle: { limit: 60, period: "1m", key: "event.data.tenantId" },
  },
  async ({ event, step }) => {
    await step.run("notify", () => ({ notified: event.data.tenantId }));
  },
);

// EventFlow: `serve` from "sst/aws/eventflow". It's the handler of the EventFlow
// component, not a URL that Inngest calls.
export const handler = serve({ client: inngest, functions: [importContacts, notifyTenant] });
