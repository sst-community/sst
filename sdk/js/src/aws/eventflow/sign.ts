import { createHmac, timingSafeEqual } from "crypto";
import type { AwsOptions } from "../client.js";
import { ssm } from "./aws.js";

// The router and the worker sign what they start, with a key only they have. The
// worker runs nothing that isn't signed, and the router holds or starts nothing from
// the queue that isn't. So a principal that can invoke the worker, or send to the
// queue, can't start a run around the router's checks, or answer another run's
// callback.

export const ENV_KEY = "SST_EVENTFLOW_KEY";
/** The SSM parameter that holds the key, as a SecureString. */
export const ENV_KEY_PARAM = "SST_EVENTFLOW_KEY_PARAM";

let loaded: string | undefined;

/**
 * Load the key, once per container. It's in an SSM SecureString, not in the
 * function's environment, which anyone who can read the function's configuration
 * sees. A test, or `sst dev`, can set it in the environment instead.
 */
export async function loadKey(aws?: AwsOptions) {
  if (loaded) return;
  if (process.env[ENV_KEY]) {
    loaded = process.env[ENV_KEY];
    return;
  }
  const name = process.env[ENV_KEY_PARAM];
  if (!name) return;
  // Many containers starting at once can be throttled by SSM: try again, with backoff.
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await ssm<{ Parameter?: { Value?: string } }>("GetParameter", { Name: name, WithDecryption: true }, aws);
      loaded = result.Parameter?.Value;
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, Math.random() * 100 * 2 ** attempt + 50));
    }
  }
}

/**
 * A run's root, which its idempotency keys and the IDs of the events it sends come
 * from. It's keyed with the signing key, so someone who knows an event's ID can't
 * work out those IDs, and send events with them first.
 */
export function deriveRoot(runId: string) {
  return createHmac("sha256", secret()).update(`root\n${runId}`).digest("base64url").slice(0, 26);
}

function secret() {
  const value = loaded ?? process.env[ENV_KEY];
  if (!value) throw new Error("The EventFlow's signing key isn't loaded. Is this running in its router or worker?");
  return value;
}

/** JSON with sorted keys, so the same value always signs the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as any)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`);
  return `{${entries.join(",")}}`;
}

export function signature(value: object) {
  return createHmac("sha256", secret()).update(canonical(value)).digest("base64url");
}

export function sign<T extends object>(value: T): T & { sig: string } {
  const { sig: _old, ...rest } = value as any;
  return { ...rest, sig: signature(rest) } as T & { sig: string };
}

export function verify(value: { sig?: unknown } | undefined | null) {
  if (!value || typeof value.sig !== "string") return false;
  const { sig, ...rest } = value as any;
  const expected = Buffer.from(signature(rest));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
