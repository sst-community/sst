import * as durable from "@aws/durable-execution-sdk-js";
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

/** The longest durable wait AWS allows: 366 days. */
export const MAX_WAIT_S = 31_622_400;
/** How long a step waits for a lease before it asks again, in case a wake was lost. */
const LEASE_WAIT_S = 900;
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

function stepId(input: string | { id: string; name?: string }) {
  const id = typeof input === "string" ? input : input?.id;
  if (typeof id !== "string" || !id) throw new TypeError("A step needs an ID.");
  return id;
}

function unsupported(name: string) {
  return () => {
    throw new TypeError(`${name} isn't supported by EventFlow.`);
  };
}

const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) =>
  console[level](JSON.stringify({ level, message, ...fields }));

interface RunState {
  releaseHeld?: () => PromiseLike<unknown> | undefined;
  ctx: durable.DurableContext;
  engine: Engine;
  def: Definition;
  registry: Map<string, Registered>;
  runId: string;
  event: WireEvent;
  memo: Record<string, unknown>;
  counts: Map<string, number>;
  /**
   * A lease the run kept from its last step with a concurrency limit, for its next one.
   * The run gives it back when it sleeps, waits, invokes or ends. So a run's steps one
   * after another don't each wait in line, as Inngest counts a run's steps in one
   * request as one.
   */
  held?: string | null;
  /** Leases of steps that ran together with the one kept, given back with it. */
  extra?: string[];
  /** How many steps with a concurrency limit are running now. */
  inflight?: number;
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

  // Give back a lease, and wake the next waiter. An error here mustn't fail the step,
  // which would run its code again: the lease expires on its own.
  const giveBack = async (leaseId: string) => {
    for (const limit of limits) {
      try {
        await engine.store.release(limit, leaseId, tenant);
        await engine.store.dispatch(limit, leaseMs(), wake);
      } catch (error) {
        log("warn", "Failed to give back a lease. It expires on its own.", { run: state.runId, error: errorInfo(error).message });
      }
    }
  };

  // Give back the lease the run kept, before it stops for a sleep, a wait or an
  // invoke, or ends. It's a step, so a replay gives it back at the same point.
  const releaseHeld = (): PromiseLike<unknown> | undefined => {
    if (!state.held && !state.extra?.length) return undefined;
    const leases = [state.held, ...(state.extra ?? [])].filter((l): l is string => Boolean(l));
    state.held = null;
    state.extra = [];
    return ctx.step(occurrence(state, "sst:release"), async () => {
      for (const leaseId of leases) await giveBack(leaseId);
    });
  };
  state.releaseHeld = releaseHeld;

  // Take a lease on each limit, in order, waiting in line for each that's full. A
  // lease that's held is kept while the step waits for the next one.
  const takeLeases = async (child: durable.DurableContext, leaseId: string, attempt: number) => {
    let n = 0;
    for (const limit of limits) {
      // When the step first joined the line, so asking again keeps its place.
      let joined: number | undefined;
      for (let round = 0; ; round++) {
        const tag = `${attempt}.${n++}`;
        const got = await child.step(`lease:${tag}`, async () =>
          engine.store.acquire(limit, leaseId, tenant, leaseMs()).catch((error) => {
            log("warn", "Failed to ask for a lease. Asking again.", { run: state.runId, error: errorInfo(error).message });
            return false;
          }),
        );
        if (got) break;
        const [woken, callbackId] = await child.createCallback<{ leaseId: string }>(`queued:${tag}`, {
          timeout: { seconds: LEASE_WAIT_S },
          serdes: json as any,
        });
        // Join the line, then hand out what's free: the lease may have freed up in
        // between. If it's ours, the step goes on without waiting.
        const queued = await child.step(`enqueue:${tag}`, async () => {
          let mine = false;
          const at = joined ?? Date.now();
          await engine.store.enqueue(limit, {
            leaseId,
            tenant,
            callbackId,
            runId: state.runId,
            at,
            expiresAt: Date.now() + LEASE_WAIT_S * 1000,
          });
          await engine.store.dispatch(limit, leaseMs(), async (w) => {
            if (w.callbackId !== callbackId) return wake(w);
            mine = true;
            return true;
          });
          return { mine, at };
        });
        joined = queued.at;
        if (queued.mine) break;
        try {
          await woken;
          break;
        } catch (error) {
          // Not woken in time: ask again. If the old place in line comes up later, the
          // wake fails, and its lease is given back.
          if (error instanceof durable.CallbackTimeoutError) continue;
          throw error;
        }
      }
    }
  };

  // A sleep, a wait and an invoke give back the kept lease first.
  const afterRelease = <T>(next: () => PromiseLike<T>): Promise<T> => {
    const released = releaseHeld();
    return released ? eager(released).then(() => next()) : eager(next());
  };

  const run = <T>(idInput: string | { id: string; name?: string }, fn: (...args: any[]) => T | Promise<T>, ...args: any[]): Promise<T> => {
    const id = occurrence(state, stepId(idInput));
    const saved = memo(id);
    if (saved.hit) return Promise.resolve(saved.value as T);
    if (!limits.length) {
      return eager(
        ctx.step(id, async () => jsonify(await fn(...args)), {
          retryStrategy: (error, attempt) => {
            const delay = retryDelay(error, attempt, def.retries, `${state.runId}\n${id}\n${attempt}`);
            return delay === undefined ? { shouldRetry: false } : { shouldRetry: true, delay: toDurableSeconds(delay) };
          },
        }),
      ) as Promise<T>;
    }

    // With a concurrency limit, each attempt takes a lease first. A step that waits
    // for a lease, or for its next attempt, holds none, as with Inngest.
    const reuse = state.held ?? null;
    state.held = null;
    state.inflight = (state.inflight ?? 0) + 1;
    return eager(
      ctx.runInChildContext(
        id,
        async (child) => {
          for (let attempt = 1; ; attempt++) {
            for (let lost = 0; ; lost++) {
              // The lease's ID comes from the run, the step and the attempt, so a lease
              // step that's retried asks for the same lease. The first attempt can use
              // the lease the run kept from its last step.
              const kept = attempt === 1 && lost === 0 ? reuse : null;
              const leaseId = kept ?? `${hash(`${state.runId}\n${id}`, 12)}.${attempt}.${lost}`;
              if (!kept) await takeLeases(child, leaseId, attempt);
              const outcome = await child.step(
                attempt === 1 && lost === 0 ? "run" : `run:${attempt}.${lost}`,
                async () => {
                  // After a crash, the run step runs again, maybe after its lease
                  // expired. Check the lease is still held before the work starts.
                  for (const limit of limits)
                    if (!(await engine.store.renew(limit, leaseId, leaseMs()))) return { lost: true as const };
                  try {
                    const value = jsonify(await fn(...args));
                    // The run keeps the lease for its next step, unless another of its
                    // steps is running, or waiting in line, which could be for this
                    // lease. What's decided is saved with the result, so a replay
                    // decides the same.
                    if ((state.inflight ?? 1) > 1) {
                      await giveBack(leaseId);
                      return { ok: true as const, value };
                    }
                    return { ok: true as const, value, kept: leaseId };
                  } catch (error) {
                    await giveBack(leaseId);
                    const delay = retryDelay(error, attempt, def.retries, `${state.runId}\n${id}\n${attempt}`);
                    return { ok: false as const, error: errorInfo(error), delay };
                  }
                },
                { retryStrategy: () => ({ shouldRetry: false }) },
              );
              if ("lost" in outcome) {
                if (lost >= 5) return { ok: false as const, error: { name: "LeaseError", message: `The step "${id}" kept losing its lease.` } };
                continue;
              }
              if (outcome.ok) return { ok: true as const, value: outcome.value, kept: outcome.kept };
              if (outcome.delay === undefined) return { ok: false as const, error: outcome.error };
              await child.wait(`retry:${attempt}`, toDurableSeconds(outcome.delay));
              break;
            }
          }
        },
        { subType: "EventFlowStep" },
      ),
    ).then((outcome) => {
      state.inflight = (state.inflight ?? 1) - 1;
      // An error thrown in a child context comes out as a ChildContextError, so the
      // outcome comes out of it, and the error is thrown here.
      if (!outcome.ok) throw new StepFailedError(id, outcome.error);
      // Keep the lease for the next step, unless one is kept already, as with steps
      // started together. Then give this one back.
      if (outcome.kept) {
        if (!state.held) state.held = outcome.kept;
        else (state.extra ??= []).push(outcome.kept);
      }
      return outcome.value as T;
    });
  };

  const sleep = (idInput: string | { id: string }, duration: DurationInput) => {
    const id = occurrence(state, stepId(idInput));
    if (memo(id).hit) return Promise.resolve();
    const seconds = bounded(parseDuration(duration, `duration of step "${id}"`), `sleep of step "${id}"`);
    return afterRelease(() => ctx.wait(id, seconds));
  };

  const sleepUntil = (idInput: string | { id: string }, time: Date | string) => {
    const id = occurrence(state, stepId(idInput));
    if (memo(id).hit) return Promise.resolve();
    const at = time instanceof Date ? time.getTime() : Date.parse(time);
    if (!Number.isFinite(at)) throw new TypeError(`The time of step "${id}" isn't a date.`);
    const seconds = bounded(at - Date.now(), `sleep of step "${id}"`);
    return afterRelease(() => ctx.wait(id, seconds));
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

    return afterRelease(() =>
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
    const timeout = timeoutMs === undefined ? undefined : bounded(timeoutMs, `timeout of step "${id}"`);

    return afterRelease(() =>
      ctx.runInChildContext(
        id,
        async (child) => {
          const [result, callbackId] = await child.createCallback<InvokeOutcome>("result", { timeout, serdes: json as any });
          // The invoked run goes through the router, like any other, so its flow
          // control applies. The message is signed, so only a run can send one.
          await child.step("start", async () => {
            const identity = `invoke\n${state.runId}\n${id}`;
            const event: WireEvent = {
              id: hash(identity),
              name: "inngest/function.invoked",
              data: options.data ?? {},
              ts: Date.now(),
              ...(state.event.tenant ? { tenant: state.event.tenant } : {}),
            };
            await engine.sendMessages([
              {
                message: sign({
                  kind: "invoke" as const,
                  fn: target,
                  event,
                  parent: callbackId,
                  runId: makeRunId(target, identity),
                }),
                group: event.tenant,
              },
            ]);
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
        // IDs come from the run and the step, so a retried step sends the same events,
        // and the router skips the ones it has seen.
        const events = list.map((p, i) =>
          toWireEvent({ ...p, id: p.id ?? hash(`${state.runId}\n${id}\n${i}`), tenant: p.tenant ?? state.event.tenant }),
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
    if (!entry)
      throw new NonRetriableError(`The function "${payload.fn}" isn't served by this version of the worker. Was it removed or renamed?`);

    const engine = getEngine();
    const state: RunState = {
      ctx,
      engine,
      def: entry.def,
      registry,
      runId: runIdFromArn(ctx.executionContext.durableExecutionArn) ?? payload.runId,
      event: payload.event,
      memo: Object.assign(Object.create(null), payload.memo ?? {}),
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

    const releaseAtEnd = async () => {
      const released = state.releaseHeld?.();
      if (released) await released;
    };

    let result: unknown;
    try {
      result = await entry.handler(makeArgs(state));
    } catch (error) {
      if (isDurableInternal(error)) throw error;
      await releaseAtEnd();
      try {
        if (entry.def.onFailure) {
          await ctx.runInChildContext("onFailure", async (child) => {
            const failure: RunState = { ...state, ctx: child, counts: new Map(), memo: Object.create(null) };
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
    await releaseAtEnd();
    await stopListening();
    await finish({ ok: true, result: value });
    return value;
  });
}

function isDurableInternal(error: unknown) {
  const name = (error as any)?.constructor?.name ?? "";
  return /Unrecoverable|NonDeterministic|Termination/.test(name);
}
