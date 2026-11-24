import { serve } from "sst/aws/eventflow";
import { flow } from "./client";
import { hourlyReport } from "./functions/hourly-report";
import { processOrder } from "./functions/process-order";
import { sendReceipt } from "./functions/send-receipt";

// The EventFlow's handler, for all of its functions. To add a function, create it and
// add it here. Nothing else changes.
export const handler = serve({
  client: flow,
  functions: [processOrder, sendReceipt, hourlyReport],
});
