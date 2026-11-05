import { all, Input, Output, output } from "@pulumi/pulumi";
import { VisibleError } from "../../error";
import { transformPart } from "../../transform";
import type {
  DeferredPart,
  ManyPart,
  NamedPart,
  Parts,
  PartsComponent,
} from "../../parts-component";
import { Function, FunctionArgs, FunctionArn } from "../function";
import { Workflow } from "../workflow";
import { splitQualifiedFunctionArn } from "./arn";

/**
 * A component's function: one the component created, or one the user
 * already has. Either way it can be invoked through these.
 */
export type FunctionPart = Output<{
  /** The function, when there is one to return: not for one given as an ARN. */
  getFunction: () => Function;
  arn: Output<string>;
  /** The ARN to invoke: the latest version of a function that has versions. */
  targetArn: Output<string>;
  qualifier: Output<string | undefined>;
  targetInvokeArn: Output<string>;
  targetResponseStreamingInvokeArn: Output<string>;
}>;

/** A `Function` component. */
export type AnyFunction = Function;

/**
 * What a user can pass for a function: a handler, its args, or one they
 * have, as its ARN, the function itself, or the workflow it runs.
 */
export type FunctionDefinition = Input<
  | string
  | FunctionArgs
  | FunctionArn
  | Function
  | Workflow
>;

/**
 * A function to run: the handler of one to create, its args, a function you
 * already have, or the ARN of one. A handler and the args are plain values,
 * since whether a function is created is decided from them. A function you
 * have, or its ARN, can be an output.
 */
export type FunctionInput =
  | Input<string>
  | FunctionArgs
  | Input<Function>
  | Input<Workflow>;

/**
 * What `existing` gives a function part: a function you have, a workflow, or
 * the ARN of one, which an output can resolve to. A handler or a function's
 * args would create a function, which isn't what `existing` is for.
 */
function existingFunction(given: unknown, what: string): FunctionDefinition {
  if (Output.isInstance(given) || typeof (given as any)?.then === "function")
    return plainFunction(given as FunctionInput, what);
  if (
    given instanceof Function ||
    given instanceof Workflow ||
    (typeof given === "string" && given.startsWith("arn:"))
  )
    return given as FunctionDefinition;
  throw new VisibleError(
    `${what} isn't a function or the ARN of one. Pass the function you have, or its ARN. A handler or the function's args create a function: pass them where the component takes its function, not in "existing".`,
  );
}

/**
 * A function a component takes the 5.0 way, checked: what's created is
 * decided from what was passed, and a preview has to know it, so only a
 * function that's already there, or its ARN, can be an output. Pass what it
 * returns to `functionPart()`.
 *
 * ```ts
 * functionPart(this, "subscriber", plainFunction(args.subscriber, `The subscriber of the "${name}" queue`), {});
 * ```
 *
 * @param what The arg, for the error.
 */
export function plainFunction(
  definition: FunctionInput,
  what: string,
): FunctionDefinition {
  if (
    !Output.isInstance(definition) &&
    typeof (definition as any)?.then !== "function"
  )
    return definition;
  // What it resolves to creates nothing, so it can wait for the deploy
  return output(definition as Input<any>).apply((value: unknown) => {
    if (typeof value === "string" && value.startsWith("arn:"))
      return value as FunctionArn;
    if (
      value instanceof Function ||
      value instanceof Workflow
    )
      return value;
    throw new VisibleError(
      `${what} is an output that isn't a function or the ARN of one. A handler or the function's args have to be a plain value, since whether a function is created is decided from them. To use a function you have, pass the function itself or its ARN.`,
    );
  });
}

/** Args a component adds to its function. Its link, environment and permissions are added to the user's. */
export type FunctionDefaults = Pick<
  FunctionArgs,
  | "description"
  | "link"
  | "environment"
  | "permissions"
  | "url"
  | "streaming"
  | "_skipHint"
>;

/**
 * Create a component's function part from what the user passed: a handler,
 * the function's args, or the ARN of a function they already have.
 *
 * The part has to be declared as `deferred(Function)`. It's created once
 * the definition is known, and not at all when it's an ARN.
 *
 * ```ts
 * const parts = () => ({ function: deferred(Function) });
 *
 * const fn = functionPart(this, "function", args.subscriber, {
 *   description: `Subscribed to ${name}`,
 *   permissions: [{ actions: ["sqs:ReceiveMessage"], resources: [queueArn] }],
 * });
 * fn.arn; // works for all three
 * ```
 *
 * @param component The component the function belongs to.
 * @param key The part to create.
 * @param definition The handler, function args, or function ARN.
 * @param defaults Args the component adds: its link, environment and permissions are added to the user's.
 */
export function functionPart<P extends Parts, K extends FunctionKeys<P>>(
  component: PartsComponent<P>,
  key: K,
  definition: FunctionDefinition,
  defaults: FunctionDefaults,
): FunctionPart;
/**
 * @param id Which one to create, for a part declared as `many(deferred(Function))`.
 */
export function functionPart<P extends Parts, K extends ManyFunctionKeys<P>>(
  component: PartsComponent<P>,
  key: K,
  id: string,
  definition: FunctionDefinition,
  defaults: FunctionDefaults,
): FunctionPart;
export function functionPart(
  component: PartsComponent<any>,
  key: string,
  ...rest: any[]
): FunctionPart {
  const [id, definition, defaults]: [
    string | undefined,
    FunctionDefinition,
    FunctionDefaults,
  ] = rest.length === 3 ? (rest as any) : [undefined, ...rest];

  const part = component.partHandle(key, id);
  // A function passed in `existing`, or its ARN, is used as it is
  const given =
    part.existing === undefined
      ? definition
      : existingFunction(
          part.existing,
          `The "existing.${key}"${id === undefined ? "" : ` named "${id}"`} of "${part.name}"`,
        );
  // What was passed decides what to do, not the values inside it. Waiting on
  // those too would leave the function out of a preview whenever an arg isn't
  // known until the deploy, and `sst diff` would show it as deleted.
  let fn: FunctionPart;
  if (Output.isInstance(given) || typeof (given as any)?.then === "function") {
    fn = output(given).apply(create);
  } else {
    const created = create(given);
    fn = output(undefined).apply(() => created);
  }
  part.defer(() => fn.apply((fn) => fn.getFunction()));
  return fn;

  function create(definition: unknown) {
    if (definition instanceof Function) return use(definition);
    if (definition instanceof Workflow) return use(definition.getFunction());
    if (typeof definition === "string" && definition.startsWith("arn:"))
      return useArn(definition, part.name);

    const args: Record<string, any> =
      typeof definition === "string"
        ? { handler: definition }
        : (definition as object);
    if (!args?.handler)
      throw new VisibleError(
        `The "${part.name}" function has no handler. Pass a handler, the function's args with a "handler", a function, or the ARN of one.`,
      );

    return use(
      new Function(
        ...transformPart(
          part.transform,
          part.name,
          // Written the way SST 4's `Function` took it, or SST 5's
          withDefaults(defaults, args),
          part.opts,
        ),
      ),
    );
  }
}

/**
 * The function's args with what the component adds: its other args are
 * defaults, and its link, environment and permissions are added to the
 * user's. Each of those is made an output only when one of the two is, so a
 * `$transform` for functions can spread what it's given, as it could with
 * the 4.x components: spreading an output copies the output, not its value.
 */
function withDefaults(
  defaults: FunctionDefaults,
  args: Record<string, any>,
): Record<string, any> {
  const merged: Record<string, any> = { ...defaults, ...args };
  const join = <T>(
    key: "link" | "environment" | "permissions",
    combine: (added: T, given: T) => T,
  ) => {
    const added = (defaults as Record<string, any>)[key];
    const given = args[key];
    if (given === undefined) {
      if (added !== undefined) merged[key] = added;
      return;
    }
    if (added === undefined) return;
    merged[key] =
      isPlain(added) && isPlain(given)
        ? combine(added, given)
        : all([added, given]).apply(([added, given]) =>
            combine(added as T, given as T),
          );
  };
  join<unknown[]>("link", (added, given) => [...added, ...given]);
  join<Record<string, unknown>>("environment", (added, given) => ({
    ...added,
    ...given,
  }));
  join<unknown[]>("permissions", (added, given) => [...added, ...given]);
  return merged;
}

const isPlain = (value: unknown) =>
  !Output.isInstance(value) && typeof (value as any)?.then !== "function";

function use(fn: Function) {
  return {
    getFunction: () => fn,
    arn: fn.arn,
    targetArn: fn.targetArn,
    qualifier: fn.qualifier,
    targetInvokeArn: fn.targetInvokeArn,
    targetResponseStreamingInvokeArn: fn.targetResponseStreamingInvokeArn,
  };
}

function useArn(arn: string, name: string) {
  const { unqualifiedArn, qualifier } = splitQualifiedFunctionArn(arn);
  const [, partition, , region] = arn.split(":");
  const invoke = (api: string, path: string) =>
    `arn:${partition}:apigateway:${region}:lambda:path/${api}/functions/${arn}/${path}`;
  return {
    getFunction: (): Function => {
      throw new VisibleError(
        `The "${name}" function is given by its ARN, so there's no function component for it in "nodes".`,
      );
    },
    arn: output(unqualifiedArn),
    targetArn: output(arn),
    qualifier: output(qualifier),
    targetInvokeArn: output(invoke("2015-03-31", "invocations")),
    targetResponseStreamingInvokeArn: output(
      invoke("2021-11-15", "response-streaming-invocations"),
    ),
  };
}

type FunctionKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends
    | DeferredPart<typeof Function>
    | NamedPart<DeferredPart<typeof Function>>
    ? K
    : never;
}[keyof P] &
  string;
type ManyFunctionKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends ManyPart<DeferredPart<typeof Function>>
    ? K
    : never;
}[keyof P] &
  string;
