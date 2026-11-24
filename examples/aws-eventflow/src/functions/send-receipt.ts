import { flow } from "../client";

// A function with no triggers runs only when another function invokes it.
export const sendReceipt = flow.createFunction(
  { id: "send-receipt" },
  async ({ event, step }) => {
    const receipt = await step.run("render", () => ({
      orderId: event.data.orderId,
      text: `Thanks for order ${event.data.orderId}`,
    }));
    await step.run("email", () => {
      // Send it with your email provider here.
      return { to: event.data.email };
    });
    return receipt;
  },
);
