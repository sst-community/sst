import crypto from "crypto";
import ts from "typescript";
import {
  chain,
  componentOf,
  FileContext,
  getName,
  objectProp,
  prop,
  type Ref,
} from "./engine";
import type { Rule } from "./rules";

// What SST 4's sub-item methods gave, like a route or a subscriber, is a part
// of the component in 5.0: its `nodes` are read on the component by the
// sub-item's id, and its own `transform` is the component's, for that id.

/** A sub-item's id, as code. */
interface Id {
  text: string;
  /** The variable it's in, when it isn't written as a string */
  node?: ts.Identifier;
}

interface Method {
  /** Its id, from the call: none for a part the component has one of. */
  id?: (call: ts.CallExpression, ctx: FileContext) => Id | undefined;
  /** The sub-item's own args, with its `transform`. */
  args: (call: ts.CallExpression) => ts.Expression | undefined;
  /**
   * SST 4's keys in the result's `nodes`, and where each is in 5.0: a part in
   * the component's `nodes`, or "" for the result itself.
   */
  nodes: Record<string, string>;
  /** The keys of its own `transform`, and the component's part each is. */
  transform: Record<string, string>;
}

const at = (i: number) => (call: ts.CallExpression) => call.arguments[i];

const text = (value: string): Id => ({ text: JSON.stringify(value) });

// A name given as an argument: a string, or a variable
function idOf(e: ts.Expression | undefined): Id | undefined {
  if (!e) return undefined;
  if (ts.isStringLiteralLike(e)) return text(e.text);
  if (ts.isIdentifier(e)) return { text: e.text, node: e };
  return undefined;
}

const nameAt = (i: number) => (call: ts.CallExpression) =>
  idOf(call.arguments[i]);

// The `name` of the args at an argument
const nameIn = (i: number) => (call: ts.CallExpression) => {
  const args = call.arguments[i];
  if (!args || !ts.isObjectLiteralExpression(args)) return undefined;
  const p = prop(args, "name");
  return p && ts.isPropertyAssignment(p) ? idOf(p.initializer) : undefined;
};

// A route's id: "<METHOD> <path>", as the API reads its key
const routeAt =
  (kind: "http" | "rest" | "websocket") => (call: ts.CallExpression) => {
    const route = call.arguments[0];
    if (!route || !ts.isStringLiteralLike(route)) return undefined;
    if (kind === "websocket") return text(route.text);
    if (kind === "http" && route.text.toLowerCase() === "$default")
      return text("$default");
    const [method, path, ...rest] = route.text.split(" ");
    if (!method || !path || rest.length > 0) return undefined;
    return text(`${method.toUpperCase()} ${path}`);
  };

// A resolver's id: its type and field
function resolverId(call: ts.CallExpression) {
  const operation = call.arguments[0];
  if (!operation || !ts.isStringLiteralLike(operation)) return undefined;
  const [type, field, ...rest] = operation.text.trim().split(/\s+/);
  return type && field && rest.length === 0
    ? text(`${type} ${field}`)
    : undefined;
}

// A WebSocket API's authorizer: SST 4 gave it its name first
function webSocketAuthorizerId(call: ts.CallExpression) {
  const first = call.arguments[0];
  return first && ts.isObjectLiteralExpression(first)
    ? nameIn(0)(call)
    : idOf(first);
}

const webSocketAuthorizerArgs = (call: ts.CallExpression) => {
  const first = call.arguments[0];
  return first && ts.isObjectLiteralExpression(first)
    ? first
    : call.arguments[1];
};

// A Realtime subscriber's id: a hash of its filter and its handler, as
// `Realtime` names one that has no name
function realtimeId(call: ts.CallExpression) {
  const [subscriber, args] = call.arguments;
  const handler =
    subscriber && ts.isStringLiteralLike(subscriber)
      ? subscriber.text
      : subscriber && ts.isObjectLiteralExpression(subscriber)
        ? stringOf(prop(subscriber, "handler"))
        : undefined;
  const filter =
    args && ts.isObjectLiteralExpression(args)
      ? stringOf(prop(args, "filter"))
      : undefined;
  if (handler === undefined || filter === undefined) return undefined;
  return text(logicalName(prettyHash(filter + handler, 6)));
}

function stringOf(p: ts.ObjectLiteralElementLike | undefined) {
  return p &&
    ts.isPropertyAssignment(p) &&
    ts.isStringLiteralLike(p.initializer)
    ? p.initializer.text
    : undefined;
}

// As `logicalName` and `hashStringToPrettyString` in the platform's naming,
// which the codemod doesn't load
export function logicalName(name: string) {
  name = name.replace(/[^a-zA-Z0-9]/g, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function prettyHash(value: string, length: number) {
  const hash = crypto.createHash("sha256").update(value).digest("hex");
  let number = Number("0x" + hash.substring(0, 16));
  const chars = "abcdefhkmnorstuvwxz";
  let out = "";
  while (number > 0) {
    out = chars[number % chars.length] + out;
    number = Math.floor(number / chars.length);
  }
  out = out.slice(0, length);
  while (out.length < length) out = "s" + out;
  return out;
}

const httpRoute = (nodes: Record<string, string>): Method => ({
  id: routeAt("http"),
  args: at(2),
  nodes: { ...nodes, route: "route", integration: "integration" },
  transform: { integration: "integration", route: "route" },
});

/**
 * Whether a `subscribe` that took a name first in SST 4 is called without
 * one: the deprecated form, whose subscriber 5.0 doesn't keep. Undefined when
 * it can't be told from the code. `from` is where the name would be.
 */
export function nameless(ctx: FileContext, call: ts.CallExpression, from = 0) {
  const args = call.arguments.slice(from);
  if (args.length >= 3) return false;
  if (args.length <= 1) return true;
  // The second is what's subscribed, or the args of the form with no name
  const second = args[1];
  if (ts.isStringLiteralLike(second) || ts.isPropertyAccessExpression(second))
    return false;
  if (ts.isObjectLiteralExpression(second)) return !prop(second, "handler");
  // A component, like a `Queue` or a `Function`, is what's subscribed
  if (componentOf(ctx, second)) return false;
  return undefined;
}

// The components whose `subscribe` could be called without a name
export const overloaded: Record<string, string[]> = {
  SnsTopic: ["subscribe", "subscribeQueue"],
  Dynamo: ["subscribe"],
  KinesisStream: ["subscribe"],
};

const subscriber = (
  nodes: Record<string, string>,
  transform: Record<string, string>,
  maybeNameless = false,
): Method => ({
  id: (call, ctx) =>
    maybeNameless && nameless(ctx, call) !== false
      ? undefined
      : nameAt(0)(call),
  args: at(2),
  nodes,
  transform,
});

/** Each component's methods whose results are parts in 5.0, by group and name. */
export const methods: Record<string, Record<string, Method>> = {
  "aws:ApiGatewayHttp": {
    route: httpRoute({ function: "handler", permission: "permission" }),
    routeUrl: httpRoute({}),
    routePrivate: httpRoute({}),
    addAuthorizer: {
      id: nameIn(0),
      args: at(0),
      nodes: { authorizer: "" },
      transform: { authorizer: "authorizer" },
    },
  },
  "aws:ApiGatewayRest": {
    ...Object.fromEntries(
      ["route", "routeIntegration"].map((m) => [
        m,
        {
          id: routeAt("rest"),
          args: at(2),
          nodes: {
            ...(m === "route" && {
              function: "handler",
              permission: "permission",
            }),
            integration: "integration",
            method: "method",
          },
          transform: { method: "method", integration: "integration" },
        },
      ]),
    ),
    addAuthorizer: {
      id: nameIn(0),
      args: at(0),
      nodes: { authorizer: "", function: "authorizerFunction" },
      transform: { authorizer: "authorizer" },
    },
  },
  "aws:ApiGatewayWebSocket": {
    route: {
      id: routeAt("websocket"),
      args: at(2),
      nodes: {
        function: "handler",
        permission: "permission",
        route: "route",
        integration: "integration",
      },
      transform: { integration: "integration", route: "route" },
    },
    addAuthorizer: {
      id: webSocketAuthorizerId,
      args: webSocketAuthorizerArgs,
      nodes: { authorizer: "" },
      transform: { authorizer: "authorizer" },
    },
  },
  "aws:AppSync": {
    addDataSource: {
      id: nameIn(0),
      args: at(0),
      nodes: {
        dataSource: "",
        function: "dataSourceFunction",
        serviceRole: "serviceRole",
      },
      transform: { dataSource: "dataSource", serviceRole: "serviceRole" },
    },
    addFunction: {
      id: nameIn(0),
      args: at(0),
      nodes: { function: "" },
      transform: { function: "function" },
    },
    addResolver: {
      id: resolverId,
      args: at(1),
      nodes: { resolver: "resolver" },
      transform: { resolver: "resolver" },
    },
  },
  "aws:Bucket": {
    // Its `notify`'s and `subscribe`'s `transform` is the bucket's: one
    // notification resource holds them all
    notify: {
      args: at(0),
      nodes: {},
      transform: { notification: "notification" },
    },
    ...Object.fromEntries(
      ["subscribe", "subscribeQueue", "subscribeTopic"].map((m) => [
        m,
        { args: at(1), nodes: {}, transform: { notification: "notification" } },
      ]),
    ),
  },
  "aws:Bus": {
    subscribe: subscriber(
      {
        function: "subscriber",
        permission: "permission",
        rule: "rule",
        target: "target",
      },
      { rule: "rule", target: "target" },
    ),
    subscribeQueue: subscriber(
      { policy: "queuePolicy", rule: "rule", target: "target" },
      { rule: "rule", target: "target" },
    ),
  },
  "aws:CognitoUserPool": {
    addIdentityProvider: {
      id: nameAt(0),
      args: at(1),
      nodes: { identityProvider: "" },
      transform: { identityProvider: "identityProvider" },
    },
  },
  ...Object.fromEntries(
    ["Dynamo", "KinesisStream"].map((c) => [
      `aws:${c}`,
      {
        subscribe: subscriber(
          { function: "subscriber", eventSourceMapping: "eventSourceMapping" },
          { eventSourceMapping: "eventSourceMapping" },
          true,
        ),
      },
    ]),
  ),
  "aws:Queue": {
    subscribe: {
      args: at(1),
      nodes: {
        function: "subscriber",
        eventSourceMapping: "eventSourceMapping",
      },
      transform: {
        function: "subscriber",
        eventSourceMapping: "eventSourceMapping",
      },
    },
  },
  "aws:Realtime": {
    subscribe: {
      id: realtimeId,
      args: at(1),
      nodes: {
        function: "subscriber",
        permission: "subscriberPermission",
        rule: "topicRule",
      },
      transform: { topicRule: "topicRule" },
    },
  },
  "aws:SnsTopic": {
    subscribe: subscriber(
      {
        function: "subscriber",
        permission: "permission",
        subscription: "subscription",
      },
      { subscription: "subscription" },
      true,
    ),
    subscribeQueue: subscriber(
      { policy: "queuePolicy", subscription: "subscription" },
      { subscription: "subscription" },
      true,
    ),
  },
  "cloudflare:Queue": {
    subscribe: {
      args: at(1),
      nodes: { worker: "subscriber!.nodes.worker", consumer: "consumer" },
      transform: { worker: "subscriber", consumer: "consumer" },
    },
  },
};

function methodOf(ref: Ref | undefined, method: string) {
  if (!ref || ref.written5) return undefined;
  return methods[`${ref.group}:${ref.five}`]?.[method];
}

// The component's transforms each file's sub-items put there, by the `new`
// that made it and the part
const pending = new WeakMap<
  FileContext,
  Map<ts.NewExpression, Map<string, { id?: Id; value: ts.Expression }[]>>
>();

/**
 * Put a sub-item's own transform of one of the component's parts in the
 * component's `transform`, for its id. It's written when the file is done,
 * with the others for the same part. Gives why it can't, if it can't.
 */
export function toComponent(
  ctx: FileContext,
  ref: Ref,
  part: string,
  id: Id | undefined,
  many: boolean,
  value: ts.Expression,
): string | undefined {
  const created = ref.created;
  const what = `the \`${ref.five}\``;
  if (!created || created.getSourceFile() !== ctx.sf)
    return `the \`new\` of ${what} isn't in this file`;
  const args = created.arguments?.[1];
  if (args && !ts.isObjectLiteralExpression(args))
    return `${what}'s args aren't written as an object here`;
  const transformProp = args && prop(args, "transform");
  const transform = args && objectProp(args, "transform");
  if (transformProp && !transform)
    return `${what}'s \`transform\` isn't written as an object here`;
  if (prop(transform, part))
    return `${what} has a \`transform.${part}\` of its own to put it in`;
  if (many && (!id || id.node))
    return `its id isn't a string the codemod can read`;
  const file = pending.get(ctx) ?? new Map();
  const parts = file.get(created) ?? new Map();
  const list = parts.get(part) ?? [];
  list.push({ id: many ? id : undefined, value });
  parts.set(part, list);
  file.set(created, parts);
  pending.set(ctx, file);
  return undefined;
}

// The component's transform of a part, from its sub-items': for a part there
// are several of, called for each one with its id
function transformText(
  ctx: FileContext,
  entries: { id?: Id; value: ts.Expression }[],
) {
  if (entries.length === 1 && !entries[0].id) return ctx.text(entries[0].value);
  // Names its values don't use
  const used = new Set<string>();
  for (const e of entries) namesIn(e.value, used);
  const free = (name: string) => {
    while (used.has(name)) name += "_";
    return name;
  };
  const [args, opts, name, id] = ["args", "opts", "name", "id"].map(free);
  const branches = entries.map((e) => {
    const value = ctx.text(e.value);
    const apply = ts.isObjectLiteralExpression(e.value)
      ? `Object.assign(${args}, ${value})`
      : ts.isArrowFunction(e.value) || ts.isFunctionExpression(e.value)
        ? `(${value})(${args}, ${opts}, ${name})`
        : `typeof ${value} === "function" ? ${value}(${args}, ${opts}, ${name}) : Object.assign(${args}, ${value})`;
    return `if (${id} === ${e.id!.text}) ${apply};`;
  });
  return `(${args}, ${opts}, ${name}, ${id}) => { ${branches.join(" ")} }`;
}

// The names an expression uses, but not its keys or the properties it reads
function namesIn(node: ts.Node, out: Set<string>) {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const key =
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node);
    if (!key) out.add(node.text);
  }
  ts.forEachChild(node, (child) => namesIn(child, out));
}

export const partRules: Rule[] = [
  // A subscriber added without a name isn't kept
  {
    name: "nameless-subscriber",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
      )
        return;
      const method = node.expression.name.text;
      const ref = componentOf(ctx, node.expression.expression);
      if (
        !ref ||
        ref.group !== "aws" ||
        ref.written5 ||
        !overloaded[ref.five]?.includes(method)
      )
        return;
      const without = nameless(ctx, node);
      if (without === false) return;
      ctx.note(
        node,
        "nameless-subscriber",
        `${
          without
            ? "This subscriber has no name"
            : "If this subscriber has no name"
        }: 5.0's \`${
          ref.five
        }\` doesn't keep one added without a name, as SST 4's deprecated \`${method}(subscriber, args)\` did. Remove it and deploy with SST 4, then add it back with a name: \`${method}(name, subscriber, args)\`.`,
      );
    },
  },

  // `nodes` read on what a method gave are the component's, by its id
  {
    name: "method-nodes",
    visit(ctx, node) {
      if (!ts.isPropertyAccessExpression(node)) return;
      const nodes = node.expression;
      if (
        !ts.isPropertyAccessExpression(nodes) ||
        nodes.name.text !== "nodes" ||
        !ts.isIdentifier(nodes.expression)
      )
        return;
      const result = resultOf(ctx, nodes.expression);
      if (!result) return;
      const { call, receiver, ref, method, m } = result;
      const key = node.name.text;
      const to = m.nodes[key];
      if (to === undefined) return;
      const what = `What \`${ref.five}\`'s \`${method}\` gives`;
      if (to === "") {
        ctx.replace(node, ctx.text(nodes.expression));
        ctx.change(node, "method-nodes", `${what} is SST 4's \`nodes.${key}\``);
        return;
      }
      const id = m.id?.(call, ctx);
      const reachable =
        ts.isIdentifier(receiver) &&
        call.getSourceFile() === ctx.sf &&
        visible(ctx, receiver, node) &&
        (!m.id || (id && (!id.node || visible(ctx, id.node, node))));
      const where = `the ${ref.five.toLowerCase()}'s \`nodes.${to}${
        m.id ? "[id]" : ""
      }\``;
      if (!reachable) {
        ctx.note(
          node,
          "method-nodes",
          `${what} has no \`nodes\`: \`nodes.${key}\` is ${where}${
            m.id ? `, by the id \`${method}\` gives it` : ""
          }.`,
        );
        return;
      }
      const path = /\.[cm]?tsx?$/.test(ctx.sf.fileName)
        ? to
        : to.replace("!", "");
      ctx.replace(
        node,
        `${(receiver as ts.Identifier).text}.nodes.${path}${
          id ? `[${id.text}]` : ""
        }`,
      );
      ctx.change(
        node,
        "method-nodes",
        `${what} has no \`nodes\`: \`nodes.${key}\` is ${where}`,
      );
    },
  },

  // A sub-item's own `transform` is the component's, for its id
  {
    name: "method-transform",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
      )
        return;
      const method = node.expression.name.text;
      const ref = componentOf(ctx, node.expression.expression);
      const m = methodOf(ref, method);
      if (!ref || !m) return;
      // A Bucket's `subscribe` is `notify`, which takes it whole
      if (ref.five === "Bucket" && method !== "notify") return;
      const args = m.args(node);
      if (!args || !ts.isObjectLiteralExpression(args)) return;
      const transformProp = prop(args, "transform");
      if (!transformProp) return;
      subTransform(ctx, ref, method, m, node, args, transformProp);
    },
    finish(ctx) {
      for (const [created, parts] of pending.get(ctx) ?? []) {
        const args = created.arguments?.[1] as
          | ts.ObjectLiteralExpression
          | undefined;
        const entries = [...parts].map(
          ([part, list]) => [part, transformText(ctx, list)] as const,
        );
        if (args)
          for (const [part, value] of entries)
            ctx.put(args, ["transform"], part, value);
        else {
          const name = created.arguments?.[0];
          if (!name) continue;
          ctx.edit(
            name.getEnd(),
            name.getEnd(),
            `, { transform: { ${entries
              .map(([part, value]) => `${part}: ${value}`)
              .join(", ")} } }`,
          );
        }
      }
      pending.delete(ctx);
    },
  },

  // Bucket: `subscribe`, `subscribeQueue` and `subscribeTopic` are a
  // notification of `notify`
  {
    name: "bucket-subscribe",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
      )
        return;
      const method = node.expression.name.text;
      const kinds: Record<string, [string, string]> = {
        subscribe: ["function", "Subscriber"],
        subscribeQueue: ["queue", "Queue"],
        subscribeTopic: ["topic", "Topic"],
      };
      if (!(method in kinds)) return;
      const receiver = node.expression.expression;
      const ref = componentOf(ctx, receiver);
      if (!ref || ref.group !== "aws" || ref.five !== "Bucket" || ref.written5)
        return;
      const [target, args] = node.arguments;
      if (!target) return;
      const [key, name] = kinds[method];
      const fields: string[] = [];
      let notification: ts.PropertyAssignment | undefined;
      if (args) {
        if (!ts.isObjectLiteralExpression(args)) {
          ctx.note(
            node,
            "bucket-subscribe",
            `\`Bucket\`'s \`${method}\` is \`notify({ notifications: [{ name, ${key}, ...args }] })\`, with the args' \`transform\` in the bucket's \`transform.notification\`.`,
          );
          return;
        }
        for (const p of args.properties) {
          const k = p.name && ts.isIdentifier(p.name) ? p.name.text : "";
          let why: string | undefined;
          if (["events", "filterPrefix", "filterSuffix"].includes(k))
            fields.push(ctx.text(p));
          else if (k === "transform") {
            const transform = objectProp(args, "transform");
            const given = prop(transform, "notification");
            why = !transform
              ? "it isn't written as an object here"
              : transform.properties.some((q) => q !== given)
                ? "it has more than `notification`"
                : given && !ts.isPropertyAssignment(given)
                  ? "its `notification` isn't written as a value"
                  : undefined;
            if (given && ts.isPropertyAssignment(given)) notification = given;
          } else why = `\`notify\` has no \`${k || ctx.text(p)}\``;
          if (why) {
            ctx.note(
              p,
              "bucket-subscribe",
              `\`Bucket\`'s \`${method}\` is \`notify\`, with its \`transform.notification\` in the bucket's, but ${why}.`,
            );
            return;
          }
        }
      }
      const why =
        notification &&
        toComponent(
          ctx,
          ref,
          "notification",
          undefined,
          false,
          notification.initializer,
        );
      if (why) {
        ctx.note(
          notification!,
          "bucket-subscribe",
          `\`Bucket\`'s \`${method}\` is \`notify\`, with its \`transform.notification\` in the bucket's, but ${why}.`,
        );
        return;
      }
      ctx.replace(node.expression.name, "notify");
      ctx.edit(
        target.getStart(ctx.sf),
        target.getStart(ctx.sf),
        `{ notifications: [{ name: "${name}", ${key}: `,
      );
      const last = node.arguments[node.arguments.length - 1];
      ctx.edit(
        target.getEnd(),
        last.getEnd(),
        `${fields.map((f) => `, ${f}`).join("")} }] }`,
      );
      ctx.change(
        node,
        "bucket-subscribe",
        `\`Bucket\`'s \`${method}\` is \`notify\`, with one notification. It keeps the ${key} it notified`,
      );
      if (!ts.isExpressionStatement(node.parent))
        ctx.note(
          node,
          "bucket-subscribe",
          `\`Bucket\`'s \`notify\` gives the bucket, where \`${method}\` gave the subscriber: read what you used of it on the bucket's \`nodes\`.`,
        );
    },
  },

  // Bucket: the static `subscribeEventBridge` is a method of the bucket, or
  // of what `get` gives
  {
    name: "bucket-subscribe-event-bridge",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== "subscribeEventBridge"
      )
        return;
      const callee = node.expression.expression;
      const ref = chain(callee);
      if (!ref || ref.group !== "aws" || ref.five !== "Bucket" || ref.written5)
        return;
      const [name, bucketName, , args] = node.arguments;
      if (!name || !bucketName) return;
      // `bucket.name` of a bucket of the app
      const own =
        ts.isPropertyAccessExpression(bucketName) &&
        bucketName.name.text === "name" &&
        ts.isIdentifier(bucketName.expression)
          ? componentOf(ctx, bucketName.expression)
          : undefined;
      const bucket =
        own && own.group === "aws" && own.five === "Bucket"
          ? (bucketName as ts.PropertyAccessExpression).expression
          : undefined;
      const transformProp =
        args && ts.isObjectLiteralExpression(args)
          ? prop(args, "transform")
          : undefined;
      if (bucket) {
        ctx.skip(callee);
        ctx.replace(callee, ctx.text(bucket));
      } else
        ctx.replace(
          node.expression.name,
          `get(${getName(ctx, name, "Bucket")}, ${ctx.text(
            bucketName,
          )}).subscribeEventBridge`,
        );
      ctx.edit(name.getEnd(), bucketName.getEnd(), "");
      ctx.change(
        node,
        "bucket-subscribe-event-bridge",
        `\`Bucket\`'s static \`subscribeEventBridge(name, bucketName, ...)\` is ${
          bucket ? "the bucket's" : "`get(name, bucketName)`'s"
        } \`subscribeEventBridge(name, ...)\`. It keeps what it created`,
      );
      if (!transformProp || !args || !ts.isObjectLiteralExpression(args))
        return;
      if (!bucket || !own) {
        ctx.note(
          transformProp,
          "bucket-subscribe-event-bridge",
          "A subscriber's `transform: { rule, target }` is the bucket's `transform.eventBridgeRule` and `eventBridgeTarget`, for its name: `get` takes no `transform`, so give the bucket's `new` the transform, with `existing`.",
        );
        return;
      }
      subTransform(
        ctx,
        own,
        "subscribeEventBridge",
        {
          id: nameAt(0),
          args: at(3),
          nodes: {},
          transform: { rule: "eventBridgeRule", target: "eventBridgeTarget" },
        },
        node,
        args,
        transformProp,
      );
    },
  },
];

// A sub-item's `transform`, each of its keys put in the component's
function subTransform(
  ctx: FileContext,
  ref: Ref,
  method: string,
  m: Method,
  call: ts.CallExpression,
  args: ts.ObjectLiteralExpression,
  transformProp: ts.ObjectLiteralElementLike,
) {
  const transform = objectProp(args, "transform");
  const what = `\`${ref.five}\`'s \`${method}\``;
  if (!transform) {
    ctx.note(
      transformProp,
      "method-transform",
      `${what} takes no \`transform\`: put it in the ${ref.five.toLowerCase()}'s \`transform\`, for the id it gives.`,
    );
    return;
  }
  const id = m.id?.(call, ctx);
  const moved: ts.ObjectLiteralElementLike[] = [];
  for (const p of transform.properties) {
    const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    const part = key && m.transform[key];
    const why = !part
      ? `it has no \`${key ?? ctx.text(p)}\``
      : !ts.isPropertyAssignment(p)
        ? "it isn't written as a value"
        : toComponent(ctx, ref, part, id, !!m.id, p.initializer);
    if (why) {
      ctx.note(
        p,
        "method-transform",
        `${what} takes no \`transform\`${
          part
            ? `: its \`${key}\` is the ${ref.five.toLowerCase()}'s \`transform.${part}\``
            : ""
        }${m.id && part ? ", for the id it gives" : ""}, but ${why}.`,
      );
      continue;
    }
    moved.push(p);
    ctx.change(
      p,
      "method-transform",
      `${what}'s \`transform.${key}\` is the ${ref.five.toLowerCase()}'s \`transform.${part}\`${
        m.id ? ", for its id" : ""
      }`,
    );
  }
  // Args with nothing left in them go, when they're the last argument
  // and no other rule changed them or what's before them
  const index = call.arguments.indexOf(args);
  const start = index > 0 ? call.arguments[index - 1].getEnd() : 0;
  if (
    moved.length === transform.properties.length &&
    args.properties.length === 1 &&
    index > 0 &&
    index === call.arguments.length - 1 &&
    !ctx.edits.some((e) => e.start < args.getEnd() && e.end > start)
  )
    ctx.edit(start, args.getEnd(), "");
  else for (const p of moved) ctx.remove(transform, p);
}

// What a variable holds when it's what a sub-item method gave
function resultOf(ctx: FileContext, ident: ts.Identifier) {
  let symbol = ctx.checker.getSymbolAtLocation(ident);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias)
    symbol = ctx.checker.getAliasedSymbol(symbol);
  const decl = symbol?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer)
    return undefined;
  const call = decl.initializer;
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression)
  )
    return undefined;
  const method = call.expression.name.text;
  const receiver = call.expression.expression;
  const sf = call.getSourceFile();
  const inner =
    sf === ctx.sf ? ctx : new FileContext(sf, ctx.checker, sf.fileName);
  const ref = componentOf(inner, receiver);
  const m = methodOf(ref, method);
  if (!ref || !m) return undefined;
  return { call, receiver, ref, method, m };
}

// Whether a name at one place means the same thing at another
function visible(ctx: FileContext, name: ts.Identifier, at: ts.Node) {
  const symbol = ctx.checker.getSymbolAtLocation(name);
  if (!symbol) return false;
  const there = ctx.checker
    .getSymbolsInScope(at, ts.SymbolFlags.Value)
    .find((s) => s.name === name.text);
  return there === symbol;
}
