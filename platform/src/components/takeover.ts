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
 * Where SST 4 kept one of SST's own resources: a Pulumi dynamic resource, with
 * its kind added to its name, like `MySiteAssetFiles.sst.aws.BucketFiles`.
 * The `sst` binary serves the ones that take their place, under types of their
 * own, so a move releases the old one: it leaves the state without its delete,
 * which would remove what it wrote, and the new one writes the same again, or
 * adopts it by its id.
 *
 * @param kind The resource's cloud and kind, like `aws.BucketFiles`.
 * @param at Where it was, with the name it was given before its kind was
 * added.
 */
export function sstResource(
  kind: `${"aws" | "cloudflare" | "vercel"}.${string}`,
  at: OldAddress,
): ReleasedAddress {
  return {
    ...at,
    type: "pulumi-nodejs:dynamic:Resource",
    // Kept a plain name when it's given one, for a move that adopts it by its
    // id: the core gives the ids by name
    name:
      typeof at.name === "string"
        ? `${at.name}.sst.${kind}`
        : interpolate`${at.name}.sst.${kind}`,
  };
}

/**
 * How a component takes over from what it was before, so that a stage keeps
 * the resources that are already deployed: from its form before SST 5, or
 * from its own earlier version.
 *
 * A deployed component with the same type and name becomes this component.
 * Each of its resources is matched to the part with the same key. List a part
 * under `moved` when it used to have a different key, or lived in a different
 * component.
 *
 * Each map is numbered. Version 1 takes over from the component's form before
 * SST 5, like SST 4's. A later change to a component that moves its resources
 * ships the next version, which takes over from the one before it. A
 * component with no map is at version 1. A stage records the version of each
 * component it has; one that's behind is moved by `sst migrate`, which applies
 * every map from the stage's version on, and a plain deploy refuses it.
 *
 * `sst migrate --check` fails on anything else a move would create, delete or
 * replace in the cloud, unless it's listed under `added`, `replaced` or
 * `released`. It never allows a resource that holds data to be deleted,
 * replaced or emptied.
 */
export interface Takeover<P extends Parts, C = unknown> {
  /**
   * The version this map takes the component to, from the one before it.
   * Version 1 takes over from its form before SST 5.
   *
   * @default `1`
   */
  version?: number;
  /**
   * The type of the component this one takes over from, when that isn't this
   * component's own type. Only version 1 can change the type.
   */
  from?: string;
  moved?: {
    [K in PartKey<P>]?:
      | string
      | ((
          component: C,
          /** The component's name, and the part's id for a `many` part. */
          part: { name: string; id?: string },
        ) => OldAddress | OldAddress[] | undefined);
  };
  /** Parts the component it takes over didn't have. A move creates them. */
  added?: PartKey<P>[];
  /**
   * Parts a move replaces, each with what changes for the user, as the
   * migration guide says it: "The function's URL changes." Only a part that
   * holds no data can be replaced.
   */
  replaced?: { [K in PartKey<P>]?: string };
  /**
   * Parts that take the place of resources a move can't carry over, as when
   * the type changes. Those leave the state without their delete being
   * called, and the part writes the same thing again or adopts it by its id.
   */
  released?: {
    [K in PartKey<P>]?: (
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
  /**
   * What a resource something created on the component's behalf takes the
   * place of, when a move can't carry that over, as `released` says for a
   * part: the CAA records a DNS adapter creates for a certificate were SST 4's
   * dynamic resources. Give the old address, with its type, by the name and
   * type the resource has now, or `undefined`.
   */
  delegatedReleased?: (
    component: C,
    resource: {
      /** The resource's name, and its type. */
      name: string;
      type: string;
      /** The component's name. */
      componentName: string;
    },
  ) => ReleasedAddress | ReleasedAddress[] | undefined;
}

// A part's key in a map: one of the component's parts, or, in a map of an
// earlier version, what a part was called then
export type PartKey<P extends Parts> = (keyof P & string) | (string & {});

// By class and not by type: a component and the one that replaces it can
// have the same type. Each class's maps are kept in the order of their
// versions.
const takeovers = new Map<Function, Takeover<any, any>[]>();

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
 * A later change ships the next version:
 *
 * ```ts
 * takeover(Uploads, { version: 2, moved: { files: "bucket" } });
 * ```
 *
 * @param component The component that takes over.
 * @param how Its version, the parts that moved, and the type it takes over from when that's another type.
 */
export function takeover<P extends Parts, C>(
  component: {
    new (...args: any[]): C;
    readonly __pulumiType: string;
    readonly __parts?: P;
  },
  how: Takeover<P, C>,
) {
  const version = how.version ?? 1;
  const type = component.__pulumiType.replaceAll(":", ".");
  if (!Number.isInteger(version) || version < 1)
    throw new Error(
      `The map of ${type} has version ${version}. A version is a whole number from 1.`,
    );
  if (how.from && version !== 1)
    throw new Error(
      `Version ${version} of ${type} names the type it takes over from. Only version 1 can: a component keeps its type after that.`,
    );
  const maps = takeovers.get(component) ?? [];
  if (maps.some((map) => (map.version ?? 1) === version))
    throw new Error(`${type} has two maps for version ${version}.`);
  takeovers.set(
    component,
    [...maps, how].sort((a, b) => (a.version ?? 1) - (b.version ?? 1)),
  );
}

/**
 * The maps of a component's class, or of the class it extends, in the order
 * of their versions.
 * @internal
 */
export function takeoverOf(
  component: Function | undefined,
): Takeover<Parts, any>[] | undefined {
  for (let cls = component; cls; cls = Object.getPrototypeOf(cls)) {
    const maps = takeovers.get(cls);
    if (maps) return maps;
  }
}

/**
 * The version of a component's class: that of its last map, or 1.
 * @internal
 */
export function versionOf(component: Function | undefined): number {
  const maps = takeoverOf(component);
  return maps ? (maps[maps.length - 1].version ?? 1) : 1;
}

/**
 * The type a component's class took over from before SST 5, when it has a
 * form from then and that had another type.
 * @internal
 */
export function formerTypeOf(component: Function | undefined) {
  return takeoverOf(component)?.find((map) => (map.version ?? 1) === 1)?.from;
}

/**
 * The maps that take a component's class from the given version to its own,
 * in order.
 * @internal
 */
export function mapsAfter(component: Function | undefined, version: number) {
  return (takeoverOf(component) ?? []).filter(
    (map) => (map.version ?? 1) > version,
  );
}

/**
 * The types of the components that have a form before SST 5, which a
 * version 1 map takes over from. A map that takes over from another type
 * covers that type only.
 * @internal
 */
export function takenOverTypes(): Set<string> {
  const types = new Set<string>();
  for (const [component, maps] of takeovers) {
    const first = maps.find((map) => (map.version ?? 1) === 1);
    if (first)
      types.add(
        first.from ??
          (component as unknown as { __pulumiType: string }).__pulumiType,
      );
  }
  return types;
}

/**
 * The version of each component class that has a map, by type. Two classes
 * of one type, like SST 4's and SST 5's form, give the larger.
 * @internal
 */
export function versionedTypes(): Map<string, number> {
  const versions = new Map<string, number>();
  for (const [component] of takeovers) {
    const type = (component as unknown as { __pulumiType: string })
      .__pulumiType;
    versions.set(type, Math.max(versions.get(type) ?? 0, versionOf(component)));
  }
  return versions;
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
