import {
  type CustomResourceOptions,
  type OutputInstance,
  type Resource,
  Output,
  all,
  output,
} from "@pulumi/pulumi";

export type Transform<T> =
  | Partial<T>
  | ((args: T, opts: CustomResourceOptions, name: string) => undefined);

export function transform<T extends object>(
  transform: Transform<T> | undefined,
  name: string,
  args: T,
  opts: CustomResourceOptions,
) {
  // Case: transform is a function
  if (typeof transform === "function") {
    transform(args, opts, name);
    return [name, args, opts] as const;
  }

  // Case: no transform
  // Case: transform is an argument
  return [name, { ...args, ...transform }, opts] as const;
}

/**
 * A part's args with every level optional: what the object form of a part's
 * transform takes. It follows how `mergeArgs()` merges. A nested object is
 * merged key by key, so it can be given in part. Anything else is replaced,
 * so it's given whole.
 */
export type PartialArgs<T> = T extends Whole
  ? T
  : T extends object
    ? { [K in keyof T]?: PartialArgs<T[K]> }
    : T;

// What a transform replaces as a whole. (An asset or archive is too, but its
// type has no members, so every object would match it.)
type Whole =
  | readonly any[]
  | ((...args: any[]) => any)
  | Promise<any>
  | OutputInstance<any>
  | Resource;

/**
 * The transform for one of a component's parts: args to merge into the
 * defaults, or a function that changes the args and options.
 */
export type PartTransform<T> =
  | PartialArgs<T>
  | ((args: T, opts: CustomResourceOptions, name: string) => undefined);

/**
 * Applies a transform to one of a component's parts. Unlike `transform()`,
 * the object form is merged into nested defaults instead of replacing them.
 *
 * The function form is given the args the component made for the part, which
 * it changes in place, so the component can read what it made of them. What's
 * inside them is a copy of the arrays and plain objects, so what it changes
 * there doesn't reach the app's config, or a default another part shares.
 * SST 4's components gave a transform copies too, made by `output()`.
 */
export function transformPart<T extends object>(
  transform: PartTransform<T> | undefined,
  name: string,
  args: T,
  opts: CustomResourceOptions,
) {
  if (typeof transform === "function") {
    const copies = new Map<object, unknown>();
    for (const [key, value] of Object.entries(args))
      (args as Record<string, unknown>)[key] = copyArgs(value, copies);
    transform(args, opts, name);
    return [name, args, opts] as const;
  }
  return [name, mergeArgs(args, transform), opts] as const;
}

// A copy of the arrays and plain objects in a part's args. Anything else, an
// output, a resource, an asset or a function, is kept as it is.
function copyArgs<T>(value: T, copies = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (copies.has(value)) return copies.get(value) as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value) copy.push(copyArgs(item, copies));
    return copy as T;
  }
  if (!isPlainObject(value)) return value;
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value))
    copy[key] = copyArgs(item, copies);
  return copy as T;
}

/**
 * Merges the object form of a transform into a resource's default args.
 *
 * Nested objects are merged key by key, so setting one nested value keeps its
 * siblings. Everything else replaces the default: arrays, strings, numbers,
 * outputs, assets and resources. A key set to `undefined` unsets the
 * default's, as SST 4's `transform()` did. To replace a nested object
 * outright, use the function form of the transform.
 */
export function mergeArgs<T>(base: T, patch: PartialArgs<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(patch)) return patch as T;

  if (Output.isInstance(base)) {
    // The default is only known later; merge once it resolves.
    return (base as Output<unknown>).apply((resolved) =>
      output(isPlainObject(resolved) ? mergeArgs(resolved, patch) : patch),
    ) as T;
  }
  if (!isPlainObject(base)) return patch as T;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] =
      value === undefined ? undefined : mergeArgs(merged[key], value as any);
  }
  return merged as T;
}

/**
 * An arg the object form of a transform sets as an object, and the settings
 * of the default's that `mergeArgs()` keeps beside it, by their paths. SST 4's
 * `transform()` put the object in the default's place, without them.
 */
export interface MergedField {
  field: string;
  kept: string[];
}

/**
 * What `mergeArgs()` keeps that SST 4's `transform()` dropped: for each arg
 * the object form sets as an object, where the default is an object too, the
 * default's settings it doesn't set. A default that's an output is read once
 * it resolves; in a preview where it isn't known, it isn't listed.
 */
export function keptByMerge(
  base: object,
  patch: unknown,
): Output<MergedField[]> {
  if (!isPlainObject(patch)) return output([]);
  const defaults = base as Record<string, unknown>;
  const fields = Object.entries(patch)
    .filter(([key, value]) => isPlainObject(value) && defaults[key] != null)
    .map(([key, value]) =>
      keptPaths(defaults[key], value as Record<string, unknown>).apply(
        (kept) => ({ field: key, kept }),
      ),
    );
  return all(fields).apply((fields) =>
    fields.filter((field) => field.kept.length > 0),
  ) as Output<MergedField[]>;
}

// The paths of the settings in `base` that `patch` doesn't set, where
// `mergeArgs()` merges the two: step for step as it does, so an output is
// read once it resolves, and anything that isn't a plain object, like a
// promise or an asset, is replaced, keeping nothing
function keptPaths(
  base: unknown,
  patch: Record<string, unknown>,
  prefix = "",
): Output<string[]> {
  if (Output.isInstance(base))
    return (base as Output<unknown>).apply((resolved) =>
      keptPaths(resolved, patch, prefix),
    );
  if (!isPlainObject(base)) return output([]);
  const kept = Object.entries(base)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]): Output<string[]> => {
      const path = prefix + key;
      // Kept, unless it's an output that resolves to nothing, as `ifSet()`
      // gives for an arg that isn't set
      if (!(key in patch))
        return Output.isInstance(value) || value instanceof Promise
          ? (output(value) as Output<unknown>).apply((v) =>
              v === undefined ? [] : [path],
            )
          : output([path]);
      const set = patch[key];
      return isPlainObject(set)
        ? keptPaths(value, set, `${path}.`)
        : output([]);
    });
  return all(kept).apply((lists) => lists.flat());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
