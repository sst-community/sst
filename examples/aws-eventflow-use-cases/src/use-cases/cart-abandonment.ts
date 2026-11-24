// Cart abandonment: wait for the purchase, and remind only if it doesn't come.
// Inngest: https://www.inngest.com/uses/webhooks (event coordination)
import { flow, services } from "../client";

export const cartAbandonment = flow.createFunction(
  { id: "cart-abandonment", triggers: { event: "cart/item.added" } },
  async ({ event, step }) => {
    const purchase = await step.waitForEvent("wait-for-purchase", {
      event: "cart/purchased",
      timeout: event.data.timeout ?? "24h",
      match: "data.cartId",
    });
    if (purchase) return { status: "purchased" };
    await step.run("send-reminder", () => services.email(event.data.email, "You left something in your cart"));
    return { status: "reminded" };
  },
);
