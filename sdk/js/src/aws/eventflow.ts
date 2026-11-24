import type { Context as LambdaContext, SQSEvent } from "aws-lambda";
import type { AwsOptions } from "./client.js";
import { define, type FunctionOptions, type TriggerInput } from "./eventflow/definition.js";
import type { DurationInput } from "./eventflow/duration.js";
import { Engine, toWireEvent, type SendPayload } from "./eventflow/engine.js";
import { handleAdmin } from "./eventflow/admin.js";
import type { DeadLetter, FunctionInfo, LimitInfo, Overview, WaitInfo } from "./eventflow/admin.js";
import { runId as makeRunId } from "./eventflow/ids.js";
import { loadKey } from "./eventflow/sign.js";
import { routeBatch, tick } from "./eventflow/router.js";
import type { ListInput, Run, RunSummary } from "./eventflow/runs.js";
import type { Store } from "./eventflow/store.js";
import { ADMIN_MARKER, TICK_MARKER, type EngineResource, type WireEvent } from "./eventflow/types.js";
import { createWorker, type Registered } from "./eventflow/worker.js";

export { NonRetriableError, RetryAfterError, InvokeFailedError, StepFailedError } from "./eventflow/worker.js";
export { SendError } from "./eventflow/engine.js";
export type { Run, RunSummary, RunStatus, StepRecord, ListInput } from "./eventflow/runs.js";
export type { DeadLetter, FunctionInfo, LimitInfo, Overview, QueueInfo, WaitInfo } from "./eventflow/admin.js";
export type { EngineResource } from "./eventflow/types.js";

/**
 * The `EventFlow` SDK lets you write event-driven functions with an API shaped like
 * [Inngest's TypeScript SDK](https://www.inngest.com/docs/reference/typescript), and
 * run them on the [`EventFlow`](/docs/component/aws/eventflow) component, in your
 * own AWS account.
 *
 * It follows `inngest` v4.27.0. The [migration guide](/docs/migrate-from-inngest)
 * lists what's the same, what's different, and what isn't supported. An option that
 * isn't supported throws when the function is created, so it's never silently
 * ignored.
 *
 * @example
 * ```ts title="src/flow.ts"
 * import { EventFlow, serve } from "sst/aws/eventflow";
 *
 * export const flow = new EventFlow({ id: "my-app" });
 *
 * const welcome = flow.createFunction(
 *   { id: "send-welcome", triggers: { event: "user/created" } },
 *   async ({ event, step }) => {
 *     await step.sleep("wait-a-day", "1d");
 *     await step.run("send-email", () => sendEmail(event.data.email));
 *   },
 * );
 *
 * export const handler = serve({ client: flow, functions: [welcome] });
 * ```
 *
 * ```ts title="src/api.ts"
 * import { flow } from "./flow";
 *
 * await flow.send({ name: "user/created", data: { email: "alice@example.com" } });
 * ```
 */
export class EventFlow {
  /** The app's ID, as with Inngest. It's used in logs. */
  public readonly id: string;
  /**
   * Find runs, see their steps, and stop or replay them.
   *
   * @example
   * ```ts
   * const run = await flow.runs.get(runId);
   * console.log(run?.status, run?.failedStep);
   *
   * const { id } = await flow.runs.replay(runId);
   * ```
   */
  public readonly runs: Runs;
  /**
   * The EventFlow's state: its functions, queue, dead letters, concurrency leases and
   * waits. It's what `sst eventflow` shows, as JSON, to build your own page on.
   *
   * It needs the admin link, in `sst.config.ts`: `link: [flow.admin]`. Linking the
   * EventFlow itself only lets a function send events.
   *
   * @example
   * ```ts
   * const { queue, deadLetters, leases } = await flow.admin.overview();
   * ```
   */
  public readonly admin: Admin;
  private engine?: Engine;

  constructor(private readonly options: EventFlowOptions) {
    if (!options || typeof options.id !== "string" || !options.id)
      throw new TypeError("new EventFlow() needs an `id`.");
    // Inngest's options that change what happens, and that EventFlow doesn't have,
    // throw. The ones about Inngest's cloud are accepted, and do nothing.
    const unsupported: Record<string, string> = {
      middleware: "EventFlow doesn't support middleware.",
      schemas: "EventFlow follows Inngest v4, which replaced `schemas` with `eventType()`. Declare each event with `eventType()`.",
      logger: "EventFlow doesn't take a logger. Functions get one in their context, which writes to CloudWatch.",
      internalLogger: "EventFlow doesn't take a logger.",
      fetch: "EventFlow doesn't take a fetch. It calls AWS with your function's IAM role.",
      endpointAdapter: "EventFlow doesn't take an endpoint adapter. Use serve() as its handler.",
      sessionPropagation: "EventFlow doesn't support sessions.",
      aiMetadata: "EventFlow doesn't support step.ai.",
    };
    for (const key of Object.keys(options))
      if (unsupported[key] && (options as any)[key] !== undefined) throw new TypeError(unsupported[key]);
    this.id = options.id;
    this.runs = new Runs(() => this.getEngine());
    this.admin = new Admin(() => this.getEngine());
  }

  /** @internal */
  public getEngine() {
    this.engine ??= Engine.resolve({
      resource: this.options.resource,
      aws: this.options.aws,
      store: this.options.store,
    });
    return this.engine;
  }

  /**
   * Create a function. It runs when one of its `triggers` happens, or when another
   * function invokes it.
   *
   * Every function of an EventFlow runs in its one worker, so adding a function
   * doesn't add any infrastructure. Pass it to `serve()`.
   *
   * @example
   * ```ts title="src/flow.ts"
   * const importContacts = flow.createFunction(
   *   {
   *     id: "import-contacts",
   *     triggers: { event: "contacts/import.requested" },
   *     retries: 5,
   *     // At most 5 steps of each tenant run at once, and 50 in all.
   *     concurrency: [
   *       { limit: 5, key: "event.data.tenantId" },
   *       { limit: 50 },
   *     ],
   *   },
   *   async ({ event, step }) => {
   *     const rows = await step.run("download", () => download(event.data.file));
   *     await step.run("save", () => save(rows));
   *   },
   * );
   * ```
   */
  public createFunction<
    const TTriggers extends TriggerInput | readonly TriggerInput[] | undefined,
    TOutput,
  >(
    options: CreateFunctionOptions<TTriggers>,
    handler: (ctx: Context<EventOf<TTriggers>>) => TOutput | Promise<TOutput>,
  ): EventFlowFunction<TOutput> {
    const def = define(options as FunctionOptions);
    return { id: def.id, opts: { id: def.id }, [registration]: { def, handler } } as any;
  }

  /**
   * Send one or more events. Each function with a trigger for an event's name starts a
   * run, and each wait for it that matches resumes.
   *
   * An event without an `id` gets one. An event with an `id` that was sent in the last
   * 24 hours is skipped, so sending again after an error is safe.
   *
   * @example
   * ```ts
   * const { ids } = await flow.send({
   *   name: "contacts/import.requested",
   *   id: `import-${importId}`,
   *   data: { tenantId, file },
   *   tenant: tenantId,
   * });
   * ```
   */
  public async send(payload: SendPayload | SendPayload[]): Promise<{ ids: string[] }> {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const p of list) await validate(p);
    const events = list.map((p) => toWireEvent(p));
    await this.getEngine().sendEvents(events);
    return { ids: events.map((e) => e.id) };
  }
}

/** The options of `createFunction()`. */
export interface CreateFunctionOptions<TTriggers = TriggerInput | readonly TriggerInput[] | undefined>
  extends Omit<FunctionOptions, "triggers"> {
  /** What starts a run: events and crons. A function with no triggers can only be invoked. */
  triggers?: TTriggers;
}

/** An event made by `create()` on an event type. */
export interface TypedPayload<TName extends string = string, TData = any> extends SendPayload {
  name: TName;
  data: TData;
}

export interface EventFlowOptions {
  /** The app's ID, as with Inngest. */
  id: string;
  /**
   * The EventFlow to use. A function linked to one EventFlow finds it by itself. One
   * linked to more than one passes the one to use.
   *
   * @example
   * ```ts
   * import { Resource } from "sst";
   *
   * new EventFlow({ id: "billing", resource: Resource.Billing });
   * ```
   */
  resource?: EngineResource;
  /** Options for the signed fetch the SDK uses to call AWS. */
  aws?: AwsOptions;
  /** @internal */
  store?: Store;
  /** Accepted for Inngest compatibility. It has no effect: sends are signed with the function's IAM role. */
  eventKey?: string;
  /** Accepted for Inngest compatibility. It has no effect. */
  signingKey?: string;
  /** Accepted for Inngest compatibility. It has no effect. `sst dev` runs functions locally. */
  isDev?: boolean;
  /** Accepted for Inngest compatibility. It has no effect. */
  signingKeyFallback?: string;
  /** Accepted for Inngest compatibility. It has no effect. */
  env?: string;
  /** Accepted for Inngest compatibility. It has no effect. */
  appVersion?: string;
  /** Accepted for Inngest compatibility. It has no effect: there's no Inngest server. */
  baseUrl?: string;
  /** Accepted for Inngest compatibility. Steps are always checkpointed. */
  checkpointing?: unknown;
  /** Accepted for Inngest compatibility. It has no effect. */
  optimizeParallelism?: boolean;
}

const registration = Symbol.for("sst.eventflow.function");

/** A function made by `createFunction()`. */
export interface EventFlowFunction<TOutput = unknown> {
  readonly id: string;
  /** @internal */
  readonly __output?: TOutput;
}

/**
 * Create the handler of the EventFlow component, for all of its functions.
 *
 * The component runs the same handler as its router, which reads the queue, and as
 * its worker, which runs the functions. It tells them apart by what invokes it.
 *
 * @example
 * ```ts title="src/flow.ts"
 * export const handler = serve({ client: flow, functions: [welcome, importContacts] });
 * ```
 *
 * ```ts title="sst.config.ts"
 * const flow = new sst.aws.EventFlow("Flow", { handler: "src/flow.handler" });
 * ```
 */
export function serve(input: { client: EventFlow; functions: EventFlowFunction<any>[] }) {
  if (!(input?.client instanceof EventFlow))
    throw new TypeError("serve() needs `client`, the EventFlow the functions were created with.");
  const registry = new Map<string, Registered>();
  for (const fn of input.functions ?? []) {
    const entry = (fn as any)?.[registration] as Registered | undefined;
    if (!entry) throw new TypeError("serve() got a function that wasn't made with createFunction().");
    if (registry.has(entry.def.id))
      throw new TypeError(`serve() got two functions with the ID "${entry.def.id}".`);
    registry.set(entry.def.id, entry);
  }
  const engine = () => input.client.getEngine();
  const worker = createWorker(registry, engine);

  return async (event: any, context: LambdaContext) => {
    // The router and the worker sign and check runs with a key they load once.
    await loadKey(input.client.getEngine().aws);
    if (event?.DurableExecutionArn) return (worker as any)(event, context);
    // The admin API. Only what may invoke the router, like `sst eventflow` or a
    // function linked to `flow.admin`, can call it.
    if (event && typeof event[ADMIN_MARKER] === "object") return handleAdmin(event[ADMIN_MARKER], registry, engine());
    if (Array.isArray(event?.Records) && event.Records[0]?.eventSource === "aws:sqs")
      return routeBatch(event as SQSEvent, registry, engine());
    if (event && typeof event[TICK_MARKER] === "string")
      return tick(event[TICK_MARKER], registry, engine());
    throw new Error(
      "The EventFlow handler got an event it doesn't know. Send events with flow.send() instead of invoking it.",
    );
  };
}

// ---------------------------------------------------------------------------
// Runs and admin
// ---------------------------------------------------------------------------

function revive<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const [k, v] of Object.entries(value as any)) {
    if (typeof v === "string" && /At$/.test(k) && /^\d{4}-\d\d-\d\dT/.test(v)) (value as any)[k] = new Date(v);
    else if (v && typeof v === "object") revive(v);
  }
  return value;
}

/**
 * Runs, by their run ID: find them, see their steps, and stop, retry or replay them.
 * It needs the admin link, `link: [flow.admin]`, except for `idFor`.
 */
export class Runs {
  /** @internal */
  constructor(private readonly engine: () => Engine) {}

  /**
   * The ID of the run that an event starts for a function. It's known before the run
   * starts, since it comes from the function, the event's ID, and its tenant.
   *
   * @example
   * ```ts
   * const { ids } = await flow.send({ name: "order/placed", data, tenant });
   * const runId = flow.runs.idFor(processOrder, ids[0], tenant);
   * ```
   */
  idFor(fn: string | { id: string }, eventId: string, tenant?: string) {
    return makeRunId(typeof fn === "string" ? fn : fn.id, JSON.stringify([tenant ?? null, eventId]));
  }

  /** List runs, newest first. */
  async list(input: ListInput = {}): Promise<RunSummary[]> {
    const fn = typeof input.function === "string" ? input.function : input.function?.id;
    return revive(await this.engine().admin<RunSummary[]>("runs.list", { ...input, function: fn }));
  }

  /** Get a run, with its steps, and the first step that failed. */
  async get(runId: string): Promise<Run | undefined> {
    return revive((await this.engine().admin<Run | null>("runs.get", { runId })) ?? undefined);
  }

  /** Stop a run. Its steps that already ran aren't undone. */
  async cancel(runId: string): Promise<{ id: string; stopped: boolean }> {
    return this.engine().admin("runs.cancel", { runId });
  }

  /**
   * Stop the runs that match: by default, every run that's running or paused, up to
   * 500 at a time. Stop an EventFlow's runs before you remove it: `sst remove` stops
   * them one at a time.
   *
   * @example
   * ```ts
   * await flow.runs.cancelAll({ function: importContacts });
   * ```
   */
  async cancelAll(input: ListInput = {}) {
    const fn = typeof input.function === "string" ? input.function : input.function?.id;
    return this.engine().admin<{ id: string; stopped?: boolean; error?: string }[]>("runs.cancelAll", {
      ...input,
      function: fn,
    });
  }

  /**
   * Run a failed run again, on the latest deployed version, from the step that
   * failed. The steps that succeeded return their saved results, and aren't run
   * again. Use it after you deploy a fix.
   *
   * It's a new run, with a new ID. Its `replayOf` is the run it retries.
   *
   * A run whose `atMostOnce` step started and didn't finish isn't retried, since that
   * step may have done its side effect, like a payment. Check it, then pass
   * `force: true`.
   *
   * A run is retried once. Retrying it again, as from a double click, returns the
   * first retry, with `existing: true`. Pass `again: true` to retry it again.
   *
   * The retry keeps the run's idempotency keys, so a step that charged a card in the
   * first run sends the provider the same key.
   *
   * @example
   * ```ts
   * const { id, reused } = await flow.runs.retry(runId);
   * ```
   */
  async retry(runId: string, options: RerunOptions = {}): Promise<Rerun> {
    return this.engine().admin("runs.retry", { runId, force: options.force === true, again: options.again === true });
  }

  /**
   * Run a function again with the event of an earlier run, as a new run on the latest
   * deployed version. Every step runs again, including the ones that succeeded. Make
   * steps with side effects idempotent, with `idempotencyKey()`.
   *
   * A run with an `atMostOnce` step that started isn't replayed without
   * `force: true`, since that step would run again. Like a retry, a run is replayed
   * once unless `again: true`.
   */
  async replay(runId: string, options: RerunOptions = {}): Promise<Rerun> {
    return this.engine().admin("runs.replay", { runId, force: options.force === true, again: options.again === true });
  }

  /**
   * Retry, or replay, the runs that match: by default, a function's failed runs. Up to
   * 100 at a time.
   *
   * @example
   * ```ts
   * await flow.runs.retryAll({ function: importContacts, from: new Date(Date.now() - 3_600_000) });
   * ```
   */
  async retryAll(input: RetryAllInput = {}) {
    const fn = typeof input.function === "string" ? input.function : input.function?.id;
    return this.engine().admin<{ id: string; result?: { id: string; existing?: boolean }; error?: string }[]>("runs.retryAll", {
      ...input,
      function: fn,
    });
  }
}

/** How to retry or replay a run. */
export interface RerunOptions {
  /**
   * Rerun it though an `atMostOnce` step may have done its side effect. Check that
   * step first.
   */
  force?: boolean;
  /** Rerun it though it was already rerun. */
  again?: boolean;
}

/** The run a retry or replay started. */
export interface Rerun {
  /** The new run's ID. */
  id: string;
  /** The run it reruns. */
  replayOf: string;
  /** For a retry, the steps whose saved results it reuses. */
  reused: string[];
  /** True when the run was already rerun, and `id` is that run. Nothing new started. */
  existing?: boolean;
}

/** What `retryAll()` takes: which runs, and whether to retry or replay them. */
export interface RetryAllInput extends ListInput {
  /** "retry" reuses the steps that succeeded; "replay" runs every step again. Defaults to "retry". */
  mode?: "retry" | "replay";
  /** Also rerun the runs whose `atMostOnce` step stopped part way. Check them first. */
  force?: boolean;
}

/**
 * The EventFlow's state, as plain JSON. It needs the admin link, `link: [flow.admin]`.
 */
export class Admin {
  /** @internal */
  constructor(private readonly engine: () => Engine) {}

  /** The functions the worker serves, with their triggers and flow control. */
  functions(): Promise<FunctionInfo[]> {
    return this.engine().admin("functions");
  }

  /** The queue, the dead letters, the concurrency leases, and the waits, in counts. */
  overview(): Promise<Overview> {
    return this.engine().admin("overview");
  }

  /** Each concurrency limit: its leases, the tenants that hold them, and the steps waiting. */
  leases(): Promise<LimitInfo[]> {
    return this.engine().admin<LimitInfo[]>("leases");
  }

  /** The runs waiting for an event, and the cancelOns listening for one. */
  waits(): Promise<WaitInfo[]> {
    return this.engine().admin("waits");
  }

  /** Look at up to 10 events the router couldn't route, without taking them off the dead-letter queue. */
  deadLetters(input: { max?: number } = {}): Promise<DeadLetter[]> {
    return this.engine().admin("deadLetters.peek", input);
  }

  /** Move the dead letters back to the queue, to be routed again, as after a fix. */
  redrive(): Promise<{ taskHandle?: string }> {
    return this.engine().admin("deadLetters.redrive");
  }
}

// ---------------------------------------------------------------------------
// Typed events
// ---------------------------------------------------------------------------

/**
 * A [Standard Schema](https://standardschema.dev), like a Zod, Valibot or ArkType
 * schema.
 * @internal
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { value: Output; issues?: undefined }
      | { issues: readonly { message: string; path?: readonly unknown[] }[] }
      | Promise<
          | { value: Output; issues?: undefined }
          | { issues: readonly { message: string; path?: readonly unknown[] }[] }
        >;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

/** An event declared with `eventType()`. */
export interface EventType<TName extends string = string, TData = any> {
  readonly name: TName;
  readonly schema?: StandardSchemaV1<any, TData>;
  readonly version?: string;
  /** Make an event of this type to `send()`. Its data is checked against the schema when it's sent. */
  create(data: TData, options?: { id?: string; ts?: number; tenant?: string }): TypedPayload<TName, TData>;
}

const schemaOf = Symbol.for("sst.eventflow.schema");

/**
 * Declare an event, with a schema for its data, as with Inngest v4. Use it in a
 * trigger, and the handler's `event.data` is typed.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { eventType, staticSchema } from "sst/aws/eventflow";
 *
 * export const userCreated = eventType("user/created", {
 *   schema: z.object({ id: z.string(), email: z.string() }),
 * });
 *
 * // Types only, with no check when it's sent.
 * export const orderPaid = eventType("order/paid", {
 *   schema: staticSchema<{ orderId: string }>(),
 * });
 *
 * await flow.send(userCreated.create({ id: "u_1", email: "alice@example.com" }));
 * ```
 */
export function eventType<TName extends string, TData = Record<string, any>>(
  name: TName,
  options?: { schema?: StandardSchemaV1<any, TData>; version?: string },
): EventType<TName, TData> {
  if (!name) throw new TypeError("eventType() needs a name.");
  return {
    name,
    schema: options?.schema,
    version: options?.version,
    create(data, extra) {
      const payload: any = { name, data, ...extra, ...(options?.version ? { v: options.version } : {}) };
      if (options?.schema) Object.defineProperty(payload, schemaOf, { value: options.schema });
      return payload;
    },
  };
}

/**
 * A schema that only declares the type, and checks nothing.
 */
export function staticSchema<T>(): StandardSchemaV1<T, T> {
  return {
    "~standard": { version: 1, vendor: "sst", validate: (value) => ({ value: value as T }) },
  };
}

/** A cron trigger, as with Inngest's `cron()`. */
export function cron(expression: string) {
  return { cron: expression } as const;
}

async function validate(payload: SendPayload) {
  const schema = (payload as any)?.[schemaOf] as StandardSchemaV1 | undefined;
  if (!schema) return;
  const result = await schema["~standard"].validate(payload.data);
  if (result.issues)
    throw new TypeError(
      `The event "${payload.name}" doesn't match its schema: ${result.issues
        .map((i) => `${i.path?.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
        .join("; ")}`,
    );
  (payload as any).data = result.value;
}

// ---------------------------------------------------------------------------
// The function's context
// ---------------------------------------------------------------------------

/** An event, as a function gets it. */
export interface FlowEvent<TName extends string = string, TData = any> {
  id: string;
  name: TName;
  data: TData;
  /** When it was sent, in ms since the epoch. */
  ts: number;
  v?: string;
  /** The tenant it was sent with. */
  tenant?: string;
}

type Data<T> = T extends EventType<any, infer D> ? D : any;
type One<T> = T extends { event: infer E }
  ? E extends EventType<infer N, any>
    ? FlowEvent<N, Data<E>>
    : E extends string
      ? FlowEvent<E>
      : FlowEvent
  : T extends { cron: string }
    ? FlowEvent<"inngest/scheduled.timer", { cron: string }>
    : FlowEvent<"inngest/function.invoked">;
type EventOf<T> = T extends readonly (infer U)[] ? One<U> : T extends undefined ? FlowEvent<"inngest/function.invoked"> : One<T>;

/** What a function's handler gets. */
export interface Context<TEvent = FlowEvent> {
  /** The event that started the run. */
  event: TEvent;
  /** The run's events. It's `[event]`, since EventFlow doesn't batch events. */
  events: TEvent[];
  /** Durable steps. */
  step: Step;
  /** `group.parallel(fn)` runs `fn`. Steps started together run together. */
  group: { parallel: <T>(fn: () => Promise<T>) => Promise<T> };
  /** The run's ID. */
  runId: string;
  /** The most times a step is tried: the function's `retries`, plus one. */
  maxAttempts: number;
  /**
   * The key of the step it's called in, for the step's side effect: pass it to a
   * payment provider, or any API that takes an idempotency key. It's the same in
   * every attempt of the step, and in every retry and replay of the run, and
   * different for every other step, every other occurrence of a step in a loop, and
   * every other run. So a step that runs again, after a crash or a retry, doesn't
   * charge twice. Call it inside `step.run()`.
   *
   * @example
   * ```ts
   * await step.run("charge", () =>
   *   stripe.paymentIntents.create(
   *     { amount, currency: "usd", customer },
   *     { idempotencyKey: idempotencyKey() },
   *   ),
   * );
   * ```
   */
  idempotencyKey: () => string;
  /** A logger that doesn't repeat itself when the function replays. */
  logger: Logger;
}

/**
 * A step's ID, or its options. `atMostOnce` is EventFlow's: AWS saves that the step
 * started before it runs, so a step the worker stops part way fails instead of running
 * again, and it isn't retried. Use it for a call that has no idempotency key.
 */
type StepId = string | { id: string; name?: string; atMostOnce?: boolean };

/** @internal */
export interface Logger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

/** The step tools, as `step` in a function's context. */
export interface Step {
  /**
   * Run code as a step. Its result is saved, so when the function runs again after a
   * sleep or a retry, the step isn't run again and returns the saved result.
   *
   * A step that throws is retried, up to the function's `retries`. Throw a
   * `NonRetriableError` to stop, or a `RetryAfterError` to choose when.
   *
   * The result is saved as JSON, so a `Date` comes back as a string.
   */
  run: <T>(id: StepId, fn: (...args: any[]) => T | Promise<T>, ...args: any[]) => Promise<Awaited<T>>;
  /** Pause the run for a duration, like `"30s"`, `"1h"` or `"7d"`, or a number of milliseconds. A paused run costs nothing. */
  sleep: (id: StepId, duration: DurationInput) => Promise<void>;
  /** Pause the run until a time. */
  sleepUntil: (id: StepId, time: Date | string) => Promise<void>;
  /**
   * Wait for an event. It returns the event, or `null` if none came before the
   * timeout. It only sees events sent after it starts waiting, and only events of the
   * run's tenant.
   *
   * @example
   * ```ts
   * const approval = await step.waitForEvent("wait-for-approval", {
   *   event: "invoice/approved",
   *   timeout: "3d",
   *   match: "data.invoiceId",
   * });
   * ```
   */
  waitForEvent: <TName extends string = string, TData = any>(
    id: StepId,
    options: { event: TName | EventType<TName, TData>; timeout: DurationInput | Date; match?: string; if?: string },
  ) => Promise<FlowEvent<TName, TData> | null>;
  /** Run another function of this EventFlow, and wait for what it returns. */
  invoke: <TOutput>(
    id: StepId,
    options: { function: EventFlowFunction<TOutput>; data?: unknown; timeout?: DurationInput | Date },
  ) => Promise<TOutput>;
  /** Send events from a run. A retried step sends the same event IDs, so they aren't sent twice. */
  sendEvent: (id: StepId, payload: SendPayload | SendPayload[]) => Promise<{ ids: string[] }>;
}

export type { SendPayload, FunctionOptions, TriggerInput, DurationInput, WireEvent };
