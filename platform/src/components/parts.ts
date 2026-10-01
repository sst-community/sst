import type { Input, Output } from "@pulumi/pulumi";
import type { Transform } from "./transform";

/**
 * The resources a component is made of, by name. Each one is the class of a
 * Pulumi resource or of another component.
 *
 * ```ts
 * const parts = {
 *   queue: aws.sqs.Queue,
 *   policy: aws.sqs.QueuePolicy,
 * };
 * ```
 *
 * Inside SST, a part that is another component has to be declared in a
 * function, `const parts = () => ({ ... })`. The components import each
 * other, so the class may not exist yet when the file that declares the parts
 * loads.
 */
export type Parts = Record<
  string,
  PartClass | DeferredPart | ManyPart | OptionalPart
>;

export type PartClass = new (name: string, args: any, opts?: any) => any;

/** A part declared with `deferred()`. */
export interface DeferredPart<C extends PartClass = PartClass> {
  deferred: C;
}

/**
 * Declare a part that is created later, or not at all. A subscriber's
 * function is one: it's created once the definition is known, and it isn't
 * created when the user passes the ARN of a function they already have.
 *
 * The part's entry in `nodes` is an `Output` of the resource. Create the
 * function with `functionPart()`.
 *
 * ```ts
 * const parts = () => ({
 *   subscriber: deferred(FunctionV5),
 *   eventSourceMapping: aws.lambda.EventSourceMapping,
 * });
 *
 * functionPart(this, "subscriber", "src/subscriber.handler", {});
 * ```
 */
export function deferred<C extends PartClass>(cls: C): DeferredPart<C> {
  return { deferred: cls };
}

/** A part declared with `optional()`. */
export interface OptionalPart<C extends PartClass = PartClass> {
  optional: C;
}

/**
 * Declare a part the component only creates sometimes, like a dead-letter
 * queue that exists only when it's configured. Its entry in `nodes` may be
 * `undefined`.
 *
 * ```ts
 * const parts = {
 *   queue: aws.sqs.Queue,
 *   deadLetters: optional(aws.sqs.Queue),
 * };
 * ```
 */
export function optional<C extends PartClass>(cls: C): OptionalPart<C> {
  return { optional: cls };
}

/** A part declared with `many()`. */
export interface ManyPart<
  T extends PartClass | DeferredPart = PartClass | DeferredPart,
> {
  many: T;
}

/**
 * Declare a part the component creates several of, like one subnet per zone
 * or one listener per port. Each one is created with an id:
 *
 * ```ts
 * const parts = {
 *   vpc: aws.ec2.Vpc,
 *   subnet: many(aws.ec2.Subnet),
 * };
 *
 * this.part("subnet", "1", { ... }); // named MyVpcSubnet1
 * this.part("subnet", "2", { ... }); // named MyVpcSubnet2
 * ```
 *
 * The part's `transform` applies to each one; its function form is also given
 * the id. Its entry in `nodes` holds them by id.
 *
 * Wrap a deferred part to have several of those, like one function per
 * subscriber: `many(deferred(FunctionV5))`.
 */
export function many<T extends PartClass | DeferredPart>(part: T): ManyPart<T> {
  return { many: part };
}

export type PartClassOf<T> =
  T extends DeferredPart<infer C>
    ? C
    : T extends ManyPart<infer M>
      ? PartClassOf<M>
      : T extends OptionalPart<infer C>
        ? C
        : T extends PartClass
          ? T
          : never;

export function partClass(part: Parts[string]): PartClass {
  if (typeof part === "function") return part;
  if ("many" in part) return partClass(part.many);
  return "optional" in part ? part.optional : part.deferred;
}

/** Whether a part's resources are created later, or not at all. */
export function isDeferred(part: Parts[string]): boolean {
  if (typeof part === "function") return false;
  return "many" in part ? isDeferred(part.many) : "deferred" in part;
}

export function isMany(part: Parts[string]): part is ManyPart {
  return typeof part !== "function" && "many" in part;
}

/** The args a part's resource is created with. */
export type PartArgs<T extends Parts[string]> = NonNullable<
  ConstructorParameters<PartClassOf<T>>[1]
>;

/**
 * The transform for a part the component creates several of. The function
 * form is called for each one, with its id as the last argument.
 */
export type ManyTransform<T> =
  | Partial<T>
  | ((
      args: T,
      opts: $util.CustomResourceOptions,
      name: string,
      id: string,
    ) => undefined);

/** The `transform` option for a component: one optional transform per part. */
export type Transforms<P extends Parts> = {
  [K in keyof P]?: P[K] extends ManyPart
    ? ManyTransform<PartArgs<P[K]>>
    : Transform<PartArgs<P[K]>>;
};

/**
 * The `nodes` of a component: the resource created for each part. A deferred
 * part is an `Output` of its resource, and a `many` part holds its resources
 * by id.
 */
export type Nodes<P extends Parts> = {
  [K in keyof P]: P[K] extends DeferredPart<infer C>
    ? Output<InstanceType<C>>
    : P[K] extends ManyPart<infer M>
      ? Record<
          string,
          M extends DeferredPart<infer C>
            ? Output<InstanceType<C>>
            : InstanceType<PartClassOf<M>>
        >
      : P[K] extends OptionalPart<infer C>
        ? InstanceType<C> | undefined
        : InstanceType<PartClassOf<P[K]>>;
};

/**
 * The `existing` option for a component: resources to use in place of ones
 * the component would create. Each is the resource itself, or the id to look
 * it up by. A `many` part takes them by id.
 */
export type Existing<P extends Parts> = {
  [K in keyof P]?: P[K] extends ManyPart
    ? Record<string, InstanceType<PartClassOf<P[K]>> | Input<string>>
    : InstanceType<PartClassOf<P[K]>> | Input<string>;
};

/** A parts map, or the function that returns it. */
type PartsOf<T> = T extends () => infer P ? P : T;

// The args of a V5 component that takes the same args as the component it
// replaces: the original's args, with `transform` and `existing` for the new
// component's parts.
//
//   interface QueueV5Args extends V5Args<QueueArgs, typeof parts> {}
//
// (Not a doc comment: an interface that extends this would show it as its own
// description in the generated docs.)
export type V5Args<Original, P extends Parts | (() => Parts)> = Omit<
  Original,
  "transform"
> &
  ComponentArgs<P>;

/**
 * The args every component built from parts accepts. Extend it in your
 * component's args.
 *
 * ```ts
 * interface UploadsArgs extends sst.ComponentArgs<typeof parts> {
 *   teams: string[];
 * }
 * ```
 */
export interface ComponentArgs<P extends Parts | (() => Parts)> {
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: Transforms<PartsOf<P>>;
  /**
   * Use resources you already have in place of ones this component would
   * create. Pass the resource, or the id to look it up by.
   *
   * @example
   * ```ts
   * {
   *   existing: {
   *     queue: "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue"
   *   }
   * }
   * ```
   */
  existing?: Existing<PartsOf<P>>;
}

export type ManyKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends ManyPart ? K : never;
}[keyof P] &
  string;

export type SingleKeys<P extends Parts> = Exclude<keyof P & string, ManyKeys<P>>;

/**
 * The parts `this.part()` creates. A deferred part is left out: it's created
 * with `functionPart()`, which makes its `nodes` entry an `Output`.
 */
export type CreatedKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends DeferredPart | ManyPart<DeferredPart>
    ? never
    : K;
}[keyof P] &
  string;
