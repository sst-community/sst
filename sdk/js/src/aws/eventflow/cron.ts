// A 5-field cron expression, with an optional "TZ=Area/City " prefix, as Inngest
// accepts it: minute hour day-of-month month day-of-week.
//
// The engine has one schedule that ticks every minute. On each tick, each cron
// trigger is checked against that minute, in its time zone.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field {
  min: number;
  max: number;
  names?: string[];
  // For month names, "jan" is 1. For day names, "sun" is 0.
  nameOffset?: number;
}

const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS, nameOffset: 1 },
  { min: 0, max: 7, names: DAYS, nameOffset: 0 },
];

export interface Cron {
  expression: string;
  timezone: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  // Cron's rule: when both day fields are restricted, a day matches either one.
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export function parseCron(input: string): Cron {
  let text = input.trim();
  let timezone = "UTC";
  const tz = text.match(/^(?:CRON_TZ|TZ)=(\S+)\s+(.*)$/);
  if (tz) {
    timezone = tz[1];
    text = tz[2].trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new TypeError(`The cron "${input}" has an unknown time zone "${timezone}".`);
    }
  }
  text = MACROS[text.toLowerCase()] ?? text;

  const parts = text.split(/\s+/);
  if (parts.length !== 5)
    throw new TypeError(
      `The cron "${input}" needs 5 fields: minute hour day-of-month month day-of-week.`,
    );

  const sets = parts.map((part, i) => parseField(part, FIELDS[i], input));
  // 7 is also Sunday.
  if (sets[4].delete(7)) sets[4].add(0);

  return {
    expression: input,
    timezone,
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays: sets[4],
    // As in Vixie cron, a field that starts with "*", like "*/2", isn't restricted.
    daysRestricted: !/^[*?]/.test(parts[2]),
    weekdaysRestricted: !/^[*?]/.test(parts[4]),
  };
}

function parseField(part: string, field: Field, input: string): Set<number> {
  const values = new Set<number>();
  for (const item of part.split(",")) {
    const [range, stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new TypeError(`The cron "${input}" has an invalid step "${item}".`);

    let from: number;
    let to: number;
    if (range === "*" || range === "?") {
      from = field.min;
      to = field.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = parseValue(a, field, input);
      to = parseValue(b, field, input);
    } else {
      from = parseValue(range, field, input);
      to = stepText === undefined ? from : field.max;
    }
    if (from > to)
      throw new TypeError(`The cron "${input}" has a backwards range "${item}".`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

function parseValue(text: string, field: Field, input: string) {
  const name = field.names?.indexOf(text.toLowerCase()) ?? -1;
  const value = name >= 0 ? name + (field.nameOffset ?? 0) : Number(text);
  if (!Number.isInteger(value) || value < field.min || value > field.max)
    throw new TypeError(`The cron "${input}" has "${text}", which is out of range.`);
  return value;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(date: Date, timezone: string) {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timezone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
  };
}

/**
 * Whether the cron fires in the minute that `date` falls in.
 */
export function cronMatches(cron: Cron, date: Date): boolean {
  const p = partsIn(date, cron.timezone);
  if (!cron.minutes.has(p.minute)) return false;
  if (!cron.hours.has(p.hour)) return false;
  if (!cron.months.has(p.month)) return false;
  const day = cron.days.has(p.day);
  const weekday = cron.weekdays.has(p.weekday);
  if (cron.daysRestricted && cron.weekdaysRestricted) return day || weekday;
  return day && weekday;
}

/**
 * The minute on the cron's clock, like "2026-11-01T01:30". When the clocks go back,
 * the hour that repeats has the same minutes, so a run named after it starts once.
 */
export function localMinute(cron: Cron, date: Date) {
  const p = partsIn(date, cron.timezone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}
