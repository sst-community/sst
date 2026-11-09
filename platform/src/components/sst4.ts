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
  // Not its `permission`: SST 5's has one, the authorizer's
  "sst:aws:Realtime": {
    ...subscriber(`, by the subscriber's name`),
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

/**
 * The `nodes` names SST 4 had for a component of this type that SST 5
 * renamed, each with what to read instead.
 */
export function renamedNodesOf(type: string): Record<string, string> {
  return renamedNodes[type] ?? {};
}
