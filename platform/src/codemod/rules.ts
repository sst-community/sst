import ts from "typescript";
import {
  argsOf,
  chain,
  componentOf,
  getName,
  isFive,
  isLeftOut,
  keyOf,
  literal,
  objectAt,
  objectProp,
  prop,
  type FileContext,
  type Ref,
} from "./engine";
import { leftOut, v1 } from "./names";
import { nameless, overloaded, partRules } from "./parts";

// The sites built on SST 4's SsrSite
const ssrSites = [
  "Analog",
  "Astro",
  "Nextjs",
  "Nuxt",
  "React",
  "Remix",
  "SolidStart",
  "SvelteKit",
  "TanStackStart",
];

export interface Rule {
  name: string;
  visit(ctx: FileContext, node: ts.Node): void;
  /** After every node of a file is visited, for what's written once. */
  finish?(ctx: FileContext): void;
}

// Each `new` of one of these components, by its 5.0 name, with its args
// object. SST 4's form only, unless `alphas`: the v5 alphas' form already has
// 5.0's args, but for the few `alphas` lists.
function onNew(
  names: string[],
  fn: (
    ctx: FileContext,
    args: ts.ObjectLiteralExpression,
    ref: Ref,
    call: ts.NewExpression,
  ) => void,
  alphas = false,
  group: Ref["group"] = "aws",
) {
  return (ctx: FileContext, node: ts.Node) => {
    if (!ts.isNewExpression(node)) return;
    const ref = chain(node.expression);
    if (
      !ref ||
      ref.group !== group ||
      !names.includes(ref.five) ||
      (ref.written5 && !alphas)
    )
      return;
    const args = argsOf(node, 1);
    if (args) fn(ctx, args, ref, node);
  };
}

// Each `x.nodes.<key>` where `x` is one of these components
function onNodes(
  names: string[],
  fn: (ctx: FileContext, node: ts.PropertyAccessExpression, ref: Ref) => void,
  group: Ref["group"] = "aws",
) {
  return (ctx: FileContext, node: ts.Node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    const nodes = node.expression;
    if (!ts.isPropertyAccessExpression(nodes) || nodes.name.text !== "nodes")
      return;
    const ref = componentOf(ctx, nodes.expression);
    if (ref && ref.group === group && names.includes(ref.five) && !ref.written5)
      fn(ctx, node, ref);
  };
}

// Each call of a method on one of these components
function onMethod(
  names: string[],
  method: string,
  fn: (ctx: FileContext, call: ts.CallExpression, ref: Ref) => void,
) {
  return (ctx: FileContext, node: ts.Node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression)
    )
      return;
    if (node.expression.name.text !== method) return;
    const ref = componentOf(ctx, node.expression.expression);
    if (ref && ref.group === "aws" && names.includes(ref.five) && !ref.written5)
      fn(ctx, node, ref);
  };
}

const renameKey =
  (rule: string, component: string, from: string[], to: string) =>
  (ctx: FileContext, args: ts.ObjectLiteralExpression) => {
    const obj = from.length > 1 ? objectAt(args, from.slice(0, -1)) : args;
    const p = prop(obj, from[from.length - 1]);
    if (!p) return;
    ctx.rename(p, to);
    ctx.change(
      p,
      rule,
      `${component}'s \`${from.join(".")}\` is \`${[
        ...from.slice(0, -1),
        to,
      ].join(".")}\``,
    );
  };

const removeKey =
  (rule: string, component: string, from: string[], why: string) =>
  (ctx: FileContext, args: ts.ObjectLiteralExpression) => {
    const obj = from.length > 1 ? objectAt(args, from.slice(0, -1)) : args;
    const p = obj && prop(obj, from[from.length - 1]);
    if (!obj || !p) return;
    ctx.remove(obj, p);
    ctx.change(
      p,
      rule,
      `${component}'s \`${from.join(".")}\` is removed: ${why}`,
    );
  };

const moveKey =
  (rule: string, component: string, from: string[], to: string[]) =>
  (ctx: FileContext, args: ts.ObjectLiteralExpression) => {
    const obj = from.length > 1 ? objectAt(args, from.slice(0, -1)) : args;
    const p = obj && prop(obj, from[from.length - 1]);
    if (!obj || !p) return;
    ctx.move(obj, p, args, to.slice(0, -1), to[to.length - 1]);
    ctx.change(
      p,
      rule,
      `${component}'s \`${from.join(".")}\` is \`${to.join(".")}\``,
    );
  };

export const rules: Rule[] = [
  {
    // `sst.aws.X` takes its 5.0 name, and `sst.aws.v5.X`, as the v5 alphas
    // wrote it, is `sst.aws.X`: and the components with no 5.0 form are listed
    name: "name",
    visit(ctx, node) {
      if (!ts.isPropertyAccessExpression(node) && !ts.isQualifiedName(node))
        return;
      const parent = node.parent;
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
        chain(parent)
      )
        return;
      const ref = chain(node);
      if (!ref || ctx.isSkipped(node)) return;
      if (ref.v1) {
        ctx.note(
          node,
          "left-out",
          v1[ref.name] ?? `\`${ref.name}.v1\` has no 5.0 form.`,
        );
        return;
      }
      if (
        !ref.written5 &&
        isLeftOut(ref.group, ref.name) &&
        oldForm(node, ref)
      ) {
        ctx.note(node, "left-out", leftOut[ref.group][ref.name]);
        return;
      }
      if (!isFive(ref.group, ref.five)) return;
      const to = ctx.qualified(ref);
      const from = ctx.text(node);
      if (from === to) return;
      ctx.replace(node, to);
      ctx.change(node, "name", `\`${from}\` is \`${to}\``);
    },
  },
  {
    name: "linkable",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
      )
        return;
      const callee = node.expression;
      if (
        !ts.isIdentifier(callee.expression) ||
        callee.expression.text !== "sst" ||
        callee.name.text !== "linkable"
      )
        return;
      ctx.replace(callee, "sst.Linkable.wrap");
      ctx.change(
        callee,
        "linkable",
        "`sst.linkable` is `sst.Linkable.wrap`, which takes the same",
      );
    },
  },

  // Function, and a function's args written inline in another component
  {
    name: "function",
    visit: onNew(["Function"], (ctx, args) => functionArgs(ctx, args)),
  },
  {
    name: "function-args",
    visit(ctx, node) {
      if (!ts.isObjectLiteralExpression(node) || !prop(node, "handler")) return;
      // A component's own args, like a `Workflow`'s, aren't a function's
      const parent = node.parent;
      if (
        ts.isNewExpression(parent) &&
        parent.arguments?.[1] === node &&
        chain(parent.expression)
      )
        return;
      if (insideSst4(ctx, node)) functionArgs(ctx, node);
    },
  },

  // Cron, SST 4's CronV2
  {
    name: "cron-job",
    visit: onNew(["Cron"], (ctx, args, ref) => {
      if (ref.name !== "CronV2") return;
      renameKey("cron-job", "`CronV2`", ["job"], "function")(ctx, args);
    }),
  },
  {
    name: "cron-nodes-job",
    visit: onNodes(["Cron"], (ctx, node, ref) => {
      if (ref.name !== "CronV2" || node.name.text !== "job") return;
      ctx.replace(node.name, "function");
      ctx.change(
        node,
        "cron-nodes-job",
        "`CronV2`'s `nodes.job` is `nodes.function`",
      );
    }),
  },

  // Task and Service
  ...(["Task", "Service"] as const).flatMap((c) =>
    (["taskRole", "executionRole"] as const).map((key) => ({
      name: `${c.toLowerCase()}-${key}`,
      visit: onNew(
        [c],
        moveKey(
          `${c.toLowerCase()}-${key}`,
          `\`${c}\``,
          [key],
          ["existing", key],
        ),
      ),
    })),
  ),

  // Redis: `nodes` was in the alphas' form too
  {
    name: "redis-nodes",
    visit: onNew(
      ["Redis"],
      (ctx, args) => {
        const p = prop(args, "nodes");
        if (!p) return;
        if (prop(args, "cluster") || prop(args, "serverless")) {
          ctx.remove(args, p);
          ctx.change(
            p,
            "redis-nodes",
            "`Redis`'s `nodes` is removed: with `cluster` or `serverless` set, SST 4 ignored it",
          );
        } else {
          ctx.move(args, p, args, ["cluster"], "nodes");
          ctx.change(p, "redis-nodes", "`Redis`'s `nodes` is `cluster.nodes`");
        }
      },
      true,
    ),
  },

  // Cluster: `forceUpgrade` was in the alphas' form too
  {
    name: "cluster-force-upgrade",
    visit: onNew(
      ["Cluster"],
      removeKey(
        "cluster-force-upgrade",
        "`Cluster`",
        ["forceUpgrade"],
        "5.0 has only the current version",
      ),
      true,
    ),
  },
  {
    name: "cluster-service-subnets",
    visit: onNew(
      ["Cluster"],
      renameKey(
        "cluster-service-subnets",
        "`Cluster`",
        ["vpc", "serviceSubnets"],
        "containerSubnets",
      ),
    ),
  },

  // Router
  {
    name: "router-invalidation",
    visit: onNew(
      ["Router"],
      removeKey(
        "router-invalidation",
        "`Router`",
        ["invalidation"],
        "SST 4 never used it",
      ),
    ),
  },

  // Auth
  {
    name: "auth-authorizer",
    visit: onNew(
      ["Auth"],
      renameKey("auth-authorizer", "`Auth`", ["authorizer"], "issuer"),
    ),
  },
  {
    name: "auth-force-upgrade",
    visit: onNew(
      ["Auth"],
      removeKey(
        "auth-force-upgrade",
        "`Auth`",
        ["forceUpgrade"],
        "5.0 has only the current version",
      ),
    ),
  },
  {
    name: "auth-nodes-authorizer",
    visit: onNodes(["Auth"], (ctx, node) => {
      if (node.name.text !== "authorizer") return;
      ctx.replace(node.name, "issuer");
      ctx.change(
        node,
        "auth-nodes-authorizer",
        "`Auth`'s `nodes.authorizer` is `nodes.issuer`",
      );
    }),
  },

  // The API Gateways
  ...(
    ["ApiGatewayHttp", "ApiGatewayRest", "ApiGatewayWebSocket"] as const
  ).flatMap((c) => [
    {
      name: `${c}-domain-name-id`,
      visit: onNew([c], domainNameId(`\`${c}\``)),
    },
    {
      // What else SST 4 took in `transform.route`: every route's args
      name: `${c}-route-args`,
      visit: onNew(
        [c],
        (ctx: FileContext, args: ts.ObjectLiteralExpression) => {
          const p = prop(objectAt(args, ["transform", "route"]), "args");
          if (p)
            ctx.note(
              p,
              "api-route-args",
              `\`${c}\`'s \`transform.route.args\` is gone: give each route its args, like its \`auth\`, in \`route()\`.`,
            );
        },
      ),
    },
    {
      name: `${c}-route-handler`,
      visit: onNew(
        [c],
        moveKey(
          "api-route-handler",
          `\`${c}\``,
          ["transform", "route", "handler"],
          ["transform", "handler"],
        ),
      ),
    },
  ]),
  ...(["ApiGatewayRest", "ApiGatewayWebSocket"] as const).map((c) => ({
    name: `${c}-access-log`,
    visit: onNew(
      [c],
      renameKey(
        "api-access-log",
        `\`${c}\``,
        ["transform", "accessLog"],
        "logGroup",
      ),
    ),
  })),

  // Bucket
  {
    name: "bucket-public",
    visit: onNew(["Bucket"], (ctx, args) => {
      const p = prop(args, "public");
      if (!p) return;
      if (literal(p) === true) {
        ctx.replace(p, `access: "public"`);
        ctx.change(
          p,
          "bucket-public",
          '`Bucket`\'s `public: true` is `access: "public"`',
        );
      } else if (literal(p) === false) {
        ctx.remove(args, p);
        ctx.change(
          p,
          "bucket-public",
          "`Bucket`'s `public: false` is removed: it's the default",
        );
      } else
        ctx.note(
          p,
          "bucket-public",
          "`Bucket`'s `public` is `access`: `access: \"public\"` where it's true.",
        );
    }),
  },
  {
    name: "bucket-public-access-block",
    visit: onNew(["Bucket"], (ctx, args) => {
      const transform = objectProp(args, "transform");
      const p = prop(transform, "publicAccessBlock");
      if (!transform || !p || literal(p) !== false) return;
      ctx.move(transform, p, args, [], "publicAccessBlock");
      ctx.change(
        p,
        "bucket-public-access-block",
        "`Bucket`'s `transform.publicAccessBlock: false` is `publicAccessBlock: false`",
      );
    }),
  },

  // Email: a DKIM key of your own needs `dkim: false`
  {
    name: "email-dkim",
    visit: onNew(["Email"], (ctx, args) => {
      const signing = objectAt(args, [
        "transform",
        "identity",
        "dkimSigningAttributes",
      ]);
      if (!prop(signing, "domainSigningPrivateKey") || prop(args, "dkim"))
        return;
      ctx.edit(
        args.getStart(ctx.sf) + 1,
        args.getStart(ctx.sf) + 1,
        " dkim: false,",
      );
      ctx.change(
        args,
        "email-dkim",
        "`Email` signs with a DKIM key of your own, so it's given `dkim: false`, and its DKIM records stay yours",
      );
    }),
  },

  // Cloudflare
  {
    name: "kv-id",
    visit(ctx, node) {
      if (!ts.isPropertyAccessExpression(node) || node.name.text !== "id")
        return;
      const ref = componentOf(ctx, node.expression);
      if (
        !ref ||
        ref.group !== "cloudflare" ||
        ref.five !== "Kv" ||
        ref.written5
      )
        return;
      ctx.replace(node.name, "namespaceId");
      ctx.change(node, "kv-id", "Cloudflare's `Kv`'s `id` is `namespaceId`");
    },
  },
  {
    name: "d1-get",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== "get"
      )
        return;
      const ref = chain(node.expression.expression);
      if (
        !ref ||
        ref.group !== "cloudflare" ||
        ref.five !== "D1" ||
        ref.written5
      )
        return;
      const id = node.arguments[1];
      if (!id || ts.isObjectLiteralExpression(id)) return;
      ctx.replace(id, `{ databaseId: ${ctx.text(id)} }`);
      ctx.change(
        id,
        "d1-get",
        "Cloudflare's `D1.get(name, id)` is `D1.get(name, { databaseId })`",
      );
    },
  },
  {
    name: "cloudflare-cron-job",
    visit: onNew(
      ["Cron"],
      renameKey(
        "cloudflare-cron-job",
        "Cloudflare's `Cron`",
        ["job"],
        "worker",
      ),
      false,
      "cloudflare",
    ),
  },

  // The sites built on SST 4's SsrSite
  { name: "site", visit: onNew(ssrSites, siteArgs) },

  // ApiGatewayWebSocket: addAuthorizer takes one object, and a Lambda
  // authorizer has no payload or response
  {
    name: "websocket-authorizer",
    visit: onMethod(["ApiGatewayWebSocket"], "addAuthorizer", (ctx, call) => {
      const [name, args] = call.arguments;
      if (!name) return;
      if (ts.isObjectLiteralExpression(name)) return lambdaFields(ctx, name);
      if (!args) ctx.replace(name, `{ name: ${ctx.text(name)} }`);
      else if (ts.isObjectLiteralExpression(args)) {
        ctx.edit(
          name.getStart(ctx.sf),
          args.getStart(ctx.sf) + 1,
          `{ name: ${ctx.text(name)},`,
        );
        lambdaFields(ctx, args);
      } else
        ctx.edit(
          name.getStart(ctx.sf),
          args.getEnd(),
          `{ name: ${ctx.text(name)}, ...${ctx.text(args)} }`,
        );
      ctx.change(
        call,
        "websocket-authorizer",
        "`ApiGatewayWebSocket`'s `addAuthorizer(name, args)` is `addAuthorizer({ name, ...args })`",
      );
    }),
  },

  // ApiGatewayRest: a route streams with `streaming` on its function
  {
    name: "rest-route-streaming",
    visit: onMethod(["ApiGatewayRest"], "route", (ctx, call) => {
      const [, handler, args] = call.arguments;
      const routeArgs =
        args && ts.isObjectLiteralExpression(args) ? args : undefined;
      const streaming = prop(routeArgs, "streaming");
      if (!routeArgs || !streaming || !handler) return;
      const value = literal(streaming);
      ctx.remove(routeArgs, streaming);
      if (value === false) {
        ctx.change(
          streaming,
          "rest-route-streaming",
          "`ApiGatewayRest`'s route `streaming: false` is removed: it's the default",
        );
        return;
      }
      if (ts.isStringLiteralLike(handler))
        ctx.replace(
          handler,
          `{ handler: ${ctx.text(handler)}, streaming: ${ctx.text(
            (streaming as ts.PropertyAssignment).initializer,
          )} }`,
        );
      else if (ts.isObjectLiteralExpression(handler))
        ctx.edit(
          handler.getStart(ctx.sf) + 1,
          handler.getStart(ctx.sf) + 1,
          ` streaming: ${ctx.text(
            (streaming as ts.PropertyAssignment).initializer,
          )},`,
        );
      else {
        ctx.note(
          streaming,
          "rest-route-streaming",
          "`ApiGatewayRest`'s route `streaming` goes on the route's function: `streaming: true` in its args. A route to a `Function` or an ARN can't stream.",
        );
        return;
      }
      ctx.change(
        streaming,
        "rest-route-streaming",
        "`ApiGatewayRest`'s route `streaming` is the function's `streaming`",
      );
    }),
  },

  // Alb
  {
    name: "alb-listeners",
    visit: onNodes(["Alb"], (ctx, node) => {
      if (node.name.text !== "listeners") return;
      ctx.replace(node.name, "listener");
      ctx.change(
        node,
        "alb-listeners",
        "`Alb`'s `nodes.listeners` is `nodes.listener`",
      );
    }),
  },

  // Nextjs
  {
    name: "nextjs-revalidation-subscriber",
    visit: onNew(["Nextjs"], (ctx, args) => {
      const transform = objectProp(args, "transform");
      const p = prop(transform, "revalidationEventsSubscriber");
      if (!transform || !p) return;
      const queue = prop(transform, "revalidationQueue");
      if (queue && !objectProp(transform, "revalidationQueue")) {
        ctx.note(
          p,
          "nextjs-revalidation-subscriber",
          "`Nextjs`'s `transform.revalidationEventsSubscriber` is `transform.revalidationQueue: { transform: { subscriber } }`, inside the function you give `revalidationQueue`.",
        );
        return;
      }
      ctx.move(
        transform,
        p,
        args,
        ["transform", "revalidationQueue", "transform"],
        "subscriber",
      );
      ctx.change(
        p,
        "nextjs-revalidation-subscriber",
        "`Nextjs`'s `transform.revalidationEventsSubscriber` is `transform.revalidationQueue.transform.subscriber`",
      );
    }),
  },

  // The static `subscribe` and `subscribeQueue`, which took an ARN, are
  // methods of what `get` gives
  {
    name: "static-subscribe",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
      )
        return;
      const method = node.expression.name.text;
      if (method !== "subscribe" && method !== "subscribeQueue") return;
      const ref = chain(node.expression.expression);
      if (!ref || ref.group !== "aws" || ref.written5) return;
      const named = ["Bus", "Dynamo", "KinesisStream", "SnsTopic"].includes(
        ref.five,
      );
      if (!named && ref.five !== "Queue") return;
      const suffix = {
        Bus: "Bus",
        Dynamo: "Table",
        KinesisStream: "Stream",
        SnsTopic: "Topic",
        Queue: "Queue",
      }[ref.five]!;
      // SnsTopic's, Dynamo's and KinesisStream's could be called without a
      // name, and 5.0 doesn't keep a subscriber added that way
      if (overloaded[ref.five]?.includes(method)) {
        const without = nameless(ctx, node, 1);
        if (without !== false) {
          ctx.note(
            node,
            "static-subscribe",
            `${
              without
                ? "This subscriber has no name"
                : "If this subscriber has no name"
            }: 5.0 doesn't keep one added without a name, as SST 4's deprecated \`${
              ref.name
            }.${method}(arn, subscriber, args)\` did. Remove it and deploy with SST 4, then add it back with a name: \`${ctx.qualified(
              ref,
            )}.get(name, arn).${method}(name, subscriber, args)\`.`,
          );
          return;
        }
      }
      const [first, second] = node.arguments;
      const arn = named ? second : first;
      if (!arn) return;
      const subscriber = named ? first : undefined;
      const args = node.arguments[named ? 3 : 2];
      // SST 4's Queue took the options its subscriber is created with, which
      // are `get`'s now
      const opts = named ? undefined : node.arguments[3];
      if (args && ts.isObjectLiteralExpression(args) && prop(args, "transform"))
        ctx.note(
          args,
          "static-subscribe",
          `\`${
            ref.five
          }\`'s static \`${method}\` with a \`transform\` is \`new ${ctx.qualified(
            ref,
          )}(name, { existing: { ... }, transform })\` and its \`${method}\`: \`get\` takes no \`transform\`.`,
        );
      ctx.replace(
        node.expression.name,
        `get(${getName(ctx, subscriber, suffix)}, ${ctx.text(arn)}${
          opts ? `, ${ctx.text(opts)}` : ""
        }).${method}`,
      );
      if (opts) ctx.edit(node.arguments[2].getEnd(), opts.getEnd(), "");
      ctx.edit(
        named ? first.getEnd() : arn.getStart(ctx.sf),
        named ? arn.getEnd() : (node.arguments[1] ?? arn).getStart(ctx.sf),
        "",
      );
      ctx.change(
        node,
        "static-subscribe",
        `\`${ref.name}\`'s static \`${method}\` is \`get(name, arn).${method}\``,
      );
    },
  },

  // Cluster: addService and addTask are the Service and the Task, with it
  {
    name: "cluster-add",
    visit(ctx, node) {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression)
      )
        return;
      const method = node.expression.name.text;
      if (method !== "addService" && method !== "addTask") return;
      const receiver = node.expression.expression;
      const ref = componentOf(ctx, receiver);
      if (!ref || ref.group !== "aws" || ref.five !== "Cluster" || ref.written5)
        return;
      const component = method === "addService" ? "Service" : "Task";
      if (!ts.isIdentifier(receiver)) {
        ctx.note(
          node,
          "cluster-add",
          `\`Cluster\`'s \`${method}\` is gone: \`new ${ctx.qualified({
            group: "aws",
            five: component,
          })}(name, { cluster, ... })\`, with the cluster's \`provider\`.`,
        );
        return;
      }
      const [name, args, opts] = node.arguments;
      if (!name) return;
      const cluster = ctx.text(receiver);
      const entry = cluster === "cluster" ? "cluster" : `cluster: ${cluster}`;
      ctx.edit(
        node.getStart(ctx.sf),
        name.getStart(ctx.sf),
        `new ${ctx.qualified({ group: "aws", five: component })}(`,
      );
      if (!args) ctx.edit(name.getEnd(), name.getEnd(), `, { ${entry} }`);
      else if (ts.isObjectLiteralExpression(args)) {
        // On a line of its own where the args are written one to a line,
        // indented as the first is
        const open = args.getStart(ctx.sf) + 1;
        const first = args.properties[0];
        const line = (pos: number) =>
          ctx.sf.getLineAndCharacterOfPosition(pos).line;
        if (first && line(first.getStart(ctx.sf)) > line(open)) {
          const start = ctx.sf.getLineStarts()[line(first.getStart(ctx.sf))];
          const indent = ctx.sf.text.slice(start, first.getStart(ctx.sf));
          ctx.edit(open, open, `\n${indent}${entry},`);
        } else ctx.edit(open, open, ` ${entry},`);
      } else ctx.replace(args, `{ ${entry}, ...${ctx.text(args)} }`);
      // The cluster's provider, which SST 4 gave what it added
      const created = ref.created;
      const clusterOpts = created?.arguments?.[2];
      const provider =
        clusterOpts && ts.isObjectLiteralExpression(clusterOpts)
          ? prop(clusterOpts, "provider")
          : undefined;
      if (
        provider &&
        ts.isPropertyAssignment(provider) &&
        created!.getSourceFile() === ctx.sf
      ) {
        const value = ctx.text(provider.initializer);
        if (!opts)
          ctx.edit(
            (args ?? name).getEnd(),
            (args ?? name).getEnd(),
            `${args ? "" : ""}, { provider: ${value} }`,
          );
        else if (ts.isObjectLiteralExpression(opts))
          ctx.edit(
            opts.getStart(ctx.sf) + 1,
            opts.getStart(ctx.sf) + 1,
            ` provider: ${value},`,
          );
        else ctx.replace(opts, `{ provider: ${value}, ...${ctx.text(opts)} }`);
      } else if (clusterOpts)
        ctx.note(
          node,
          "cluster-add",
          `The ${component.toLowerCase()} \`${method}\` made took the cluster's \`provider\`: give it the same in its options.`,
        );
      ctx.change(
        node,
        "cluster-add",
        `\`Cluster\`'s \`${method}\` is \`new ${ctx.qualified({
          group: "aws",
          five: component,
        })}(name, { cluster, ... })\``,
      );
    },
  },

  // Service: `public` is `loadBalancer`, its `ports` are `rules`, and a
  // rule's `path` is `conditions.path`
  { name: "service-load-balancer", visit: onNew(["Service"], loadBalancer) },

  // Task and Service: with `containers`, what's set for one container goes,
  // and `permissions` go next to a role of your own, as SST 4 left them out
  ...(["Task", "Service"] as const).map((c) => ({
    name: `${c.toLowerCase()}-containers`,
    visit: onNew([c], (ctx, args) => {
      if (!prop(args, "containers")) return;
      const ignored = (
        obj: ts.ObjectLiteralExpression | undefined,
        keys: string[],
        at = "",
      ) => {
        for (const key of keys) {
          const p = prop(obj, key);
          if (!obj || !p) continue;
          ctx.remove(obj, p);
          ctx.change(
            p,
            "fargate-containers",
            `\`${c}\`'s \`${at}${key}\` next to \`containers\` is removed: SST 4 didn't apply it with \`containers\`. Set it on each container to apply it`,
          );
        }
      };
      ignored(args, [
        "image",
        "command",
        "entrypoint",
        "logging",
        "environment",
        "environmentFiles",
        "volumes",
        "ssm",
        ...(c === "Service" ? ["health"] : []),
      ]);
      if (c === "Service")
        ignored(
          objectProp(args, "dev"),
          ["command", "autostart", "directory"],
          "dev.",
        );
    }),
  })),
  ...(["Task", "Service"] as const).map((c) => ({
    name: `${c.toLowerCase()}-permissions`,
    visit: onNew([c], (ctx, args) => {
      const permissions = prop(args, "permissions");
      if (
        !permissions ||
        !(
          prop(args, "taskRole") ||
          prop(objectProp(args, "existing"), "taskRole")
        )
      )
        return;
      ctx.remove(args, permissions);
      ctx.change(
        permissions,
        "fargate-permissions",
        `\`${c}\`'s \`permissions\` next to \`taskRole\` are removed: SST 4 didn't add them to the role it was given, so nothing deployed changes. To grant them, add them to that role`,
      );
    }),
  })),

  // StaticSite: a site's `route`, `cdn` and `router` as the SSR sites', and
  // the one KV store a CloudFront function takes
  { name: "static-site", visit: onNew(["StaticSite"], siteArgs) },
  {
    name: "static-site-kv-stores",
    visit: onNew(["StaticSite"], (ctx, args) => {
      const edge = objectProp(args, "edge");
      for (const event of ["viewerRequest", "viewerResponse"]) {
        const fn = objectProp(edge, event);
        const stores = prop(fn, "kvStores");
        if (!fn || !stores) continue;
        const list =
          ts.isPropertyAssignment(stores) &&
          ts.isArrayLiteralExpression(stores.initializer)
            ? stores.initializer
            : undefined;
        const first = list?.elements[0];
        if (
          event === "viewerRequest" ||
          prop(fn, "kvStore") ||
          (list && !first)
        ) {
          ctx.remove(fn, stores);
          ctx.change(
            stores,
            "static-site-kv-stores",
            `\`StaticSite\`'s \`edge.${event}.kvStores\` is removed: SST 4 used ${
              event === "viewerRequest" ? "only `kvStore` there" : "`kvStore`"
            }`,
          );
        } else if (first && !ts.isSpreadElement(first)) {
          ctx.replace(stores, `kvStore: ${ctx.text(first)}`);
          ctx.change(
            stores,
            "static-site-kv-stores",
            "`StaticSite`'s `edge.viewerResponse.kvStores` is `kvStore`, the first of them, the one SST 4 used",
          );
        } else
          ctx.note(
            stores,
            "static-site-kv-stores",
            "`StaticSite`'s `edge.viewerResponse.kvStores` is `kvStore`: a CloudFront function takes one, and SST 4 used the first.",
          );
      }
    }),
  },

  // Router: `kvStores` did something only for the inline `routes`, which are
  // gone
  {
    name: "router-kv-stores",
    visit: onNew(["Router"], (ctx, args) => {
      const routes = prop(args, "routes");
      if (routes) {
        ctx.note(
          routes,
          "router-routes",
          "`Router`'s `routes` are gone. With SST 4, add each with `route()` or `routeBucket()` in place of `routes` and deploy; then switch the `Router`.",
        );
        return;
      }
      const edge = objectProp(args, "edge");
      for (const event of ["viewerRequest", "viewerResponse"]) {
        const fn = objectProp(edge, event);
        const stores = prop(fn, "kvStores");
        if (!fn || !stores) continue;
        ctx.remove(fn, stores);
        ctx.change(
          stores,
          "router-kv-stores",
          `\`Router\`'s \`edge.${event}.kvStores\` is removed: SST 4 used it only with \`routes\``,
        );
      }
    }),
  },

  // Workflow: `transform.function` transforms the function's args, and its
  // `role` is the function's `existing.role`
  { name: "workflow", visit: onNew(["Workflow"], workflowArgs) },

  // Vpc: the lists in `nodes` are records, by the AZ's number from "1"
  {
    name: "vpc-nodes",
    visit: onNodes(["Vpc"], (ctx, node) => {
      const singular = vpcLists[node.name.text];
      if (!singular) return;
      const nodes = ctx.text(node.expression);
      const parent = node.parent;
      if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isNumericLiteral(parent.argumentExpression)
      )
        ctx.replace(
          parent,
          `${nodes}.${singular}["${
            Number(parent.argumentExpression.text) + 1
          }"]`,
        );
      else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node
      )
        ctx.replace(node, `$output(Object.values(${nodes}.${singular}))`);
      else ctx.replace(node, `Object.values(${nodes}.${singular})`);
      ctx.change(
        node,
        "vpc-nodes",
        `\`Vpc\`'s \`nodes.${node.name.text}\` is \`nodes.${singular}\`, a record by the AZ's number from "1"`,
      );
    }),
  },

  // Cloudflare's Cron: `nodes.worker` is the `Worker`, not its script
  {
    name: "cloudflare-cron-nodes-worker",
    visit: onNodes(
      ["Cron"],
      (ctx, node) => {
        if (node.name.text !== "worker") return;
        // Already the `Worker`'s: what only it has is read
        const after = node.parent;
        if (
          ts.isPropertyAccessExpression(after) &&
          after.expression === node &&
          ["nodes", "url"].includes(after.name.text)
        )
          return;
        ctx.edit(node.getEnd(), node.getEnd(), ".nodes.worker");
        ctx.change(
          node,
          "cloudflare-cron-nodes-worker",
          "Cloudflare's `Cron`'s `nodes.worker` is its `Worker`, and the script SST 4 gave there is `nodes.worker.nodes.worker`",
        );
      },
      "cloudflare",
    ),
  },

  // What a route, a subscriber and the like gave: their `nodes` and their
  // own `transform` are the component's
  ...partRules,
];

// SST 4's lists in a Vpc's `nodes`, and the record each is in 5.0
const vpcLists: Record<string, string> = {
  privateSubnets: "privateSubnet",
  publicSubnets: "publicSubnet",
  natGateways: "natGateway",
  natInstances: "natInstance",
  elasticIps: "elasticIp",
  privateRouteTables: "privateRouteTable",
  publicRouteTables: "publicRouteTable",
};

// A Service's `public`, `ports` and each rule's `path`
function loadBalancer(ctx: FileContext, args: ts.ObjectLiteralExpression) {
  const pub = prop(args, "public");
  if (pub && !prop(args, "loadBalancer")) {
    ctx.rename(pub, "loadBalancer");
    ctx.change(
      pub,
      "service-public",
      "`Service`'s `public` is `loadBalancer`, with the same settings",
    );
  }
  const balancer =
    objectProp(args, "loadBalancer") ?? (pub && objectProp(args, "public"));
  if (!balancer) return;
  const ports = prop(balancer, "ports");
  if (ports && !prop(balancer, "rules")) {
    ctx.rename(ports, "rules");
    ctx.change(
      ports,
      "service-ports",
      "`Service`'s `loadBalancer.ports` is `loadBalancer.rules`",
    );
  }
  const list = prop(balancer, "rules") ?? ports;
  if (
    !list ||
    !ts.isPropertyAssignment(list) ||
    !ts.isArrayLiteralExpression(list.initializer)
  )
    return;
  for (const rule of list.initializer.elements) {
    if (!ts.isObjectLiteralExpression(rule)) continue;
    const path = prop(rule, "path");
    if (!path) continue;
    if (prop(rule, "conditions") && !objectProp(rule, "conditions")) {
      ctx.note(
        path,
        "service-rule-path",
        "A `Service` rule's `path` is `conditions.path`.",
      );
      continue;
    }
    ctx.move(rule, path, rule, ["conditions"], "path");
    ctx.change(
      path,
      "service-rule-path",
      "A `Service` rule's `path` is `conditions.path`",
    );
  }
}

// A Workflow's `transform.function`, which was its function's own
// `transform`, and its `role`
function workflowArgs(ctx: FileContext, args: ts.ObjectLiteralExpression) {
  const transformProp = prop(args, "transform");
  const transform = objectProp(args, "transform");
  const fn = prop(transform, "function");
  const role = prop(args, "role");
  const roleText = role && valueOf(ctx, role);
  // Already 5.0's, as the codemod writes it: only `transform` and `existing`
  if (
    !role &&
    fn &&
    ts.isPropertyAssignment(fn) &&
    ts.isObjectLiteralExpression(fn.initializer) &&
    fn.initializer.properties.length > 0 &&
    fn.initializer.properties.every(
      (p) =>
        p.name &&
        ts.isIdentifier(p.name) &&
        ["transform", "existing"].includes(p.name.text),
    )
  )
    return;
  if (fn && ts.isPropertyAssignment(fn)) {
    ctx.replace(
      fn,
      `function: { transform: ${ctx.text(fn.initializer)}${
        roleText ? `, existing: { role: ${roleText} }` : ""
      } }`,
    );
    ctx.change(
      fn,
      "workflow-transform",
      "`Workflow`'s `transform.function` is `transform.function.transform`: `transform.function` transforms the function's args",
    );
    if (role) {
      ctx.remove(args, role);
      ctx.change(
        role,
        "workflow-role",
        "`Workflow`'s `role` is `transform.function.existing.role`",
      );
    }
    return;
  }
  if (!role) return;
  if (fn || (transformProp && !transform)) {
    ctx.note(
      role,
      "workflow-role",
      "`Workflow`'s `role` is the function's: `transform: { function: { existing: { role } } }`.",
    );
    return;
  }
  ctx.move(args, role, args, ["transform", "function", "existing"], "role");
  ctx.change(
    role,
    "workflow-role",
    "`Workflow`'s `role` is `transform.function.existing.role`",
  );
}

// A prop's value as text, `x` for a shorthand `x`
function valueOf(ctx: FileContext, p: ts.ObjectLiteralElementLike) {
  if (ts.isPropertyAssignment(p)) return ctx.text(p.initializer);
  if (ts.isShorthandPropertyAssignment(p)) return ctx.text(p.name);
  return undefined;
}

// Whether a component that shares its name with a 5.0 one is SST 4's first:
// `Cron` with `job`. Cloudflare's `StaticSite`, and `Cron` without its args,
// are read as 5.0's, which they are in a config the codemod already ran on.
function oldForm(node: ts.Node, ref: Ref) {
  const call = node.parent;
  const args =
    ts.isNewExpression(call) && call.expression === node
      ? argsOf(call, 1)
      : undefined;
  if (ref.group === "aws" && ref.name === "Cron")
    return !!args && !!prop(args, "job");
  if (ref.group === "cloudflare" && ref.name === "StaticSite") return false;
  return true;
}

// What SST 4's `Function` took that 5.0's takes another way: in a `Function`'s
// args, and in a function's args another component is given
function functionArgs(ctx: FileContext, args: ts.ObjectLiteralExpression) {
  const role = prop(args, "role");
  if (role) {
    ctx.move(args, role, args, ["existing"], "role");
    ctx.change(role, "function-role", "A function's `role` is `existing.role`");
  }
  const logging = objectProp(args, "logging");
  const logGroup = prop(logging, "logGroup");
  if (logging && logGroup) {
    ctx.move(logging, logGroup, args, ["existing"], "logGroup");
    ctx.change(
      logGroup,
      "function-log-group",
      "A function's `logging.logGroup` is `existing.logGroup`",
    );
  }
  const live = prop(args, "live");
  if (live) {
    const value = literal(live);
    if (value === false) {
      ctx.rename(live, "dev");
      ctx.change(
        live,
        "function-live",
        "A function's `live: false` is `dev: false`",
      );
    } else if (value === true) {
      ctx.remove(args, live);
      ctx.change(
        live,
        "function-live",
        "A function's `live: true` is removed: it's the default",
      );
    } else
      ctx.note(
        live,
        "function-live",
        "A function's `live` is `dev`: `dev: false` where it's false.",
      );
  }
  const url = objectProp(args, "url");
  const route = prop(url, "route");
  if (route) {
    const target =
      ts.isPropertyAssignment(route) &&
      ts.isObjectLiteralExpression(route.initializer)
        ? route.initializer
        : undefined;
    const router = prop(target, "router");
    if (target && router) {
      ctx.rename(route, "router");
      ctx.rename(router, "instance");
      ctx.change(
        route,
        "function-url-route",
        "A function's `url.route: { router }` is `url.router: { instance }`",
      );
    } else
      ctx.note(
        route,
        "function-url-route",
        "A function's `url.route: { router, ... }` is `url.router: { instance, ... }`.",
      );
  }
}

// Whether a node is in the args of a call on one of SST's components, in SST
// 4's form: its `new`, a method of it, or a static method
function insideSst4(ctx: FileContext, node: ts.Node) {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isNewExpression(up)) {
      const ref = chain(up.expression);
      if (ref) return ref.group === "aws" && !ref.written5;
    }
    if (
      ts.isCallExpression(up) &&
      ts.isPropertyAccessExpression(up.expression)
    ) {
      const ref =
        chain(up.expression.expression) ??
        componentOf(ctx, up.expression.expression);
      if (ref) return ref.group === "aws" && !ref.written5;
    }
  }
  return false;
}

// A domain given by SST 4's `nameId` is `existing.domainName`. Its `dns` and
// `cert`, which SST 4 ignored then, go
function domainNameId(component: string) {
  return (ctx: FileContext, args: ts.ObjectLiteralExpression) => {
    const domainProp = prop(args, "domain");
    const domain = objectProp(args, "domain");
    const nameId = prop(domain, "nameId");
    if (!domainProp || !domain || !nameId) return;
    const ignored = domain.properties.filter((p) =>
      ["dns", "cert"].includes(keyOf(p) ?? ""),
    );
    const rest = domain.properties.filter(
      (p) => !["nameId", "dns", "cert"].includes(keyOf(p) ?? ""),
    );
    if (rest.length === 0) {
      ctx.move(domain, nameId, args, ["existing"], "domainName", true);
      ctx.remove(args, domainProp);
    } else {
      ctx.move(domain, nameId, args, ["existing"], "domainName");
      for (const p of ignored) ctx.remove(domain, p);
    }
    ctx.change(
      nameId,
      "api-domain-name-id",
      `${component}'s \`domain.nameId\` is \`existing.domainName\``,
    );
    for (const p of ignored)
      ctx.change(
        p,
        "api-domain-name-id",
        `${component}'s \`domain.${keyOf(
          p,
        )}\` is removed: SST 4 ignored it with \`nameId\`, and the domain you have keeps its own`,
      );
  };
}

// A site's `route`, `cdn` and what its `router` took that SST 4 ignored
function siteArgs(
  ctx: FileContext,
  args: ts.ObjectLiteralExpression,
  ref: Ref,
) {
  const route = prop(args, "route");
  if (route) {
    const target =
      ts.isPropertyAssignment(route) &&
      ts.isObjectLiteralExpression(route.initializer)
        ? route.initializer
        : undefined;
    const router = prop(target, "router");
    if (target && router && !prop(args, "router")) {
      ctx.rename(route, "router");
      ctx.rename(router, "instance");
      ctx.change(
        route,
        "site-route",
        `\`${ref.five}\`'s \`route: { router }\` is \`router: { instance }\``,
      );
    } else
      ctx.note(
        route,
        "site-route",
        `\`${ref.five}\`'s \`route: { router, ... }\` is \`router: { instance, ... }\`.`,
      );
  }
  // SST 4 refused `server.edge`, and took it at the top level
  const server = objectProp(args, "server");
  const serverEdge = prop(server, "edge");
  if (server && serverEdge && ssrSites.includes(ref.five)) {
    if (prop(args, "edge"))
      ctx.note(
        serverEdge,
        "site-server-edge",
        `\`${ref.five}\`'s \`server.edge\` is \`edge\`, which it has: SST 4 refused \`server.edge\`.`,
      );
    else {
      ctx.move(server, serverEdge, args, [], "edge");
      ctx.change(
        serverEdge,
        "site-server-edge",
        `\`${ref.five}\`'s \`server.edge\` is \`edge\`, as SST 4 took it`,
      );
    }
  }
  const cdn = prop(args, "cdn");
  if (cdn) {
    if (literal(cdn) === true) {
      ctx.remove(args, cdn);
      ctx.change(
        cdn,
        "site-cdn",
        `\`${ref.five}\`'s \`cdn: true\` is removed: it's the default`,
      );
    } else
      ctx.note(
        cdn,
        "site-cdn",
        `\`${ref.five}\`'s \`cdn\` is gone: a site without its own distribution is served by a \`Router\`, with \`router: { instance, path }\`.`,
      );
  }
  const router = objectProp(args, "router");
  for (const key of [
    "rewrite",
    "readTimeout",
    "keepAliveTimeout",
    "connectionTimeout",
    "connectionAttempts",
  ]) {
    const p = prop(router, key);
    if (!router || !p) continue;
    ctx.remove(router, p);
    ctx.change(
      p,
      "site-router",
      `\`${ref.five}\`'s \`router.${key}\` is removed: SST 4 ignored it for a site. A rewrite goes on the router's \`route()\`, and its timeouts on the router's origins`,
    );
  }
}

// A Lambda authorizer's `payload` and `response`, which API Gateway ignores on
// a WebSocket API
function lambdaFields(
  ctx: FileContext,
  args: ts.ObjectLiteralExpression | undefined,
) {
  const lambda = objectProp(args, "lambda");
  for (const key of ["payload", "response"]) {
    const p = prop(lambda, key);
    if (!lambda || !p) continue;
    ctx.remove(lambda, p);
    ctx.change(
      p,
      "websocket-authorizer",
      `\`ApiGatewayWebSocket\`'s authorizer \`lambda.${key}\` is removed: API Gateway ignores it on a WebSocket API`,
    );
  }
}
