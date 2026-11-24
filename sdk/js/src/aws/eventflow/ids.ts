import { createHash, randomBytes } from "crypto";

// Crockford's base32: no I, L, O or U, so IDs are easy to read and say.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(bytes: Uint8Array, length: number) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/**
 * A ULID: 26 characters, sorted by the time they were made.
 */
export function ulid(now = Date.now()) {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + base32(randomBytes(10), 16);
}

export function hash(input: string, length = 26) {
  return base32(createHash("sha256").update(input).digest(), length);
}

/**
 * The run ID is the name of the durable execution. Lambda starts one execution per
 * name, so the same function and the same event make the same ID, and an event that
 * is delivered twice starts one run.
 *
 * It's 1 to 64 letters, digits, - and _. It starts with the function's ID, so it's
 * easy to tell runs apart in the console.
 */
export function runId(functionId: string, identity: string) {
  const slug = functionId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
  return `${slug || "fn"}-${hash(`${functionId}\n${identity}`)}`;
}

/**
 * The ID of a replay of a run. A replay is a new execution, so it needs a new name.
 */
export function replayId(id: string, now = Date.now()) {
  const base = id.replace(/_r[0-9A-Z]{10}$/, "").slice(0, 52);
  return `${base}_r${hash(`${id}\n${now}\n${randomBytes(4).toString("hex")}`, 10)}`;
}

/**
 * A key for a table item, from parts that may hold any characters. The parts are
 * encoded as a JSON array, then hashed, so two different lists of parts never make
 * the same key, whatever `#` or other characters they have.
 */
export function key(prefix: string, ...parts: unknown[]) {
  return `${prefix}#${hash(JSON.stringify(parts), 26)}`;
}
