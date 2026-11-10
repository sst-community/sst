import type { CustomResourceOptions, Input, Output } from "@pulumi/pulumi";
import type { PartTransform, PartialArgs } from "./transform";

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
export type Parts = Record<string, UnnamedPart | NamedPart>;

type UnnamedPart =
  | PartClass
  | DeferredPart<PartClass | OptionalPart>
  | ManyPart
  | OptionalPart;

export type PartClass = new (name: string, args: any, opts?: any) => any;

/** A part declared with `deferred()`. */
export interface DeferredPart<C extends PartClass | OptionalPart = PartClass> {
  deferred: C;
}

/**
 * Declare a part that is created later, or not at all. A subscriber's
 * function is one: it's created once the definition is known, and it isn't
 * created when the user passes the ARN of a function they already have. A
 * site's server is another: it's created once the site is built.
 *
 * The part's entry in `nodes` is an `Output` of the resource. Create a
 * function from a definition with `functionPart()`. Create anything else with
 * `this.part()` in what `this.after()` runs. Wrap a part that may not be
 * created at all in `optional()`: its entry is then an `Output` that may be
 * `undefined`.
 *
 * ```ts
 * const parts = () => ({
 *   subscriber: deferred(Function),
 *   eventSourceMapping: aws.lambda.EventSourceMapping,
 *   cache: deferred(optional(aws.dynamodb.Table)),
 * });
 *
 * functionPart(this, "subscriber", "src/subscriber.handler", {});
 * ```
 */
export function deferred<C extends PartClass | OptionalPart>(
  cls: C,
): DeferredPart<C> {
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
  T extends PartClass | DeferredPart<PartClass | OptionalPart> =
    | PartClass
    | DeferredPart<PartClass | OptionalPart>,
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
 * subscriber: `many(deferred(Function))`. Each one `after()` may not create,
 * like a site's server when its build has none, is
 * `many(deferred(optional(Function)))`: its entry is then an `Output` that may
 * be `undefined`.
 */
export function many<T extends PartClass | DeferredPart<PartClass | OptionalPart>>(
  part: T,
): ManyPart<T> {
  return { many: part };
}

/** A part declared with `named()`. */
export interface NamedPart<T extends UnnamedPart = UnnamedPart> {
  named: string;
  part: T;
}

/**
 * Declare a part whose resource isn't named after its key. A resource is
 * named after the component and the part, `MyQueue` and `policy` giving
 * `MyQueuePolicy`, and that name is how a deployed app knows the resource.
 * With `named()` the key can change, or differ from the name, and the
 * resource stays the one that's deployed:
 *
 * ```ts
 * const parts = {
 *   // Named MyVpcNatInstanceSecurityGroup
 *   natSecurityGroup: named(aws.ec2.SecurityGroup, "NatInstanceSecurityGroup"),
 * };
 * ```
 *
 * It wraps the other markers: `named(optional(aws.ec2.SecurityGroup), "...")`.
 * For a `many()` part the id is added to the name, as it is to the key.
 *
 * The name is permanent. Changing it later renames the resource, which
 * replaces it unless it's given an alias.
 */
export function named<T extends UnnamedPart>(part: T, name: string): NamedPart<T> {
  return { named: name, part };
}

/** A part as it's declared, without the name `named()` gives it. */
export type Unnamed<T> = T extends NamedPart<infer U> ? U : T;

export type PartClassOf<T> =
  T extends NamedPart<infer U>
    ? PartClassOf<U>
    : T extends DeferredPart<infer C>
      ? PartClassOf<C>
      : T extends ManyPart<infer M>
        ? PartClassOf<M>
        : T extends OptionalPart<infer C>
          ? C
          : T extends PartClass
            ? T
            : never;

function unnamed(part: Parts[string]): UnnamedPart {
  return typeof part !== "function" && "named" in part ? part.part : part;
}

export function partClass(part: Parts[string] | DeferredPart): PartClass {
  const declared = unnamed(part);
  if (typeof declared === "function") return declared;
  if ("many" in declared) return partClass(declared.many);
  return "optional" in declared
    ? declared.optional
    : partClass(declared.deferred);
}

/** Whether a part's resources are created later, or not at all. */
export function isDeferred(part: Parts[string] | DeferredPart): boolean {
  const declared = unnamed(part);
  if (typeof declared === "function") return false;
  return "many" in declared ? isDeferred(declared.many) : "deferred" in declared;
}

export function isMany(part: Parts[string]): boolean {
  const declared = unnamed(part);
  return typeof declared !== "function" && "many" in declared;
}

/** The name a part was given with `named()`, in place of its key. */
export function nameGiven(part: Parts[string]): string | undefined {
  return typeof part !== "function" && "named" in part ? part.named : undefined;
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
  | PartialArgs<T>
  | ((
      args: T,
      opts: CustomResourceOptions,
      name: string,
      id: string,
    ) => undefined);

/** The `transform` option for a component: one optional transform per part. */
export type Transforms<P extends Parts> = {
  [K in keyof P]?: Unnamed<P[K]> extends ManyPart
    ? ManyTransform<PartArgs<P[K]>>
    : PartTransform<PartArgs<P[K]>>;
};

/**
 * The `nodes` of a component: the resource created for each part. A deferred
 * part is an `Output` of its resource, and a `many` part holds its resources
 * by id.
 */
export type Nodes<P extends Parts> = {
  [K in keyof P]: Unnamed<P[K]> extends DeferredPart<infer C>
    ? DeferredNode<C>
    : Unnamed<P[K]> extends ManyPart<infer M>
      ? Record<
          string,
          M extends DeferredPart<infer C>
            ? DeferredNode<C>
            : InstanceType<PartClassOf<M>>
        >
      : Unnamed<P[K]> extends OptionalPart<infer C>
        ? InstanceType<C> | undefined
        : InstanceType<PartClassOf<P[K]>>;
};

// A deferred part's entry in `nodes`: an output of its resource, which may be
// `undefined` for one that's also optional
type DeferredNode<C> =
  C extends OptionalPart<infer D>
    ? Output<InstanceType<D> | undefined>
    : Output<InstanceType<PartClassOf<C>>>;

/**
 * The `existing` option for a component: resources to use in place of ones
 * the component would create. Each is the resource itself, or the id to look
 * it up by. A `many` part takes them by id.
 */
export type Existing<P extends Parts> = {
  [K in keyof P]?: Unnamed<P[K]> extends ManyPart
    ? Record<string, InstanceType<PartClassOf<P[K]>> | Input<string>>
    : InstanceType<PartClassOf<P[K]>> | Input<string>;
};

/** A parts map, or the function that returns it. */
type PartsOf<T> = T extends () => infer P ? P : T;

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
  [K in keyof P]: Unnamed<P[K]> extends ManyPart ? K : never;
}[keyof P] &
  string;

export type SingleKeys<P extends Parts> = Exclude<keyof P & string, ManyKeys<P>>;

/**
 * The parts `this.part()` creates: all of them. A deferred one is created
 * there in what `this.after()` runs, and a deferred function from a definition
 * with `functionPart()`.
 */
export type CreatedKeys<P extends Parts> = keyof P & string;
