import { Resource } from "../../resource/index.js";
import { awsFetch, type AwsOptions } from "../client.js";
import { workflow } from "../workflow.js";
import { sqs } from "./aws.js";
import { ulid } from "./ids.js";
import { sign } from "./sign.js";
import { DynamoStore, type Store } from "./store.js";
import {
  ADMIN_MARKER,
  ENV_RESOURCE,
  type EngineResource,
  type Message,
  type RunPayload,
  type WireEvent,
} from "./types.js";

/** The largest event, in bytes of JSON, that `send()` accepts. It leaves room for the message around it in SQS's 256 KB. */
export const MAX_EVENT_BYTES = 255 * 1024;
/** How long an event ID is remembered, so a second send of it is skipped. */
export const DEDUP_MS = 24 * 3_600_000;

/**
 * The parts of the engine every role uses: the resource, the store, and the calls
 * that send events, start runs, and reach the router.
 */
export class Engine {
  private _store?: Store;

  constructor(
    public readonly resource: EngineResource,
    store: Store | undefined,
    public readonly aws?: AwsOptions,
  ) {
    this._store = store;
  }

  /** The table. Only the router and the worker can use it. */
  get store(): Store {
    if (this._store) return this._store;
    if (!this.resource.tableName)
      throw new Error("Only the EventFlow's router and worker use its table. Use flow.admin to look at its state.");
    return (this._store = new DynamoStore(this.resource.tableName, this.aws));
  }

  static resolve(input: { resource?: EngineResource; aws?: AwsOptions; store?: Store }) {
    return new Engine(input.resource ?? findResource(), input.store, input.aws);
  }

  get worker() {
    const name = this.resource.workerName;
    const qualifier = this.resource.workerQualifier || process.env.AWS_LAMBDA_FUNCTION_VERSION;
    if (!name || !qualifier || qualifier === "$LATEST")
      throw new Error("Only the EventFlow's router starts runs.");
    return { name, qualifier };
  }

  async sendMessages(messages: { message: Message; group?: string; delaySeconds?: number }[]) {
    // SendMessageBatch takes 10 messages and 256 KB.
    const batches: (typeof messages)[] = [];
    let batch: typeof messages = [];
    let bytes = 0;
    for (const m of messages) {
      const size = Buffer.byteLength(JSON.stringify(m.message));
      if (batch.length === 10 || (batch.length && bytes + size > 255 * 1024)) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(m);
      bytes += size;
    }
    if (batch.length) batches.push(batch);

    for (const entries of batches) {
      const result = await sqs<{ Failed?: { Id: string; Code: string; Message?: string }[] }>(
        "SendMessageBatch",
        {
          QueueUrl: this.resource.queueUrl,
          Entries: entries.map((e, i) => ({
            Id: String(i),
            MessageBody: JSON.stringify(e.message),
            ...(e.group ? { MessageGroupId: e.group } : {}),
            ...(e.delaySeconds ? { DelaySeconds: e.delaySeconds } : {}),
          })),
        },
        this.aws,
      );
      if (result.Failed?.length) {
        const failed = result.Failed.map((f) => {
          const m = entries[Number(f.Id)].message;
          return `${m.event.id}: ${f.Code}${f.Message ? ` ${f.Message}` : ""}`;
        });
        throw new SendError(`Failed to send ${failed.length} of ${entries.length} events: ${failed.join("; ")}`);
      }
    }
  }

  async sendEvents(events: WireEvent[]) {
    await this.sendMessages(events.map((event) => ({ message: { kind: "event", event }, group: event.tenant })));
  }

  /**
   * Start a run. Lambda starts one execution per name, and returns the existing one
   * when the name and payload are the same, so starting a run twice is safe. The
   * payload is signed, and the worker runs nothing that isn't.
   */
  async startRun(payload: RunPayload, worker = this.worker) {
    const signed = sign(payload);
    try {
      return await workflow.start(worker, { name: payload.runId, payload: signed }, { aws: this.aws });
    } catch (error) {
      if (error instanceof workflow.StartError) {
        const body = await error.response.text().catch(() => "");
        // The name is used by a run with another payload. The run already happened.
        if (error.response.status === 409 && body.includes("AlreadyStarted")) return undefined;
        throw new Error(`Failed to start run "${payload.runId}": ${error.response.status} ${body}`.trim(), {
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Resume a run's callback. Returns false when the callback is closed or unknown,
   * as when the run stopped, and throws for errors worth retrying.
   */
  async callback(callbackId: string, payload: unknown) {
    try {
      await workflow.succeed(callbackId, { payload }, { aws: this.aws });
      return true;
    } catch (error) {
      if (error instanceof workflow.SucceedError && [400, 404].includes(error.response.status)) return false;
      throw error;
    }
  }

  /** Stop a run. Returns false when it had already ended. */
  async stopRun(arn: string) {
    try {
      await workflow.stop(arn, undefined, { aws: this.aws });
      return true;
    } catch (error) {
      if (error instanceof workflow.StopError && [400, 404, 409].includes(error.response.status)) return false;
      throw error;
    }
  }

  /** Call the router's admin API. */
  async admin<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await awsFetch(
      "lambda",
      `/2015-03-31/functions/${encodeURIComponent(this.resource.routerName)}/invocations`,
      { method: "POST", body: JSON.stringify({ [ADMIN_MARKER]: { op, args } }) },
      { aws: this.aws },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `The EventFlow admin API failed: ${response.status} ${text}. Is this function linked to the EventFlow's admin, with "link: [flow.admin]"?`,
      );
    if (response.headers.get("X-Amz-Function-Error")) {
      const error = JSON.parse(text || "{}");
      throw new Error(`The EventFlow admin API failed: ${error.errorMessage ?? text}`);
    }
    const result = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: { name: string; message: string } };
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.name = result.error.name;
      throw error;
    }
    return result.result;
  }
}

export class SendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendError";
  }
}

export interface SendPayload {
  name: string;
  data?: unknown;
  id?: string;
  ts?: number;
  /**
   * The tenant the event belongs to. SST sends it as the message's `MessageGroupId`,
   * so a tenant with a backlog doesn't hold up the others. Flow control, event IDs and
   * waits are kept apart per tenant. Take it from something you trust, like the
   * signed-in user: EventFlow can't check it.
   */
  tenant?: string;
  v?: string;
}

// SQS's MessageGroupId: letters, digits and punctuation.
const TENANT = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{1,128}$/;
const ID = /^[\x21-\x7e]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Check an event, as `send()` does and as the router does for every message. */
export function checkEvent(input: Partial<WireEvent> & Record<string, unknown>, label = "event") {
  if (!input || typeof input !== "object") throw new TypeError(`The ${label} isn't an object.`);
  const name = input.name;
  if (typeof name !== "string" || !name) throw new TypeError(`An ${label} needs a name.`);
  if (name.length > 256 || CONTROL.test(name))
    throw new TypeError(`The ${label} name "${name.slice(0, 40)}" must be 1 to 256 characters, with no control characters.`);
  if (input.tenant !== undefined && (typeof input.tenant !== "string" || !TENANT.test(input.tenant)))
    throw new TypeError(
      `The tenant of ${label} "${name}" must be 1 to 128 letters, digits and punctuation, as SQS allows in a MessageGroupId.`,
    );
  if (input.id !== undefined && (typeof input.id !== "string" || !ID.test(input.id)))
    throw new TypeError(`The id of ${label} "${name}" must be 1 to 128 printable characters, with no spaces.`);
  if (input.ts !== undefined && (typeof input.ts !== "number" || !Number.isFinite(input.ts)))
    throw new TypeError(`The ts of ${label} "${name}" must be a number of milliseconds.`);
  if ("user" in input)
    throw new TypeError(
      `The ${label} "${name}" has a "user" field. Inngest v4 removed it, and EventFlow doesn't support it. Put it in "data".`,
    );
}

export function toWireEvent(input: SendPayload, now = Date.now()): WireEvent {
  checkEvent(input as any);
  const event: WireEvent = {
    id: input.id ?? ulid(now),
    name: input.name,
    data: input.data ?? {},
    ts: input.ts ?? now,
    ...(input.v ? { v: input.v } : {}),
    ...(input.tenant ? { tenant: input.tenant } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(event));
  if (bytes > MAX_EVENT_BYTES)
    throw new TypeError(
      `The event "${input.name}" is ${bytes} bytes. The most is ${MAX_EVENT_BYTES}. Store large data in a bucket and send its key.`,
    );
  return event;
}

function findResource(): EngineResource {
  const fromEnv = process.env[ENV_RESOURCE];
  if (fromEnv) return JSON.parse(fromEnv);

  const linked = Object.entries(Resource as Record<string, any>).filter(
    ([, value]) => value && typeof value === "object" && value.type === "sst.aws.EventFlow",
  );
  if (linked.length === 1) return linked[0][1];
  if (linked.length === 0)
    throw new Error(`No EventFlow is linked to this function. Link it in sst.config.ts, like "link: [flow]".`);
  throw new Error(
    `This function is linked to ${linked.length} EventFlows (${linked
      .map(([name]) => name)
      .join(", ")}). Pass the one to use, like "new EventFlow({ id, resource: Resource.${linked[0][0]} })".`,
  );
}

void sign;
