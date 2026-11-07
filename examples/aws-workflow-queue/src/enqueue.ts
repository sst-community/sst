import { randomUUID } from "node:crypto";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { Resource } from "sst";

const sqs = new SQSClient({});

export async function handler(event: APIGatewayProxyEventV2) {
  const query = event.queryStringParameters ?? {};
  // In your app, take the tenant from something you trust, like the signed-in
  // user, and not from the request.
  const tenant = query.tenant ?? "a";
  const count = Math.min(Number(query.count ?? 1), 1000);
  const url =
    query.queue === "import"
      ? Resource.ImportQueue.url
      : Resource.ResizeQueue.url;

  for (let i = 0; i < count; i += 10) {
    const entries = Array.from({ length: Math.min(10, count - i) }, () => ({
      Id: randomUUID(),
      MessageBody: JSON.stringify({ jobId: randomUUID() }),
      MessageGroupId: tenant,
    }));
    const result = await sqs.send(
      new SendMessageBatchCommand({ QueueUrl: url, Entries: entries }),
    );
    if (result.Failed?.length) throw new Error(JSON.stringify(result.Failed));
  }

  return `Sent ${count} jobs for tenant ${tenant}.`;
}
