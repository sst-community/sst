// A weekly digest: a cron fans out one event per user, and each user's digest is a
// run of its own, retried on its own. The throttle keeps the email provider happy.
// Inngest: https://www.inngest.com/uses/scheduled-jobs
import { flow, services } from "../client";

export const weeklyDigest = flow.createFunction(
  { id: "weekly-digest", triggers: { cron: "TZ=Europe/Paris 0 12 * * 5" } },
  async ({ event, step }) => {
    // The run's time comes from the event, not Date.now(), so it's the same when the
    // run resumes.
    const week = new Date(event.ts).toISOString().slice(0, 10);
    const users = await step.run("load-users", () => [
      { id: "u1", email: "ada@example.com" },
      { id: "u2", email: "grace@example.com" },
    ]);
    await step.sendEvent(
      "fan-out",
      users.map((u) => ({ name: "digest/send", id: `digest-${u.id}-${week}`, data: u })),
    );
    return { users: users.length };
  },
);

export const sendDigest = flow.createFunction(
  {
    id: "send-digest",
    triggers: { event: "digest/send" },
    throttle: { limit: 10, period: "1s" },
  },
  async ({ event, step }) => {
    await step.run("send", () => services.email(event.data.email, "Your week"));
  },
);
