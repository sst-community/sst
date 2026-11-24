import { awsFetch } from "../client.js";
import type { Engine } from "./engine.js";
import { replayId } from "./ids.js";
import type { RunPayload, WireEvent } from "./types.js";
import type { InvokeOutcome } from "./worker.js";

// Runs, by their run ID, as the router's admin API serves them. A run is a durable
// execution of the worker, and its ID is the execution's name, so it can be found
// without its ARN.

export type RunStatus =
  | "RUNNING"
  | "PAUSING"
  | "PAUSED"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "STOPPED";

export interface RunSummary {
  /** The run ID, which is the durable execution's name. */
  id: string;
  /** The durable execution's ARN. */
  arn: string;
  status: RunStatus;
  startedAt: Date;
  endedAt?: Date;
}

export interface StepRecord {
  /** The step's ID, as the function names it. Steps in a step with a concurrency limit, a wait for an event, or an invoke are under it, like "charge/run". */
  id: string;
  type: "step" | "sleep" | "waitForEvent" | "invoke" | "callback" | "group" | "other";
  status: "running" | "succeeded" | "failed" | "waiting" | "timed out" | "cancelled";
  attempts: number;
  startedAt?: Date;
  endedAt?: Date;
  error?: { name?: string; message?: string };
}

export interface Run extends RunSummary {
  /** The function's ID. */
  function: string;
  /** The event that started the run. */
  event: WireEvent;
  /** The worker version that runs it. A run keeps the version it started on. */
  version?: string;
  output?: unknown;
  error?: { name?: string; message?: string };
  /** For a replay or a retry, the run it replays. */
  replayOf?: string;
  /** For a retry, the steps that weren't run again, since they'd succeeded. */
  reused?: string[];
  /** Each step, in the order it started. */
  steps: StepRecord[];
  /** The first step that failed, if any. */
  failedStep?: StepRecord;
  /** Where to look next. */
  links: { logs: string; logGroup: string };
}

export interface ListInput {
  /** Only the runs of this function. */
  function?: string | { id: string };
  status?: RunStatus;
  from?: Date;
  to?: Date;
  /** At most this many. Defaults to 100. */
  limit?: number;
}


const base = "/2025-12-01";
/** The largest set of saved step results a retry passes to its run. */
const MAX_MEMO_BYTES = 800 * 1024;

async function lambda<T>(engine: Engine, path: string, init: RequestInit = { method: "GET" }): Promise<T> {
  const response = await awsFetch("lambda", `${base}${path}`, init as any, { aws: engine.aws });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Lambda ${init.method ?? "GET"} ${path.split("?")[0]} failed: ${response.status} ${text}`.trim());
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function time(t: string | number | undefined) {
  if (t === undefined || t === null) return undefined;
  const n = typeof t === "number" ? t : Number(t);
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n);
  return new Date(t);
}

function summary(e: any): RunSummary {
  return {
    id: e.DurableExecutionName,
    arn: e.DurableExecutionArn,
    status: e.Status,
    startedAt: time(e.StartTimestamp)!,
    endedAt: time(e.EndTimestamp),
  };
}

function parse(text: string | undefined) {
  if (text === undefined || text === null || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The run ID prefix of a function. */
export function runPrefix(fn: string) {
  return `${fn.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "fn"}-`;
}

export async function listRuns(engine: Engine, input: ListInput = {}): Promise<RunSummary[]> {
  const fn = typeof input.function === "string" ? input.function : input.function?.id;
  const prefix = fn ? runPrefix(fn) : undefined;
  const limit = Math.min(Math.max(1, input.limit ?? 100), 1000);
  const runs: RunSummary[] = [];
  let marker: string | undefined;
  // At most 10 pages, so a filter that matches little can't page forever.
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ MaxItems: "1000", ReverseOrder: "true" });
    if (input.status) params.set("Statuses", input.status);
    if (input.from) params.set("StartedAfter", new Date(input.from).toISOString());
    if (input.to) params.set("StartedBefore", new Date(input.to).toISOString());
    if (marker) params.set("Marker", marker);
    const result = await lambda<any>(engine, `/functions/${encodeURIComponent(engine.worker.name)}/durable-executions?${params}`);
    for (const e of result.DurableExecutions ?? []) {
      if (prefix && !String(e.DurableExecutionName).startsWith(prefix)) continue;
      runs.push(summary(e));
    }
    marker = result.NextMarker;
    if (!marker || runs.length >= limit) break;
  }
  return runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, limit);
}

async function find(engine: Engine, runId: string): Promise<RunSummary | undefined> {
  const params = new URLSearchParams({ DurableExecutionName: runId, MaxItems: "10" });
  const page = await lambda<any>(engine, `/functions/${encodeURIComponent(engine.worker.name)}/durable-executions?${params}`);
  const match = (page.DurableExecutions ?? []).find((e: any) => e.DurableExecutionName === runId);
  return match ? summary(match) : undefined;
}

async function history(engine: Engine, arn: string) {
  const events: any[] = [];
  let marker: string | undefined;
  do {
    const params = new URLSearchParams({ MaxItems: "1000", IncludeExecutionData: "true" });
    if (marker) params.set("Marker", marker);
    const page = await lambda<any>(engine, `/durable-executions/${encodeURIComponent(arn)}/history?${params}`);
    events.push(...(page.Events ?? []));
    marker = page.NextMarker;
  } while (marker);
  return events;
}

async function detail(engine: Engine, arn: string) {
  return lambda<any>(engine, `/durable-executions/${encodeURIComponent(arn)}?IncludeExecutionData=true`);
}

export async function getRun(engine: Engine, runId: string): Promise<Run | undefined> {
  const found = await find(engine, runId);
  if (!found) return undefined;
  const [info, events] = await Promise.all([detail(engine, found.arn), history(engine, found.arn)]);
  const payload = parse(info.InputPayload) as RunPayload | undefined;
  const steps = toSteps(events);
  const logGroup = `/aws/lambda/${engine.worker.name}`;
  const region = process.env.AWS_REGION ?? "us-east-1";
  return {
    ...found,
    function: payload?.fn ?? "",
    event: payload?.event as WireEvent,
    replayOf: payload?.replayOf,
    reused: payload?.memo ? Object.keys(payload.memo) : undefined,
    version: info.Version,
    output: parse(info.Result),
    error: info.Error ? { name: info.Error.ErrorType, message: info.Error.ErrorMessage } : undefined,
    steps,
    failedStep: steps.find((s) => s.status === "failed"),
    links: {
      logGroup,
      logs: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(logGroup).replace(/%/g, "$25")}`,
    },
  };
}

export async function cancelRun(engine: Engine, runId: string) {
  const found = await find(engine, runId);
  if (!found) throw new Error(`There's no run "${runId}".`);
  const info = await detail(engine, found.arn);
  const payload = parse(info.InputPayload) as RunPayload | undefined;
  const stopped = await engine.stopRun(found.arn);
  // The run that invoked it would otherwise wait for it.
  if (stopped && payload?.parent)
    await engine.callback(payload.parent, {
      ok: false,
      error: { name: "Cancelled", message: "The run was cancelled." },
    } satisfies InvokeOutcome);
  return { id: runId, stopped };
}

/**
 * Run a function again with the event of an earlier run, as a new run on the latest
 * deployed version. With `reuse`, the steps that succeeded return their saved
 * results instead of running again: the retry picks up at the step that failed.
 */
export async function rerun(engine: Engine, runId: string, reuse: boolean): Promise<{ id: string; replayOf: string; reused: string[] }> {
  const found = await find(engine, runId);
  if (!found) throw new Error(`There's no run "${runId}".`);
  if (reuse && (found.status === "RUNNING" || found.status === "PAUSED" || found.status === "PAUSING"))
    throw new Error(`The run "${runId}" is still running. Cancel it first, or replay it.`);
  const [info, events] = await Promise.all([detail(engine, found.arn), reuse ? history(engine, found.arn) : Promise.resolve([])]);
  const payload = parse(info.InputPayload) as RunPayload | undefined;
  if (!payload?.fn) throw new Error(`The run "${runId}" isn't an EventFlow run.`);
  if (payload.parent) throw new Error(`The run "${runId}" was invoked by another run. Retry or replay that run instead.`);
  const memo = reuse ? { ...(payload.memo ?? {}), ...memoFrom(events) } : undefined;
  if (memo && Buffer.byteLength(JSON.stringify(memo)) > MAX_MEMO_BYTES)
    throw new Error(`The saved results of "${runId}" are over ${MAX_MEMO_BYTES} bytes. Replay it instead, to run every step again.`);
  const id = replayId(runId);
  const { sig: _sig, ...rest } = payload;
  await engine.startRun({ ...rest, runId: id, replayOf: runId, memo });
  return { id, replayOf: runId, reused: memo ? Object.keys(memo) : [] };
}

export async function rerunAll(
  engine: Engine,
  input: ListInput & { reuse: boolean },
): Promise<{ id: string; result?: { id: string }; error?: string }[]> {
  const runs = await listRuns(engine, { ...input, status: input.status ?? "FAILED", limit: Math.min(input.limit ?? 50, 100) });
  const out: { id: string; result?: { id: string }; error?: string }[] = [];
  for (const run of runs) {
    try {
      const result = await rerun(engine, run.id, input.reuse);
      out.push({ id: run.id, result: { id: result.id } });
    } catch (error) {
      out.push({ id: run.id, error: (error as Error).message });
    }
  }
  return out;
}

/**
 * Stop the runs that match: by default, the ones running. Up to 500 at a time, 10 at
 * once. Before an EventFlow with many runs in flight is removed, this is faster than
 * `sst remove`, which stops them one at a time.
 */
export async function cancelAll(engine: Engine, input: ListInput = {}) {
  const runs: RunSummary[] = [];
  for (const status of input.status ? [input.status] : (["RUNNING", "PAUSED"] as RunStatus[]))
    runs.push(...(await listRuns(engine, { ...input, status, limit: Math.min(input.limit ?? 500, 500) })));
  const out: { id: string; stopped?: boolean; error?: string }[] = [];
  for (let i = 0; i < runs.length; i += 10) {
    const results = await Promise.allSettled(runs.slice(i, i + 10).map((r) => cancelRun(engine, r.id)));
    results.forEach((r, j) =>
      out.push(
        r.status === "fulfilled"
          ? { id: runs[i + j].id, stopped: r.value.stopped }
          : { id: runs[i + j].id, error: (r.reason as Error)?.message ?? String(r.reason) },
      ),
    );
  }
  return out;
}

/**
 * The results of a run's top-level steps that succeeded, by step ID, from its
 * history. A retry passes them to its run, so those steps aren't run again.
 */
export function memoFrom(events: any[]): Record<string, unknown> {
  const memo: Record<string, unknown> = Object.create(null);
  for (const e of events) {
    if (e.ParentId) continue;
    const name: string | undefined = e.Name;
    if (!name || name.startsWith("sst:")) continue;
    const type = String(e.EventType ?? "");
    const payload = (d: any) => {
      if (d?.Result?.Truncated) throw new Error(`The result of step "${name}" is too large to reuse. Replay the run instead.`);
      const text = d?.Result?.Payload;
      return text === undefined || text === "" ? null : JSON.parse(text);
    };
    if (type === "StepSucceeded") memo[name] = payload(e.StepSucceededDetails);
    else if (type === "WaitSucceeded") memo[name] = true;
    else if (type === "ContextSucceeded") {
      const value = payload(e.ContextSucceededDetails);
      if (e.SubType === "EventFlowStep") {
        if (value?.ok) memo[name] = value.value;
      } else if (e.SubType === "EventFlowInvoke") {
        if (value?.ok) memo[name] = value.result;
      } else if (e.SubType === "EventFlowWait") memo[name] = value;
    }
  }
  return memo;
}

// The child contexts EventFlow makes, by their subtype.
const SUBTYPES: Record<string, StepRecord["type"]> = {
  EventFlowStep: "step",
  EventFlowWait: "waitForEvent",
  EventFlowInvoke: "invoke",
};

const TYPES: Record<string, StepRecord["type"]> = {
  Step: "step",
  Wait: "sleep",
  Callback: "callback",
  Context: "group",
  ChainedInvoke: "invoke",
};

// Turn the history's events into one record per operation. Operations in a child
// context are named under the context, like "charge/run".
export function toSteps(events: any[]): StepRecord[] {
  const ops = new Map<string, StepRecord & { parent?: string; name: string }>();
  for (const e of events) {
    const type = String(e.EventType ?? "");
    const match = type.match(/^(Step|Wait|Callback|Context|ChainedInvoke)(Started|Succeeded|Failed|TimedOut|Cancelled|Stopped)$/);
    if (!match || !e.Id) continue;
    const [, kind, phase] = match;
    let op = ops.get(e.Id);
    if (!op) {
      op = {
        id: e.Name ?? e.Id,
        name: e.Name ?? e.Id,
        parent: e.ParentId,
        type: SUBTYPES[e.SubType] ?? TYPES[kind] ?? "other",
        status: kind === "Wait" || kind === "Callback" ? "waiting" : "running",
        attempts: 0,
      };
      ops.set(e.Id, op);
    }
    const at = time(e.EventTimestamp);
    if (phase === "Started") {
      op.startedAt ??= at;
      if (kind === "Step") op.attempts++;
      continue;
    }
    const details = e[`${kind}${phase}Details`] ?? {};
    const attempt = details.RetryDetails?.CurrentAttempt;
    if (typeof attempt === "number") op.attempts = Math.max(op.attempts, attempt);
    if (phase === "Succeeded") {
      op.status = "succeeded";
      op.endedAt = at;
      op.error = undefined;
      // A step with a concurrency limit, and an invoke, end their context with the
      // outcome, and throw outside it. An outcome that isn't ok is the step failing.
      if (kind === "Context" && (e.SubType === "EventFlowStep" || e.SubType === "EventFlowInvoke")) {
        let outcome: any;
        try {
          outcome = JSON.parse(details.Result?.Payload ?? "null");
        } catch {}
        if (outcome && outcome.ok === false) {
          op.status = "failed";
          op.error = { name: outcome.error?.name, message: outcome.error?.message };
        }
      }
    } else if (phase === "Failed") {
      // A step that will retry has a next attempt.
      const retrying = details.RetryDetails?.NextAttemptDelaySeconds !== undefined;
      op.status = retrying ? "running" : "failed";
      op.endedAt = retrying ? undefined : at;
      const payload = details.Error?.Payload ?? {};
      op.error = { name: payload.ErrorType, message: payload.ErrorMessage };
    } else if (phase === "TimedOut") {
      op.status = "timed out";
      op.endedAt = at;
    } else {
      op.status = "cancelled";
      op.endedAt = at;
    }
  }

  // Name each operation under its parents.
  const full = (op: StepRecord & { parent?: string; name: string }): string => {
    const parent = op.parent ? ops.get(op.parent) : undefined;
    return parent ? `${full(parent)}/${op.name}` : op.name;
  };
  const list = [...ops.values()].map((op) => ({ ...op, id: full(op) }));
  // A step with a concurrency limit was tried as many times as it has "run" steps.
  for (const op of list)
    if (op.type === "step" && !op.attempts)
      op.attempts = list.filter((o) => o.id === `${op.id}/run` || o.id.startsWith(`${op.id}/run:`)).length;
  // A step with a concurrency limit has "lease" and "run" steps in it. Its failure is
  // the failure of its last "run" step.
  for (const op of list) {
    if (op.status === "failed" && !op.error) {
      const last = list.filter((o) => o.id.startsWith(`${op.id}/run`)).pop();
      if (last) op.error = last.error;
    }
  }
  return list.map(({ parent: _p, name: _n, ...rest }) => rest);
}
