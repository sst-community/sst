import {
  all,
  ComponentResourceOptions,
  Input,
  Output,
  output,
} from "@pulumi/pulumi";
import { Function, FunctionArgs, FunctionArn } from "../function.js";
import { Workflow } from "../workflow.js";
import { transform, Transform } from "../../component";
import type {
  DeferredPart,
  ManyPart,
  Parts,
  PartsComponent,
} from "../../parts-component";
import { VisibleError } from "../../error";
import { splitQualifiedFunctionArn } from "./arn.js";

export type FunctionBuilder = Output<{
  getFunction: () => Function;
  arn: Output<string>;
  targetArn: Output<string>;
  qualifier: Output<string | undefined>;
  targetInvokeArn: Output<string>;
  targetResponseStreamingInvokeArn: Output<string>;
}>;

/**
 * Create a component's function part from what the user passed: a handler,
 * the function's args, or the ARN of a function they already have.
 *
 * The part has to be declared as `deferred(Function)`. It's created once the
 * definition is known, and not at all when it's an ARN.
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
 * @param defaultArgs Args the component adds: its link, environment and permissions are merged with the user's.
 */
export function functionPart<P extends Parts, K extends FunctionKeys<P>>(
  component: PartsComponent<P>,
  key: K,
  definition: FunctionDefinition,
  defaultArgs: FunctionDefaults,
): FunctionBuilder;
/**
 * @param id Which one to create, for a part declared as `many(deferred(Function))`.
 */
export function functionPart<P extends Parts, K extends ManyFunctionKeys<P>>(
  component: PartsComponent<P>,
  key: K,
  id: string,
  definition: FunctionDefinition,
  defaultArgs: FunctionDefaults,
): FunctionBuilder;
export function functionPart(
  component: PartsComponent<any>,
  key: string,
  ...rest: any[]
): FunctionBuilder {
  const [id, definition, defaultArgs] =
    rest.length === 3 ? rest : [undefined, ...rest];

  const part = component.partHandle(key, id);
  const fn = functionBuilder(
    part.name,
    // A function passed in `existing`, or its ARN, is used as it is
    (part.existing as FunctionDefinition | undefined) ?? definition,
    defaultArgs,
    part.transform,
    part.opts,
  );
  part.defer(() => fn.apply((fn) => fn.getFunction()));
  return fn;
}

type FunctionDefinition = Parameters<typeof functionBuilder>[1];
type FunctionDefaults = Parameters<typeof functionBuilder>[2];
type FunctionKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends DeferredPart<typeof Function> ? K : never;
}[keyof P] &
  string;
type ManyFunctionKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends ManyPart<DeferredPart<typeof Function>>
    ? K
    : never;
}[keyof P] &
  string;

export function functionBuilder(
  name: string,
  definition: Input<string | Workflow | Function | FunctionArgs | FunctionArn>,
  defaultArgs: Pick<
    FunctionArgs,
    | "description"
    | "link"
    | "environment"
    | "permissions"
    | "url"
    | "streaming"
    | "_skipHint"
  >,
  argsTransform?: Transform<FunctionArgs>,
  opts?: ComponentResourceOptions,
): FunctionBuilder {
  function buildResult(fn: Function) {
    return {
      getFunction: () => fn,
      arn: fn.arn,
      targetArn: fn.targetArn,
      qualifier: fn.qualifier,
      targetInvokeArn: fn.targetInvokeArn,
      targetResponseStreamingInvokeArn: fn.targetResponseStreamingInvokeArn,
    };
  }

  return output(definition).apply((definition) => {
    if (definition instanceof Workflow) {
      return buildResult(definition.getFunction());
    }

    if (definition instanceof Function) {
      return buildResult(definition);
    }

    if (typeof definition === "string") {
      // Case 1: The definition is an ARN
      if (definition.startsWith("arn:")) {
        const { unqualifiedArn, qualifier } = splitQualifiedFunctionArn(
          definition,
        );
        const parts = definition.split(":");
        return {
          getFunction: () => {
            throw new VisibleError(
              "Cannot access the created function because it is referenced as an ARN.",
            );
          },
          arn: output(unqualifiedArn),
          targetArn: output(definition),
          qualifier: output(qualifier),
          targetInvokeArn: output(
            `arn:${parts[1]}:apigateway:${parts[3]}:lambda:path/2015-03-31/functions/${definition}/invocations`,
          ),
          targetResponseStreamingInvokeArn: output(
            `arn:${parts[1]}:apigateway:${parts[3]}:lambda:path/2021-11-15/functions/${definition}/response-streaming-invocations`,
          ),
        };
      }

      // Case 2: The definition is a handler
      const fn = new Function(
        ...transform(
          argsTransform,
          name,
          { handler: definition, ...defaultArgs },
          opts || {},
        ),
      );
      return buildResult(fn);
    }

    // Case 3: The definition is a FunctionArgs
    else if (definition.handler) {
      const fn = new Function(
        ...transform(
          argsTransform,
          name,
          {
            ...defaultArgs,
            ...definition,
            link: all([defaultArgs?.link, definition.link]).apply(
              ([defaultLink, link]) => [
                ...(defaultLink ?? []),
                ...(link ?? []),
              ],
            ),
            environment: all([
              defaultArgs?.environment,
              definition.environment,
            ]).apply(([defaultEnvironment, environment]) => ({
              ...(defaultEnvironment ?? {}),
              ...(environment ?? {}),
            })),
            permissions: all([
              defaultArgs?.permissions,
              definition.permissions,
            ]).apply(([defaultPermissions, permissions]) => [
              ...(defaultPermissions ?? []),
              ...(permissions ?? []),
            ]),
          },
          opts || {},
        ),
      );
      return buildResult(fn);
    }
    throw new Error(`Invalid function definition for the "${name}" Function`);
  });
}
