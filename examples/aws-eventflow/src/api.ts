import { randomUUID, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { Resource } from "sst";
import { flow, orderApproved, orderPlaced } from "./client";
import { processOrder } from "./functions/process-order";

// The app's API. Linking the EventFlow lets it send events, and nothing more. Look at
// runs, retry and replay them with `sst eventflow`, or link `flow.admin` to a function
// that checks who's asking.
export async function handler(event: APIGatewayProxyEventV2) {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  let match: RegExpMatchArray | null;

  // Place an order. The event ID is the order's, so sending it again is skipped.
  if (method === "POST" && path === "/orders") {
    const orderId = randomUUID();
    const amount = Number(event.queryStringParameters?.amount ?? 25);
    const { ids } = await flow.send(
      orderPlaced.create({ orderId, amount, email: "alice@example.com" }, { id: `order-${orderId}` }),
    );
    // The run's ID is known now, from the function and the event.
    return json({ orderId, runId: flow.runs.idFor(processOrder, ids[0]) });
  }

  // Approve a large order. It resumes the run waiting for it. Only someone with the
  // approver's token may: in your app, check the signed-in user instead.
  if (method === "POST" && (match = path.match(/^\/orders\/([^/]+)\/approve$/))) {
    if (!allowed(event.headers["x-approver-token"])) return json({ error: "Forbidden" }, 403);
    await flow.send(orderApproved.create({ orderId: match[1], by: "ops" }));
    return json({ approved: match[1] });
  }

  return json({ error: "Not found" }, 404);
}

function allowed(token: string | undefined) {
  const expected = Buffer.from(Resource.ApproverToken.value);
  const given = Buffer.from(token ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function json(body: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}
