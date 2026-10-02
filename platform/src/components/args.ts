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
 * An arg's value, or `fallback` when the user left it out. Pass `convert` to
 * turn it into what the resource takes.
 *
 * ```ts
 * withDefault(args.engine, "redis");
 * withDefault(args.delay, "0 seconds", toSeconds);
 * ```
 */
export function withDefault<T>(
  value: Input<T | undefined> | undefined,
  fallback: T,
): Output<T>;
export function withDefault<T, R>(
  value: Input<T | undefined> | undefined,
  fallback: T,
  convert: (value: Unwrap<T>) => R,
): Output<R>;
export function withDefault(
  value: any,
  fallback: unknown,
  convert?: (value: unknown) => unknown,
) {
  return output(value).apply((value) => {
    const set = value ?? fallback;
    return convert ? convert(set) : set;
  });
}

/**
 * What a resource takes for an arg the user may have left out: the value
 * when they set it, and nothing when they didn't. Pass `convert` to turn the
 * value into what the resource takes.
 *
 * ```ts
 * authorizerId: ifSet(auth.authorizer),
 * redrivePolicy: ifSet(args.dlq, (dlq) => jsonStringify({ ... })),
 * ```
 */
export function ifSet<T>(value: Input<T | undefined> | undefined): Output<T>;
export function ifSet<T, R>(
  value: Input<T | undefined> | undefined,
  convert: (value: Unwrap<T>) => Input<R>,
): Output<R>;
export function ifSet(value: any, convert?: (value: unknown) => unknown) {
  return output(value).apply((value) =>
    value === undefined || value === null || !convert ? value : convert(value),
  );
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
 */
export function plain<T>(value: T, what: string): T {
  if (Output.isInstance(value) || value instanceof Promise)
    throw new VisibleError(
      `${what} has to be a plain value, not an output. It decides which resources are created, so it has to be known before they are.`,
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
 */
export function plainDeep<T>(value: T, what: string): T {
  plain(value, what);
  if (value && typeof value === "object")
    for (const inner of Object.values(value)) plainDeep(inner, what);
  return value;
}

/**
 * Fail when a method is given an option it doesn't take, saying what to use
 * instead. The types flag this too, but a config runs without being
 * type-checked, and the option would be dropped without a word.
 *
 * ```ts
 * notAnOption(args, "transform", `Use the "transform" of the "${name}" queue.`);
 * ```
 */
export function notAnOption(args: object, option: string, instead: string) {
  if ((args as Record<string, unknown>)[option] !== undefined)
    throw new VisibleError(`"${option}" isn't an option here. ${instead}`);
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
