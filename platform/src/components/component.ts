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
  ResourceTransformationArgs,
} from "@pulumi/pulumi";
import { nameResource, registerNamingRule } from "./naming.js";
import type { NamingRule } from "./naming-rules.js";
import { takeoverOf } from "./takeover.js";
import { VisibleError } from "./error.js";
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

    // `this` is not available to the transformations below until `super`
    // returns, so they reach the component through this variable.
    let self: Component | undefined;

    super(type, name, {}, {
      ...opts,
      // A deployed component this one takes over from becomes this one.
      // Pulumi carries the alias over to its children.
      aliases: [...(opts?.aliases ?? []), ...takeoverAliases(new.target, opts)],
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

  /** @internal */
  protected registerVersion(input: {
    new: number;
    old?: number;
    message?: string;
    forceUpgrade?: `v${number}`;
  }) {
    // Check component version
    const oldVersion = input.old;
    const newVersion = input.new ?? 1;
    if (oldVersion) {
      const className = this.componentType.replaceAll(":", ".");
      // Invalid forceUpgrade value
      if (input.forceUpgrade && input.forceUpgrade !== `v${newVersion}`) {
        throw new VisibleError(
          [
            `The value of "forceUpgrade" does not match the version of "${className}" component.`,
            `Set "forceUpgrade" to "v${newVersion}" to upgrade to the new version.`,
          ].join("\n"),
        );
      }
      // Version upgraded without forceUpgrade
      if (oldVersion < newVersion && !input.forceUpgrade) {
        throw new VisibleError(input.message ?? "");
      }
      // Version downgraded
      if (oldVersion > newVersion) {
        throw new VisibleError(
          [
            `It seems you are trying to use an older version of "${className}".`,
            `You need to recreate this component to rollback - https://sst.dev/docs/components/#versioning`,
          ].join("\n"),
        );
      }
    }

    // Set version
    if (newVersion > 1) {
      new Version(this.componentName, newVersion, { parent: this });
    }
  }
}

// The addresses of the component this one takes over from, when that one
// has another type: the same address with the old type. When the component is also given an old name or
// parent, as a part that moved is, the old type goes with each of those too.
// Pulumi reads every alias on its own, so two that each say one thing don't
// add up to the address that had both.
function takeoverAliases(component: Function, opts?: ComponentResourceOptions) {
  const from = takeoverOf(component)?.from;
  if (!from) return [];
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
  // @ts-expect-error
  const type = resource.__pulumiType;
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

export class Version extends ComponentResource {
  constructor(target: string, version: number, opts: ComponentResourceOptions) {
    super("sst:sst:Version", target + "Version", {}, opts);
    this.registerOutputs({ target, version });
  }
}

export type ComponentVersion = { major: number; minor: number };
export function parseComponentVersion(version: string): ComponentVersion {
  const [major, minor] = version.split(".");
  return { major: parseInt(major), minor: parseInt(minor) };
}
