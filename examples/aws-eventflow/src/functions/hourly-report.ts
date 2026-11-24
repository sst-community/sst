import { flow } from "../client";

// A cron trigger. The EventFlow's schedule ticks every minute, and starts the
// functions that are due. Use "TZ=Europe/Paris 0 9 * * *" for a time zone.
export const hourlyReport = flow.createFunction(
  { id: "hourly-report", triggers: { cron: "0 * * * *" } },
  async ({ event, step }) => {
    const orders = await step.run("count-orders", async () => {
      const runs = await flow.runs.list({ function: "process-order", from: new Date(event.ts - 3_600_000) });
      return runs.length;
    });
    return { hour: new Date(event.ts).toISOString(), orders };
  },
);
