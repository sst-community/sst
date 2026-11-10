import { VisibleError } from "./error";

// SST 4's names that SST 5 doesn't have. A config written for SST 4 that
// still uses one fails with what to write: `new sst.aws.ApiGatewayV2(...)`
// would fail with "is not a constructor", and `vpc.nodes.privateSubnets`
// would read `undefined` and fail somewhere else. `sst migrate --codemod`
// rewrites the renamed ones; these are for a config it hasn't been run on, or
// code it can't read.

/**
 * What a name SST 5 doesn't have is at runtime: a class that refuses to be
 * created, saying what to write.
 */
export type Sst4Name = new (...args: any[]) => never;

/** A component SST 5 names otherwise. */
export function renamedComponent(name: string, now: string): Sst4Name {
  return refusing(
    `"${name}" is SST 4's name: it's "${now}" in SST 5. "sst migrate --codemod" renames it, and lists anything else to change in your config.`,
  );
}

/**
 * A component SST 5 doesn't have. `instead` says what to use, and what a
 * stage deployed with it does first.
 */
export function leftOutComponent(name: string, instead: string): Sst4Name {
  return refusing(`"${name}" has no SST 5 form. ${instead}`);
}

/**
 * SST 4's `.v1` of a component, read as `sst.aws.Vpc.v1`. `now` says what the
 * current one is, where it's more than another version of the same.
 */
export function firstVersion(name: string, now = `"${name}"`): never {
  throw new VisibleError(
    `"${name}.v1" is SST 4's first version of "${name}", which SST 5 doesn't have: use ${now}. A stage deployed with the first version moves to the current one with SST 4 first.`,
  );
}

// What each stub says, for what's handed one as a class, like `$transform`
const refusals = new WeakMap<object, string>();

function refusing(message: string): Sst4Name {
  const refuse = (): never => {
    throw new VisibleError(message);
  };
  const stub = class {
    constructor() {
      refuse();
    }
    // SST 4's `Vector` had a static `get`
    static get(): never {
      return refuse();
    }
  };
  refusals.set(stub, message);
  return stub as unknown as Sst4Name;
}

/**
 * Throws what a stub of SST 4's names says, when `cls` is one: for what takes
 * a component's class, like `$transform`, which would otherwise fail on what
 * the stub doesn't have.
 */
export function refuseSst4Name(cls: unknown) {
  const message = typeof cls === "function" ? refusals.get(cls) : undefined;
  if (message !== undefined) throw new VisibleError(message);
}

/**
 * Gives a resource a method returns in SST 5, where SST 4's returned a
 * component of its own for it, the `nodes` names that component had: each
 * says what to read instead. Without them, `authorizer.nodes.authorizer.id`
 * fails reading `authorizer` of `undefined`. They aren't enumerable, so
 * nothing that lists the resource's fields sees them.
 *
 * @param what What the method gives, in messages: `the authorizer`.
 * @param nodes What to read for each, where it isn't the resource itself.
 */
export function sst4NodesOn<T extends object>(
  resource: T,
  method: string,
  what: string,
  nodes: Record<string, string | undefined>,
): T {
  // One the app gave in `existing` may be its own, with `nodes` of its own
  if ("nodes" in resource) return resource;
  const refusing = Object.create(null);
  for (const [key, now] of Object.entries(nodes))
    Object.defineProperty(refusing, key, {
      enumerable: false,
      get() {
        throw new VisibleError(
          `"nodes.${key}" of what "${method}" gives is SST 4's: SST 5's "${method}" gives ${what} itself, which has no "nodes". ${
            now ?? `Read what "nodes.${key}" had on it, like its "id".`
          }`,
        );
      },
    });
  Object.defineProperty(resource, "nodes", {
    configurable: true,
    enumerable: false,
    value: refusing,
  });
  return resource;
}

/** @deprecated SST 4's: use `sst.Linkable.wrap`, which takes the same. */
export function linkable(..._args: unknown[]): never {
  throw new VisibleError(
    `"sst.linkable" is SST 4's: use "sst.Linkable.wrap", which takes the same.`,
  );
}

// The Vpc's parts there's one of in each AZ, which SST 4 listed in the plural
const vpcLists = [
  "publicSubnet",
  "privateSubnet",
  "publicRouteTable",
  "privateRouteTable",
  "elasticIp",
  "natGateway",
  "natInstance",
];

// What a subscriber's or a route's `nodes` had in SST 4, where the method
// that adds one gave a component of its own: SST 5's method gives the
// component itself, with each one's resources in its `nodes`
const added = (what: string, key: string, by: string) =>
  `"nodes.${key}"${by}: "${what}" gives the component itself in SST 5, not one of its own for each`;
const subscriber = (by = `, by the subscriber's name`) => ({
  function: added("subscribe", "subscriber", by),
});
const route = { function: added("route", "handler", `, by the route`) };

// `nodes` names SST 4 had that SST 5 renamed, by the component's type: what
// to read instead. One that's a part of SST 5's component isn't listed here.
export const renamedNodes: Record<string, Record<string, string>> = {
  "sst:aws:Alb": { listeners: `"nodes.listener", by the same keys` },
  "sst:aws:Auth": { authorizer: `"nodes.issuer"` },
  "sst:aws:Cron": { job: `"nodes.function"` },
  "sst:aws:CronV2": { job: `"nodes.function"` },
  "sst:aws:Bus": {
    ...subscriber(),
    policy: added(
      "subscribeQueue",
      "queuePolicy",
      `, by the subscriber's name`,
    ),
  },
  "sst:aws:SnsTopic": {
    ...subscriber(),
    policy: added(
      "subscribeQueue",
      "queuePolicy",
      `, by the subscriber's name`,
    ),
  },
  "sst:aws:Dynamo": subscriber(),
  "sst:aws:KinesisStream": subscriber(),
  "sst:aws:Queue": subscriber(""),
  "sst:aws:Realtime": {
    ...subscriber(`, by the subscriber's name`),
    permission: `${added(
      "subscribe",
      "subscriberPermission",
      `, by the subscriber's name`,
    )}. The authorizer's is "nodes.authorizerPermission"`,
    rule: added("subscribe", "topicRule", `, by the subscriber's name`),
  },
  "sst:aws:Bucket": {
    functions: added("notify", "subscriber", `, by the notification's name`),
  },
  "sst:aws:ApiGatewayV2": route,
  "sst:aws:ApiGatewayV1": route,
  "sst:aws:ApiGatewayWebSocket": route,
  "sst:cloudflare:Queue": {
    worker: added(
      "subscribe",
      "subscriber",
      `, a Worker whose "nodes.worker" is the script`,
    ),
  },
  "sst:aws:Nextjs": {
    revalidationFunction: `the revalidation queue's "nodes.subscriber". "nodes.revalidationQueue" is an output of the queue, undefined without ISR`,
  },
  "sst:aws:Vpc": Object.fromEntries(
    vpcLists.map((part) => [
      `${part}s`,
      `"nodes.${part}", by the AZ's number: "Object.values(nodes.${part})" for the list`,
    ]),
  ),
};

// SST 4's `nodes` names on what a method gave, where SST 5's method gives
// the component itself and has a part of that name, by the component's type:
// read on the component, each is a record by id, not the one resource SST 4's
// was. And a site's server, which SST 4 had one of.
const gaveOwn =
  (...methods: string[]) =>
  (key: string) =>
    `SST 4's ${methods
      .map((m) => `"${m}"`)
      .join(
        methods.length > 2 ? ", " : " and ",
      )} gave a component of its own for each, whose \`nodes.${key}\` was one: SST 5's ${
      methods.length > 1 ? "give" : "gives"
    } the component itself.`;
const firstServer = () =>
  `SST 4's was the server of the first region: \`Object.values(nodes.server)[0]\`.`;
export const keptById: Record<
  string,
  Record<string, (key: string) => string>
> = {
  "sst:aws:Bus": {
    permission: gaveOwn("subscribe"),
    rule: gaveOwn("subscribe", "subscribeQueue"),
    target: gaveOwn("subscribe", "subscribeQueue"),
  },
  "sst:aws:SnsTopic": {
    permission: gaveOwn("subscribe"),
    subscription: gaveOwn("subscribe", "subscribeQueue"),
  },
  "sst:aws:Dynamo": { eventSourceMapping: gaveOwn("subscribe") },
  "sst:aws:KinesisStream": { eventSourceMapping: gaveOwn("subscribe") },
  "sst:aws:ApiGatewayV2": {
    integration: gaveOwn("route", "routeUrl", "routePrivate"),
    permission: gaveOwn("route"),
    route: gaveOwn("route", "routeUrl", "routePrivate"),
  },
  "sst:aws:ApiGatewayV1": {
    integration: gaveOwn("route", "routeIntegration"),
    method: gaveOwn("route", "routeIntegration"),
    permission: gaveOwn("route"),
  },
  "sst:aws:ApiGatewayWebSocket": {
    integration: gaveOwn("route"),
    permission: gaveOwn("route"),
    route: gaveOwn("route"),
  },
  "sst:aws:AppSync": { resolver: gaveOwn("addResolver") },
  ...Object.fromEntries(
    [
      "Nextjs",
      "Astro",
      "SvelteKit",
      // SST 4's type, which SST 5 keeps
      "TanstackStart",
      "Nuxt",
      "SolidStart",
      "Analog",
      "Remix",
      "React",
    ].map((site) => [`sst:aws:${site}`, { server: firstServer }]),
  ),
};

/**
 * What SST 4 had where SST 5's component has a record by id under `key`, for
 * a read of one resource's field on the record: an empty string where SST 4
 * had nothing of the name.
 */
export function keptByIdOf(type: string, key: string): string {
  const said = keptById[type]?.[key];
  return said ? ` ${said(key)}` : "";
}

/**
 * The `nodes` names SST 4 had for a component of this type that SST 5
 * renamed, each with what to read instead.
 */
export function renamedNodesOf(type: string): Record<string, string> {
  return renamedNodes[type] ?? {};
}
