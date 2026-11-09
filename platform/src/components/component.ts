import {
  ComponentResource,
  ComponentResourceOptions,
  Inputs,
  runtime,
  output,
  asset as pulumiAsset,
  Input,
  all,
  Output,
  Resource,
  ResourceTransformationArgs,
} from "@pulumi/pulumi";
import { nameResource, registerNamingRule } from "./naming.js";
import type { NamingRule } from "./naming-rules.js";
import {
  formerTypeOf,
  takenOverTypes,
  takeoverOf,
  versionOf,
} from "./takeover.js";
import {
  type Outer,
  mapsFrom,
  newFormCreated,
  noteCreated,
  oldFormCreated,
} from "./move.js";
import { VisibleError } from "./error.js";
import { refuseSst4Name } from "./sst4.js";
import { checkComponent } from "./check.js";
import path from "path";
import { statSync } from "fs";

export { type Transform, transform, mergeArgs } from "./transform.js";
export type { NamingRule } from "./naming-rules.js";

// Previously, `this.api.id` was used as the ID. `this.api.id` was of type Output<string>
// the value evaluates to the mistake id.
// In the future version, we will release a breaking change to fix this.
export const outputId =
  "Calling [toString] on an [Output<T>] is not supported.\n\nTo get the value of an Output<T> as an Output<string> consider either:\n1: o.apply(v => `prefix${v}suffix`)\n2: pulumi.interpolate `prefix${v}suffix`\n\nSee https://www.pulumi.com/docs/concepts/inputs-outputs for more details.\nThis function may throw in a future version of @pulumi/pulumi.";

/**
 * Helper type to inline nested types
 */
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

/**
 * The class every component extends. It names the component's resources and
 * applies `$transform`.
 *
 * To write a component, extend what `component()` returns instead. It adds
 * parts to this class.
 */
export class Component extends ComponentResource {
  /** @internal */
  protected readonly componentType: string;
  /** The name the component was created with. */
  protected readonly componentName: string;
  /**
   * The outermost of SST's components it's inside, which it moves with, if
   * it's inside one.
   *
   * @internal
   */
  protected readonly outer: Outer | undefined;
  // Its version: the one its maps take it to, or 0 for SST 4's form
  private readonly componentVersion: number;

  constructor(
    type: string,
    name: string,
    args?: Inputs,
    opts?: ComponentResourceOptions,
  ) {
    const transforms = ComponentTransforms.get(type) ?? [];
    for (const transform of transforms) {
      transform({ name, props: args, opts });
    }
    // The app's and its packages' checks see the args as transformed
    checkComponent(type, name, args);
    // Every component is at a version: the one its maps take it to, or 1. SST
    // 4's form of one that has a 5.0 form is version 0. One inside another of
    // SST's components moves with the outermost.
    const outer = Component.outerSst(opts?.parent);
    const version =
      takeoverOf(new.target) === undefined && takenOverTypes().has(type)
        ? 0
        : versionOf(new.target);
    if (version === 0) {
      if (!outer) oldFormCreated(type, name);
    } else
      newFormCreated(
        formerTypeOf(new.target) ?? type,
        type,
        name,
        version,
        outer,
      );

    // `this` is not available to the transformations below until `super`
    // returns, so they reach the component through this variable.
    let self: Component | undefined;

    super(type, name, {}, {
      ...opts,
      // A deployed component this one takes over from becomes this one.
      // Pulumi carries the alias over to its children.
      aliases: [
        ...(opts?.aliases ?? []),
        ...takeoverAliases(new.target, type, outer, opts),
      ],
      transformations: [
        // Ensure logical and physical names are prefixed
        (args) => nameResource({ type, name }, args),
        // Set child resources `retainOnDelete` if set on component
        (args) => ({
          props: args.props,
          opts: {
            ...args.opts,
            retainOnDelete: args.opts.retainOnDelete ?? opts?.retainOnDelete,
          },
        }),
        // Tell the component about each resource created directly under it
        (args) => {
          if (self && args.opts.parent === self) self.childCreated?.(args);
          return undefined;
        },
        ...(opts?.transformations ?? []),
      ],
    });

    self = this;
    this.componentType = type;
    this.componentName = name;
    this.outer = outer;
    this.componentVersion = version;
    noteCreated(type, version, this, outer);
  }

  // The outermost of SST's components a resource is, or is inside
  private static outerSst(resource: Resource | undefined): Outer | undefined {
    let outer: Component | undefined;
    for (let at = resource; at; at = (at as any).__parentResource) {
      if (at instanceof Component && at.componentType.startsWith("sst:"))
        outer = at;
    }
    return (
      outer && {
        type: outer.componentType,
        formerType: formerTypeOf(outer.constructor),
        version: outer.componentVersion,
        name: outer.componentName,
      }
    );
  }

  /**
   * Called for each resource created directly under this component.
   *
   * @internal
   */
  protected childCreated?(child: ResourceTransformationArgs): void;

  /**
   * Say how resources of a type get their physical name when they are created
   * inside a component. SST already knows the types its own components use.
   *
   * @example
   * ```ts
   * sst.Component.naming("aws:kms/alias:Alias", false);
   * sst.Component.naming("aws:athena/workgroup:Workgroup", {
   *   field: "name",
   *   max: 128,
   * });
   * ```
   */
  public static naming(type: string, rule: NamingRule) {
    registerNamingRule(type, rule);
  }
}

// The addresses of the component this one takes over from, when that one
// has another type: the same address with the old type, while the stage still
// has it in that form. When the component is also given an old name or
// parent, as a part that moved is, the old type goes with each of those too.
// Pulumi reads every alias on its own, so two that each say one thing don't
// add up to the address that had both.
function takeoverAliases(
  component: Function,
  type: string,
  outer: Outer | undefined,
  opts?: ComponentResourceOptions,
) {
  const from = formerTypeOf(component);
  if (!from || mapsFrom(type, versionOf(component), from, outer) !== 0)
    return [];
  const moved = (opts?.aliases ?? []).flatMap((alias) =>
    typeof alias === "object" &&
    !Output.isInstance(alias) &&
    !(alias instanceof Promise) &&
    alias.type === undefined
      ? [{ ...alias, type: from }]
      : [],
  );
  return [...moved, { type: from }];
}

const ComponentTransforms = new Map<string, any[]>();
export function $transform<T, Args, Options>(
  resource: { new (name: string, args: Args, opts?: Options): T },
  cb: (args: Args, opts: Options, name: string) => void,
) {
  refuseSst4Name(resource);
  // @ts-expect-error
  const type = resource.__pulumiType;
  if (typeof type !== "string")
    throw new VisibleError(
      "$transform takes a component's or a resource's class, like sst.aws.Function or aws.s3.Bucket.",
    );
  // A component is given its args before it creates anything
  if (type.startsWith("sst:") || resource.prototype instanceof Component) {
    let transforms = ComponentTransforms.get(type);
    if (!transforms) {
      transforms = [];
      ComponentTransforms.set(type, transforms);
    }
    transforms.push((input: any) => {
      cb(input.props, input.opts, input.name);
      return input;
    });
    return;
  }
  runtime.registerStackTransformation((input) => {
    if (input.type !== type) return;
    cb(input.props as any, input.opts as any, input.name);
    return input;
  });
}

export function $asset(assetPath: string) {
  const fullPath = path.isAbsolute(assetPath)
    ? assetPath
    : path.join($cli.paths.root, assetPath);

  try {
    return statSync(fullPath).isDirectory()
      ? new pulumiAsset.FileArchive(fullPath)
      : new pulumiAsset.FileAsset(fullPath);
  } catch (e) {
    throw new VisibleError(`Asset not found: ${fullPath}`);
  }
}

export function $lazy<T>(fn: () => T) {
  return output(undefined)
    .apply(async () => output(fn()))
    .apply((x) => x);
}

export function $print(...msg: Input<any>[]) {
  return all(msg).apply((msg) => console.log(...msg));
}

