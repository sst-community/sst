import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

// A request to the function's URL
interface Request {
  body?: string;
  isBase64Encoded?: boolean;
}

// The URL is public. A webhook for a real service checks the signature the
// service sends before it trusts the body.
export async function handler(request: Request) {
  const body = request.isBase64Encoded
    ? Buffer.from(request.body ?? "", "base64").toString()
    : (request.body ?? "");
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: body }));
  return { statusCode: 202 };
}
