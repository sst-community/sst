import { z } from "zod";
import { EventFlow, eventType, staticSchema } from "sst/aws/eventflow";

// The client. Functions are created with it, and events are sent with it. It finds
// the EventFlow it's linked to.
export const flow = new EventFlow({ id: "shop" });

// Events, with a schema for their data. A trigger with one of them types
// `event.data` in the handler. The data is checked against the schema when it's sent.
export const orderPlaced = eventType("order/placed", {
  schema: z.object({
    orderId: z.string(),
    amount: z.number().positive(),
    email: z.string().email(),
  }),
});

// Types only, with no check.
export const orderApproved = eventType("order/approved", {
  schema: staticSchema<{ orderId: string; by: string }>(),
});
