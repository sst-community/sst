import { all, Input, Output, output } from "@pulumi/pulumi";
import { VisibleError } from "../../error";
import { transformPart } from "../../transform";
import type {
  DeferredPart,
  ManyPart,
  Parts,
  PartsComponent,
} from "../../parts-component";
import { Function, FunctionArgs, FunctionArn } from "../function";
import { FunctionV5, FunctionV5Args } from "../function-v5";
import { parseRoleArn, splitQualifiedFunctionArn } from "./arn";

/**
 * A component's function: one the component created, or one the user
 * already has. Either way it can be invoked through these.
 */
export type FunctionPart = Output<{
  /** The function, when there is one to return: not for one given as an ARN. */
  getFunction: () => FunctionV5;
  arn: Output<string>;
  /** The ARN to invoke: the latest version of a function that has versions. */
  targetArn: Output<string>;
  qualifier: Output<string | undefined>;
  targetInvokeArn: Output<string>;
  targetResponseStreamingInvokeArn: Output<string>;
}>;

/** What a user can pass for a function: a handler, its args, or the ARN of one they have. */
export type FunctionDefinition = Input<
  string | FunctionArgs | FunctionV5Args | FunctionArn | FunctionV5
>;

/** Args a component adds to its function. Its link, environment and permissions are added to the user's. */
export type FunctionDefaults = Pick<
  FunctionV5Args,
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
 * The part has to be declared as `deferred(FunctionV5)`. It's created once
 * the definition is known, and not at all when it's an ARN.
 *
 * ```ts
 * const parts = () => ({ function: deferred(FunctionV5) });
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
 * @param id Which one to create, for a part declared as `many(deferred(FunctionV5))`.
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
  const fn = output(
    // A function passed in `existing`, or its ARN, is used as it is
    (part.existing as FunctionDefinition | undefined) ?? definition,
  ).apply((definition: unknown) => {
    if (definition instanceof FunctionV5 || definition instanceof Function)
      return use(definition);
    if (typeof definition === "string" && definition.startsWith("arn:"))
      return useArn(definition);

    const args: Record<string, any> =
      typeof definition === "string"
        ? { handler: definition }
        : (definition as object);
    if (!args?.handler)
      throw new VisibleError(
        `Invalid function definition for "${part.name}". Pass a handler, the function's args, or the ARN of a function.`,
      );

    return use(
      new FunctionV5(
        ...transformPart(
          part.transform,
          part.name,
          asV5Args({
            ...defaults,
            ...args,
            link: all([defaults.link, args.link]).apply(([added, link]) => [
              ...(added ?? []),
              ...(link ?? []),
            ]),
            environment: all([defaults.environment, args.environment]).apply(
              ([added, environment]) => ({ ...added, ...environment }),
            ),
            permissions: all([defaults.permissions, args.permissions]).apply(
              ([added, permissions]) => [
                ...(added ?? []),
                ...(permissions ?? []),
              ],
            ),
          }),
          part.opts,
        ),
      ),
    );
  });
  part.defer(() => fn.apply((fn) => fn.getFunction()));
  return fn;
}

function use(fn: FunctionV5 | Function) {
  return {
    getFunction: () => fn as FunctionV5,
    arn: fn.arn,
    targetArn: fn.targetArn,
    qualifier: fn.qualifier,
    targetInvokeArn: fn.targetInvokeArn,
    targetResponseStreamingInvokeArn: fn.targetResponseStreamingInvokeArn,
  };
}

function useArn(arn: string) {
  const { unqualifiedArn, qualifier } = splitQualifiedFunctionArn(arn);
  const [, partition, , region] = arn.split(":");
  const invoke = (api: string, path: string) =>
    `arn:${partition}:apigateway:${region}:lambda:path/${api}/functions/${arn}/${path}`;
  return {
    getFunction: (): FunctionV5 => {
      throw new VisibleError(
        "Cannot access the created function because it is referenced as an ARN.",
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

// A definition can be written the way `Function` takes it. The few options
// `FunctionV5` takes somewhere else are moved to where it takes them.
function asV5Args(args: Record<string, any>): FunctionV5Args {
  const { live, role, ...rest } = args;
  const existing = { ...rest.existing };
  let { dev, logging, url } = rest;

  if (dev === undefined && live === false) dev = false;
  // `Function` takes the role's ARN, and looks the role up by its name
  if (role) existing.role = parseRoleArn(role).roleName;
  if (logging && logging.logGroup !== undefined) {
    const { logGroup, ...others } = logging;
    existing.logGroup = logGroup;
    logging = others;
  }
  // The deprecated `url.route` names the router `router`
  if (url && typeof url === "object" && url.route) {
    const { route, ...others } = url;
    const { router, ...routing } = route;
    url = { router: { ...routing, instance: router }, ...others };
  }

  return {
    ...(rest as FunctionV5Args),
    dev,
    logging,
    url,
    ...(Object.keys(existing).length ? { existing } : {}),
  };
}

type FunctionKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends DeferredPart<typeof FunctionV5> ? K : never;
}[keyof P] &
  string;
type ManyFunctionKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends ManyPart<DeferredPart<typeof FunctionV5>>
    ? K
    : never;
}[keyof P] &
  string;
