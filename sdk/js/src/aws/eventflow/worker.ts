import * as durable from "@aws/durable-execution-sdk-js";
import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import type { Definition } from "./definition.js";
import { parseDuration, toDurableSeconds, type DurationInput } from "./duration.js";
import { toWireEvent, type Engine, type SendPayload } from "./engine.js";
import { bind, evaluate, getPath, parseExpression, type Expression } from "./expression.js";
import { hash, key, runId as makeRunId } from "./ids.js";
import { sign, verify } from "./sign.js";
import type { LeaseWaiter, Limit } from "./store.js";
import type { RunPayload, WireEvent } from "./types.js";

// The worker runs every function of the engine, in one durable Lambda function.
// A run is one durable execution. Its name is the run ID.

export interface Registered {
  def: Definition;
  handler: (ctx: any) => unknown;
}

/** A function's return, as the run that invoked it gets it. */
export type InvokeOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string } };

export class NonRetriableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as any);
    this.name = "NonRetriableError";
  }
}

export class RetryAfterError extends Error {
  public readonly retryAfter: Date | number | string;
  constructor(message: string, retryAfter: number | string | Date, options?: { cause?: unknown }) {
    super(message, options as any);
    this.name = "RetryAfterError";
    this.retryAfter = retryAfter;
  }
}

/** The error a step throws once it has used up its retries. */
export class StepFailedError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly cause: { name: string; message: string },
  ) {
    super(cause.message);
    this.name = cause.name === "Error" ? "StepError" : cause.name;
  }
}

export class InvokeFailedError extends Error {
  constructor(
    message: string,
    public readonly functionId: string,
  ) {
    super(message);
    this.name = "InvokeError";
  }
}

/** The error name of an at-most-once step that stopped part way. */
export const INTERRUPTED = "StepInterrupted";

function interrupted(id: string) {
  return {
    name: INTERRUPTED,
    message: `The step "${id}" stopped part way, and isn't run again because it's atMostOnce. Its side effect may have happened: check it before you retry the run, with force.`,
  };
}

function isInterruption(error: unknown) {
  return error instanceof durable.StepInterruptedError || /interruption/i.test(String((error as any)?.message ?? ""));
}

/**
 * How long an invoke waits when it has no timeout: the run's timeout, at most 20 days.
 * Longer timers overflow Node's setTimeout, as the local test runner uses.
 */
const DEFAULT_INVOKE_TIMEOUT_MS = 20 * 86_400_000;

/**
 * How long a signed message in the queue is good for: longer than the dead-letter
 * queue keeps it, so one moved back after a fix still runs.
 */
export const MESSAGE_TTL_MS = 15 * 86_400_000;

/** The longest durable wait AWS allows: 366 days. */
export const MAX_WAIT_S = 31_622_400;
/**
 * How long a step waits for a lease before it asks again, in case a wake was lost: 3
 * minutes, longer the more it asks, up to 15. Each time is 3 operations in the run's
 * history, so a step that waits a day in line adds about 300, not 1,500.
 */
export function leaseWaitSeconds(round: number) {
  return Math.min(900, 180 * 2 ** Math.floor(round / 2));
}
/** A waiter whose callback is this, followed by a run's ARN, stops the run. */
export const STOP = "stop:";
/** How long a received event is kept for a wait that registers just after it. */
export const RECENT_MS = 3_600_000;
/** The largest `if` a wait or cancelOn keeps, with the run's values in it. */
const MAX_CONDITION_BYTES = 16 * 1024;

const json = {
  serialize: async (value: unknown) => (value === undefined ? undefined : JSON.stringify(value)),
  deserialize: async (data: string | undefined) => (data === undefined || data === "" ? null : JSON.parse(data)),
};

// Step results are JSON, as they are with Inngest: a Date becomes a string, and
// undefined becomes null.
function jsonify(value: unknown) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

export function errorInfo(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

// Exponential backoff, from 2 seconds, doubling to at most 10 minutes. The jitter
// comes from the run and step, so a replay gets the same delay.
export function backoffMs(attempt: number, seed: string) {
  const base = Math.min(600_000, 2000 * 2 ** (attempt - 1));
  // From the seed's hash, as a number from 0 to 1.
  const jitter = createHash("sha256").update(seed).digest().readUInt32BE(0) / 2 ** 32;
  return Math.round(base * (0.5 + jitter / 2));
}

function retryDelay(error: unknown, attempt: number, retries: number, seed: string) {
  if (error instanceof NonRetriableError || (error as any)?.name === "NonRetriableError") return undefined;
  if (attempt > retries) return undefined;
  let delay = backoffMs(attempt, seed);
  if (error instanceof RetryAfterError) {
    const at = error.retryAfter;
    if (at instanceof Date) delay = at.getTime() - Date.now();
    else if (typeof at === "number") delay = at;
    else {
      const date = Date.parse(at);
      delay = Number.isNaN(date) ? parseDuration(at, "retryAfter") : date - Date.now();
    }
  }
  return Math.min(Math.max(1000, delay), MAX_WAIT_S * 1000);
}

type StepInput = string | { id: string; name?: string; atMostOnce?: boolean };

function stepId(input: StepInput) {
  const id = typeof input === "string" ? input : input?.id;
  if (typeof id !== "string" || !id) throw new TypeError("A step needs an ID.");
  return id;
}

function atMostOnce(input: StepInput) {
  return typeof input === "object" && input?.atMostOnce === true;
}

/** The subtype of an at-most-once step, so a retry can see it in the history. */
export const ONCE = "EventFlowOnce";

/** The key of the step that's running, for `idempotencyKey()`. */
const stepKeys = new AsyncLocalStorage<{ key: string }>();

/**
 * A key for a step's side effect, like a payment provider's idempotency key. It comes
 * from the run's root, which a retry or replay of the run keeps, the function or
 * onFailure, and the step's ID with its occurrence, like "charge:2" in a loop. So it's
 * the same in every attempt, retry and replay of that step, and different for every
 * other step, occurrence and run.
 */
export function idempotencyKey(root: string, namespace: string, stepId: string) {
  return `ef_${hash(JSON.stringify([root, namespace, stepId]), 26)}`;
}

function unsupported(name: string) {
  return () => {
    throw new TypeError(`${name} isn't supported by EventFlow.`);
  };
}

const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) =>
  console[level](JSON.stringify({ level, message, ...fields }));

interface RunState {
  ctx: durable.DurableContext;
  engine: Engine;
  def: Definition;
  registry: Map<string, Registered>;
  runId: string;
  event: WireEvent;
  memo: Record<string, unknown>;
  counts: Map<string, number>;
  /**
   * The run this one started from: a retry or a replay of a run has the same root,
   * and an invoked run's root comes from its parent's root and step. It's signed in
   * the payload, and idempotency keys and sent event IDs come from it.
   */
  root: string;
  /** "" for the function, "onFailure" for its onFailure, so their keys differ. */
  namespace: string;
}

// Inngest gives a step ID used more than once the suffixes ":1", ":2", and so on.
// It's done here too, so IDs that are built in a loop stay distinct in the history.
function occurrence(state: RunState, id: string) {
  const n = state.counts.get(id) ?? 0;
  state.counts.set(id, n + 1);
  return n === 0 ? id : `${id}:${n}`;
}

// A DurablePromise starts when it's awaited. Start it now, as Inngest does, so a step
// that isn't awaited still runs, and steps started together run together.
function eager<T>(promise: PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(() => promise);
}

/** A tenant, or a key value, as a short string that's safe as a map key. */
function shortTenant(value: string) {
  return value.length <= 64 ? value : `#${hash(value, 20)}`;
}

/**
 * The tenant of a run, for fair shares: the event's tenant, or the value of the
 * function's first concurrency key.
 */
export function tenantOf(def: Definition, event: WireEvent) {
  if (event.tenant) return event.tenant;
  const keyed = def.concurrency.find((c) => c.key);
  const value = keyed?.key?.({ event });
  return value === undefined ? "" : shortTenant(value);
}

export function limitsFor(def: Definition, event: WireEvent): Limit[] {
  return def.concurrency.map((c) => {
    const value = c.key ? (c.key({ event }) ?? null) : undefined;
    if (c.scope === "fn") {
      const label = value === undefined ? `fn:${def.id}` : `fn:${def.id}:${value}`;
      return { item: key("C", "fn", def.id, value ?? null), limit: c.limit, label };
    }
    return { item: key("C", c.scope, value), limit: c.limit, label: `${c.scope}:${value}` };
  });
}

function makeStep(state: RunState) {
  const { ctx, engine, def } = state;
  const limits = limitsFor(def, state.event);
  const tenant = tenantOf(def, state.event);

  // A wait can't outlast the run, or AWS's longest wait. Say so, instead of the
  // checkpoint error AWS gives.
  const maxWaitMs = Math.min(MAX_WAIT_S, engine.resource.runTimeoutSeconds ?? MAX_WAIT_S) * 1000;
  const bounded = (ms: number, what: string) => {
    if (ms > maxWaitMs)
      throw new TypeError(
        `The ${what} is ${Math.round(ms / 1000)}s, longer than a run can last (${maxWaitMs / 1000}s). Raise timeout.execution on the EventFlow, up to 366 days.`,
      );
    return toDurableSeconds(ms);
  };

  // A retry passes the results of the steps that succeeded. They aren't run again.
  const memo = (id: string): { hit: true; value: any } | { hit: false } =>
    Object.prototype.hasOwnProperty.call(state.memo, id) ? { hit: true, value: state.memo[id] } : { hit: false };

  const leaseMs = () => Math.max(30_000, (ctx.lambdaContext?.getRemainingTimeInMillis?.() ?? 900_000) + 10_000);
  const wake = (w: LeaseWaiter) => engine.callback(w.callbackId, { leaseId: w.leaseId });

  // Give back a step's leases, and hand them to the steps in line. An error here
  // mustn't fail the step, which would run its code again: the leases expire.
  const giveBack = async (leaseId: string) => {
    try {
      // Straight to the next step in line, where there's one.
      await engine.store.handoff(limits, leaseId, tenant, wake);
    } catch (error) {
      log("warn", "Failed to give back a lease. It expires on its own.", { run: state.runId, error: errorInfo(error).message });
    }
  };

  // Take a lease on every limit at once, or wait in line until a release can give the
  // step all of them. A step never holds one lease while it waits for another, so two
  // steps can't wait for each other.
  // `place.joined` is when the step first joined the line, so asking again, or after
  // a lease was lost, keeps its place. It comes from a step's result, so a replay has
  // the same.
  const takeLeases = async (child: durable.DurableContext, leaseId: string, tag: string, place: { joined?: number }) => {
    for (let round = 0; ; round++) {
      const t = `${tag}.${round}`;
      const got = await child.step(`lease:${t}`, async () => {
        const result = await engine.store.acquire(limits, leaseId, tenant, leaseMs()).catch((error) => {
          log("warn", "Failed to ask for a lease. Joining the line.", { run: state.runId, error: errorInfo(error).message });
          return "full" as const;
        });
        return result === "granted";
      });
      if (got) return;
      const [woken, callbackId] = await child.createCallback<{ leaseId: string }>(`queued:${t}`, {
        timeout: { seconds: leaseWaitSeconds(round) },
        serdes: json as any,
      });
      // Join the line, then hand out what's free: the leases may have freed up in
      // between. If they're the step's, it goes on without waiting.
      const queued = await child.step(`enqueue:${t}`, async () => {
        const at = place.joined ?? Date.now();
        const result = await engine.store.enqueue({
          leaseId,
          limits,
          tenant,
          callbackId,
          runId: state.runId,
          at,
          expiresAt: Date.now() + leaseWaitSeconds(round) * 1000,
        });
        if (result === "held") return { mine: true, at };
        let mine = false;
        for (const limit of limits)
          await engine.store.dispatch(limit, async (w) => {
            if (w.callbackId !== callbackId) return wake(w);
            mine = true;
            return true;
          });
        return { mine, at };
      });
      place.joined = queued.at;
      if (queued.mine) return;
      try {
        await woken;
        return;
      } catch (error) {
        // Not woken in time: ask again, keeping its place. If the old callback is
        // woken later, the wake fails, and the leases are handed on.
        if (error instanceof durable.CallbackTimeoutError) continue;
        throw error;
      }
    }
  };

  // The key of a step's side effect, for idempotencyKey() called in the step.
  const keyFor = (id: string) => idempotencyKey(state.root, state.namespace, id);
  const inStep = <T>(id: string, fn: () => T | Promise<T>) => stepKeys.run({ key: keyFor(id) }, fn);

  const run = <T>(idInput: StepInput, fn: (...args: any[]) => T | Promise<T>, ...args: any[]): Promise<T> => {
    const id = occurrence(state, stepId(idInput));
    const saved = memo(id);
    if (saved.hit) return Promise.resolve(saved.value as T);
    // At most once: AWS saves that the step started before it runs. If the worker
    // stops part way, the step fails instead of running again. It isn't retried.
    const once = atMostOnce(idInput);
    if (!limits.length) {
      if (once)
        return eager(
          ctx.step(id, async () => jsonify(await inStep(id, () => fn(...args))), {
            semantics: durable.StepSemantics.AtMostOncePerRetry,
            retryStrategy: () => ({ shouldRetry: false }),
            subType: ONCE,
          }),
        ).catch((error) => {
          throw isInterruption(error) ? new StepFailedError(id, interrupted(id)) : error;
        }) as Promise<T>;
      return eager(
        ctx.step(id, async () => jsonify(await inStep(id, () => fn(...args))), {
          retryStrategy: (error, attempt) => {
            const delay = retryDelay(error, attempt, def.retries, `${state.runId}\n${id}\n${attempt}`);
            return delay === undefined ? { shouldRetry: false } : { shouldRetry: true, delay: toDurableSeconds(delay) };
          },
        }),
      ) as Promise<T>;
    }

    // With a concurrency limit, each attempt takes its leases first, and gives them
    // back when it ends. A step that waits for a lease, or for its next attempt, holds
    // none, as with Inngest.
    return eager(
      ctx.runInChildContext(
        id,
        async (child) => {
          for (let attempt = 1; ; attempt++) {
            // A lost lease keeps the step's place in line; a retry joins it again.
            const place: { joined?: number } = {};
            for (let lost = 0; ; lost++) {
              // The lease's ID comes from the run, the step and the attempt, so a lease
              // step that's retried asks for the same lease.
              const leaseId = `${hash(`${state.runId}\n${id}`, 12)}.${attempt}.${lost}`;
              await takeLeases(child, leaseId, `${attempt}.${lost}`, place);
              const outcome = await child.step(
                attempt === 1 && lost === 0 ? "run" : `run:${attempt}.${lost}`,
                async () => {
                  // After a crash, the run step runs again, maybe after its leases
                  // expired. Check they're still held before the work starts.
                  // One that can't be checked, as when DynamoDB keeps failing, counts as
                  // lost: the step takes a new one, and its code hasn't run.
                  const held = await engine.store.renew(limits, leaseId, leaseMs()).catch((error) => {
                    log("warn", "Failed to renew a lease. Taking a new one.", { run: state.runId, error: errorInfo(error).message });
                    return false;
                  });
                  if (!held) return { lost: true as const };
                  try {
                    return { ok: true as const, value: jsonify(await inStep(id, () => fn(...args))) };
                  } catch (error) {
                    const delay = once ? undefined : retryDelay(error, attempt, def.retries, `${state.runId}\n${id}\n${attempt}`);
                    return { ok: false as const, error: errorInfo(error), delay };
                  } finally {
                    await giveBack(leaseId);
                  }
                },
                {
                  retryStrategy: () => ({ shouldRetry: false }),
                  ...(once ? { semantics: durable.StepSemantics.AtMostOncePerRetry, subType: ONCE } : {}),
                },
              ).then(
                (o) => o,
                // An at-most-once step that the worker stopped part way fails here.
                (error) => ({
                  ok: false as const,
                  error: isInterruption(error) ? interrupted(id) : errorInfo(error),
                  delay: undefined,
                }),
              );
              if ("lost" in outcome) {
                // A lease expired before the step ran. Give back the rest.
                await child.step(`release:${attempt}.${lost}`, async () => giveBack(leaseId));
                if (lost >= 5) return { ok: false as const, error: { name: "LeaseError", message: `The step "${id}" kept losing its lease.` } };
                continue;
              }
              if (outcome.ok) return { ok: true as const, value: outcome.value };
              if (outcome.delay === undefined) return { ok: false as const, error: outcome.error };
              await child.wait(`retry:${attempt}`, toDurableSeconds(outcome.delay));
              break;
            }
          }
        },
        { subType: "EventFlowStep" },
      ),
    ).then((outcome) => {
      // An error thrown in a child context comes out as a ChildContextError, so the
      // outcome comes out of it, and the error is thrown here.
      if (!outcome.ok) throw new StepFailedError(id, outcome.error);
      return outcome.value as T;
    });
  };

  const sleep = (idInput: string | { id: string }, duration: DurationInput) => {
    const id = occurrence(state, stepId(idInput));
    if (memo(id).hit) return Promise.resolve();
    const seconds = bounded(parseDuration(duration, `duration of step "${id}"`), `sleep of step "${id}"`);
    return eager(ctx.wait(id, seconds));
  };

  const sleepUntil = (idInput: string | { id: string }, time: Date | string) => {
    const id = occurrence(state, stepId(idInput));
    if (memo(id).hit) return Promise.resolve();
    const at = time instanceof Date ? time.getTime() : Date.parse(time);
    if (!Number.isFinite(at)) throw new TypeError(`The time of step "${id}" isn't a date.`);
    const seconds = bounded(at - Date.now(), `sleep of step "${id}"`);
    return eager(ctx.wait(id, seconds));
  };

  const waitForEvent = (
    idInput: string | { id: string },
    options: { event: string | { name: string }; timeout: DurationInput | Date; match?: string; if?: string },
  ): Promise<WireEvent | null> => {
    const id = occurrence(state, stepId(idInput));
    const saved = memo(id);
    if (saved.hit) return Promise.resolve(saved.value);
    const name = typeof options.event === "string" ? options.event : options.event?.name;
    if (!name) throw new TypeError(`The step "${id}" waits for an event with no name.`);
    if (options.match && options.if) throw new TypeError(`The step "${id}" has both "match" and "if". Use one.`);
    const timeoutMs =
      options.timeout instanceof Date
        ? options.timeout.getTime() - Date.now()
        : parseDuration(options.timeout, `timeout of step "${id}"`);
    const timeout = bounded(timeoutMs, `timeout of step "${id}"`);
    const { field, value, condition } = matcher(id, state.event, options);

    return eager(
      ctx.runInChildContext(
        id,
        async (child) => {
          const [received, callbackId] = await child.createCallback<WireEvent>("event", { timeout, serdes: json as any });
          // The wait may find an event that came while it was registering. Then it uses
          // that event, and doesn't wait for the callback.
          const early = await child.step("listen", async () => {
            const found = await listen(engine, {
              name,
              tenant: state.event.tenant,
              field,
              value,
              condition,
              callbackId,
              runId: state.runId,
              expiresAt: Date.now() + timeoutMs,
              kind: "wait",
            });
            return found.event;
          });
          if (early) return early;
          try {
            return await received;
          } catch (error) {
            if (error instanceof durable.CallbackTimeoutError) return null;
            throw error;
          }
        },
        { subType: "EventFlowWait" },
      ),
    ) as Promise<WireEvent | null>;
  };

  const invoke = (
    idInput: string | { id: string },
    options: { function: { id: string } | { opts?: { id: string } }; data?: unknown; timeout?: DurationInput | Date },
  ) => {
    const id = occurrence(state, stepId(idInput));
    const saved = memo(id);
    if (saved.hit) return Promise.resolve(saved.value);
    const target = (options.function as any)?.id ?? (options.function as any)?.opts?.id;
    if (typeof options.function === "string" || !target)
      throw new TypeError(`The step "${id}" invokes a function by its ID. Pass the function itself, as Inngest v4 does.`);
    if (!state.registry.has(target))
      throw new TypeError(`The step "${id}" invokes "${target}", which isn't served by this EventFlow.`);
    const timeoutMs =
      options.timeout === undefined
        ? undefined
        : options.timeout instanceof Date
          ? options.timeout.getTime() - Date.now()
          : parseDuration(options.timeout, `timeout of step "${id}"`);
    // Without a timeout, the run waits as long as it can last, at most 20 days, so a
    // child that never answers, like one AWS stopped, doesn't keep it waiting forever.
    const timeout = bounded(timeoutMs ?? Math.min(maxWaitMs, DEFAULT_INVOKE_TIMEOUT_MS), `timeout of step "${id}"`);

    return eager(
      ctx.runInChildContext(
        id,
        async (child) => {
          const [result, callbackId] = await child.createCallback<InvokeOutcome>("result", { timeout, serdes: json as any });
          // The invoked run goes through the router, like any other, so its flow
          // control applies. The message is signed, so only a run can send one.
          await child.step("start", async () => {
            // The child run is new for each run that invokes it, as a retry of the
            // parent needs its own. Its root, which its idempotency keys come from,
            // is the same for every retry and replay of the parent.
            const identity = `invoke\n${state.runId}\n${state.namespace}\n${id}`;
            const root = hash(JSON.stringify([state.root, state.namespace, id]), 26);
            const event: WireEvent = {
              id: hash(identity),
              name: "inngest/function.invoked",
              data: options.data ?? {},
              ts: Date.now(),
              ...(state.event.tenant ? { tenant: state.event.tenant } : {}),
            };
            const childRunId = makeRunId(target, identity);
            await engine.sendMessages([
              {
                message: sign({
                  kind: "invoke" as const,
                  fn: target,
                  event,
                  parent: callbackId,
                  runId: childRunId,
                  root,
                  exp: Date.now() + MESSAGE_TTL_MS,
                }),
                group: event.tenant,
              },
            ]);
            // In the history, so a rerun of this run can find the child, and check it.
            return { runId: childRunId };
          });
          try {
            return await result;
          } catch (error) {
            if (error instanceof durable.CallbackTimeoutError)
              return {
                ok: false,
                error: { name: "InvokeError", message: `The function "${target}" didn't finish within the timeout of step "${id}".` },
              } satisfies InvokeOutcome;
            throw error;
          }
        },
        { subType: "EventFlowInvoke" },
      ),
    ).then((outcome: InvokeOutcome) => {
      if (!outcome.ok) throw new InvokeFailedError(outcome.error.message, target);
      return outcome.result;
    });
  };

  const sendEvent = (idInput: string | { id: string }, payload: SendPayload | SendPayload[]) => {
    const id = occurrence(state, stepId(idInput));
    const saved = memo(id);
    if (saved.hit) return Promise.resolve(saved.value as { ids: string[] });
    const list = Array.isArray(payload) ? payload : [payload];
    return eager(
      ctx.step(id, async () => {
        // IDs come from the run's root and the step, so a retried step, and a retry
        // or replay of the run, send the same events, and the router skips the ones
        // it has seen.
        const events = list.map((p, i) =>
          toWireEvent({
            ...p,
            id: p.id ?? hash(JSON.stringify([state.root, state.namespace, id, i]), 26),
            tenant: p.tenant ?? state.event.tenant,
          }),
        );
        await engine.sendEvents(events);
        return { ids: events.map((e) => e.id) };
      }),
    );
  };

  return {
    run,
    sleep,
    sleepUntil,
    waitForEvent,
    invoke,
    sendEvent,
    get fetch() {
      return unsupported("step.fetch")();
    },
    get ai() {
      return unsupported("step.ai")();
    },
    get waitForSignal() {
      return unsupported("step.waitForSignal")();
    },
    get sendSignal() {
      return unsupported("step.sendSignal")();
    },
    get realtime() {
      return unsupported("step.realtime")();
    },
  };
}

// How a wait finds its event. `match: "data.userId"` matches an event with the same
// value at that path. An `if` with `async.<path> == event.<path>` matches on that
// path too, and the rest of the `if` is checked when the event comes.
export function matcher(
  stepId: string,
  event: WireEvent,
  options: { match?: string; if?: string },
): { field: string; value?: string; condition?: Expression } {
  if (options.match) {
    const path = options.match.replace(/^(event|async)\./, "");
    const value = getPath(event, path.split("."));
    if (value === undefined)
      throw new TypeError(`The step "${stepId}" matches on "${path}", which the run's event doesn't have.`);
    return { field: path, value: JSON.stringify(value) };
  }
  if (options.if) {
    const parsed = parseExpression(options.if, `"if" of step "${stepId}"`);
    // A path of the run's event that it doesn't have would compare as null, and match
    // any event that sends null. Say so instead.
    for (const c of parsed.clauses)
      for (const o of [c.left, c.right])
        if (o?.kind === "path" && o.path[0] === "event" && getPath(event, o.path.slice(1)) === undefined)
          throw new TypeError(`The "if" of step "${stepId}" uses "${o.path.join(".")}", which the run's event doesn't have.`);
    const expr = bind(parsed, "event", event);
    if (Buffer.byteLength(JSON.stringify(expr)) > MAX_CONDITION_BYTES)
      throw new TypeError(`The "if" of step "${stepId}" is over ${MAX_CONDITION_BYTES} bytes with the run's values in it.`);
    for (const c of expr.clauses) {
      if (c.op !== "==" || !c.right) continue;
      const [path, literal] =
        c.left.kind === "path" && c.left.path[0] === "async" && c.right.kind === "literal"
          ? [c.left.path, c.right.value]
          : c.right.kind === "path" && c.right.path[0] === "async" && c.left.kind === "literal"
            ? [c.right.path, c.left.value]
            : [undefined, undefined];
      if (path) return { field: path.slice(1).join("."), value: JSON.stringify(literal), condition: expr };
    }
    return { field: "*", condition: expr };
  }
  return { field: "*" };
}

export function waitKey(name: string, tenant: string | undefined, field: string, value?: string) {
  return key("W", name, tenant ?? null, field, value ?? null);
}

export function recentKey(name: string, tenant: string | undefined) {
  return key("R", name, tenant ?? null);
}

// Registering a wait and routing an event each write first and read second:
//
//   wait:   add the field, note the time T, add the waiter, read events since T
//   router: note the time R, read the fields, store the event, read the waiters
//
// So for an event with R >= T, at least one of them sees the other. If the router
// sees the waiter, it resolves the callback. If the wait sees the event, it uses it
// and doesn't wait for the callback. An event with R < T came before the wait
// started, and isn't matched. When both see each other, the run goes on with the
// event the wait found, and the callback is left to time out.
async function listen(
  engine: Engine,
  input: {
    name: string;
    tenant?: string;
    field: string;
    value?: string;
    condition?: Expression;
    callbackId: string;
    runId: string;
    expiresAt: number;
    kind: "wait" | "cancel";
    parent?: string;
  },
): Promise<{ event: WireEvent | null; registered: { key: string; createdAt: number; callbackId: string } }> {
  await engine.store.addWaitField(input.name, input.tenant, input.field, input.expiresAt);
  const createdAt = Date.now();
  const k = waitKey(input.name, input.tenant, input.field, input.value);
  const waiter = {
    callbackId: input.callbackId,
    runId: input.runId,
    createdAt,
    expiresAt: input.expiresAt,
    condition: input.condition ? JSON.stringify(input.condition) : undefined,
    kind: input.kind,
    parent: input.parent,
    info: { name: input.name, tenant: input.tenant, field: input.field },
  };
  await engine.store.putWaiter(k, waiter);
  const registered = { key: k, createdAt, callbackId: input.callbackId };
  const recent = await engine.store.recent(recentKey(input.name, input.tenant), createdAt);
  for (const { event } of recent) {
    if (!eventMatches(event, input.field, input.value, waiter.condition)) continue;
    await engine.store.deleteWaiter(k, waiter).catch(() => {});
    return { event, registered };
  }
  return { event: null, registered };
}

export function eventMatches(event: WireEvent, field: string, value?: string, condition?: string) {
  if (field !== "*") {
    const actual = getPath(event, field.split("."));
    if (actual === undefined || JSON.stringify(actual) !== value) return false;
  }
  if (condition) {
    try {
      return evaluate(JSON.parse(condition) as Expression, { async: event });
    } catch {
      return false;
    }
  }
  return true;
}

function runIdFromArn(arn: string) {
  return arn.match(/\/durable-execution\/([^/]+)\//)?.[1];
}

/**
 * The durable handler: start the function named in the payload.
 */
export function createWorker(registry: Map<string, Registered>, getEngine: () => Engine) {
  return durable.withDurableExecution(async (payload: RunPayload, ctx: durable.DurableContext) => {
    // Only the router and the worker can sign a run. A payload from anything else, like
    // a direct invoke, is refused before any of it is used.
    if (!payload || payload["sst:eventflow"] !== 1 || !verify(payload))
      throw new NonRetriableError("The EventFlow worker only runs what its router starts.");
    const entry = registry.get(payload.fn);
    const engine = getEngine();
    if (!entry) {
      const message = `The function "${payload.fn}" isn't served by this version of the worker. Was it removed or renamed?`;
      // The run that invoked it would otherwise wait for it.
      if (payload.parent)
        await ctx.step("sst:return", async () => {
          await engine.callback(payload.parent!, { ok: false, error: { name: "InvokeError", message } } satisfies InvokeOutcome);
        });
      throw new NonRetriableError(message);
    }

    const state: RunState = {
      ctx,
      engine,
      def: entry.def,
      registry,
      runId: runIdFromArn(ctx.executionContext.durableExecutionArn) ?? payload.runId,
      event: payload.event,
      memo: Object.assign(Object.create(null), payload.memo ?? {}),
      // The root is signed with the payload. A payload from before roots is its own.
      root: payload.root ?? payload.runId,
      namespace: "",
      counts: new Map(),
    };

    const makeArgs = (forState: RunState, extra: Record<string, unknown> = {}) => {
      const args: Record<string, unknown> = {
        event: payload.event,
        events: [payload.event],
        step: makeStep(forState),
        group: { parallel: <T>(fn: () => Promise<T>) => fn() },
        runId: state.runId,
        logger: forState.ctx.logger,
        ...extra,
      };
      // Each step is tried at most this many times, as with Inngest.
      args.maxAttempts = entry.def.retries + 1;
      // The key of the step that's running, for its side effect.
      args.idempotencyKey = (...given: unknown[]) => {
        if (given.length)
          throw new TypeError(
            "Call idempotencyKey() with no arguments, inside step.run: it's the key of that step, the same in every attempt, retry and replay.",
          );
        const current = stepKeys.getStore();
        if (!current) throw new TypeError("Call idempotencyKey() inside step.run: it's the key of that step.");
        return current.key;
      };
      // What EventFlow can't give throws when it's read, instead of being undefined.
      const missing: Record<string, string> = {
        attempt: "EventFlow doesn't have `attempt` in the function's context. Each step retries on its own.",
        defer: "EventFlow doesn't support `defer`.",
        sessions: "EventFlow doesn't support `sessions`.",
      };
      for (const [name, message] of Object.entries(missing))
        Object.defineProperty(args, name, {
          enumerable: false,
          get() {
            throw new TypeError(message);
          },
        });
      return args;
    };

    // Listen for the events that cancel the run, before it does anything else.
    const cancelKeys = entry.def.cancelOn.length
      ? await ctx.step("sst:cancelOn", async () => {
          const arn = ctx.executionContext.durableExecutionArn;
          const keys: { key: string; createdAt: number; callbackId: string }[] = [];
          for (const c of entry.def.cancelOn) {
            const { field, value, condition } = matcher("cancelOn", payload.event, c);
            const expiresAt = Date.now() + (c.timeoutMs ?? (engine.resource.runTimeoutSeconds ?? MAX_WAIT_S) * 1000);
            const found = await listen(engine, {
              name: c.name,
              tenant: payload.event.tenant,
              field,
              value,
              condition,
              callbackId: `${STOP}${arn}`,
              runId: state.runId,
              expiresAt,
              kind: "cancel",
              parent: payload.parent,
            });
            keys.push(found.registered);
            // An event that came as it registered cancels it now.
            if (found.event) await engine.stopRun(arn);
          }
          return keys;
        })
      : [];

    const stopListening = async () => {
      if (!cancelKeys.length) return;
      await ctx.step("sst:cancelOn:end", async () => {
        await Promise.all(cancelKeys.map((k) => engine.store.deleteWaiter(k.key, k).catch(() => {})));
      });
    };

    // Tell the run that invoked this one how it ended. A run that's gone is fine; any
    // other error is retried, so the result isn't lost.
    const finish = async (outcome: InvokeOutcome) => {
      if (!payload.parent) return;
      await ctx.step("sst:return", async () => {
        await engine.callback(payload.parent!, outcome);
      });
    };

    let result: unknown;
    try {
      result = await entry.handler(makeArgs(state));
    } catch (error) {
      if (isDurableInternal(error)) throw error;
      try {
        if (entry.def.onFailure) {
          await ctx.runInChildContext("onFailure", async (child) => {
            const failure: RunState = { ...state, ctx: child, counts: new Map(), memo: Object.create(null), namespace: "onFailure" };
            const ts = await child.step("sst:failed-at", async () => Date.now());
            await entry.def.onFailure!(
              makeArgs(failure, {
                error,
                event: {
                  id: hash(`failed\n${state.runId}`),
                  name: "inngest/function.failed",
                  data: { event: payload.event, error: errorInfo(error), function_id: entry.def.id, run_id: state.runId },
                  ts,
                },
              }),
            );
          });
        }
      } catch (failure) {
        if (isDurableInternal(failure)) throw failure;
        log("error", "onFailure failed", { run: state.runId, error: errorInfo(failure).message });
      } finally {
        await stopListening();
        await finish({ ok: false, error: errorInfo(error) });
      }
      throw error;
    }
    const value = jsonify(result);
    await stopListening();
    await finish({ ok: true, result: value });
    return value;
  });
}

function isDurableInternal(error: unknown) {
  const name = (error as any)?.constructor?.name ?? "";
  return /Unrecoverable|NonDeterministic|Termination/.test(name);
}
