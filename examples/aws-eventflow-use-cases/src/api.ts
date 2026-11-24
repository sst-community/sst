import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { Resource } from "sst";
import { flow } from "./client";

// A Stripe webhook. It's public, so it checks Stripe's signature before it sends
// anything, and the event's name and ID come from Stripe, not the caller.
//
// Linking the EventFlow lets this function send events, and nothing more.
export async function handler(event: APIGatewayProxyEventV2) {
  if (event.requestContext.http.method !== "POST" || event.rawPath !== "/webhooks/stripe")
    return { statusCode: 404, body: "Not found" };

  const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString() : (event.body ?? "");
  if (!verifyStripe(raw, event.headers["stripe-signature"], Resource.StripeWebhookSecret.value))
    return { statusCode: 400, body: "Bad signature" };

  const body = JSON.parse(raw);
  // Only the events the app handles.
  if (body.type !== "invoice.payment_failed") return { statusCode: 200, body: "Ignored" };
  await flow.send({
    name: "stripe/invoice.payment_failed",
    // A webhook delivered twice has the same ID, and starts nothing the second time.
    id: `stripe-${body.id}`,
    data: body.data.object,
  });
  return { statusCode: 200, body: "OK" };
}

// Stripe signs `${timestamp}.${body}` with HMAC-SHA256, and sends
// "t=<timestamp>,v1=<signature>". It's what stripe.webhooks.constructEvent checks.
function verifyStripe(body: string, header: string | undefined, secret: string, toleranceSeconds = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const given = header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  return given.some((g) => g.length === expected.length && timingSafeEqual(Buffer.from(g), Buffer.from(expected)));
}
