import { serve } from "sst/aws/eventflow";
import { flow } from "./client";
import { summarizeDocument } from "./use-cases/ai-chain";
import { onSignup } from "./use-cases/background-job";
import { cartAbandonment } from "./use-cases/cart-abandonment";
import { sendDigest, weeklyDigest } from "./use-cases/digest";
import { publishPost } from "./use-cases/human-in-the-loop";
import { reminder } from "./use-cases/reminders";
import { syncContacts } from "./use-cases/sync";
import { trial } from "./use-cases/trial";
import { downgradeOnFailedPayment, notifyOnFailedPayment } from "./use-cases/webhooks";

// Eleven functions, one worker. None of them added infrastructure.
export const handler = serve({
  client: flow,
  functions: [
    onSignup,
    downgradeOnFailedPayment,
    notifyOnFailedPayment,
    cartAbandonment,
    reminder,
    trial,
    weeklyDigest,
    sendDigest,
    syncContacts,
    summarizeDocument,
    publishPost,
  ],
});
