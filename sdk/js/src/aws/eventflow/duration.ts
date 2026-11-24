// Durations, as Inngest accepts them: a number of milliseconds, or a string like
// "30s", "5m", "1h", "2d", "1w", "1h30m", or "2 hours".

const UNITS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

export type DurationInput = number | string;

/**
 * Parse a duration into milliseconds. Throws a `TypeError` that names the input when
 * it can't be parsed, so a typo fails the run instead of sleeping for no time.
 */
export function parseDuration(input: DurationInput, label = "duration"): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0)
      throw new TypeError(`The ${label} ${input} isn't a number of milliseconds.`);
    return input;
  }
  if (typeof input !== "string")
    throw new TypeError(`The ${label} must be a number of milliseconds or a string like "1h".`);

  const text = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = "";
  for (const match of text.matchAll(pattern)) {
    const unit = UNITS[match[2]];
    if (unit === undefined) break;
    total += Number(match[1]) * unit;
    consumed += match[0];
  }
  if (!consumed || consumed.replace(/\s/g, "") !== text.replace(/\s/g, ""))
    throw new TypeError(
      `The ${label} "${input}" isn't a duration. Use milliseconds or a string like "30s", "5m", "1h", or "2d".`,
    );
  return total;
}

/**
 * A durable wait takes whole seconds. Round up, and wait at least one second.
 */
export function toDurableSeconds(ms: number) {
  return { seconds: Math.max(1, Math.ceil(ms / 1000)) };
}
