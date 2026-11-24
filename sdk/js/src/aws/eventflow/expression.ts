// The small part of Inngest's CEL expressions that EventFlow evaluates:
//
//   event.data.customerId                      a path, for keys
//   event.data.plan == "pro"                   comparisons with ==, !=, <, <=, >, >=
//   async.data.userId == event.data.userId     joined with &&
//
// Operands are paths, strings in single or double quotes, numbers, true, false and
// null. Anything else, like ||, !, functions or arithmetic, throws a TypeError that
// says so, instead of being read some other way.

export type Operand =
  | { kind: "path"; path: string[] }
  | { kind: "literal"; value: unknown };

export interface Comparison {
  left: Operand;
  op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "truthy";
  right?: Operand;
}

export interface Expression {
  source: string;
  clauses: Comparison[];
}

const TOKEN =
  /\s*(?:(&&)|(==|!=|<=|>=|<|>)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*))\s*/y;

export function parseExpression(source: string, label: string): Expression {
  if (typeof source !== "string" || !source.trim())
    throw new TypeError(`The ${label} must be a non-empty expression.`);

  const tokens: { type: string; text: string }[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(source);
    if (!m || m.index !== start) {
      throw unsupported(source, label, source.slice(start).trim());
    }
    if (m[1]) tokens.push({ type: "and", text: m[1] });
    else if (m[2]) tokens.push({ type: "op", text: m[2] });
    else if (m[3]) tokens.push({ type: "string", text: m[3] });
    else if (m[4]) tokens.push({ type: "number", text: m[4] });
    else if (m[5]) tokens.push({ type: "ident", text: m[5] });
    else if (TOKEN.lastIndex === start) break;
  }

  const clauses: Comparison[] = [];
  let i = 0;
  const operand = (): Operand => {
    const t = tokens[i++];
    if (!t) throw unsupported(source, label, "the end");
    if (t.type === "string")
      return { kind: "literal", value: unquote(t.text) };
    if (t.type === "number") return { kind: "literal", value: Number(t.text) };
    if (t.type === "ident") {
      if (t.text === "true") return { kind: "literal", value: true };
      if (t.text === "false") return { kind: "literal", value: false };
      if (t.text === "null") return { kind: "literal", value: null };
      return { kind: "path", path: splitPath(t.text) };
    }
    throw unsupported(source, label, t.text);
  };

  while (i < tokens.length) {
    const left = operand();
    const next = tokens[i];
    if (next?.type === "op") {
      i++;
      clauses.push({ left, op: next.text as Comparison["op"], right: operand() });
    } else {
      clauses.push({ left, op: "truthy" });
    }
    if (i < tokens.length) {
      if (tokens[i].type !== "and") throw unsupported(source, label, tokens[i].text);
      i++;
      if (i === tokens.length) throw unsupported(source, label, "&&");
    }
  }
  return { source, clauses };
}

function unsupported(source: string, label: string, near: string) {
  return new TypeError(
    `The ${label} "${source}" isn't supported near "${near}". EventFlow evaluates paths like "event.data.id", literals, comparisons (==, !=, <, <=, >, >=) and &&.`,
  );
}

function unquote(text: string) {
  const body = text.slice(1, -1);
  return body.replace(/\\(.)/g, "$1");
}

function splitPath(text: string) {
  return text
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

export function getPath(scope: unknown, path: string[]): unknown {
  let value: any = scope;
  for (const key of path) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    // Only the value's own properties, so a path can't reach a prototype, like
    // `__proto__` or `constructor`.
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function resolve(operand: Operand, scope: Record<string, unknown>) {
  return operand.kind === "literal" ? operand.value : getPath(scope, operand.path);
}

export function evaluate(expr: Expression, scope: Record<string, unknown>): boolean {
  return expr.clauses.every((c) => {
    const left = resolve(c.left, scope);
    if (c.op === "truthy") return Boolean(left);
    const right = resolve(c.right!, scope);
    switch (c.op) {
      case "==":
        return equal(left, right);
      case "!=":
        return !equal(left, right);
      // Order only compares numbers with numbers, and strings with strings, so a
      // string or a list in an event can't pass a numeric check like `amount > 100`.
      case "<":
        return comparable(left, right) && (left as any) < (right as any);
      case "<=":
        return comparable(left, right) && (left as any) <= (right as any);
      case ">":
        return comparable(left, right) && (left as any) > (right as any);
      case ">=":
        return comparable(left, right) && (left as any) >= (right as any);
    }
  });
}

function comparable(a: unknown, b: unknown) {
  return (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) ||
    (typeof a === "string" && typeof b === "string");
}

function equal(a: unknown, b: unknown) {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a && b)
    return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * Replace every path under `root` with its value in `scope`, so the expression only
 * refers to the other roots. A wait uses it to fix the values from the run's event
 * when the wait starts.
 */
export function bind(expr: Expression, root: string, value: unknown): Expression {
  const sub = (o: Operand | undefined): Operand | undefined =>
    o?.kind === "path" && o.path[0] === root
      ? { kind: "literal", value: getPath(value, o.path.slice(1)) ?? null }
      : o;
  return {
    source: expr.source,
    clauses: expr.clauses.map((c) => ({ ...c, left: sub(c.left)!, right: sub(c.right) })),
  };
}

/**
 * A key: a path like "event.data.customerId", or a function of the event. Returns
 * the key as a string, or undefined when the event has no value there.
 */
export type KeyInput = string | ((event: any) => unknown);

export function compileKey(
  input: KeyInput,
  label: string,
): (scope: Record<string, unknown>) => string | undefined {
  if (typeof input === "function") {
    return (scope) => stringify(input(scope.event));
  }
  const expr = parseExpression(input, label);
  if (expr.clauses.length !== 1 || expr.clauses[0].op !== "truthy")
    throw new TypeError(
      `The ${label} "${input}" must be a single path, like "event.data.customerId".`,
    );
  const operand = expr.clauses[0].left;
  return (scope: Record<string, unknown>) => stringify(resolve(operand, scope));
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}
