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
    /** For a cancelled transaction, the code of each of its items, like "ConditionalCheckFailed". */
    public readonly reasons: string[] = [],
  ) {
    super(`${service} ${action} failed: ${status} ${type}${message ? `: ${message}` : ""}`);
    this.name = "AwsError";
  }
}

async function call<T>(
  service: "sqs" | "dynamodb" | "ssm",
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
        "Content-Type": service === "ssm" ? "application/x-amz-json-1.1" : "application/x-amz-json-1.0",
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
    let reasons: string[] = [];
    try {
      const data = JSON.parse(text);
      type = String(data.__type ?? data.code ?? "").split("#").pop() ?? "";
      message = data.message ?? data.Message ?? "";
      if (Array.isArray(data.CancellationReasons)) reasons = data.CancellationReasons.map((r: any) => String(r?.Code ?? "None"));
      // Otherwise they're in the message: "... [ConditionalCheckFailed, None]".
      else if (type === "TransactionCanceledException") {
        const listed = /\[([^\]]*)\]\s*$/.exec(message);
        if (listed) reasons = listed[1].split(",").map((r) => r.trim());
      }
    } catch {}
    throw new AwsError(service, action, response.status, type, message, reasons);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export function sqs<T = any>(action: string, body: unknown, aws?: AwsOptions) {
  return call<T>("sqs", "AmazonSQS", action, body, aws);
}

export function ssm<T = any>(action: string, body: unknown, aws?: AwsOptions) {
  return call<T>("ssm", "AmazonSSM", action, body, aws);
}

/**
 * A DynamoDB call. A throttle or a transaction conflict did nothing, so it's tried
 * again, a few times, with backoff.
 */
export async function dynamo<T = any>(action: string, body: unknown, aws?: AwsOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call<T>("dynamodb", "DynamoDB_20120810", action, body, aws);
    } catch (error) {
      // A hot item, like a busy concurrency limit, can conflict with transactions for
      // a while: about 3 seconds in all, with jitter, before giving up.
      if (attempt >= 8 || !isTransient(error)) throw error;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(1000, 20 * 2 ** attempt) + 10));
    }
  }
}

const TRANSIENT = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "TransactionConflictException",
  "TransactionInProgressException",
]);
const TRANSIENT_REASONS = new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded", "RequestLimitExceeded"]);

/** An error that did nothing, and that's gone when asked again later. */
export function isTransient(error: unknown) {
  if (!(error instanceof AwsError)) return false;
  if (TRANSIENT.has(error.type)) return true;
  return error.type === "TransactionCanceledException" && error.reasons.some((r) => TRANSIENT_REASONS.has(r));
}

/**
 * A condition that wasn't met, and nothing else: a cancelled transaction counts only
 * if each of its items was cancelled by its condition or by another's. One cancelled
 * for a conflict, a throttle or a validation error, like an item over 400 KB, isn't.
 */
export function isConditionFailure(error: unknown) {
  if (!(error instanceof AwsError)) return false;
  if (error.type === "ConditionalCheckFailedException") return true;
  if (error.type !== "TransactionCanceledException") return false;
  if (!error.reasons.length) return true;
  return error.reasons.includes("ConditionalCheckFailed") && error.reasons.every((r) => r === "None" || r === "ConditionalCheckFailed");
}
