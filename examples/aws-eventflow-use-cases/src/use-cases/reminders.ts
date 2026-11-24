// Reminders at a time the user chose, cancelled if they act first.
// Inngest: https://www.inngest.com/uses/scheduled-jobs
import { flow, services } from "../client";

export const reminder = flow.createFunction(
  {
    id: "reminder",
    triggers: { event: "reminder/scheduled" },
    // A "reminder/cancelled" event with the same reminderId stops the run, even while
    // it sleeps.
    cancelOn: [{ event: "reminder/cancelled", match: "data.reminderId" }],
  },
  async ({ event, step }) => {
    await step.sleepUntil("wait-for-time", event.data.remindAt);
    await step.run("send", () => services.email(event.data.email, event.data.text));
  },
);
