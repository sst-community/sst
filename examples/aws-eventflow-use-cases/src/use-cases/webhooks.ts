// Webhooks: one event, many functions. Each runs and retries on its own.
// Inngest: https://www.inngest.com/uses/webhooks
//
// The webhook handler sends the provider's event ID as the event ID, so a webhook
// that's delivered twice starts each function once. See src/api.ts.
import { flow, services } from "../client";

export const downgradeOnFailedPayment = flow.createFunction(
  { id: "downgrade-on-failed-payment", triggers: { event: "stripe/invoice.payment_failed" } },
  async ({ event, step }) => {
    await step.run("downgrade", () => services.billing("downgrade", event.data.customer));
    await step.run("email", () => services.email(event.data.customer_email, "Your payment failed"));
  },
);

export const notifyOnFailedPayment = flow.createFunction(
  { id: "notify-on-failed-payment", triggers: { event: "stripe/invoice.payment_failed" } },
  async ({ event, step }) => {
    await step.run("slack", () => services.slack(`Payment failed for ${event.data.customer}`));
  },
);
