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
 */
export function transformPart<T extends object>(
  transform: PartTransform<T> | undefined,
  name: string,
  args: T,
  opts: CustomResourceOptions,
) {
  if (typeof transform === "function") {
    transform(args, opts, name);
    return [name, args, opts] as const;
  }
  return [name, mergeArgs(args, transform), opts] as const;
}

/**
 * Merges the object form of a transform into a resource's default args.
 *
 * Nested objects are merged key by key, so setting one nested value keeps its
 * siblings. Everything else replaces the default: arrays, strings, numbers,
 * outputs, assets and resources. To replace a nested object outright, use the
 * function form of the transform.
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
    merged[key] = mergeArgs(merged[key], value as any);
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
      output(defaults[key] as object).apply((resolved: unknown) => ({
        field: key,
        kept: isPlainObject(resolved)
          ? keptPaths(resolved, value as Record<string, unknown>)
          : [],
      })),
    );
  return all(fields).apply((fields) =>
    fields.filter((field) => field.kept.length > 0),
  ) as Output<MergedField[]>;
}

// The paths of the settings in `base` that `patch` doesn't set, within those
// both set as objects
function keptPaths(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  prefix = "",
): string[] {
  const kept: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const path = prefix + key;
    if (!(key in patch)) kept.push(path);
    else if (isPlainObject(value) && isPlainObject(patch[key]))
      kept.push(...keptPaths(value, patch[key], `${path}.`));
  }
  return kept;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
