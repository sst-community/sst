import {
  type Alias,
  Input,
  Output,
  Resource,
  all,
  getProject,
  getStack,
  interpolate,
  output,
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
        /**
         * The component that one was created in. A 4.x site kept its warmer
         * in a component of its own, inside the site.
         */
        within?: Resource;
      };
}

/**
 * A resource that a part takes the place of, and which leaves the state
 * without being deleted.
 */
export interface ReleasedAddress extends OldAddress {
  /** The resource's type, like `pulumi-nodejs:dynamic:Resource`. */
  type: string;
}

/**
 * How a component takes over from the one it replaces, so that switching to
 * it keeps the resources that are already deployed.
 *
 * A deployed component with the same type and name becomes this component.
 * Each of its resources is matched to the part with the same key. List a part
 * under `moved` when it used to have a different key, or lived in a different
 * component.
 *
 * `sst migrate --check` fails on anything else a move would create, delete or
 * replace in the cloud, unless it's listed under `added`, `replaced` or
 * `released`. It never allows a resource that holds data to be deleted,
 * replaced or emptied.
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
  /** Parts the component it takes over didn't have. A move creates them. */
  added?: (keyof P)[];
  /**
   * Parts a move replaces, each with what changes for the user, as the
   * migration guide says it: "The function's URL changes." Only a part that
   * holds no data can be replaced.
   */
  replaced?: { [K in keyof P]?: string };
  /**
   * Parts that take the place of resources a move can't carry over, as when
   * the type changes. Those leave the state without their delete being
   * called, and the part writes the same thing again or adopts it by its id.
   */
  released?: {
    [K in keyof P]?: (
      component: C,
      /** The component's name, and the part's id for a `many` part. */
      part: { name: string; id?: string },
    ) => ReleasedAddress | ReleasedAddress[] | undefined;
  };
  /**
   * Where a resource something created on the component's behalf lived, when
   * that isn't where it lives now. Those aren't parts: a DNS adapter's records
   * are created through the adapter. Give each one's old address, by the name
   * and type it has now, or `undefined` where it didn't move.
   */
  delegated?: (
    component: C,
    resource: {
      /** The resource's name, and its type. */
      name: string;
      type: string;
      /** The component's name. */
      componentName: string;
    },
  ) => OldAddress | OldAddress[] | undefined;
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

/**
 * The types of the components a state map takes over from: those with a 5.0
 * form. A map that takes over from another type covers that type only.
 * @internal
 */
export function takenOverTypes(): Set<string> {
  const types = new Set<string>();
  for (const [component, how] of takeovers)
    types.add(
      how.from ??
        (component as unknown as { __pulumiType: string }).__pulumiType,
    );
  return types;
}

/**
 * The Pulumi alias for an old address of the resource named `name`.
 *
 * An old address can be made from a value that isn't known in a preview, like
 * the ARN of a queue a new stage is about to create. Nothing can be at it
 * then, and Pulumi fails on an alias it can't resolve, so in that case the
 * alias is one that matches nothing: the resource's own name with a suffix,
 * which no other resource has.
 */
export function aliasOf(old: OldAddress, name: string): Input<Alias> {
  const alias = addressOf(old);
  const computed = [alias.name, alias.parent].filter((value) =>
    Output.isInstance(value),
  ) as unknown as { isKnown: Promise<boolean> }[];
  if (computed.length === 0) return alias;
  const known = Promise.all(computed.map((value) => value.isKnown)).then(
    (each) => each.every(Boolean),
  );
  return output(known).apply(
    (known): Input<Alias> =>
      known
        ? Resource.isInstance(alias.parent) || alias.parent === undefined
          ? output(alias.name).apply((name) => ({ ...alias, name }))
          : all([alias.name, alias.parent]).apply(([name, parent]) => ({
              name,
              parent,
            }))
        : { name: `${name}$unknown-in-preview` },
  ) as Output<Alias>;
}

/**
 * The addresses a resource a part releases can be at. One with no `parent` was
 * in the component this one takes over from: at this component's address, or
 * at one it answers to through an alias, like the type it takes over from, or
 * the name a parent's map gave it before. Under an alias, a name that starts
 * with the component's starts with the alias's instead, as Pulumi names a
 * child's alias.
 *
 * @param component This component, and its name.
 * @internal
 */
export function releasedAddresses(
  old: ReleasedAddress,
  component: Resource,
  componentName: string,
): Output<string[]> {
  if (old.parent !== undefined) {
    const parent =
      old.parent === false
        ? undefined
        : (addressOf(old).parent as Input<string>);
    return all([parent, old.name]).apply(([parent, name]) => [
      parent
        ? childAddress(parent, old.type, name)
        : `urn:pulumi:${getStack()}::${getProject()}::${old.type}::${name}`,
    ]);
  }
  // What Pulumi resolved the component's aliases to
  const aliases: Input<string>[] = (component as any).__aliases ?? [];
  return all([component.urn, all(aliases), old.name]).apply(
    ([urn, aliases, name]) => [
      ...new Set(
        [urn, ...aliases].map((parent) =>
          childAddress(
            parent,
            old.type,
            name.startsWith(componentName)
              ? parent.slice(parent.lastIndexOf("::") + 2) +
                  name.slice(componentName.length)
              : name,
          ),
        ),
      ),
    ],
  );
}

// The address of a resource named `name` of a type, inside the one at `parent`
function childAddress(parent: string, type: string, name: string) {
  const [stack, project, types] = parent.split("::");
  return [stack, project, `${types}$${type}`, name].join("::");
}

function addressOf(old: OldAddress) {
  // Pulumi reads a parent that's set but empty as "it had no parent"
  if (old.parent === false)
    return { name: old.name, parent: rootStackResource };
  if (!old.parent) return { name: old.name };

  const { type, name, beside, within } = old.parent;
  // The address of `within`, with the type and the name added
  if (within)
    return {
      name: old.name,
      parent: all([within.urn, name]).apply(([urn, name]) => {
        const [stack, project, types] = urn.split("::");
        return [stack, project, `${types}$${type}`, name].join("::");
      }),
    };
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
