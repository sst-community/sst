// Background jobs: work that shouldn't block a request, retried step by step.
// Inngest: https://www.inngest.com/uses/serverless-node-background-jobs
import { flow, services } from "../client";

export const onSignup = flow.createFunction(
  { id: "on-signup", triggers: { event: "user/signup" } },
  async ({ event, step }) => {
    // If the CRM sync fails, it retries alone: the email isn't sent again.
    await step.run("send-welcome-email", () => services.email(event.data.email, "Welcome"));
    await step.run("sync-to-crm", () => services.crm(event.data.userId));
  },
);
