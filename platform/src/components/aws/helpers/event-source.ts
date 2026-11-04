import { Input, Output, output } from "@pulumi/pulumi";
import type { lambda } from "@pulumi/aws";
import { DurationMinutes, toSeconds } from "../../duration";
import { VisibleError } from "../../error";
import type { PartsBuilder } from "../../parts-component";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "./function-part";

/**
 * The event source mapping settings for a subscription's `filters`: each
 * filter becomes a pattern, and a record is delivered when it matches one.
 */
export function filterCriteria(
  filters?: Input<Input<Record<string, any>>[]>,
) {
  if (!filters) return undefined;
  return {
    filters: output(filters).apply((filters) =>
      filters.map((filter) => ({ pattern: JSON.stringify(filter) })),
    ),
  };
}

/**
 * The event source mapping settings for a subscription's `batch`: how many
 * records to deliver at once, how long to wait for them, and whether the
 * function can report the ones that failed.
 */
export function batchSettings(
  batch?: Input<{
    size?: Input<number>;
    window?: Input<DurationMinutes>;
    partialResponses?: Input<boolean>;
  }>,
) {
  const settings = output(batch);
  return {
    batchSize: settings.apply((batch) => batch?.size ?? 10),
    maximumBatchingWindowInSeconds: settings.apply((batch) =>
      batch?.window ? toSeconds(batch.window) : 0,
    ),
    functionResponseTypes: settings.apply((batch) =>
      batch?.partialResponses ? ["ReportBatchItemFailures"] : [],
    ),
  };
}

/**
 * Check that a method that adds a subscriber is given the subscriber's name
 * first. SST 4 also took a subscriber without a name, and called that way the
 * arguments are shifted: the subscriber is where the name goes.
 *
 * ```ts
 * assertNamedSubscriber(`the "${name}" table`, "subscribe", name, subscriber);
 * ```
 *
 * @param owner The component, for the error: `the "MyTable" table`.
 * @param method The method that was called.
 */
export function assertNamedSubscriber(
  owner: string,
  method: string,
  name: unknown,
  subscriber: unknown,
) {
  // A subscription's args where the subscriber goes
  const isArgs =
    typeof subscriber === "object" &&
    subscriber !== null &&
    !Output.isInstance(subscriber) &&
    Object.getPrototypeOf(subscriber) === Object.prototype &&
    !("handler" in subscriber);
  if (typeof name === "string" && subscriber !== undefined && !isArgs) return;
  throw new VisibleError(
    `A subscriber of ${owner} needs a name, given first: ${method}("MySubscriber", ...).`,
  );
}

/**
 * A function subscribed to a queue or a stream: the function part, allowed to
 * read from it, and the event source mapping that sends it what's read. The
 * component declares them as `subscriber` and `eventSourceMapping`, one of
 * each, or one of each by the subscriber's name.
 *
 * ```ts
 * eventSourceSubscriber(this.builder(), name, subscriber, {
 *   component: this.componentName,
 *   kind: "table",
 *   source: streamArn,
 *   actions: ["dynamodb:GetRecords"],
 *   mapping: { startingPosition: "LATEST" },
 * });
 * ```
 *
 * @param id The subscriber's name, for a component with several.
 */
export function eventSourceSubscriber(
  builder: PartsBuilder<any>,
  id: string | undefined,
  subscriber: FunctionInput,
  args: {
    /** The component's name, which the function's description names. */
    component: string;
    /** What the component is, for the errors: `table`. */
    kind: string;
    /** The ARN of what the function reads from. */
    source: Input<string>;
    /** What the function is allowed to do with it. */
    actions: string[];
    /** The mapping's other args. */
    mapping: Omit<
      lambda.EventSourceMappingArgs,
      "eventSourceArn" | "functionName"
    >;
  },
) {
  const owner = `the "${args.component}" ${args.kind}`;
  const definition = plainFunction(
    subscriber,
    id === undefined
      ? `The subscriber of ${owner}`
      : `The subscriber "${id}" of ${owner}`,
  );
  const defaults = {
    description: `Subscribed to ${args.component}`,
    permissions: [{ actions: args.actions, resources: [args.source] }],
  };
  const fn =
    id === undefined
      ? functionPart(builder.component, "subscriber", definition, defaults)
      : functionPart(builder.component, "subscriber", id, definition, defaults);
  const mapping = {
    eventSourceArn: args.source,
    functionName: fn.targetArn,
    ...args.mapping,
  };
  // The component's own parts, which its types know and these don't
  const part = builder.part as unknown as (
    key: string,
    ...rest: unknown[]
  ) => unknown;
  if (id === undefined) part("eventSourceMapping", mapping);
  else part("eventSourceMapping", id, mapping);
}
