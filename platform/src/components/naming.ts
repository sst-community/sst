import crypto from "crypto";
import {
  output,
  type ResourceTransformationArgs,
  type ResourceTransformationResult,
} from "@pulumi/pulumi";
import { VisibleError } from "./error.js";
import {
  NAMING_RULES,
  UNPREFIXED_TYPES,
  type BuiltInNamingRule,
  type NamingRule,
} from "./naming-rules.js";

export function logicalName(name: string) {
  name = name.replace(/[^a-zA-Z0-9]/g, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function physicalName(max: number, name: string, suffix: string = "") {
  // This function does the following:
  // - Removes all non-alphanumeric characters
  // - Prefixes the name with the app name and stage
  // - Truncates the name if it's too long
  // - Adds a random suffix
  // - Adds a suffix if provided
  const main = prefixName(max - 9 - suffix.length, name);
  const random = hashStringToPrettyString(
    crypto.randomBytes(8).toString("hex"),
    8,
  );
  return `${main}-${random}${suffix}`;
}

export function prefixName(max: number, name: string) {
  // This function does the following:
  // - Removes all non-alphanumeric characters
  // - Prefixes the name with the app name and stage
  // - Truncates the name if it's too long
  // ie. foo => app-stage-foo

  name = name.replace(/[^a-zA-Z0-9]/g, "");

  const stageLen = $app.stage.length;
  const nameLen = name.length;
  const strategy =
    nameLen + 1 >= max
      ? ("name" as const)
      : nameLen + stageLen + 2 >= max
        ? ("stage+name" as const)
        : ("app+stage+name" as const);

  if (strategy === "name") return `${name.substring(0, max)}`;
  if (strategy === "stage+name")
    return `${$app.stage.substring(0, max - nameLen - 1)}-${name}`;
  return `${$app.name.substring(0, max - stageLen - nameLen - 2)}-${
    $app.stage
  }-${name}`;
}

export function hashNumberToPrettyString(number: number, length: number) {
  const charLength = PRETTY_CHARS.length;
  let hash = "";
  while (number > 0) {
    hash = PRETTY_CHARS[number % charLength] + hash;
    number = Math.floor(number / charLength);
  }

  // Padding with 's'
  hash = hash.slice(0, length);
  while (hash.length < length) {
    hash = "s" + hash;
  }

  return hash;
}

export function hashStringToPrettyString(str: string, length: number) {
  const hash = crypto.createHash("sha256");
  hash.update(str);
  const num = Number("0x" + hash.digest("hex").substring(0, 16));
  return hashNumberToPrettyString(num, length);
}

export const PRETTY_CHARS = "abcdefhkmnorstuvwxz";

const CustomNamingRules = new Map<string, NamingRule>();

export function registerNamingRule(type: string, rule: NamingRule) {
  CustomNamingRules.set(type, rule);
}

/**
 * Checks the logical name of a resource created inside a component, and gives
 * it a physical name prefixed with the app and stage.
 *
 * @param component The type and name of the component.
 * @param args The resource being created inside it.
 */
export function nameResource(
  component: { type: string; name: string },
  args: ResourceTransformationArgs,
): ResourceTransformationResult | undefined {
  const { type, name } = component;

  // Ensure component names do not contain spaces
  if (name.includes(" "))
    throw new Error(
      `Invalid component name "${name}" (${args.type}). Component names cannot contain spaces.`,
    );

  // Ensure names are prefixed with parent's name
  if (
    args.type !== type &&
    // @ts-expect-error
    !args.name.startsWith(args.opts.parent!.__name)
  ) {
    throw new Error(
      `In "${name}" component, the logical name of "${args.name}" (${
        args.type
      }) is not prefixed with parent's name ${
        // @ts-expect-error
        args.opts.parent!.__name
      }`,
    );
  }

  // Ensure physical names are prefixed with app/stage
  // note: We are setting the default names here instead of inline when creating
  //       the resource is b/c the physical name is inferred from the logical name.
  //       And it's convenient to access the logical name here.
  if (args.type.startsWith("sst:")) return;
  if (UNPREFIXED_TYPES.has(args.type)) return;
  // A resource that's looked up has the name it has
  if (args.opts.id !== undefined) return;

  const custom = CustomNamingRules.get(args.type);
  if (custom === false) return;
  const rule: BuiltInNamingRule | undefined = custom
    ? [custom.field, custom.max, custom]
    : NAMING_RULES[args.type];
  if (!rule) {
    // Built-in components have to say how each of their resources is named.
    // Other components can use resource types SST doesn't know; those are
    // left to the provider's own naming.
    if (!type.startsWith("sst:")) return;
    throw new VisibleError(
      `In "${name}" component, the physical name of "${args.name}" (${args.type}) is not prefixed`,
    );
  }

  // name is already set
  const [nameField, length, options = {}] = rule;
  if (args.props[nameField] && args.props[nameField] !== "") return;

  // Handle prefix field is tags
  if (nameField === "tags") {
    return {
      props: {
        ...args.props,
        tags: {
          // @ts-expect-error
          ...args.tags,
          Name: prefixName(length, args.name),
        },
      },
      opts: args.opts,
    };
  }

  // Handle prefix field is name
  const suffix = options.suffix ? options.suffix(args.props) : output("");
  return {
    props: {
      ...args.props,
      [nameField]: suffix.apply((suffix) => {
        let v = options.lower
          ? physicalName(length, args.name, suffix).toLowerCase()
          : physicalName(length, args.name, suffix);
        if (options.replace) v = options.replace(v);
        return v;
      }),
    },
    opts: {
      ...args.opts,
      ignoreChanges: [...(args.opts.ignoreChanges ?? []), nameField],
    },
  };
}
