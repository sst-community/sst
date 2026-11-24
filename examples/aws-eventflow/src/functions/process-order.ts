import { NonRetriableError } from "sst/aws/eventflow";
import { CardDeclined, charge } from "../payments";
import { flow, orderApproved, orderPlaced } from "../client";
import { sendReceipt } from "./send-receipt";

export const processOrder = flow.createFunction(
  {
    id: "process-order",
    triggers: { event: orderPlaced },
    // Each step is tried at most 6 times: once, and 5 retries.
    retries: 5,
  },
  async ({ event, step, logger, idempotencyKey }) => {
    // A step's result is saved. When the run resumes after a sleep or a wait, the
    // step isn't run again: it returns what it returned the first time.
    const payment = await step.run("charge-card", async () => {
      try {
        // The payment API charges once per key, so a step that runs again, after a
        // crash or a retry, doesn't charge twice. The key is the same in every
        // attempt, and in every retry and replay of the run.
        return await charge({ amount: event.data.amount, idempotencyKey: idempotencyKey("charge-card") });
      } catch (error) {
        // A declined card won't get better on its own: stop retrying.
        if (error instanceof CardDeclined) throw new NonRetriableError(error.message);
        // Anything else is retried, with backoff.
        throw error;
      }
    });

    if (event.data.amount >= 1000) {
      // Wait for the order's approval. It only matches an `order/approved` event
      // with the same `data.orderId`, sent after the wait starts.
      const approval = await step.waitForEvent("wait-for-approval", {
        event: orderApproved,
        timeout: "1h",
        match: "data.orderId",
      });
      if (!approval) {
        await step.run("refund", () => ({ refunded: payment.chargeId }));
        return { status: "not approved" };
      }
      logger.info({ message: "Approved", by: approval.data.by });
    }

    // A sleep costs nothing while it waits.
    await step.sleep("cool-off", "10s");

    // Run another function, and wait for what it returns.
    const receipt = await step.invoke("send-receipt", {
      function: sendReceipt,
      data: { orderId: event.data.orderId, email: event.data.email },
    });

    return { status: "done", chargeId: payment.chargeId, receipt };
  },
);
