import {
  type ComponentResourceOptions,
  type CustomResourceOptions,
  type Input,
  type Inputs,
  Output,
  type Resource,
  type ResourceTransformationArgs,
  ComponentResource,
  all,
  output,
  runtime,
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
  nameGiven,
  partClass,
} from "./parts";
import type { Permission } from "./aws/permission";
import type { binding } from "./cloudflare/binding";
import type { env } from "./linkable";
import {
  type OldAddress,
  type ReleasedAddress,
  type Takeover,
  aliasOf,
  formerTypeOf,
  mapsAfter,
  releasedAddresses,
  versionOf,
} from "./takeover";
import { adoptable, mapsFrom, moving, reportPart } from "./move";
import { type Report, reportItems, withRecord } from "./contract";
import { VisibleError } from "./error";
import { isFromGet, notAnOption } from "./args";

export {
  type ComponentArgs,
  type V5Args,
  type DeferredPart,
  type Existing,
  type ManyPart,
  type ManyTransform,
  type NamedPart,
  type Nodes,
  type OptionalPart,
  type PartArgs,
  type Parts,
  type Transforms,
  deferred,
  many,
  named,
  optional,
} from "./parts";
export { type PartTransform, type PartialArgs } from "./transform";

/**
 * What a link grants besides its properties: an AWS permission from
 * `sst.aws.permission()`, a Cloudflare binding from `sst.cloudflare.binding()`,
 * or environment variables from `sst.env()`.
 */
/**
 * What a helper needs to build parts on a component's behalf, for what two
 * components share: the component, and its own `part()`, `existingPart()`,
 * `runsLocally()` and `report()`. A component hands it over with
 * `this.builder()`.
 *
 * @internal
 */
export interface PartsBuilder<P extends Parts> {
  /** The component the parts are built for. */
  component: PartsComponent<P>;
  part: {
    <K extends SingleKeys<P> & CreatedKeys<P>>(
      key: K,
      args: PartArgs<P[K]>,
      opts?: CustomResourceOptions,
    ): InstanceType<PartClassOf<P[K]>>;
    <K extends ManyKeys<P> & CreatedKeys<P>>(
      key: K,
      id: string,
      args: PartArgs<P[K]>,
      opts?: CustomResourceOptions,
    ): InstanceType<PartClassOf<P[K]>>;
  };
  existingPart: {
    <K extends SingleKeys<P>>(key: K): InstanceType<PartClassOf<P[K]>> | undefined;
    <K extends ManyKeys<P>>(
      key: K,
      id: string,
    ): InstanceType<PartClassOf<P[K]>> | undefined;
  };
  runsLocally(): void;
  report(report: Report): void;
  /** Create parts once something the program waits for is ready: `after()`. */
  after<T, R>(
    ready: Promise<T>,
    create: (value: T) => R | Promise<R>,
  ): Promise<R>;
  /** The ids `after()` will create a deferred part with: `willCreate()`. */
  willCreate(key: ManyKeys<P>, ids: string[]): void;
}

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
 * class Uploads extends sst.component("acme:index:Uploads", parts) {
 *   constructor(name: string, args: UploadsArgs = {}) {
 *     super(name, args);
 *     this.part("bucket", { forceDestroy: true });
 *   }
 * }
 * ```
 *
 * @param type The component's type, as `<package>:<module>:<Name>`, like
 * `acme:index:Uploads`. Pulumi's tools expect the three parts.
 * @param parts The resources the component is made of. Pass a function that
 * returns them when a part is another SST component and this is SST's own
 * code: those files import each other, so the class may not exist yet when
 * the file loads.
 */
export function component<P extends Parts>(
  type: string,
  parts: P | (() => P),
): ComponentClass<P> {
  if (!/^[^:\s]+:[^:\s]+:[^:\s]+$/.test(type))
    throw new VisibleError(
      `The component type "${type}" needs three parts, as "<package>:<module>:<Name>", like "acme:index:Uploads".`,
    );
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
 * The class `component()` returns. It has a name so that a component in a
 * published package can be compiled to a `.d.ts`: TypeScript can't write out
 * an unnamed class that has private members.
 */
export interface ComponentClass<P extends Parts>
  extends Omit<typeof PartsComponent, "prototype"> {
  new (
    name: string,
    args?: Inputs,
    opts?: ComponentResourceOptions,
  ): PartsComponent<P>;
  /** @internal */
  readonly __pulumiType: string;
  /** @internal Only carries the type of the parts. */
  readonly __parts?: P;
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
  // What `after()` is creating, each time it's called: the `nodes` of a
  // deferred part wait for it, and fail with it
  private readonly creating: Promise<unknown>[] = [];
  // The ids `after()` will create a deferred `many` part with, by part, from
  // `willCreate()`
  private readonly partPromised: Record<string, Set<string>> = {};
  // What the component reported to the core, and whether its outputs, which
  // carry it, are registered
  private reported?: Report;
  private outputsRegistered = false;

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
      // What a `get` was given only references the resource. A `$transform`
      // for every component of this kind runs on its args too, and what it
      // sets for the part has nothing to apply to here.
      if (
        this.partTransforms[key] &&
        !isMany(parts[key]) &&
        !(args && isFromGet(args))
      )
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
   * `queue` giving `MyQueueQueue`, or after the name the part is declared
   * with in `named()`. The user's `transform` for the part is applied to
   * `args`, and the resource is added to `nodes`.
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
    opts?: CustomResourceOptions,
  ): InstanceType<PartClassOf<P[K]>>;
  protected part<K extends ManyKeys<P> & CreatedKeys<P>>(
    key: K,
    id: string,
    args: PartArgs<P[K]>,
    opts?: CustomResourceOptions,
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

    const name = this.nameOf(key, id);
    return new cls(
      ...transformPart(this.transformOf(key, id), name, args, {
        ...opts,
        ...this.adoptedOf(key, id),
        aliases: [...(opts?.aliases ?? []), ...this.aliasesOf(key, name, id)],
        parent: this,
      }),
    );
  }

  // The id of what a part takes the place of, when the core says a move adopts
  // it: the part imports it, where a create would make a second one in the
  // cloud. The map gives the released resource's name; the core gives the ids
  // by name (`adoptable()`), until the move finishes.
  private adoptedOf(key: string, id?: string): { import?: string } {
    const ids = adoptable();
    if (Object.keys(ids).length === 0) return {};
    for (const [map, current] of this.keysIn(this.takeoverMaps(), key)) {
      if (current === undefined) continue;
      const old = map.released?.[current]?.(this, {
        name: this.componentName,
        id,
      });
      for (const address of [old ?? []].flat()) {
        const found =
          typeof address.name === "string" ? ids[address.name] : undefined;
        if (found) return { import: found };
      }
    }
    return {};
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
   * Look up the resource of a part by its id, in place of creating it. This
   * is for a component that references something already deployed and works
   * out the ids of its other parts itself: from a tag, or a data source. A
   * resource the user passed in `existing` for the part is used instead; for
   * an id passed there, use `existingPart(key) ?? lookupPart(...)`.
   *
   * @example
   * ```ts
   * const cluster = this.existingPart("cluster");
   * if (cluster) this.lookupPart("secret", cluster.tags.apply((tags) => tags.secret));
   * ```
   *
   * @param key The part to look up.
   * @param resourceId The id the resource is looked up by.
   */
  protected lookupPart<K extends SingleKeys<P> & CreatedKeys<P>>(
    key: K,
    resourceId: Input<string>,
    opts?: CustomResourceOptions,
  ): InstanceType<PartClassOf<P[K]>>;
  protected lookupPart<K extends ManyKeys<P> & CreatedKeys<P>>(
    key: K,
    id: string,
    resourceId: Input<string>,
    opts?: CustomResourceOptions,
  ): InstanceType<PartClassOf<P[K]>>;
  protected lookupPart(key: string, ...rest: any[]) {
    const [id, resourceId, opts] = isMany(this.partClasses[key])
      ? rest
      : [undefined, ...rest];
    // A resource the user passed in `existing` is used in place of the
    // lookup. An id there is the component's to read: it looks up by what it
    // works out from it, like a role's name from its ARN.
    if (
      at(this.partExisting, key, id) instanceof
      partClass(this.partClasses[key])
    )
      return this.existingOf(key, id, opts);
    return this.lookUp(key, id, resourceId, opts);
  }

  /**
   * Create the rest of the parts once something they're made from is ready,
   * like a site's build: `create` is called with it, and creates them with
   * `this.part()`. What it returns is what the promise `after()` returns
   * resolves to. Until it has, the `nodes` entry of a part declared with
   * `deferred()` is an output that resolves to what `create` created, and to
   * `undefined` for one it didn't. Declare a part it may not create with
   * `deferred(optional(...))`. A part declared with `many(deferred(...))` is
   * listed in `nodes` by id as it's created, or from the start with the ids
   * given to `willCreate()`.
   *
   * The program waits for `create`, and an error in `ready` or in `create`
   * fails the deploy, once, however many resources wait on it. The `nodes`
   * entries of deferred parts fail with it too, so nothing made from them is
   * deployed without them. A preview runs
   * it too, so `ready` has to resolve in a preview: decide what's created from
   * what a preview knows. A site's build leaves out the values a preview
   * doesn't know.
   *
   * @example
   * ```ts
   * this.after(buildSite({ ... }), (sitePath) => {
   *   this.part("server", { handler: "index.handler", bundle: sitePath });
   * });
   * ```
   */
  protected after<T, R>(
    ready: Promise<T>,
    create: (value: T) => R | Promise<R>,
  ): Promise<R> {
    const done = runtime.rpcKeepAlive();
    const created = ready.then(create).finally(done);
    this.creating.push(created);
    return created;
  }

  /**
   * Say which ids `after()` will create a part declared with
   * `many(deferred(...))` with, when they're known before it runs, like the
   * regions a site's server is deployed to. `nodes` lists them from the
   * start, each an output that resolves to the resource once it's created.
   * Without this, an id is listed once its resource is created.
   *
   * List only the ids `create` always creates.
   *
   * @example
   * ```ts
   * this.willCreate("server", regions);
   * ```
   */
  protected willCreate(key: ManyKeys<P>, ids: string[]) {
    const part = this.partClasses[key];
    if (!part || !isMany(part) || !isDeferred(part))
      throw new VisibleError(
        `"${key}" of the "${this.componentName}" component isn't declared with \`many(deferred(...))\`, so its resources are listed in \`nodes\` as they're created.`,
      );
    const promised = (this.partPromised[key] ??= new Set());
    for (const id of ids) promised.add(id);
  }

  /**
   * Say that this component isn't deployed in `sst dev` because it runs
   * locally there. Reading `nodes` then explains why a resource is missing.
   *
   * Call it in the one place the component handles dev mode, and return
   * before creating the parts that aren't deployed there. A part that's
   * created all the same, like the role the local process runs as, is in
   * `nodes` as usual.
   */
  protected runsLocally() {
    this.runningLocally = true;
  }

  /**
   * Hand a helper what it needs to build parts on this component's behalf,
   * for what two components share, like the `Postgres` and the `Mysql`.
   *
   * @internal
   */
  protected builder(): PartsBuilder<P> {
    return {
      component: this,
      part: this.part.bind(this),
      existingPart: this.existingPart.bind(this),
      runsLocally: () => this.runsLocally(),
      report: (report) => this.report(report),
      after: (ready, create) => this.after(ready, create),
      willCreate: (key, ids) => this.willCreate(key, ids),
    };
  }

  /**
   * Tell the core about this component, through the program contract: a
   * function it builds, a command or a task `sst dev` runs, a bastion `sst
   * tunnel` connects through, or a URL to show when a deploy is done. Each
   * call adds the items it gives, and an item given again replaces the first.
   *
   * Call it in the constructor, before `registerOutputs()`, and not inside an
   * `apply`: the report goes in with the component's outputs, which are
   * registered once, and by the time an `apply` runs they may be.
   *
   * @example
   * ```ts
   * this.report({
   *   dev: { command: "npm run dev", directory: "web", link: [bucket] },
   *   hint: this.url,
   * });
   * ```
   */
  protected report(report: Report) {
    if (this.outputsRegistered)
      throw new VisibleError(
        `The "${this.componentName}" component (${this.componentType.replaceAll(":", ".")}) reported to SST after it registered its outputs. Call report() before registerOutputs(), in its constructor.`,
      );
    const unknown = Object.keys(report).filter((k) => !reportItems.includes(k));
    if (unknown.length)
      throw new VisibleError(
        `The "${this.componentName}" component (${this.componentType.replaceAll(":", ".")}) reported ${unknown.map((k) => `"${k}"`).join(", ")}, which SST doesn't read. It reads ${reportItems.map((k) => `"${k}"`).join(", ")}.`,
      );
    // An item given as `undefined` isn't reported, so a component given
    // nothing to report writes no record
    const given = Object.entries(report).filter(([, v]) => v !== undefined);
    if (given.length)
      this.reported = { ...this.reported, ...Object.fromEntries(given) };
  }

  /**
   * Register the component's outputs, with what it reported. Pulumi registers
   * them once: the first call does, and Pulumi calls it after the constructor
   * if the component didn't.
   */
  protected registerOutputs(
    outputs?: Inputs | Promise<Inputs> | Output<Inputs>,
  ) {
    if (this.outputsRegistered) return;
    this.outputsRegistered = true;
    if (!this.reported) return super.registerOutputs(outputs);
    // As one Output, a secret anywhere in them would make all the outputs one
    // secret value, and the core couldn't find the report in it
    if (Output.isInstance(outputs) || outputs instanceof Promise)
      throw new VisibleError(
        `The "${this.componentName}" component (${this.componentType.replaceAll(":", ".")}) reported to SST, and registers its outputs as one Output. Pass registerOutputs() an object, with an Output for each value that needs one.`,
      );
    super.registerOutputs(withRecord(outputs, this.reported));
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
      // known by the time `childCreated()` sees it. Pulumi reads its aliases
      // after its transformations, so the map's can be added here.
      transformations: [
        (child) => {
          this.partDelegated.add(child.resource);
          if (moving()) this.reportDelegated(child);
          const aliases = this.delegatedAliases(child.name, child.type);
          if (aliases.length === 0) return undefined;
          return {
            props: child.props,
            opts: {
              ...child.opts,
              aliases: [...(child.opts.aliases ?? []), ...aliases],
            },
          };
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
    const name = this.nameOf(key, id);
    return {
      name,
      transform: this.transformOf(key, id),
      opts: {
        parent: this as Component,
        aliases: this.aliasesOf(key, name, id),
      },
      /** What the user passed in `existing` for the part, as they passed it. */
      existing: at(this.partExisting, key, id) as unknown,
      /**
       * Supply the part's entry in `nodes`: the resource, or an output of it.
       * `node` is called when `nodes` is read, so it may fail when the
       * resource was never created.
       */
      defer: (node: () => unknown) =>
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
    if (moving()) this.reportMoved(part, child.resource);
  }

  // While the stage moves, tell the core what the maps it takes over with say
  // about a part: that it's new, replaced, or in the place of what's released
  private reportMoved(part: PartRef, resource: Resource) {
    const maps = this.takeoverMaps();
    let added = false;
    let replaced: string | undefined;
    const released: ReleasedAddress[] = [];
    for (const [map, key] of this.keysIn(maps, part.key)) {
      if (key === undefined) continue;
      added ||= map.added?.includes(key) ?? false;
      replaced ??= map.replaced?.[key];
      const old = map.released?.[key]?.(this, {
        name: this.componentName,
        id: part.id,
      });
      released.push(...[old ?? []].flat());
    }
    if (!added && !replaced && !released.length) return;
    reportPart({
      component: this.urn,
      type: this.componentType,
      key: part.key,
      ...(part.id === undefined ? {} : { id: part.id }),
      // Set once the resource's transformations, this among them, have run
      urn: all([]).apply(() => resource.urn),
      ...(added ? { added } : {}),
      ...(replaced ? { replaced } : {}),
      releases: released.map((old) =>
        releasedAddresses(old, this, this.componentName),
      ),
    });
  }

  // The part a child belongs to. One created some other way than `part()` is
  // matched by its name: the component's name, the part's own, and for a
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
      const prefix = this.partName(key);
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
    const part = this.partClasses[key];
    const created = this.partNodes[key];
    const deferred = this.partDeferred[key];
    if (this.runningLocally && created === undefined && deferred === undefined)
      throw new VisibleError(
        `Cannot access \`nodes.${key}\` of "${this.componentName}" in \`sst dev\`. It runs locally there, so the resource isn't created.`,
      );

    if (!isMany(part)) {
      if (deferred) return deferred();
      return isDeferred(part) && this.creating.length
        ? this.whenCreated(key)
        : created;
    }
    // Held by id on an object with no prototype, so `id in nodes.route` is
    // only true for a route that exists, whatever the id is.
    if (!isDeferred(part)) return Object.assign(byId(), created);

    // Each is read when asked for: one given as an ARN has no resource
    const many = byId();
    const ids = new Set([
      ...Object.keys({ ...deferred, ...created }),
      ...(this.partPromised[key] ?? []),
    ]);
    for (const id of ids) {
      Object.defineProperty(many, id, {
        enumerable: true,
        get: () =>
          deferred?.[id]
            ? deferred[id]()
            : this.creating.length
              ? this.whenCreated(key, id)
              : output(created?.[id]),
      });
    }
    return many;
  }

  // A deferred part's resource, once `after()` has created what it creates
  private whenCreated(key: string, id?: string) {
    // A failure rejects with the same error, which Pulumi reports once
    return output(
      Promise.all(this.creating).then(() => at(this.partNodes, key, id)),
    );
  }

  private existingOf(key: string, id?: string, opts?: CustomResourceOptions) {
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

    return this.lookUp(key, id, existing, opts);
  }

  private lookUp(
    key: string,
    id: string | undefined,
    resourceId: unknown,
    opts?: CustomResourceOptions,
  ) {
    const lookup = partClass(this.partClasses[key]) as unknown as {
      get?: Function;
    };
    if (typeof lookup.get !== "function")
      throw new VisibleError(
        `The "${this.componentName}" component can't look up its "${key}" by id. Pass the resource itself in "existing".`,
      );
    const name = this.nameOf(key, id);
    const lookupOpts = { ...opts, parent: this };
    // A component's `get` takes its options third, like
    // `Dynamo.get(name, tableName, opts)`. A resource's takes its state
    // there, and its options fourth.
    const isComponent =
      (lookup as unknown as Function).prototype instanceof ComponentResource;
    return isComponent
      ? lookup.get(name, resourceId, lookupOpts)
      : lookup.get(name, resourceId, undefined, lookupOpts);
  }

  // The maps this run takes the component over with: those from the version
  // the stage has it at to its own. None when the stage has none of it, or has
  // it at this version, as on every deploy after the one that moved it.
  private takeoverMaps() {
    const from = mapsFrom(
      this.componentType,
      versionOf(this.constructor),
      formerTypeOf(this.constructor),
      this.outer,
    );
    return from === undefined ? [] : mapsAfter(this.constructor, from);
  }

  // Each map with the key the part has once that map has taken over: the
  // part's own key for the last, and for each before it what the next one
  // says it was. `undefined` once a map says where it was by its address, as
  // what came before can't be followed by its key.
  private keysIn(maps: Takeover<Parts, any>[], key: string) {
    const keys: [Takeover<Parts, any>, string | undefined][] = [];
    let current: string | undefined = key;
    for (const map of [...maps].reverse()) {
      keys.unshift([map, current]);
      const moved: unknown = current && map.moved?.[current];
      if (typeof moved === "string") current = moved;
      else if (moved) current = undefined;
    }
    return keys;
  }

  // Where a part's resource lived at each version the stage moves it from.
  // `name` is the part's own.
  private aliasesOf(key: string, name: string, id?: string) {
    const old: OldAddress[] = [];
    for (const [map, current] of this.keysIn(this.takeoverMaps(), key)) {
      const moved = current === undefined ? undefined : map.moved?.[current];
      if (!moved) continue;
      if (typeof moved !== "string") {
        old.push(...[moved(this, { name: this.componentName, id }) ?? []].flat());
        continue;
      }
      // Before SST 5 a part was named the way 4.x names things: the component,
      // the key, then the id. After, the way SST 5 does.
      const idPart =
        id === undefined
          ? ""
          : (map.version ?? 1) === 1
            ? logicalName(id)
            : idName(id);
      old.push({ name: `${this.componentName}${logicalName(moved)}${idPart}` });
    }
    // Each old address that isn't known yet stands in under a name of its own
    return old.map((address, i) =>
      aliasOf(address, i === 0 ? name : `${name}-${i}`),
    );
  }

  // While the stage moves, tell the core what a resource created on this
  // component's behalf takes the place of, by the maps
  private reportDelegated(child: ResourceTransformationArgs) {
    const released = this.takeoverMaps().flatMap((map) => [
      map.delegatedReleased?.(this, {
        name: child.name,
        type: child.type,
        componentName: this.componentName,
      }) ?? [],
    ].flat());
    if (!released.length) return;
    reportPart({
      component: this.urn,
      type: this.componentType,
      key: child.name,
      // Set once the resource's transformations, this among them, have run
      urn: all([]).apply(() => child.resource.urn),
      releases: released.map((old) =>
        releasedAddresses(old, this, this.componentName),
      ),
    });
  }

  // Where a resource created on this component's behalf lived, by the maps
  private delegatedAliases(name: string, type: string) {
    const old = this.takeoverMaps().flatMap((map) => [
      map.delegated?.(this, { name, type, componentName: this.componentName }) ??
        [],
    ].flat());
    return old.map((address, i) =>
      aliasOf(address, i === 0 ? name : `${name}-${i}`),
    );
  }

  private nameOf(key: string, id?: string) {
    if (
      isMany(this.partClasses[key]) &&
      (typeof id !== "string" || idName(id) === "")
    )
      throw new VisibleError(
        `The "${this.componentName}" component creates several "${key}" parts, so each one needs an id.`,
      );

    const name = `${this.componentName}${this.partName(key)}${id === undefined ? "" : idName(id)}`;
    const refs = this.partNames.get(name) ?? [];
    const other = refs.find((ref) => ref.key === key && ref.id !== id);
    if (other)
      throw new VisibleError(
        `In the "${this.componentName}" component, "${other.id}" and "${id}" are too alike: both would be named "${name}". Change one of them.`,
      );
    this.partNames.set(name, [...refs, id === undefined ? { key } : { key, id }]);
    return name;
  }

  // What a part adds to the component's name: its key, or the name it's
  // declared with
  private partName(key: string) {
    return nameGiven(this.partClasses[key]) ?? logicalName(key);
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
