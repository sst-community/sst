import { output, runtime, type Inputs } from "@pulumi/pulumi";
import { VisibleError } from "./error";

/**
 * What a check is given in place of a value that isn't known yet, in a
 * preview. A check that needs the value reports it, or leaves it to the
 * deploy, where it's known.
 */
export const unknown: unique symbol = Symbol.for("sst.check.unknown");

/** What a check found. */
export interface Finding {
  /** What's wrong. */
  message: string;
  /** How to fix it. */
  fix?: string;
}

/** What a check returns: nothing when all is well, or what it found. */
export type Found =
  | void
  | undefined
  | null
  | string
  | Finding
  | (string | Finding)[];

/** A component, with the args it was given. */
export interface CheckedComponent {
  type: string;
  name: string;
  /** Its args as given, after `$transform`. A value can be an output. */
  args: Record<string, unknown>;
}

/** A resource, with its inputs. */
export interface CheckedResource {
  type: string;
  name: string;
  /** Its inputs, resolved. One that isn't known yet is {@link unknown}. */
  props: Record<string, unknown>;
}

/** A provider function the program calls, like `aws.getRegion()`. */
export interface CheckedInvoke {
  token: string;
  /** What it's given, resolved. One that isn't known yet is {@link unknown}. */
  args: Record<string, unknown>;
}

/**
 * A check, from {@link check}: what it looks at, and what it finds.
 */
export interface Check {
  /** The check's name, which its findings are shown with. */
  name: string;
  /** Looks at each component, SST's or an app's, with its args. */
  component?(component: CheckedComponent): Found;
  /** Looks at each resource, with its inputs. */
  resource?(resource: CheckedResource): Found | Promise<Found>;
  /** Looks at each provider function the program calls. */
  invoke?(invoke: CheckedInvoke): Found | Promise<Found>;
}

const checks: Check[] = [];
let installed = false;
// Whether a component was created before any check was turned on
let componentsBefore = false;

/**
 * Turn a check on for the program it runs in: it looks at each component,
 * resource and provider function the program has, and what it finds stops the
 * deploy. A package exports a function that calls this, which an app calls
 * in `run()`.
 *
 * On a stage whose program has checks, a deploy runs a preview first, so a
 * finding stops it before anything changes. A value that isn't known in the
 * preview is checked again in the deploy, once it is.
 *
 * @example
 * ```ts title="sst.config.ts"
 * sst.check({
 *   name: "no-public-buckets",
 *   resource(r) {
 *     if (r.type === "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock" &&
 *         r.props.blockPublicPolicy === false)
 *       return { message: `${r.name} allows a public policy`, fix: "Leave the bucket private." };
 *   },
 * });
 * ```
 */
export function check(definition: Check): Check {
  if (!definition?.name)
    throw new VisibleError(
      `A check needs a "name", which its findings are shown with.`,
    );
  if (checks.length === 0 && componentsBefore)
    throw new VisibleError(
      `The "${definition.name}" check is turned on after a component was created, which it wouldn't see. Turn checks on at the top of run(), before any component.`,
    );
  if (!checks.includes(definition)) checks.push(definition);
  install();
  // A deploy with no preview first could stop at a finding with half its
  // changes made. It stops here instead, before anything is registered, and
  // the CLI runs it again with a preview first. pkg/project/run.go looks for
  // this message.
  if (
    typeof $cli !== "undefined" &&
    $cli.command === "deploy" &&
    process.env.SST_PREVIEW_FIRST !== "1"
  )
    throw new VisibleError(
      `This stage's program has checks, so its deploys run a preview first. Turn them on at the top of run(), before any component.`,
    );
  return definition;
}

/**
 * The names of the checks the program has. They're kept with the stage's
 * state, so the next deploy knows to run a preview first.
 *
 * @internal
 */
export function checkNames() {
  return checks.map((c) => c.name);
}

/**
 * Checks a component when it's created.
 *
 * @internal
 */
export function checkComponent(type: string, name: string, args?: Inputs) {
  if (checks.length === 0) componentsBefore = true;
  for (const c of checks) {
    if (!c.component) continue;
    stop(
      c,
      `the ${type} "${name}"`,
      c.component({ type, name, args: args ?? {} }),
    );
  }
}

/**
 * Checks a resource before it's registered, with its inputs resolved.
 *
 * @internal
 */
export async function checkResource(type: string, name: string, props: Inputs) {
  if (!checks.some((c) => c.resource)) return;
  const resolved = await resolve(props);
  for (const c of checks) {
    if (!c.resource) continue;
    stop(
      c,
      `the ${type} "${name}"`,
      await c.resource({ type, name, props: resolved }),
    );
  }
}

/**
 * Checks a call to a provider function, with what it's given resolved.
 *
 * @internal
 */
export async function checkInvoke(token: string, args: Inputs) {
  if (!checks.some((c) => c.invoke)) return;
  const resolved = await resolve(args);
  for (const c of checks) {
    if (!c.invoke) continue;
    stop(c, `the call to ${token}`, await c.invoke({ token, args: resolved }));
  }
}

function install() {
  if (installed) return;
  installed = true;
  // Under vitest the engine is the mock, which calls checkResource itself
  if (process.env.VITEST) return;
  runtime.registerResourceTransform(async (args) => {
    // A component's own args are checked when it's created
    if (args.custom) await checkResource(args.type, args.name, args.props);
    return undefined;
  });
  runtime.registerInvokeTransform(async (args) => {
    await checkInvoke(args.token, args.args);
    return undefined;
  });
}

// What's given, resolved, with each value that isn't known yet as `unknown`
async function resolve(value: Inputs): Promise<Record<string, unknown>> {
  const resolved = await (output(value) as any).promise(true);
  return markUnknowns(resolved ?? {}) as Record<string, unknown>;
}

// Pulumi's own mark of a value that isn't known yet. It's read by its field,
// as Pulumi does, since a deep import of its module fails in the program.
function isUnknown(value: unknown) {
  return (value as { __pulumiUnknown?: boolean })?.__pulumiUnknown === true;
}

// How Pulumi marks a secret and an unknown value on the wire, as the mock
// passes them on
const SECRET = "4dabf18193072939515e22adb298388d";
const UNKNOWN_STRING = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

/** @internal */
export function markUnknowns(value: unknown): unknown {
  if (isUnknown(value) || value === UNKNOWN_STRING) return unknown;
  // A secret is checked as its value
  if (
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[SECRET] ===
      "1b47061264138c4ac30d75fd1eb44270"
  )
    return markUnknowns((value as { value?: unknown }).value);
  if (Array.isArray(value)) return value.map(markUnknowns);
  if (value && typeof value === "object" && value.constructor === Object)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, markUnknowns(v)]),
    );
  return value;
}

// A finding stops the program, with what was found and how to fix it
function stop(c: Check, what: string, found: Found) {
  const findings = (Array.isArray(found) ? found : [found])
    .filter((f): f is string | Finding => Boolean(f))
    .map((f) => (typeof f === "string" ? { message: f } : f));
  if (findings.length === 0) return;
  throw new VisibleError(
    [
      `The "${c.name}" check found a problem with ${what}:`,
      ...findings.map((f) => `- ${f.message}${f.fix ? `\n  ${f.fix}` : ""}`),
    ].join("\n"),
  );
}

/**
 * Turns every check off. For tests.
 *
 * @internal
 */
export function resetChecks() {
  checks.length = 0;
  componentsBefore = false;
}
