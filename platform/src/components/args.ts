import { type Unwrap, Output, output } from "@pulumi/pulumi";
import type { Input } from "./input";
import { VisibleError } from "./error";

/**
 * The plain form of an arg that 4.x takes as an `Input`: the value itself,
 * not an output or a promise of it. What's inside it can still be inputs.
 *
 * ```ts
 * cors?: Plain<BucketArgs["cors"]>;
 * ```
 */
export type Plain<T> = T extends Input<infer U> ? U : T;

/**
 * Turn an arg into what a resource takes. When the arg is a plain value, with
 * no output or promise anywhere inside it, it's turned now, and the resource
 * is given a plain value. Otherwise it's turned once it resolves.
 *
 * A part's `transform` function sees what this gives, so an app whose config
 * is plain values gets plain values there, as SST 4 gave them.
 *
 * ```ts
 * clusterMode: mapArg(args.cluster, (v) => (v ? "enabled" : "disabled")),
 * ```
 */
export function mapArg<T, R>(
  value: Input<T>,
  convert: (value: Unwrap<T>) => Input<R>,
): Input<R> {
  return known(value)
    ? convert(value as Unwrap<T>)
    : output(value).apply(convert as (value: Unwrap<T>) => R);
}

/**
 * An arg's value, or `fallback` when the user left it out. Pass `convert` to
 * turn it into what the resource takes. It's a plain value when the arg is,
 * as `mapArg()` says.
 *
 * ```ts
 * withDefault(args.engine, "redis");
 * withDefault(args.delay, "0 seconds", toSeconds);
 * ```
 */
export function withDefault<T>(
  value: Input<T | undefined> | undefined,
  fallback: T,
): Input<T>;
export function withDefault<T, R>(
  value: Input<T | undefined> | undefined,
  fallback: T,
  convert: (value: Unwrap<T>) => R,
): Input<R>;
export function withDefault(
  value: any,
  fallback: unknown,
  convert?: (value: unknown) => unknown,
) {
  return mapArg(value, (value: unknown) => {
    const set = value ?? fallback;
    return convert ? convert(set) : set;
  });
}

/**
 * What a resource takes for an arg the user may have left out: the value
 * when they set it, and nothing when they didn't. Pass `convert` to turn the
 * value into what the resource takes. It's a plain value when the arg is, as
 * `mapArg()` says.
 *
 * ```ts
 * authorizerId: ifSet(auth.authorizer),
 * redrivePolicy: ifSet(args.dlq, (dlq) => jsonStringify({ ... })),
 * ```
 */
export function ifSet<T>(value: Input<T | undefined> | undefined): Input<T>;
export function ifSet<T, R>(
  value: Input<T | undefined> | undefined,
  convert: (value: Unwrap<T>) => Input<R>,
): Input<R>;
export function ifSet(value: any, convert?: (value: unknown) => unknown) {
  return mapArg(value, (value: unknown) =>
    value === undefined || value === null || !convert ? value : convert(value),
  );
}

// Whether a value is known now: no output or promise anywhere inside it. A
// resource or any other class instance counts as known, as `output()` keeps
// one as it is.
function known(value: unknown): boolean {
  if (Output.isInstance(value) || value instanceof Promise) return false;
  if (Array.isArray(value)) return value.every(known);
  if (value === null || typeof value !== "object") return true;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return true;
  return Object.values(value).every(known);
}

/**
 * Check that an arg is a plain value. An arg that decides which resources a
 * component creates has to be known up front, so it can't be an output. The
 * fields inside it still can.
 *
 * ```ts
 * const domain = plain(args.domain, `The "domain" of the "${name}" API`);
 * ```
 *
 * @param what The arg, as the start of the error message.
 * @param why Why it has to be known up front, for an arg that doesn't decide
 * which resources are created, like what a function's build reads.
 */
export function plain<T>(
  value: T,
  what: string,
  why = "It decides which resources are created, so it has to be known before they are.",
): T {
  if (Output.isInstance(value) || value instanceof Promise)
    throw new VisibleError(
      `${what} has to be a plain value, not an output. ${why}`,
    );
  return value;
}

/**
 * Check that an arg is plain all the way down: the value, and everything
 * inside it. This is for an arg a resource is named after, like the
 * conditions of a load balancer rule.
 *
 * ```ts
 * plainDeep(rule, `Rule ${i + 1} of the "${name}" service`);
 * ```
 *
 * @param what The arg, as the start of the error message.
 * @param why Why it has to be known up front, as for `plain()`.
 */
export function plainDeep<T>(value: T, what: string, why?: string): T {
  plain(value, what, why);
  if (value && typeof value === "object")
    for (const inner of Object.values(value)) plainDeep(inner, what, why);
  return value;
}

/**
 * Fail when a method is given an option it doesn't take, saying what to use
 * instead. The types flag this too, but a config runs without being
 * type-checked, and the option would be dropped without a word.
 *
 * ```ts
 * notAnOption(
 *   args,
 *   "route",
 *   `Route it with "router".`,
 *   `the "${name}" Astro site`,
 * );
 * ```
 *
 * @param owner What the option was given to, as `the "Web" Astro site`, so an
 * app with several of them knows which. Leave it out only for a method's own
 * options, which the call names.
 */
export function notAnOption(
  args: object,
  option: string,
  instead: string,
  owner?: string,
) {
  if ((args as Record<string, unknown>)[option] !== undefined)
    throw new VisibleError(
      `"${option}" isn't an option ${
        owner ? `for ${owner}` : "here"
      }. ${instead}`,
    );
}

/**
 * Fail when `existing` has a resource for a part the component can't take one
 * for, saying what to do instead.
 *
 * ```ts
 * notAnExistingPart(
 *   args.existing,
 *   "logGroup",
 *   `the "${name}" MicroVm`,
 *   `Change it in "transform.logGroup".`,
 * );
 * ```
 */
export function notAnExistingPart(
  existing: object | undefined,
  part: string,
  owner: string,
  instead: string,
) {
  if ((existing as Record<string, unknown> | undefined)?.[part] !== undefined)
    throw new VisibleError(
      `"existing.${part}" isn't an option for ${owner}. ${instead}`,
    );
}

/**
 * Fail when a component given an existing resource is also given args that
 * would configure it. The resource is used the way it is, so they'd be
 * dropped without a word. Args a `get` made, with `getArgs()`, aren't
 * checked: what else is in them came from a `$transform`.
 *
 * ```ts
 * if (this.existingPart("queue"))
 *   usedAsItIs(args, ["fifo", "delay", "dlq"], "queue", `the "${name}" queue`);
 * ```
 */
export function usedAsItIs(
  args: object,
  keys: readonly string[],
  part: string,
  owner: string,
) {
  if (isFromGet(args)) return;
  const set = keys.filter(
    (key) => (args as Record<string, unknown>)[key] !== undefined,
  );
  if (set.length > 0)
    throw new VisibleError(
      `${owner[0].toUpperCase()}${owner.slice(
        1,
      )} is given an existing "${part}", which it uses the way it is. Remove ${set
        .map((key) => `"${key}"`)
        .join(", ")} from its args.`,
    );
}

/**
 * The value of an output once a preview knows it, or `undefined` while it
 * doesn't, like the ids of subnets a new stage is about to create. In a
 * deploy, every value is known once it's resolved. For deciding from what a
 * preview knows with `after()`.
 */
export function knownValue<T>(value: Output<T>): Promise<T | undefined> {
  const resolved = value as unknown as {
    isKnown: Promise<boolean>;
    promise(): Promise<T>;
  };
  return resolved.isKnown.then((known) =>
    known ? resolved.promise() : undefined,
  );
}

/**
 * The same value, without the resources it came from: what's given it doesn't
 * depend on them, though it still waits for the value. For a value that's
 * made on this machine from things in AWS, like a function's built code,
 * which is given its links. Without this the code would depend on everything
 * that's linked.
 */
export function withoutDependencies<T>(value: Output<T>): Output<T> {
  const from = value as any;
  // As Pulumi's own `unsecret()` rebuilds an output
  return new (Output as any)(
    [],
    from.promise(/* withUnknowns */ true),
    from.isKnown,
    from.isSecret,
    Promise.resolve([]),
  );
}

/**
 * Fail for each entry of `existing` the component has no use for, next to the
 * resource it's given in `existing` and uses the way it is.
 *
 * ```ts
 * onlyExisting(args.existing, ["instance", "secret", "proxy"], owner);
 * ```
 *
 * @param used The entries it uses, the main resource first.
 */
export function onlyExisting(
  existing: object | undefined,
  used: readonly [string, ...string[]],
  owner: string,
) {
  const [main] = used;
  for (const key of Object.keys(existing ?? {}))
    if (!used.includes(key))
      notAnExistingPart(
        existing,
        key,
        owner,
        `It's given an existing "${main}", which it uses the way it is, so it creates nothing this would stand in for. Remove it.`,
      );
}

/**
 * `notAnOption()` for an option inside an arg, like `router.rewrite`, given
 * its value.
 */
export function notAnOptionOf(
  value: unknown,
  option: string,
  instead: string,
  owner: string,
) {
  notAnOption({ [option]: value }, option, instead, owner);
}

// What a component's `get` gives it is `existing` alone: a resource that's
// used the way it is. A `$transform` for the component runs on those args
// too, and what it sets for every one of its kind, like a runtime for every
// function, isn't meant for one that's only referenced.
const fromGet = new WeakSet<object>();

/**
 * The args a component's `get` creates it with. `usedAsItIs()` doesn't check
 * them.
 *
 * ```ts
 * return new Queue(name, getArgs({ existing: { queue } }), opts);
 * ```
 */
export function getArgs<T extends object>(args: T): T {
  fromGet.add(args);
  return args;
}

/**
 * Whether a component's args are the ones its `get` made, which only
 * reference a resource: what else is in them came from a `$transform`.
 */
export function isFromGet(args: object) {
  return fromGet.has(args);
}
