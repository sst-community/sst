import { createHmac, timingSafeEqual } from "crypto";

// The router and the worker sign what they start, with a key only they have. The
// worker runs nothing that isn't signed, and the router holds or starts nothing from
// the queue that isn't. So a principal that can invoke the worker, or send to the
// queue, can't start a run around the router's checks, or answer another run's
// callback.

export const ENV_KEY = "SST_EVENTFLOW_KEY";

function secret() {
  const value = process.env[ENV_KEY];
  if (!value) throw new Error(`${ENV_KEY} isn't set. Is this running in an EventFlow's router or worker?`);
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
