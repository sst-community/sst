import ts from "typescript";
import { exports, fiveName, leftOut, type Group } from "./names";

/** Where the 5.0 components are: `sst.aws.v5` until the swap, `sst.aws` after. */
export type Namespace = "v5" | "";

/** A change the codemod made, or something it couldn't do, with what to write. */
export interface Finding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A component an expression names, as the config writes it. */
export interface Ref {
  group: Group;
  /** Its name as written, like `ApiGatewayV2` */
  name: string;
  /** Its 5.0 name, like `ApiGatewayHttp` */
  five: string;
  /** Whether the config already writes it as `sst.<group>.v5.X` */
  written5: boolean;
  /** The `new` that made it, when the config has one */
  created?: ts.NewExpression;
}

/** One file's edits, changes and notes, while the rules run over it. */
export class FileContext {
  readonly edits: Edit[] = [];
  readonly changes: Finding[] = [];
  readonly notes: Finding[] = [];
  // Props moved into an object that may not exist yet, by where they go
  private moves = new Map<
    string,
    {
      root: ts.ObjectLiteralExpression;
      path: string[];
      props: {
        key: string;
        // A prop moved, from its object, or an entry put there as code
        prop?: ts.ObjectLiteralElementLike;
        from?: ts.ObjectLiteralExpression;
        keep?: boolean;
        text?: string;
      }[];
    }
  >();

  constructor(
    readonly sf: ts.SourceFile,
    readonly checker: ts.TypeChecker,
    readonly namespace: Namespace,
    readonly file: string,
  ) {}

  line(node: ts.Node) {
    return (
      this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1
    );
  }

  text(node: ts.Node) {
    return node.getText(this.sf);
  }

  edit(start: number, end: number, text: string) {
    this.edits.push({ start, end, text });
  }

  replace(node: ts.Node, text: string) {
    this.edit(node.getStart(this.sf), node.getEnd(), text);
  }

  change(node: ts.Node, rule: string, message: string) {
    this.changes.push({
      file: this.file,
      line: this.line(node),
      rule,
      message,
    });
  }

  note(node: ts.Node, rule: string, message: string) {
    this.notes.push({ file: this.file, line: this.line(node), rule, message });
  }

  /** The 5.0 way to write a component: `sst.aws.v5.X` until the swap. */
  qualified(ref: { group: Group; five: string }) {
    return `sst.${ref.group}.${this.namespace ? `${this.namespace}.` : ""}${
      ref.five
    }`;
  }

  // Props to remove, by their object, removed together at the end
  private removals = new Map<
    ts.ObjectLiteralExpression,
    Set<ts.ObjectLiteralElementLike>
  >();

  /** Remove a prop from an object, with its comma and the comments before it. */
  remove(obj: ts.ObjectLiteralExpression, prop: ts.ObjectLiteralElementLike) {
    const set = this.removals.get(obj) ?? new Set();
    set.add(prop);
    this.removals.set(obj, set);
  }

  // Objects something was put in, which aren't removed when emptied
  private filled = new Set<ts.ObjectLiteralExpression>();

  // Each run of props removed side by side is one edit, so two don't overlap.
  // An object left with nothing in it goes, with its key, as `transform: {}`
  // would say nothing.
  private flushRemovals() {
    let emptied = true;
    while (emptied) {
      emptied = false;
      for (const [obj, removed] of this.removals) {
        const holder = obj.parent;
        if (
          removed.size === obj.properties.length &&
          !this.filled.has(obj) &&
          ts.isPropertyAssignment(holder) &&
          ts.isObjectLiteralExpression(holder.parent)
        ) {
          this.removals.delete(obj);
          this.remove(holder.parent, holder);
          emptied = true;
        }
      }
    }
    // A prop inside one that's removed goes with it
    const removedNodes = new Set<ts.Node>();
    for (const set of this.removals.values())
      for (const p of set) removedNodes.add(p);
    for (const [obj, set] of this.removals) {
      let up: ts.Node | undefined = obj.parent;
      while (up && !removedNodes.has(up)) up = up.parent;
      if (up) this.removals.delete(obj);
      else for (const p of set) if (!obj.properties.includes(p)) set.delete(p);
    }
    for (const [obj, removed] of this.removals) {
      const props = obj.properties;
      let i = 0;
      while (i < props.length) {
        if (!removed.has(props[i])) {
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < props.length && removed.has(props[j + 1])) j++;
        const first = props[i];
        const last = props[j];
        if (j < props.length - 1)
          this.edit(first.getFullStart(), props[j + 1].getFullStart(), "");
        else {
          const comma = /^\s*,/.exec(this.sf.text.slice(last.getEnd()));
          if (comma)
            this.edit(
              first.getFullStart(),
              last.getEnd() + comma[0].length,
              "",
            );
          else if (i > 0) this.edit(props[i - 1].getEnd(), last.getEnd(), "");
          else this.edit(first.getFullStart(), last.getEnd(), "");
        }
        i = j + 1;
      }
    }
    this.removals.clear();
  }

  /** Rename a prop's key, keeping its value. */
  rename(prop: ts.ObjectLiteralElementLike, key: string) {
    if (ts.isShorthandPropertyAssignment(prop))
      this.replace(prop, `${key}: ${this.text(prop.name)}`);
    else if (prop.name) this.replace(prop.name, key);
  }

  /**
   * Move a prop of `from` into the object at `path` under `root`, as `key`,
   * creating what isn't there. Moves to the same place are written together,
   * at the end, so two props moved into a new `existing` make one.
   */
  move(
    from: ts.ObjectLiteralExpression,
    prop: ts.ObjectLiteralElementLike,
    root: ts.ObjectLiteralExpression,
    path: string[],
    key: string,
    // Not removed from `from`, as something around it is
    keep = false,
  ) {
    const id = `${root.pos}:${path.join(".")}`;
    const entry = this.moves.get(id) ?? { root, path, props: [] };
    entry.props.push({ prop, key, from, keep });
    this.moves.set(id, entry);
  }

  /**
   * Put an entry, as code, into the object at `path` under `root`, creating
   * what isn't there, with the moves to the same place.
   */
  put(
    root: ts.ObjectLiteralExpression,
    path: string[],
    key: string,
    text: string,
  ) {
    const id = `${root.pos}:${path.join(".")}`;
    const entry = this.moves.get(id) ?? { root, path, props: [] };
    entry.props.push({ key, text });
    this.moves.set(id, entry);
  }

  // Nodes a rule rewrote whole, which the rules for what's in them leave
  private skipped = new Set<ts.Node>();

  /** Leave a node to the rule that rewrites what's around it. */
  skip(node: ts.Node) {
    this.skipped.add(node);
  }

  isSkipped(node: ts.Node) {
    return this.skipped.has(node);
  }

  /** Write the moves the rules asked for. */
  finish() {
    for (const { root, path, props } of this.moves.values()) {
      const entries = props.map(
        ({ prop, key, text }) => `${key}: ${text ?? valueText(this, prop!)}`,
      );
      // The deepest object of the path that's there
      let target = root;
      let depth = 0;
      while (depth < path.length) {
        const next = objectProp(target, path[depth]);
        if (!next) break;
        target = next;
        depth++;
      }
      const rest = path.slice(depth);
      const inner = rest.reduceRight(
        (acc, key) => `${key}: { ${acc} }`,
        entries.join(", "),
      );
      // A prop of the object the new entry goes in becomes it, in its place
      const inPlace =
        rest.length > 0
          ? props.find((p) => p.prop && p.from === target)
          : undefined;
      if (inPlace) this.replace(inPlace.prop!, inner);
      else {
        insertFirst(this, target, inner);
        this.filled.add(target);
      }
      for (const p of props)
        if (p !== inPlace && !p.keep && p.prop && p.from)
          this.remove(p.from, p.prop);
    }
    this.moves.clear();
    this.flushRemovals();
  }

  /** The file's text with its edits made, or undefined if there are none. */
  output() {
    if (this.edits.length === 0) return undefined;
    const edits = [...this.edits].sort(
      (a, b) => b.start - a.start || b.end - a.end,
    );
    let text = this.sf.text;
    let last = Infinity;
    for (const e of edits) {
      if (e.end > last)
        throw new Error(
          `Two of the codemod's edits overlap in ${this.file}, at offset ${e.start}`,
        );
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
      last = e.start;
    }
    return text;
  }
}

// A prop's value as text, `x` for a shorthand `x`
function valueText(ctx: FileContext, prop: ts.ObjectLiteralElementLike) {
  if (ts.isPropertyAssignment(prop)) return ctx.text(prop.initializer);
  if (ts.isShorthandPropertyAssignment(prop)) return ctx.text(prop.name);
  return ctx.text(prop);
}

// Insert an entry first in an object, on its own line when the object's
// entries are. It goes before the first entry's comments and space, so it
// sits beside the first entry's removal, if that's removed too.
function insertFirst(
  ctx: FileContext,
  obj: ts.ObjectLiteralExpression,
  entry: string,
) {
  const first = obj.properties[0];
  if (!first) {
    ctx.edit(obj.getStart(ctx.sf) + 1, obj.getEnd() - 1, ` ${entry} `);
    return;
  }
  const lead = ctx.sf.text.slice(first.getFullStart(), first.getStart(ctx.sf));
  const newline = lead.lastIndexOf("\n");
  const space =
    newline >= 0 ? lead.slice(newline).replace(/[^\n\s].*$/s, "") : " ";
  ctx.edit(first.getFullStart(), first.getFullStart(), `${space}${entry},`);
}

/** A prop of an object literal by its key. */
export function prop(obj: ts.ObjectLiteralExpression | undefined, key: string) {
  return obj?.properties.find((p) => keyOf(p) === key);
}

/** The object literal a prop of an object literal holds. */
export function objectProp(
  obj: ts.ObjectLiteralExpression | undefined,
  key: string,
) {
  const p = prop(obj, key);
  return p &&
    ts.isPropertyAssignment(p) &&
    ts.isObjectLiteralExpression(p.initializer)
    ? p.initializer
    : undefined;
}

/** The object literal at a path of keys. */
export function objectAt(
  obj: ts.ObjectLiteralExpression | undefined,
  path: string[],
) {
  let current = obj;
  for (const key of path) current = objectProp(current, key);
  return current;
}

export function keyOf(p: ts.ObjectLiteralElementLike) {
  const name = p.name;
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  )
    return name.text;
  return undefined;
}

/** The value of a prop, when it's a literal: `true`, `false`, a string or a number. */
export function literal(p: ts.ObjectLiteralElementLike | undefined) {
  if (!p || !ts.isPropertyAssignment(p)) return undefined;
  const v = p.initializer;
  if (v.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (v.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteralLike(v)) return v.text;
  if (ts.isNumericLiteral(v)) return Number(v.text);
  return undefined;
}

/**
 * The component a chain like `sst.aws.Function` or `sst.aws.v5.Function` names,
 * in a value or a type. With `v1` for `sst.aws.Vpc.v1`.
 */
export function chain(node: ts.Node): (Ref & { v1?: boolean }) | undefined {
  const parts: string[] = [];
  let current: ts.Node = node;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isQualifiedName(current)
  ) {
    const name = ts.isPropertyAccessExpression(current)
      ? current.name
      : current.right;
    parts.unshift(name.text);
    current = ts.isPropertyAccessExpression(current)
      ? current.expression
      : current.left;
  }
  if (!ts.isIdentifier(current) || current.text !== "sst") return undefined;
  const [group, ...rest] = parts;
  if (group !== "aws" && group !== "cloudflare" && group !== "x")
    return undefined;
  const written5 = rest[0] === "v5";
  let names = written5 ? rest.slice(1) : rest;
  // Cloudflare's experimental names, like `sst.cloudflare.x.Astro`
  if (group === "cloudflare" && names[0] === "x") {
    if (!names[1]) return undefined;
    names = [`x.${names[1]}`, ...names.slice(2)];
  }
  if (names.length === 0 || names.length > 2) return undefined;
  const [name, member] = names;
  if (member !== undefined && member !== "v1") return undefined;
  const five = fiveName(group, name);
  return { group, name, five, written5, ...(member === "v1" && { v1: true }) };
}

/** Whether a name is one of a group's 5.0 components, or one of their types. */
export function isFive(group: Group, five: string) {
  return exports[group].includes(five);
}

/** Whether a 4.x name has no 5.0 form, by its group. */
export function isLeftOut(group: Group, name: string) {
  return name in leftOut[group];
}

/**
 * The component an expression is: a `new sst.aws.X(...)`, an `sst.aws.X.get(...)`,
 * or a variable that holds one, followed through imports by its symbol. Types
 * aren't used, as after the swap an app's 4.x names have none.
 */
export function componentOf(
  ctx: FileContext,
  expr: ts.Expression,
  depth = 0,
): Ref | undefined {
  if (depth > 5) return undefined;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  )
    expr = expr.expression;
  if (ts.isNewExpression(expr)) {
    const ref = chain(expr.expression);
    return ref && { ...ref, created: expr };
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "get"
  )
    return chain(expr.expression.expression);
  if (ts.isAwaitExpression(expr))
    return componentOf(ctx, expr.expression, depth + 1);
  if (ts.isIdentifier(expr)) {
    let symbol = ctx.checker.getSymbolAtLocation(expr);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = ctx.checker.getAliasedSymbol(symbol);
    let decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    // `const { api } = await import("./infra/api")`, as an app loads its files
    // in `run()`: what the module exports under that name
    if (
      decl &&
      ts.isBindingElement(decl) &&
      ts.isObjectBindingPattern(decl.parent)
    ) {
      const holder = decl.parent.parent;
      let init = ts.isVariableDeclaration(holder)
        ? holder.initializer
        : undefined;
      while (
        init &&
        (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init))
      )
        init = init.expression;
      const name = (decl.propertyName ?? decl.name) as ts.Node;
      if (
        init &&
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isIdentifier(name)
      ) {
        const mod =
          init.arguments[0] &&
          ctx.checker.getSymbolAtLocation(init.arguments[0]);
        const exported =
          mod &&
          ctx.checker.getExportsOfModule(mod).find((e) => e.name === name.text);
        const target =
          exported && exported.flags & ts.SymbolFlags.Alias
            ? ctx.checker.getAliasedSymbol(exported)
            : exported;
        decl = target?.valueDeclaration ?? target?.declarations?.[0];
      }
    }
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const sf = decl.getSourceFile();
      const inner =
        sf === ctx.sf
          ? ctx
          : new FileContext(sf, ctx.checker, ctx.namespace, sf.fileName);
      return componentOf(inner, decl.initializer, depth + 1);
    }
  }
  return undefined;
}

/** The args object of a `new` call, when it's written as an object literal. */
export function argsOf(
  call: ts.NewExpression | ts.CallExpression,
  index: number,
) {
  const arg = call.arguments?.[index];
  return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
}

/**
 * The name to give a component looked up with `get`, from the name of what's
 * done with it, like a subscriber's.
 */
export function getName(
  ctx: FileContext,
  name: ts.Expression | undefined,
  suffix: string,
  fallback = "Subscribed",
) {
  if (name && ts.isStringLiteralLike(name))
    return JSON.stringify(name.text + suffix);
  if (name) return `\`\${${ctx.text(name)}}${suffix}\``;
  return JSON.stringify(`${fallback}${suffix}`);
}
