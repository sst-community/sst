import {
  Input,
  Resource,
  all,
  getProject,
  getStack,
  interpolate,
  rootStackResource,
} from "@pulumi/pulumi";
import type { Parts } from "./parts";

/**
 * Where a resource lived before, when that isn't where it lives now.
 */
export interface OldAddress {
  /** The name the resource had. */
  name: Input<string>;
  /**
   * The component it was in, when that was a different component from the one
   * it's in now. `false` when it wasn't in a component at all: it was created
   * at the top of the app, beside the component.
   */
  parent?:
    | false
    | {
        type: string;
        name: Input<string>;
        /**
         * The component that one was created next to, under the same parent.
         * Leave it out when it was at the top of the app whatever it was
         * created for.
         */
        beside?: Resource;
      };
}

/**
 * How a component takes over from the one it replaces, so that switching to
 * it keeps the resources that are already deployed.
 *
 * A deployed component with the same type and name becomes this component.
 * Each of its resources is matched to the part with the same key. List a part
 * under `moved` when it used to have a different key, or lived in a different
 * component.
 */
export interface Takeover<P extends Parts, C = unknown> {
  /**
   * The type of the component this one takes over from, when that isn't this
   * component's own type.
   */
  from?: string;
  moved?: {
    [K in keyof P]?:
      | string
      | ((
          component: C,
          /** The component's name, and the part's id for a `many` part. */
          part: { name: string; id?: string },
        ) => OldAddress | OldAddress[] | undefined);
  };
}

// By class and not by type: a component and the one that replaces it can
// have the same type
const takeovers = new Map<Function, Takeover<any, any>>();

/**
 * Say how a component takes over from the one it replaces. This lives apart
 * from the component, so the component's own code doesn't carry the layout of
 * what came before it.
 *
 * @example
 * ```ts
 * takeover(Redis, {
 *   moved: {
 *     // The key this part had
 *     secret: "proxySecret",
 *   },
 * });
 * ```
 *
 * @param component The component that takes over.
 * @param how The parts that moved, and the type it takes over from when that's another type.
 */
export function takeover<P extends Parts, C>(
  component: {
    new (...args: any[]): C;
    readonly __pulumiType: string;
    readonly __parts?: P;
  },
  how: Takeover<P, C>,
) {
  takeovers.set(component, how);
}

/**
 * How a component's class takes over, or the class it extends.
 * @internal
 */
export function takeoverOf(
  component: Function | undefined,
): Takeover<Parts, any> | undefined {
  for (let cls = component; cls; cls = Object.getPrototypeOf(cls)) {
    const how = takeovers.get(cls);
    if (how) return how;
  }
}

/** The Pulumi alias for an old address. */
export function aliasOf(old: OldAddress) {
  // Pulumi reads a parent that's set but empty as "it had no parent"
  if (old.parent === false)
    return { name: old.name, parent: rootStackResource };
  if (!old.parent) return { name: old.name };

  const { type, name, beside } = old.parent;
  if (!beside)
    return {
      name: old.name,
      parent: interpolate`urn:pulumi:${getStack()}::${getProject()}::${type}::${name}`,
    };
  // The same address as `beside`, with the last type and the name swapped
  return {
    name: old.name,
    parent: all([beside.urn, name]).apply(([urn, name]) => {
      const [stack, project, types] = urn.split("::");
      const chain = [...types.split("$").slice(0, -1), type].join("$");
      return [stack, project, chain, name].join("::");
    }),
  };
}
