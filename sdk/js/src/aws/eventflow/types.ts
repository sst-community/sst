// What goes over the wire between the senders, the router and the worker.

/**
 * An event as the engine stores and delivers it.
 */
export interface WireEvent {
  /** The event's ID. Given by the sender, or made when it's sent. */
  id: string;
  name: string;
  data: unknown;
  /** When it was sent, in ms since the epoch. */
  ts: number;
  v?: string;
  /**
   * The tenant, from the sender. It's the message's MessageGroupId. It's a label the
   * sender asserts: the engine keeps tenants apart, but can't check who they are.
   */
  tenant?: string;
}

/** A queue message. */
export type Message =
  // From a sender.
  | { kind: "event"; event: WireEvent }
  // From the router: a run that a throttle held, to start at `at`. Signed.
  | { kind: "start"; fn: string; event: WireEvent; at: number; parent?: string; sig: string }
  // From the worker: a run another run invokes. Signed.
  | { kind: "invoke"; fn: string; event: WireEvent; parent: string; runId: string; sig: string };

/** The payload a run starts with. Signed by the router or the worker. */
export interface RunPayload {
  "sst:eventflow": 1;
  fn: string;
  runId: string;
  event: WireEvent;
  /** For a replay or a retry, the run it replays. */
  replayOf?: string;
  /** For an invoked run, the callback of the run that invoked it. */
  parent?: string;
  /**
   * For a retry, the results of the steps that succeeded in the run it retries, by
   * step ID. Those steps return their result without running again.
   */
  memo?: Record<string, unknown>;
  sig?: string;
}

/** What the engine's resource gives the SDK, from the link or the environment. */
export interface EngineResource {
  /** The URL of the queue that events are sent to. */
  queueUrl: string;
  /** The name of the router function, which also serves the admin API. */
  routerName: string;
  /** The name of the worker function. Only the router and the worker have it. */
  workerName?: string;
  /** The worker's published version. Only the router has it. */
  workerQualifier?: string;
  /** The name of the table. Only the router and the worker have it. */
  tableName?: string;
  /** The URL of the dead-letter queue. Only the router has it. */
  deadLetterQueueUrl?: string;
  /** The longest a run can take, in seconds. */
  runTimeoutSeconds?: number;
}

export const RUN_MARKER = "sst:eventflow" as const;
export const TICK_MARKER = "sst:eventflow:tick" as const;
export const ADMIN_MARKER = "sst:eventflow:admin" as const;
export const ENV_RESOURCE = "SST_EVENTFLOW";
