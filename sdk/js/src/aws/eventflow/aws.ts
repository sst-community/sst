import { awsFetch, type AwsOptions } from "../client.js";

// The few SQS and DynamoDB calls EventFlow makes, over their JSON protocols, with the
// same signed fetch as the rest of the SDK. There's no AWS SDK in the bundle.

export class AwsError extends Error {
  constructor(
    public readonly service: string,
    public readonly action: string,
    public readonly status: number,
    public readonly type: string,
    message: string,
  ) {
    super(`${service} ${action} failed: ${status} ${type}${message ? `: ${message}` : ""}`);
    this.name = "AwsError";
  }
}

async function call<T>(
  service: "sqs" | "dynamodb",
  target: string,
  action: string,
  body: unknown,
  aws?: AwsOptions,
): Promise<T> {
  const response = await awsFetch(
    service,
    "/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": `${target}.${action}`,
      },
      body: JSON.stringify(body),
    },
    { aws },
  );
  const text = await response.text();
  if (!response.ok) {
    let type = "";
    let message = text;
    try {
      const data = JSON.parse(text);
      type = String(data.__type ?? data.code ?? "").split("#").pop() ?? "";
      message = data.message ?? data.Message ?? "";
    } catch {}
    throw new AwsError(service, action, response.status, type, message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export function sqs<T = any>(action: string, body: unknown, aws?: AwsOptions) {
  return call<T>("sqs", "AmazonSQS", action, body, aws);
}

export function dynamo<T = any>(action: string, body: unknown, aws?: AwsOptions) {
  return call<T>("dynamodb", "DynamoDB_20120810", action, body, aws);
}

export function isConditionFailure(error: unknown) {
  return (
    error instanceof AwsError &&
    (error.type === "ConditionalCheckFailedException" ||
      error.type === "TransactionCanceledException")
  );
}
