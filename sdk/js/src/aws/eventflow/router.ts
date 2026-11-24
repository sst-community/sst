import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { cronMatches, localMinute } from "./cron.js";
import { matchesTrigger, type Definition } from "./definition.js";
import { checkEvent, DEDUP_MS, type Engine } from "./engine.js";
import { getPath } from "./expression.js";
import { hash, key, runId as makeRunId } from "./ids.js";
import { sign, verify } from "./sign.js";
import type { Admission } from "./store.js";
import type { Message, RunPayload, WireEvent } from "./types.js";
import { eventMatches, MESSAGE_TTL_MS, RECENT_MS, recentKey, STOP, waitKey, type InvokeOutcome, type Registered } from "./worker.js";

// The router reads the engine's queue. For each event it resolves the waits that
// match it, and starts a run of each function it triggers. It also gets the tick of
// the engine's schedule each minute, and starts the cron functions that are due.
//
// It's the only way into the worker. It checks every message: an event must be
// well formed, and its tenant must be its message group; a held or invoked run must
// be signed. What it starts, it signs.

const log = (message: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ level: "info", message, ...fields }));
const warn = (message: string, fields: Record<string, unknown>) =>
  console.warn(JSON.stringify({ level: "warn", message, ...fields }));

/** A message the router won't ever route. It's dropped, not retried. */
class Rejected extends Error {}

export async function routeBatch(
  sqsEvent: SQSEvent,
  registry: Map<string, Registered>,
  engine: Engine,
): Promise<SQSBatchResponse> {
  const results = await Promise.allSettled(sqsEvent.Records.map((record) => routeRecord(record, registry, engine)));
  const batchItemFailures: SQSBatchItemFailure[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") return;
    const record = sqsEvent.Records[i];
    if (result.reason instanceof Rejected) {
      warn("Dropped a message that isn't valid", { messageId: record.messageId, reason: result.reason.message });
      return;
    }
    console.error(
      JSON.stringify({
        level: "error",
        message: "Failed to route a message. It will be retried.",
        messageId: record.messageId,
        receiveCount: record.attributes.ApproximateReceiveCount,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }),
    );
    batchItemFailures.push({ itemIdentifier: record.messageId });
  });
  return { batchItemFailures };
}

function parse(record: SQSRecord): Message {
  let message: any;
  try {
    message = JSON.parse(record.body);
  } catch {
    throw new Rejected("The body isn't JSON.");
  }
  if (!message || typeof message !== "object") throw new Rejected("The body isn't a message.");
  try {
    checkEvent(message.event ?? {}, "event");
  } catch (error) {
    throw new Rejected((error as Error).message);
  }
  if (typeof message.event.id !== "string") throw new Rejected("The event has no ID.");
  const group = record.attributes.MessageGroupId;
  if (message.kind === "event") {
    // The tenant is the message group, so fair queues and flow control agree on who
    // the event belongs to.
    if ((message.event.tenant ?? undefined) !== (group ?? undefined))
      throw new Rejected("The event's tenant isn't its message group.");
    return { kind: "event", event: message.event };
  }
  if (message.kind === "start" || message.kind === "invoke") {
    if (!verify(message)) throw new Rejected(`The ${message.kind} message isn't signed by this EventFlow.`);
    // A signed message is good for a while, so one that's copied can't be sent again
    // later.
    if (typeof message.exp !== "number" || message.exp < Date.now())
      throw new Rejected(`The ${message.kind} message expired.`);
    return message as Message;
  }
  throw new Rejected(`Unknown message kind "${String(message.kind).slice(0, 20)}".`);
}

async function routeRecord(record: SQSRecord, registry: Map<string, Registered>, engine: Engine) {
  const message = parse(record);
  if (message.kind === "start" || message.kind === "invoke") {
    const entry = registry.get(message.fn);
    if (!entry) {
      warn("Skipped a run of a function that's gone", { fn: message.fn });
      if (message.parent)
        await notifyParent(engine, message.parent, { name: "InvokeError", message: `The function "${message.fn}" isn't served.` });
      return;
    }
    return startRun(entry.def, message.event, engine, {
      parent: message.parent,
      runId: message.runId,
      root: message.root,
    });
  }

  const event = message.event;
  // When the event was sent, so a delivery that's retried later doesn't match waits
  // that started after it.
  const receivedAt = Number(record.attributes.SentTimestamp) || Date.now();

  // An event ID is used once per tenant in 24 hours. The same message delivered
  // again, or a message whose routing didn't finish, is routed again, since starting
  // a run and resolving a wait are both safe to repeat.
  const item = key("E", event.tenant ?? null, event.id);
  const seen = await engine.store.beginEvent(item, record.messageId, DEDUP_MS);
  if (seen === "duplicate") return log("Skipped an event whose ID was already sent", { id: event.id });

  await resolveWaits(event, receivedAt, engine);

  const matched = [...registry.values()].filter((r) => matchesTrigger(r.def, event));
  // Start them one by one, so a failure part way through retries the rest, and the
  // ones that started are found by name.
  for (const { def } of matched) await startRun(def, event, engine);
  await engine.store.finishEvent(item, DEDUP_MS);
}

async function notifyParent(engine: Engine, parent: string, error: { name: string; message: string }) {
  await engine.callback(parent, { ok: false, error } satisfies InvokeOutcome);
}

async function resolveWaits(event: WireEvent, receivedAt: number, engine: Engine) {
  const fields = await engine.store.waitFields(event.name, event.tenant);
  if (!fields.length) return;
  await engine.store.putRecent(recentKey(event.name, event.tenant), event, receivedAt, RECENT_MS);
  const now = Date.now();
  for (const field of fields) {
    const raw = field === "*" ? undefined : getPath(event, field.split("."));
    if (field !== "*" && raw === undefined) continue;
    const value = raw === undefined ? undefined : JSON.stringify(raw);
    const k = waitKey(event.name, event.tenant, field, value);
    const waiters = await engine.store.waiters(k, now);
    await Promise.all(
      waiters
        // A wait that started after the event came finds it itself.
        .filter((w) => w.createdAt <= receivedAt)
        .filter((w) => eventMatches(event, field, value, w.condition))
        .map(async (w) => {
          if (w.kind === "cancel" && w.callbackId.startsWith(STOP)) {
            if (await engine.stopRun(w.callbackId.slice(STOP.length))) {
              log("Cancelled a run", { run: w.runId, event: event.id });
              if (w.parent)
                await notifyParent(engine, w.parent, { name: "Cancelled", message: `The run was cancelled by "${event.name}".` });
            }
          } else if (await engine.callback(w.callbackId, event)) {
            log("Resolved a wait for an event", { run: w.runId, event: event.id });
          }
          await engine.store.deleteWaiter(k, w).catch(() => {});
        }),
    );
  }
}

/**
 * Start a run of a function for an event, after its rate limit, idempotency key and
 * throttle allow it. What's decided for a function and an event is saved, so a
 * message delivered again gets the same decision, and doesn't take a second slot.
 */
export async function startRun(
  def: Definition,
  event: WireEvent,
  engine: Engine,
  opts: { parent?: string; runId?: string; root?: string; identity?: string } = {},
) {
  const scope = { event };
  const tenant = event.tenant ?? null;
  const id = opts.runId ?? makeRunId(def.id, opts.identity ?? JSON.stringify([tenant, event.id]));
  const item = key("A", def.id, id);
  const now = Date.now();

  let admission = await engine.store.getAdmission(item);
  if (!admission) {
    let decided: Admission = { decision: "start" };
    // A limit without a key is per tenant.
    const bucket = (kind: string, k: string | undefined) => key("T", def.id, kind, k ?? tenant);
    if (def.rateLimit) {
      const k = def.rateLimit.key?.(scope);
      if ((await engine.store.take(bucket("rl", k), def.rateLimit.intervalMs, def.rateLimit.toleranceMs)) > 0)
        decided = { decision: "skip", reason: "rateLimit" };
    }
    if (decided.decision === "start" && def.idempotency) {
      const k = def.idempotency(scope);
      if (k !== undefined && !(await engine.store.claim(key("I", def.id, tenant, k), id, DEDUP_MS)))
        decided = { decision: "skip", reason: "idempotency" };
    }
    if (decided.decision === "start" && def.throttle) {
      // Each held run takes its own slot, so they come back one at a time, in order.
      const k = def.throttle.key?.(scope);
      const at = await engine.store.reserve(bucket("th", k), def.throttle.intervalMs, def.throttle.toleranceMs);
      if (at > now + 1000) decided = { decision: "hold", at };
    }
    const ttl = DEDUP_MS + (decided.decision === "hold" ? decided.at - now : 0);
    admission = await engine.store.putAdmission(item, decided, ttl);
  }

  if (admission.decision === "skip") {
    log(admission.reason === "rateLimit" ? "Skipped a run over the rate limit" : "Skipped a run with an idempotency key already used", {
      fn: def.id,
      event: hash(event.id, 10),
    });
    if (opts.parent)
      await notifyParent(engine, opts.parent, { name: "InvokeError", message: `The run was skipped by its ${admission.reason}.` });
    return;
  }

  if (admission.decision === "hold" && admission.at > Date.now() + 1000) {
    // Hold the run: send it back to the queue, to come again when it's due. A queue
    // delays a message at most 15 minutes, so a longer wait comes back more than once.
    await engine.sendMessages([
      {
        message: sign({
          kind: "start" as const,
          fn: def.id,
          event,
          at: admission.at,
          // The run keeps its ID and root when it comes back, so it's the same run.
          runId: id,
          root: opts.root ?? id,
          exp: admission.at + MESSAGE_TTL_MS,
          ...(opts.parent ? { parent: opts.parent } : {}),
        }),
        group: event.tenant ?? `t-${hash(def.id, 10)}`,
        delaySeconds: Math.min(900, Math.ceil((admission.at - Date.now()) / 1000)),
      },
    ]);
    return;
  }

  const payload: RunPayload = {
    "sst:eventflow": 1,
    fn: def.id,
    runId: id,
    root: opts.root ?? id,
    event,
    ...(opts.parent ? { parent: opts.parent } : {}),
  };
  await engine.startRun(payload);
}

/**
 * The schedule's tick, once a minute. `time` is when it was due.
 */
export async function tick(time: string, registry: Map<string, Registered>, engine: Engine) {
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) throw new Error(`The tick has no time: "${time}".`);
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const due = [...registry.values()].flatMap(({ def }) =>
    def.triggers.flatMap((t) => (t.kind === "cron" && cronMatches(t.cron, minute) ? [{ def, cron: t.cron }] : [])),
  );
  // Two crons of one function that fire in the same minute start one run.
  const unique = new Map(due.map((d) => [d.def.id, d]));
  const results = await Promise.allSettled(
    [...unique.values()].map(({ def, cron }) => {
      // The run is named after the minute on the cron's clock, so an hour that repeats
      // when the clocks go back starts its run once.
      const identity = `cron\n${cron.timezone}\n${localMinute(cron, minute)}`;
      const event: WireEvent = {
        id: hash(`${def.id}\n${identity}`),
        name: "inngest/scheduled.timer",
        data: { cron: cron.expression },
        ts: minute.getTime(),
      };
      return startRun(def, event, engine, { identity });
    }),
  );
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  if (failed.length) {
    // The schedule retries the tick, and the runs that started are found by name.
    throw new Error(
      `Failed to start ${failed.length} cron runs: ${failed.map((f) => String(f.reason?.message ?? f.reason)).join("; ")}`,
    );
  }
}
