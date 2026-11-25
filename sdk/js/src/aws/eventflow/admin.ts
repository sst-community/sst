import { sqs } from "./aws.js";
import { toWireEvent, type Engine, type SendPayload } from "./engine.js";
import type { Definition } from "./definition.js";
import { cancelAll, cancelRun, getRun, listRuns, rerun, rerunAll, type ListInput } from "./runs.js";
import { parseLease } from "./store.js";
import type { Registered } from "./worker.js";

// The admin API. The router serves it, to whatever may invoke the router: the
// developer's own credentials, as `sst eventflow` uses, or a function linked to
// `flow.admin`. It's one JSON contract, for the CLI, an app's own page, or a console.
//
// Request:  { "sst:eventflow:admin": { "op": "...", "args": { ... } } }
// Response: { "ok": true, "result": ... } or { "ok": false, "error": { "name", "message" } }

export interface FunctionInfo {
  id: string;
  name: string;
  triggers: ({ event: string; if?: string } | { cron: string; timezone: string } | { invoke: true })[];
  retries: number;
  concurrency: { limit: number; scope: string; key?: string }[];
  throttle?: { perSecond: number; burst: number };
  rateLimit?: { perSecond: number };
  idempotency: boolean;
  cancelOn: { event: string; match?: string; if?: string }[];
}

export interface QueueInfo {
  /** Events waiting to be routed, and runs held by a throttle that are due. */
  waiting: number;
  /** Being routed now. */
  inFlight: number;
  /** Runs held by a throttle, not yet due. */
  delayed: number;
  oldestAgeSeconds?: number;
}

export interface Overview {
  functions: number;
  queue: QueueInfo;
  deadLetters: { count: number };
  /** The concurrency limits, and how many of them are full. */
  leases: { limits: number; full: number };
  waits: { waits: number; cancelOns: number };
}

export interface LimitInfo {
  label: string;
  limit?: number;
  active: number;
  queued: number;
  tenants: Record<string, number>;
  leases: { id: string; tenant: string; expiresAt: string }[];
}

export interface WaitInfo {
  kind: "wait" | "cancel";
  event: string;
  tenant?: string;
  field: string;
  run: string;
  createdAt: string;
  expiresAt: string;
}

export interface DeadLetter {
  messageId: string;
  receiveCount: number;
  sentAt?: string;
  kind?: string;
  event?: { id: string; name: string; tenant?: string };
  body?: string;
}

const MAX_SCAN = 5000;

function functionInfo(def: Definition): FunctionInfo {
  return {
    id: def.id,
    name: def.name,
    triggers: def.triggers.map((t) =>
      t.kind === "event"
        ? { event: t.name, ...(t.if ? { if: t.if.source } : {}) }
        : t.kind === "cron"
          ? { cron: t.cron.expression, timezone: t.cron.timezone }
          : { invoke: true as const },
    ),
    retries: def.retries,
    concurrency: def.concurrency.map((c) => ({ limit: c.limit, scope: c.scope, ...(c.keySource ? { key: c.keySource } : {}) })),
    throttle: def.throttle
      ? { perSecond: 1000 / def.throttle.intervalMs, burst: Math.round(def.throttle.toleranceMs / def.throttle.intervalMs) }
      : undefined,
    rateLimit: def.rateLimit ? { perSecond: 1000 / def.rateLimit.intervalMs } : undefined,
    idempotency: Boolean(def.idempotency),
    cancelOn: def.cancelOn.map((c) => ({ event: c.name, ...(c.match ? { match: c.match } : {}), ...(c.if ? { if: c.if } : {}) })),
  };
}

async function queueInfo(engine: Engine, url: string | undefined) {
  if (!url) return undefined;
  const result = await sqs<{ Attributes?: Record<string, string> }>(
    "GetQueueAttributes",
    {
      QueueUrl: url,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ],
    },
    engine.aws,
  );
  const a = result.Attributes ?? {};
  return {
    waiting: Number(a.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

async function limits(engine: Engine): Promise<LimitInfo[]> {
  const found = await engine.store.scan("C#", MAX_SCAN);
  // A limit is an item with its leases, and one for each tenant in its line.
  const byLimit = new Map<string, Record<string, any>>();
  for (const i of found) {
    const l = byLimit.get(String(i.pk)) ?? { queued: 0 };
    if (String(i.sk).startsWith("w#")) l.queued += Math.max(0, Number(i.n ?? 0));
    else Object.assign(l, i);
    byLimit.set(String(i.pk), l);
  }
  const items = [...byLimit.values()].filter((i) => i.leases !== undefined);
  const now = Date.now();
  return items.map((i) => ({
    label: String(i.label ?? i.pk),
    limit: i.cap === undefined ? undefined : Number(i.cap),
    active: Object.values<any>(i.leases).filter((v) => parseLease(String(v)).expires > now).length,
    queued: i.queued,
    tenants: { ...(i.tenants ?? {}) },
    leases: Object.entries<any>(i.leases).map(([id, v]) => {
      const { expires, tenant } = parseLease(String(v));
      return { id, tenant, expiresAt: new Date(expires).toISOString() };
    }),
  }));
}

async function waits(engine: Engine): Promise<WaitInfo[]> {
  const items = await engine.store.scan("W#", MAX_SCAN);
  const now = Date.now();
  return items
    .filter((i) => Number(i.until) > now)
    .map((i) => {
      const info = i.info ? JSON.parse(i.info) : {};
      return {
        kind: i.kind === "cancel" ? ("cancel" as const) : ("wait" as const),
        event: info.name ?? "",
        ...(info.tenant ? { tenant: info.tenant } : {}),
        field: info.field ?? "",
        run: String(i.run),
        createdAt: new Date(Number(i.created)).toISOString(),
        expiresAt: new Date(Number(i.until)).toISOString(),
      };
    });
}

async function deadLetters(engine: Engine, max: number): Promise<DeadLetter[]> {
  const url = engine.resource.deadLetterQueueUrl;
  if (!url) return [];
  // Look without taking them: a visibility timeout of 0 leaves them in the queue.
  const result = await sqs<{ Messages?: any[] }>(
    "ReceiveMessage",
    {
      QueueUrl: url,
      MaxNumberOfMessages: Math.min(Math.max(1, max), 10),
      VisibilityTimeout: 0,
      MessageSystemAttributeNames: ["ApproximateReceiveCount", "SentTimestamp"],
    },
    engine.aws,
  );
  return (result.Messages ?? []).map((m) => {
    let parsed: any;
    try {
      parsed = JSON.parse(m.Body);
    } catch {}
    return {
      messageId: m.MessageId,
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0),
      sentAt: m.Attributes?.SentTimestamp ? new Date(Number(m.Attributes.SentTimestamp)).toISOString() : undefined,
      ...(parsed?.event
        ? {
            kind: String(parsed.kind),
            event: { id: String(parsed.event.id), name: String(parsed.event.name), ...(parsed.event.tenant ? { tenant: parsed.event.tenant } : {}) },
          }
        : { body: String(m.Body).slice(0, 500) }),
    };
  });
}

async function redrive(engine: Engine) {
  const url = engine.resource.deadLetterQueueUrl;
  if (!url) throw new Error("This EventFlow has no dead-letter queue.");
  const attributes = await sqs<{ Attributes?: Record<string, string> }>(
    "GetQueueAttributes",
    { QueueUrl: url, AttributeNames: ["QueueArn"] },
    engine.aws,
  );
  const arn = attributes.Attributes?.QueueArn;
  // With no destination, SQS moves the messages back to the queue they came from.
  const result = await sqs<{ TaskHandle?: string }>("StartMessageMoveTask", { SourceArn: arn }, engine.aws);
  return { taskHandle: result.TaskHandle };
}

export async function handleAdmin(
  request: { op?: unknown; args?: Record<string, any> },
  registry: Map<string, Registered>,
  engine: Engine,
) {
  try {
    const args = request?.args && typeof request.args === "object" ? request.args : {};
    const result = await run(String(request?.op), args, registry, engine);
    return { ok: true as const, result };
  } catch (error) {
    return {
      ok: false as const,
      error: { name: (error as Error).name ?? "Error", message: (error as Error).message ?? String(error) },
    };
  }
}

async function run(op: string, args: Record<string, any>, registry: Map<string, Registered>, engine: Engine) {
  const runId = () => {
    if (typeof args.runId !== "string" || !args.runId) throw new TypeError(`"${op}" needs a runId.`);
    return args.runId as string;
  };
  const list = (): ListInput => ({
    function: typeof args.function === "string" ? args.function : undefined,
    status: typeof args.status === "string" ? (args.status as any) : undefined,
    from: args.from ? new Date(args.from) : undefined,
    to: args.to ? new Date(args.to) : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
  });
  switch (op) {
    case "functions":
      return [...registry.values()].map((r) => functionInfo(r.def));
    case "overview": {
      const [queue, dead, l, w] = await Promise.all([
        queueInfo(engine, engine.resource.queueUrl),
        queueInfo(engine, engine.resource.deadLetterQueueUrl),
        limits(engine),
        waits(engine),
      ]);
      return {
        functions: registry.size,
        queue: queue!,
        deadLetters: { count: (dead?.waiting ?? 0) + (dead?.inFlight ?? 0) },
        leases: {
          limits: l.length,
          full: l.filter((x) => x.limit !== undefined && x.active >= x.limit).length,
        },
        waits: { waits: w.filter((x) => x.kind === "wait").length, cancelOns: w.filter((x) => x.kind === "cancel").length },
      } satisfies Overview;
    }
    case "leases":
      return limits(engine);
    case "waits":
      return waits(engine);
    case "deadLetters.peek":
      return deadLetters(engine, Number(args.max ?? 10));
    case "deadLetters.redrive":
      return redrive(engine);
    case "runs.list":
      return listRuns(engine, list());
    case "runs.get":
      return (await getRun(engine, runId())) ?? null;
    case "runs.cancel":
      return cancelRun(engine, runId());
    case "runs.cancelAll":
      return cancelAll(engine, list());
    case "runs.replay":
      return rerun(engine, runId(), false, { force: args.force === true, again: args.again === true });
    case "runs.retry":
      return rerun(engine, runId(), true, { force: args.force === true, again: args.again === true });
    case "runs.retryAll":
      return rerunAll(engine, { ...list(), reuse: args.mode !== "replay", force: args.force === true });
    case "send": {
      const events = (Array.isArray(args.events) ? args.events : [args.events]).map((e: SendPayload) => toWireEvent(e));
      await engine.sendEvents(events);
      return { ids: events.map((e) => e.id) };
    }
    default:
      throw new TypeError(`Unknown admin operation "${op.slice(0, 40)}".`);
  }
}
