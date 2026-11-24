// Data sync: walk a paginated API, one step per page, so a failure resumes at the
// page that failed.
// Inngest: https://www.inngest.com/docs/guides (patterns: loops)
import { flow, services } from "../client";

export const syncContacts = flow.createFunction(
  {
    id: "sync-contacts",
    triggers: [{ event: "contacts/sync.requested" }, { cron: "0 3 * * *" }],
    // One sync per tenant at a time.
    concurrency: { limit: 1, key: "event.tenant" },
  },
  async ({ step }) => {
    let cursor: number | undefined = 0;
    let total = 0;
    while (cursor !== undefined) {
      // The same ID in each pass of the loop is given ":1", ":2", ...
      const page: { items: string[]; next?: number } = await step.run("fetch-page", () => services.page(cursor!));
      total += page.items.length;
      cursor = page.next;
    }
    return { total };
  },
);
