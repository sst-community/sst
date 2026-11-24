import { parseCron, type Cron } from "./cron.js";
import { parseDuration, type DurationInput } from "./duration.js";
import {
  compileKey,
  evaluate,
  parseExpression,
  type Expression,
  type KeyInput,
} from "./expression.js";

// A function's options, checked and normalized when `createFunction()` runs, so a
// mistake or an option EventFlow doesn't support fails when the module loads, not
// when an event comes.

export interface ConcurrencyOption {
  limit: number;
  key?: KeyInput;
  scope?: "fn" | "env" | "account";
}

export interface FunctionOptions {
  id: string;
  name?: string;
  description?: string;
  triggers?: TriggerInput | TriggerInput[];
  retries?: number;
  concurrency?: number | ConcurrencyOption | ConcurrencyOption[];
  throttle?: { limit: number; period: DurationInput; burst?: number; key?: KeyInput };
  rateLimit?: { limit: number; period: DurationInput; key?: KeyInput };
  idempotency?: KeyInput;
  onFailure?: (...args: any[]) => unknown;
  cancelOn?: CancelOnInput[];
  /** Accepted for Inngest compatibility. Steps are always checkpointed. */
  checkpointing?: unknown;
  /** Accepted for Inngest compatibility. It has no effect. */
  optimizeParallelism?: unknown;
}

export interface CancelOnInput {
  /** The event that cancels the run. */
  event: string | { name: string };
  /** Cancel only for an event with the same value at this path as the run's event, like "data.orderId". */
  match?: string;
  /** Cancel only when this is true. `event` is the run's event, and `async` the one that came. */
  if?: string;
  /** Stop listening after this long. By default, until the run ends. */
  timeout?: DurationInput;
}

export interface CancelOn {
  name: string;
  match?: string;
  if?: string;
  timeoutMs?: number;
}

export type TriggerInput =
  | { event: string | { name: string }; if?: string }
  | { cron: string; jitter?: unknown }
  | { invoke: true };

export type Trigger =
  | { kind: "event"; name: string; if?: Expression }
  | { kind: "cron"; cron: Cron }
  | { kind: "invoke" };

export interface Limit {
  limit: number;
  scope: "fn" | "env" | "account";
  key?: (scope: Record<string, unknown>) => string | undefined;
  keySource?: string;
}

export interface Bucket {
  intervalMs: number;
  toleranceMs: number;
  key?: (scope: Record<string, unknown>) => string | undefined;
}

export interface Definition {
  id: string;
  name: string;
  triggers: Trigger[];
  retries: number;
  concurrency: Limit[];
  throttle?: Bucket;
  rateLimit?: Bucket;
  idempotency?: (scope: Record<string, unknown>) => string | undefined;
  onFailure?: (...args: any[]) => unknown;
  cancelOn: CancelOn[];
}

export const DEFAULT_RETRIES = 4;

const UNSUPPORTED: Record<string, string> = {
  debounce: "debounce",
  batchEvents: "event batching",
  priority: "priority",
  timeouts: "timeouts (set timeout.execution on the EventFlow component instead)",
  singleton: "singleton",
  middleware: "middleware",
};

const KNOWN = new Set([
  "id",
  "name",
  "description",
  "triggers",
  "retries",
  "concurrency",
  "throttle",
  "rateLimit",
  "idempotency",
  "onFailure",
  "cancelOn",
  "checkpointing",
  "optimizeParallelism",
]);

export function define(options: FunctionOptions): Definition {
  if (!options || typeof options !== "object" || typeof (options as any).id !== "string")
    throw new TypeError("createFunction() needs an options object with an `id`.");
  const id = options.id;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id))
    throw new TypeError(
      `The function ID "${id}" must be 1 to 128 letters, digits, ".", "_", ":", "/" and "-".`,
    );
  const where = `function "${id}"`;

  for (const key of Object.keys(options)) {
    if (UNSUPPORTED[key])
      throw new TypeError(
        `The ${where} uses ${UNSUPPORTED[key]}, which EventFlow doesn't support yet. See the migration guide for what to use instead.`,
      );
    if (!KNOWN.has(key))
      throw new TypeError(`The ${where} has an unknown option "${key}".`);
  }

  const retries = options.retries ?? DEFAULT_RETRIES;
  if (!Number.isInteger(retries) || retries < 0 || retries > 20)
    throw new TypeError(`The ${where} has retries ${retries}. Use 0 to 20.`);

  const triggers = normalizeTriggers(options.triggers, where);

  const concurrency = normalizeConcurrency(options.concurrency, where);

  const bucket = (
    input: { limit: number; period: DurationInput; burst?: number; key?: KeyInput } | undefined,
    label: string,
    burstDefault: number | undefined,
  ): Bucket | undefined => {
    if (!input) return undefined;
    if (!Number.isInteger(input.limit) || input.limit < 1)
      throw new TypeError(`The ${where} has a ${label} limit of ${input.limit}. Use a whole number of at least 1.`);
    const periodMs = parseDuration(input.period, `${label} period of ${where}`);
    if (periodMs < 1000 || periodMs > 7 * 86_400_000)
      throw new TypeError(`The ${label} period of ${where} must be from 1s to 7d.`);
    const intervalMs = periodMs / input.limit;
    const burst = input.burst ?? burstDefault;
    return {
      intervalMs,
      // A rate limit lets `limit` runs start in each period. A throttle lets
      // `burst` start at once, and then one each interval.
      toleranceMs: burst === undefined ? periodMs - intervalMs : burst * intervalMs,
      key: input.key === undefined ? undefined : compileKey(input.key, `${label} key of ${where}`),
    };
  };

  return {
    id,
    name: options.name ?? id,
    triggers,
    retries,
    concurrency,
    throttle: bucket(options.throttle, "throttle", 1),
    rateLimit: bucket(options.rateLimit, "rateLimit", undefined),
    idempotency:
      options.idempotency === undefined
        ? undefined
        : compileKey(options.idempotency, `idempotency key of ${where}`),
    onFailure: options.onFailure,
    cancelOn: normalizeCancelOn(options.cancelOn, where),
  };
}

function normalizeCancelOn(input: FunctionOptions["cancelOn"], where: string): CancelOn[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError(`The cancelOn of ${where} must be a list.`);
  return input.map((c) => {
    const name = typeof c?.event === "string" ? c.event : c?.event?.name;
    if (!name) throw new TypeError(`A cancelOn of ${where} has no event name.`);
    if (c.match && c.if) throw new TypeError(`A cancelOn of ${where} has both "match" and "if". Use one.`);
    // Check the expression now, so a mistake fails when the function is created.
    if (c.if) parseExpression(c.if, `cancelOn "if" of ${where}`);
    return {
      name,
      match: c.match,
      if: c.if,
      timeoutMs: c.timeout === undefined ? undefined : parseDuration(c.timeout, `cancelOn timeout of ${where}`),
    };
  });
}

function normalizeTriggers(input: FunctionOptions["triggers"], where: string): Trigger[] {
  const list = input === undefined ? [] : Array.isArray(input) ? input : [input];
  if (list.length > 10) throw new TypeError(`The ${where} has more than 10 triggers.`);
  const triggers = list.map((t): Trigger => {
    if (t && "event" in t) {
      const name = typeof t.event === "string" ? t.event : t.event?.name;
      if (!name) throw new TypeError(`A trigger of ${where} has no event name.`);
      if (name.includes("*"))
        throw new TypeError(`The trigger "${name}" of ${where} has a wildcard, which EventFlow doesn't support.`);
      return {
        kind: "event",
        name,
        if: t.if === undefined ? undefined : parseExpression(t.if, `trigger "if" of ${where}`),
      };
    }
    if (t && "cron" in t) {
      if ((t as any).jitter !== undefined)
        throw new TypeError(`The cron trigger of ${where} has a jitter, which EventFlow doesn't support.`);
      return { kind: "cron", cron: parseCron(t.cron) };
    }
    if (t && "invoke" in t) return { kind: "invoke" };
    throw new TypeError(`A trigger of ${where} isn't an event or a cron.`);
  });
  // A function with no triggers can only be invoked.
  if (!triggers.length) triggers.push({ kind: "invoke" });
  return triggers;
}

/** The largest concurrency limit. */
export const MAX_CONCURRENCY = 1000;

function normalizeConcurrency(input: FunctionOptions["concurrency"], where: string): Limit[] {
  if (input === undefined) return [];
  const list = typeof input === "number" ? [{ limit: input }] : Array.isArray(input) ? input : [input];
  if (list.length > 2) throw new TypeError(`The ${where} has more than 2 concurrency limits.`);
  return list
    .filter((c) => c.limit !== 0)
    .map((c) => {
      // Every lease of a limit is in one table item, which DynamoDB caps at 400 KB.
      if (!Number.isInteger(c.limit) || c.limit < 1 || c.limit > MAX_CONCURRENCY)
        throw new TypeError(
          `The ${where} has a concurrency limit of ${c.limit}. Use a whole number from 1 to ${MAX_CONCURRENCY}.`,
        );
      const scope = c.scope ?? "fn";
      if (!["fn", "env", "account"].includes(scope))
        throw new TypeError(`The ${where} has a concurrency scope "${scope}". Use "fn", "env" or "account".`);
      if (scope !== "fn" && c.key === undefined)
        throw new TypeError(`The ${where} has an "${scope}" concurrency limit without a key. Inngest needs a key for it, and so does EventFlow.`);
      return {
        limit: c.limit,
        scope,
        key: c.key === undefined ? undefined : compileKey(c.key, `concurrency key of ${where}`),
        keySource: typeof c.key === "string" ? c.key : undefined,
      };
    });
}

export function matchesTrigger(def: Definition, event: { name: string; data: unknown }) {
  return def.triggers.some((t) => {
    if (t.kind !== "event" || t.name !== event.name) return false;
    if (!t.if) return true;
    return evaluateSafe(t.if, { event });
  });
}

function evaluateSafe(expr: Expression, scope: Record<string, unknown>) {
  try {
    return evaluate(expr, scope);
  } catch {
    return false;
  }
}
