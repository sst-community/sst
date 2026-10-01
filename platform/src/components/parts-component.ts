import {
  type ComponentResourceOptions,
  type Inputs,
  type Output,
  type ResourceTransformationArgs,
  output,
} from "@pulumi/pulumi";
import { Component } from "./component";
import { hashStringToPrettyString, logicalName } from "./naming";
import { type PartTransform, transformPart } from "./transform";
import {
  type CreatedKeys,
  type ManyKeys,
  type Nodes,
  type PartArgs,
  type PartClassOf,
  type Parts,
  type SingleKeys,
  isDeferred,
  isMany,
  partClass,
} from "./parts";
import type { Permission } from "./aws/permission";
import type { binding } from "./cloudflare/binding";
import type { env } from "./linkable";
import { aliasOf, takeoverOf } from "./takeover";
import { VisibleError } from "./error";
import { notAnOption } from "./args";

export {
  type ComponentArgs,
  type V5Args,
  type DeferredPart,
  type Existing,
  type ManyPart,
  type ManyTransform,
  type Nodes,
  type OptionalPart,
  type PartArgs,
  type Parts,
  type Transforms,
  deferred,
  many,
  optional,
} from "./parts";
export { type PartTransform, type PartialArgs } from "./transform";

/**
 * What a link grants besides its properties: an AWS permission from
 * `sst.aws.permission()`, a Cloudflare binding from `sst.cloudflare.binding()`,
 * or environment variables from `sst.env()`.
 */
export type LinkInclude =
  | Permission
  | ReturnType<typeof binding>
  | ReturnType<typeof env>;

/** What a component's `link()` returns. */
export interface LinkDefinition {
  /** Values readable at runtime through `Resource.<Name>`. */
  properties: Record<string, any>;
  /** Permissions, bindings and environment variables to grant. */
  include?: LinkInclude[];
}

/**
 * Define a component: its type and the parts it's made of. Extend the class
 * this returns, and create the parts in the constructor.
 *
 * @example
 * ```ts title="sst.config.ts"
 * const parts = {
 *   bucket: aws.s3.Bucket,
 * };
 *
 * interface UploadsArgs extends sst.ComponentArgs<typeof parts> {
 *   retention?: number;
 * }
 *
 * class Uploads extends sst.component("acme:Uploads", parts) {
 *   constructor(name: string, args: UploadsArgs = {}) {
 *     super(name, args);
 *     this.part("bucket", { forceDestroy: true });
 *   }
 * }
 * ```
 *
 * @param type The component's type, as `<package>:<Name>` or `<package>:<module>:<Name>`.
 * @param parts The resources the component is made of. Pass a function that
 * returns them when a part is another SST component and this is SST's own
 * code: those files import each other, so the class may not exist yet when
 * the file loads.
 */
export function component<P extends Parts>(
  type: string,
  parts: P | (() => P),
) {
  return class extends PartsComponent<P> {
    /** @internal */
    static readonly __pulumiType = type;
    /** @internal Only carries the type of the parts. */
    static readonly __parts?: P;

    constructor(name: string, args?: Inputs, opts?: ComponentResourceOptions) {
      super(
        type,
        name,
        args,
        opts,
        typeof parts === "function" ? parts() : parts,
      );
    }
  };
}

/**
 * A component built from parts. `component()` returns a class that extends
 * this one; that is the way to define a component.
 *
 * This class keeps track of the parts: what each is named, the user's
 * `transform` and `existing` for it, where it lived in the component this one
 * takes over from, and the resource it ends up as in `nodes`.
 */
export class PartsComponent<P extends Parts> extends Component {
  /** The resource options the component was created with. */
  protected readonly componentOpts: ComponentResourceOptions;
  private readonly partClasses: P;
  private readonly partTransforms: Record<string, PartTransform<any> | undefined>;
  private readonly partExisting: Record<string, unknown>;
  // The resource each part was created as. A `many` part holds its by id.
  private readonly partNodes: Record<string, any> = {};
  // The same for deferred parts, as functions that are called when `nodes` is read
  private readonly partDeferred: Record<string, any> = {};
  // Names handed out for parts, and which part each one belongs to. Two parts
  // of different classes can have the same name.
  private readonly partNames = new Map<string, PartRef[]>();
  // Resources created through `delegateOpts()`
  private readonly partDelegated = new WeakSet<object>();
  private runningLocally = false;

  constructor(
    type: string,
    name: string,
    args: Inputs | undefined,
    opts: ComponentResourceOptions | undefined,
    parts: P,
  ) {
    super(type, name, args, opts);
    this.componentOpts = opts ?? {};
    this.partClasses = parts;
    // Read after `super`, which has applied any `$transform` to the args
    this.partTransforms = args?.transform ?? {};
    this.partExisting = args?.existing ?? {};

    const typeName = type.replaceAll(":", ".");
    const has = `It has: ${Object.keys(parts).join(", ")}.`;
    for (const key of Object.keys(this.partTransforms)) {
      if (!(key in parts))
        throw new VisibleError(
          `"${key}" is not something you can transform in the "${name}" component (${typeName}). ${has}`,
        );
    }
    for (const key of Object.keys(this.partExisting)) {
      if (!(key in parts))
        throw new VisibleError(
          `"${key}" is not something you can pass an existing resource for in the "${name}" component (${typeName}). ${has}`,
        );
      if (this.partTransforms[key] && !isMany(parts[key]))
        throw new VisibleError(
          `The "${name}" component (${typeName}) is given an existing "${key}", so it doesn't create one and there is nothing to transform. Remove "${key}" from its transform.`,
        );
    }

    // Links are read through `getSSTLink()`. Give the class that defines
    // `link()` that method, unless it has one: `Linkable.wrap()` sets its
    // own, and that one wins.
    if (typeof this.link === "function" && !("getSSTLink" in this)) {
      let owner = Object.getPrototypeOf(this);
      while (!Object.prototype.hasOwnProperty.call(owner, "link"))
        owner = Object.getPrototypeOf(owner);
      Object.defineProperty(owner, "getSSTLink", {
        value(this: PartsComponent<Parts>) {
          return this.link!();
        },
        writable: true,
        configurable: true,
      });
    }
  }

  /**
   * Make this component linkable. Return what a function, worker or site gets
   * when the component is passed in its `link`:
   *
   * - `properties` are readable at runtime as `Resource.<Name>`.
   * - `include` grants access: AWS permissions with `sst.aws.permission()`,
   *   Cloudflare bindings with `sst.cloudflare.binding()`, and extra
   *   environment variables with `sst.env()`.
   *
   * @example
   * ```ts
   * link() {
   *   return {
   *     properties: { name: this.nodes.bucket.bucket },
   *     include: [
   *       sst.aws.permission({
   *         actions: ["s3:GetObject"],
   *         resources: [$interpolate`${this.nodes.bucket.arn}/*`],
   *       }),
   *     ],
   *   };
   * }
   * ```
   */
  public link?(): LinkDefinition;

  /**
   * The underlying resources this component creates.
   */
  public get nodes(): Nodes<P> {
    const nodes = {};
    for (const key of Object.keys(this.partClasses)) {
      Object.defineProperty(nodes, key, {
        enumerable: true,
        get: () => this.nodeOf(key),
      });
    }
    return nodes as Nodes<P>;
  }

  /**
   * Create one of this component's parts.
   *
   * The resource is named after the component and the part, `MyQueue` and
   * `queue` giving `MyQueueQueue`. The user's `transform` for the part is
   * applied to `args`, and the resource is added to `nodes`.
   *
   * A part declared with `many()` also takes an id, which is added to the
   * name: `this.part("subnet", "1", args)` creates `MyVpcSubnet1`.
   *
   * @param key The part to create, one of the keys this component declares.
   * @param args The default args for the resource.
   * @param opts Resource options. The parent is always this component.
   */
  protected part<K extends SingleKeys<P> & CreatedKeys<P>>(
    key: K,
    args: PartArgs<P[K]>,
    opts?: $util.CustomResourceOptions,
  ): InstanceType<PartClassOf<P[K]>>;
  protected part<K extends ManyKeys<P> & CreatedKeys<P>>(
    key: K,
    id: string,
    args: PartArgs<P[K]>,
    opts?: $util.CustomResourceOptions,
  ): InstanceType<PartClassOf<P[K]>>;
  protected part(key: string, ...rest: any[]) {
    const part = this.partClasses[key];
    if (!part)
      throw new VisibleError(
        `"${key}" is not one of the parts of the "${this.componentName}" component.`,
      );

    const [id, args, opts] = isMany(part) ? rest : [undefined, ...rest];
    const cls = partClass(part);

    // The user has one already: use it, or look it up, and create nothing.
    const existing = this.existingOf(key, id, opts);
    if (existing !== undefined) return existing;

    if (at(this.partNodes, key, id) !== undefined)
      throw new VisibleError(
        `The "${this.componentName}" component has already created its "${key}"${id === undefined ? "" : ` named "${id}"`}. A part is created once.`,
      );

    return new cls(
      ...transformPart(this.transformOf(key, id), this.nameOf(key, id), args, {
        ...opts,
        aliases: [...(opts?.aliases ?? []), ...this.aliasesOf(key, id)],
        parent: this,
      }),
    );
  }

  /**
   * The resource the user passed in `existing` for a part, looked up when
   * they passed its id. `undefined` when they didn't pass one.
   *
   * `this.part()` already uses it. Call this when the component has more to do
   * for a resource it didn't create.
   */
  protected existingPart<K extends SingleKeys<P>>(
    key: K,
  ): InstanceType<PartClassOf<P[K]>> | undefined;
  protected existingPart<K extends ManyKeys<P>>(
    key: K,
    id: string,
  ): InstanceType<PartClassOf<P[K]>> | undefined;
  protected existingPart(key: string, id?: string) {
    return this.existingOf(key, id);
  }

  /**
   * Say that this component isn't deployed in `sst dev` because it runs
   * locally there. Reading `nodes` then explains why a resource is missing.
   *
   * Call it in the one place the component handles dev mode, and return
   * before creating any parts.
   */
  protected runsLocally() {
    this.runningLocally = true;
  }

  /**
   * Check what a method that adds something to this component is given: a
   * name that isn't taken, and no `transform` of its own. The component's
   * `transform` is where each one is changed.
   *
   * @example
   * ```ts
   * this.assertNew("route", "route", id, args, ["handler", "integration", "route"]);
   * ```
   *
   * @param what What's being added, for the error messages: "route".
   * @param key The `many` part that has one for each.
   * @param id Its name.
   * @param args The args the method was called with.
   * @param transforms The parts whose `transform` applies to it. Defaults to `key`.
   */
  protected assertNew(
    what: string,
    key: ManyKeys<P>,
    id: string,
    args: object = {},
    transforms: (keyof P & string)[] = [key],
  ) {
    const name = this.componentName;
    const quoted = transforms.map((part) => `"${part}"`);
    const last = quoted.pop();
    const listed = quoted.length ? `${quoted.join(", ")} and ${last}` : last;
    notAnOption(
      args,
      "transform",
      `Use the "transform" of "${name}": its ${listed} ${quoted.length ? "apply" : "applies"} to every ${what}, and a function there is given the ${what}'s name.`,
    );

    const taken =
      at(this.partNodes, key, id) !== undefined ||
      at(this.partDeferred, key, id) !== undefined;
    if (taken)
      throw new VisibleError(
        `"${name}" already has ${/^[aeiou]/.test(what) ? "an" : "a"} ${what} named "${id}". Give each ${what} its own name.`,
      );
  }

  /**
   * Resource options for something that creates resources under this
   * component on its behalf, like a DNS adapter creating records. Those
   * resources aren't parts: they're configured through what creates them, so
   * they have no `transform` here and aren't in `nodes`.
   *
   * @example
   * ```ts
   * dns.createAlias(name, record, this.delegateOpts());
   * ```
   */
  protected delegateOpts(): ComponentResourceOptions {
    return {
      parent: this,
      // A resource's own transformations run before its parent's, so it's
      // known by the time `childCreated()` sees it.
      transformations: [
        (child) => {
          this.partDelegated.add(child.resource);
          return undefined;
        },
      ],
    };
  }

  /**
   * What a helper needs to create a part on this component's behalf: its
   * name, the user's transform, and where to report the result. This is how
   * `functionPart()` creates a deferred part.
   *
   * @internal
   */
  public partHandle(key: string, id?: string) {
    return {
      name: this.nameOf(key, id),
      transform: this.transformOf(key, id),
      opts: { parent: this, aliases: this.aliasesOf(key, id) },
      /** What the user passed in `existing` for the part, as they passed it. */
      existing: at(this.partExisting, key, id) as unknown,
      /**
       * Supply the part's entry in `nodes`. `node` is called when `nodes` is
       * read, so it may fail when the resource was never created.
       */
      defer: (node: () => Output<unknown>) =>
        put(this.partDeferred, key, id, node),
    };
  }

  /**
   * Check that a resource created directly under this component is one of
   * its parts, and record it for `nodes`.
   *
   * @internal
   */
  protected childCreated(child: ResourceTransformationArgs) {
    if (this.partDelegated.has(child.resource)) return;

    const part = this.findPart(child);
    if (!part)
      throw new VisibleError(
        `In the "${this.componentName}" component, "${child.name}" (${child.type}) is not one of the component's parts. Add it to the parts of ${this.componentType.replaceAll(":", ".")}: ${Object.keys(this.partClasses).join(", ")}.`,
      );
    put(this.partNodes, part.key, part.id, child.resource);
  }

  // The part a child belongs to. One created some other way than `part()` is
  // matched by its name: the component's name, the part's key, and for a
  // `many` part its id.
  private findPart(child: ResourceTransformationArgs): PartRef | undefined {
    const isA = (key: string) =>
      child.resource instanceof partClass(this.partClasses[key]);
    // One of SST's own provider resources adds its type to the name it's
    // given: "MyFunctionRouteKey.sst.aws.KvKeys"
    const name = child.name.replace(/\.sst\.[\w.]+$/, "");

    const named = this.partNames.get(name)?.find((ref) => isA(ref.key));
    if (named) return named;

    const suffix = name.slice(this.componentName.length);
    let found: PartRef | undefined;
    let longest = 0;
    for (const [key, part] of Object.entries(this.partClasses)) {
      const prefix = logicalName(key);
      if (!isA(key)) continue;
      if (!isMany(part)) {
        if (suffix === prefix) return { key };
      } else if (
        suffix.startsWith(prefix) &&
        suffix.length > prefix.length &&
        prefix.length > longest
      ) {
        found = { key, id: suffix.slice(prefix.length) };
        longest = prefix.length;
      }
    }
    return found;
  }

  private nodeOf(key: string) {
    if (this.runningLocally)
      throw new VisibleError(
        `Cannot access \`nodes.${key}\` of "${this.componentName}" in \`sst dev\`. It runs locally there, so the resource isn't created.`,
      );

    const part = this.partClasses[key];
    const created = this.partNodes[key];
    const deferred = this.partDeferred[key];
    if (!isMany(part)) return deferred ? deferred() : created;
    // Held by id on an object with no prototype, so `id in nodes.route` is
    // only true for a route that exists, whatever the id is.
    if (!isDeferred(part)) return Object.assign(byId(), created);

    // Each is read when asked for: one given as an ARN has no resource
    const many = byId();
    for (const id of Object.keys({ ...deferred, ...created })) {
      Object.defineProperty(many, id, {
        enumerable: true,
        get: () => (deferred?.[id] ? deferred[id]() : output(created[id])),
      });
    }
    return many;
  }

  private existingOf(
    key: string,
    id?: string,
    opts?: $util.CustomResourceOptions,
  ) {
    const existing = at(this.partExisting, key, id);
    if (existing === undefined) return undefined;

    // Looked up already
    const found = at(this.partNodes, key, id);
    if (found) return found;

    const cls = partClass(this.partClasses[key]);
    if (existing instanceof cls) {
      put(this.partNodes, key, id, existing);
      return existing;
    }

    const lookup = cls as unknown as { get?: Function };
    if (typeof lookup.get !== "function")
      throw new VisibleError(
        `The "${this.componentName}" component can't look up its "${key}" by id. Pass the resource itself in "existing".`,
      );
    return lookup.get(this.nameOf(key, id), existing, undefined, {
      ...opts,
      parent: this,
    });
  }

  // Where a part's resource lived in the component this one takes over from
  private aliasesOf(key: string, id?: string) {
    const moved = takeoverOf(this.componentType)?.moved?.[key];
    if (!moved) return [];

    // A part that only changed its key was named the way 4.x names things:
    // the component, the key, then the id.
    const old =
      typeof moved === "string"
        ? { name: `${this.componentName}${logicalName(moved)}${logicalName(id ?? "")}` }
        : moved(this, { name: this.componentName, id });
    return [old ?? []].flat().map(aliasOf);
  }

  private nameOf(key: string, id?: string) {
    if (
      isMany(this.partClasses[key]) &&
      (typeof id !== "string" || idName(id) === "")
    )
      throw new VisibleError(
        `The "${this.componentName}" component creates several "${key}" parts, so each one needs an id.`,
      );

    const name = `${this.componentName}${logicalName(key)}${id === undefined ? "" : idName(id)}`;
    const refs = this.partNames.get(name) ?? [];
    const other = refs.find((ref) => ref.key === key && ref.id !== id);
    if (other)
      throw new VisibleError(
        `In the "${this.componentName}" component, "${other.id}" and "${id}" are too alike: both would be named "${name}". Change one of them.`,
      );
    this.partNames.set(name, [...refs, id === undefined ? { key } : { key, id }]);
    return name;
  }

  private transformOf(key: string, id?: string): PartTransform<any> | undefined {
    const transform = this.partTransforms[key];
    if (id === undefined || typeof transform !== "function") return transform;
    // The transform of a `many` part is also told which one it is given.
    const many = transform as (...args: unknown[]) => undefined;
    return (args: unknown, opts: unknown, name: unknown) =>
      many(args, opts, name, id);
  }
}

type PartRef = { key: string; id?: string };

// What an id adds to a resource's name. A plain id is used the way it reads.
// Any other, like the route "GET /users/{id}", could easily come out the
// same as a different id once it's reduced to a name, so a hash of the id is
// added. Two plain ids can still come out the same ("get-user", "getuser");
// `nameOf()` reports that.
function idName(id: string) {
  const name = logicalName(id);
  return /^[\w-]*$/.test(id)
    ? name
    : `${name}${logicalName(hashStringToPrettyString(id, 6))}`;
}

// Read and write what's kept for a part: by key, and by id under a `many`
// part. An id can be any string, including the name of something every
// object has, like "constructor".
function at(entries: Record<string, any>, key: string, id?: string) {
  if (id === undefined) return entries[key];
  const many = entries[key];
  return many && Object.hasOwn(many, id) ? many[id] : undefined;
}

function put(
  entries: Record<string, any>,
  key: string,
  id: string | undefined,
  value: unknown,
) {
  if (id === undefined) entries[key] = value;
  else (entries[key] ??= byId())[id] = value;
}

function byId(): Record<string, any> {
  return Object.create(null);
}
