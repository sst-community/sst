import {
  type Input,
  ComponentResource,
  type Resource,
  all,
} from "@pulumi/pulumi";
import { rpc } from "./rpc/rpc";
import { perRun } from "../util/lazy";
import { VisibleError } from "./error";
import { takenOverTypes, versionedTypes } from "./takeover";

/**
 * A part of a component that the component's state map says something about,
 * as the core reads it while the stage moves (`pkg/move`): new, replaced, or
 * in the place of what's released.
 *
 * @internal
 */
export interface MovedPart {
  /** The component's address and type. */
  component: string;
  type: string;
  /** The part's key, and its id for a part the component has several of. */
  key: string;
  id?: string;
  /** The part's address. */
  urn: string;
  added?: boolean;
  /** What changes for the user when it's replaced. */
  replaced?: string;
  /**
   * The addresses of the resources it takes the place of, and the others
   * each can be at.
   */
  releases?: string[];
}

/**
 * Whether the program runs as the stage moves to new components: for
 * `sst migrate`, or `sst migrate --check`.
 *
 * @internal
 */
export function moving() {
  return typeof $cli !== "undefined" && $cli.move === true;
}

/**
 * The type of the marker that says a stage is on SST 5's components. It also
 * lists the version of each component the stage has, which the record of a
 * deploy that finished takes the place of. The core refuses to deploy a stage
 * that has something deployed and no marker, except with `sst migrate`
 * (`pkg/project/moved.go`).
 *
 * @internal
 */
export const movedMarker = "sst:sst:Moved";

/**
 * The type of the record of the version of each component the stage has, left
 * by every deploy once all it deployed is deployed.
 *
 * @internal
 */
export const versionsRecord = "sst:sst:Versions";

/**
 * Whether the stage has moved to SST 5's components: its state has the marker.
 *
 * @internal
 */
export function stageMoved() {
  return typeof $cli !== "undefined" && $cli.state?.moved === true;
}

// Whether nothing is deployed on the stage
function stageEmpty() {
  return typeof $cli !== "undefined" && $cli.state?.empty === true;
}

// The types of the components the stage has, or `undefined` when the core
// didn't say, as under a mock that wasn't given a state; and those it has only
// inside SST's components, which move with those
const stageTypes = perRun((): Set<string> | undefined =>
  typeof $cli === "undefined" || !$cli.state?.types
    ? undefined
    : new Set($cli.state.types),
);
const nestedTypes = perRun(
  (): Set<string> =>
    new Set(typeof $cli === "undefined" ? [] : ($cli.state?.nested ?? [])),
);

function stageHas(type: string, nested = false) {
  const types = stageTypes();
  if (!types) return true;
  return types.has(type) || (nested && nestedTypes().has(type));
}

// The version of each component the marker lists, by type. A marker written
// before components had versions listed only their types.
function listedVersions(): Record<string, number> {
  const listed =
    typeof $cli === "undefined" ? undefined : $cli.state?.components;
  if (Array.isArray(listed))
    return Object.fromEntries(listed.map((type) => [type, 1]));
  return listed ?? {};
}

/**
 * The version of a component the stage has as this run starts, by its type:
 * `undefined` when it has none of it, as on a new stage, and 0 for its form
 * before SST 5, as on a stage SST 4 deployed. On a stage that has moved, it's
 * what the last deploy that finished recorded. One it didn't record is in its
 * form before SST 5 when it has one: it gained a 5.0 form after the stage
 * moved, and switching it is a move. Otherwise no deploy that finished
 * created it, as when the stage's first one failed, so it's at the code's.
 *
 * @param formerType The type of its form before SST 5, when that's another.
 * @param nested Whether it's inside one of SST's components.
 * @param version The code's version of it.
 * @internal
 */
export function stageVersionOf(
  type: string,
  formerType?: string,
  nested = false,
  version?: number,
): number | undefined {
  if (stageEmpty()) return undefined;
  if (!stageHas(type, nested))
    return formerType && formerType !== type && stageHas(formerType, nested)
      ? 0
      : undefined;
  if (!stageMoved()) return 0;
  return (
    listedVersions()[type] ?? (takenOverTypes().has(type) ? 0 : (version ?? 1))
  );
}

// What this run has seen and done: the types of the SST 4 components it
// created that have a 5.0 form, the versions the marker it left lists, and
// the version of each component it created, with the components at the top
// of the app, which a record of them waits for
const run = perRun(() => ({
  oldForms: new Set<string>(),
  newForms: new Set<string>(),
  left: undefined as Map<string, number> | undefined,
  created: new Map<string, number>(),
  components: [] as Resource[],
}));

// Whether this run deploys, or shows what a deploy would do, so a component
// the stage has at another version than its own is refused. A refresh and a
// remove run whatever the versions.
function deploys() {
  return (
    typeof $cli !== "undefined" &&
    ($cli.command === "deploy" || $cli.command === "diff")
  );
}

// A move switches all of a component at once. One that kept some in SST 4's
// form would list none of them as moved, and a later deploy could switch the
// others back without a move, deleting what their 5.0 form wrote.
function splitError(name: string, form: string, type: string) {
  const className = type.replaceAll(":", ".");
  return new VisibleError(
    form === "old"
      ? `"${name}" is SST 4's ${className}, and this move switches others to their 5.0 form. A move switches all of a component at once: use its 5.0 form.`
      : `"${name}" is SST 5's ${className}, and this move keeps others in SST 4's form. A move switches all of a component at once: use the 5.0 form for each.`,
  );
}

/**
 * Note a component created in its SST 4 form when it has a 5.0 form. It's
 * refused on a stage that has that component in its 5.0 form, or a new one:
 * deploying it where the 5.0 form was would delete what that wrote, like a
 * site's files, and a new stage starts on SST 5's components.
 *
 * @internal
 */
export function oldFormCreated(type: string, name: string) {
  const className = type.replaceAll(":", ".");
  const version = stageVersionOf(type);
  if (
    stageEmpty() ||
    (stageMoved() && (version === undefined || version >= 1)) ||
    run().left?.has(type)
  )
    throw new VisibleError(
      stageEmpty()
        ? `"${name}" is SST 4's ${className}. A new stage starts on SST 5's components: use its 5.0 form.`
        : `"${name}" is SST 4's ${className}, and this stage has moved to its 5.0 form. Use the 5.0 form: a stage doesn't go back to SST 4's components by a deploy.`,
    );
  if (moving() && run().newForms.has(type)) throw splitError(name, "old", type);
  run().oldForms.add(type);
}

/**
 * Note a component created at a version its maps take it to, which takes over
 * from components of `from` before SST 5. Outside a move, a deploy refuses it
 * on a stage that has it at another version: still in its SST 4 form, or at
 * an earlier version, getting there is a move, which applies the maps in
 * between, checked, and releases what they can't carry over; and at a later
 * one, the stage was deployed with newer code.
 *
 * @internal
 */
export function newFormCreated(
  from: string,
  type: string,
  name: string,
  version: number,
) {
  const className = type.replaceAll(":", ".");
  const ahead = (has: number) =>
    new VisibleError(
      `"${name}" is version ${version} of ${className}, and this stage has version ${has}, from newer code. Deploy it with code that has version ${has} or later: a stage doesn't go back to an earlier version by a deploy.`,
    );
  if (moving()) {
    if (run().oldForms.has(from)) throw splitError(name, "new", from);
    const has = stageVersionOf(type, from, false, version);
    if (has !== undefined && has > version) throw ahead(has);
    run().newForms.add(from);
    return;
  }
  if (!stageMoved() || !deploys()) return;
  const has = stageVersionOf(type, from, false, version);
  if (has === undefined || has === version) return;
  if (has === 0)
    throw new VisibleError(
      `"${name}" is SST 5's ${className}, and this stage still has SST 4's ${from.replaceAll(
        ":",
        ".",
      )}. Switching to it is a move: \`sst migrate --check\` shows what it does, and \`sst migrate\` makes it.`,
    );
  if (has < version)
    throw new VisibleError(
      `"${name}" is version ${version} of ${className}, and this stage has version ${has}. Moving it to version ${version} is a move: \`sst migrate --check\` shows what it does, and \`sst migrate\` makes it.`,
    );
  throw ahead(has);
}

/**
 * Note a component this run created, at its version, for the record of them.
 * One at the top of the app is also what the record waits for; those inside
 * it come with it.
 *
 * @internal
 */
export function noteCreated(
  type: string,
  version: number,
  component: Resource,
  nested: boolean,
) {
  const { created, components } = run();
  created.set(type, Math.max(created.get(type) ?? 0, version));
  if (!nested) components.push(component);
}

/**
 * The version a component's maps apply from in this run: the one the stage
 * has it at, when that's earlier than its own. \`undefined\` when there's
 * nothing to take over: the stage has none of it, or has it at this version.
 *
 * @internal
 */
export function mapsFrom(
  type: string,
  version: number,
  formerType?: string,
  nested = false,
): number | undefined {
  const has = stageVersionOf(type, formerType, nested, version);
  return has === undefined || has >= version ? undefined : has;
}

/**
 * Leave the marker that says the stage is on SST 5's components. A run on a
 * stage that has moved, or a new one, leaves it before the app's program
 * runs, so a deploy that fails partway keeps it, with the version of each
 * component the stage has; one it has none of is at its own version once it's
 * created. A move leaves it once everything it deployed is deployed, so a
 * move that fails partway leaves the stage to be moved again. A deploy that
 * doesn't leave it takes it out of the state.
 *
 * @internal
 */
export function leaveMarker(when: "before" | "after") {
  let versions: Map<string, number> | undefined;
  if (when === "before" && !moving() && (stageMoved() || stageEmpty())) {
    versions = new Map();
    const listed = listedVersions();
    for (const [type, version] of versionedTypes())
      if (stageEmpty() || !stageHas(type, true)) versions.set(type, version);
    if (!stageEmpty())
      for (const [type, version] of Object.entries(listed))
        if (stageHas(type, true)) versions.set(type, version);
  }
  if (when === "after" && moving()) versions = createdVersions();
  if (!versions) return undefined;
  run().left = versions;
  new Moved(
    Object.fromEntries([...versions].sort()),
    when === "after" ? run().components : [],
  );
  return versions;
}

/**
 * Leave the record of the version of each component this run created, once
 * everything it deployed is deployed: a deploy that fails partway leaves the
 * one before, so what it didn't get to is still behind, and moved by the next
 * move. Left on a stage on SST 5's components, a new one, and in a move, after
 * the program has run, so it has what an app or a package registered as it
 * ran.
 *
 * @internal
 */
export function recordVersions() {
  if (!moving() && !stageMoved() && !stageEmpty()) return undefined;
  const versions = createdVersions();
  new Versions(Object.fromEntries([...versions].sort()), run().components);
  return versions;
}

// Every component with a 5.0 form at its version, but one this run kept in
// SST 4's form, and what else it created at its version, as an app's own
// component, whose map may be registered as the program runs. One created
// later, inside an \`apply\`, is listed so already. SST 4's form is version 0,
// which is what a stage has of one when nothing's listed.
function createdVersions() {
  const versions = new Map(
    [...versionedTypes()].filter(([type]) => !run().oldForms.has(type)),
  );
  for (const [type, version] of run().created)
    if (version >= 1) versions.set(type, version);
  return versions;
}

// The marker, which lists the version of each component in its outputs
class Moved extends ComponentResource {
  constructor(components: Record<string, number>, dependsOn: Resource[]) {
    super(movedMarker, "Moved", {}, { dependsOn });
    this.registerOutputs({ components });
  }
}

// The record, which lists the version of each component in its outputs
class Versions extends ComponentResource {
  constructor(components: Record<string, number>, dependsOn: Resource[]) {
    super(versionsRecord, "Versions", {}, { dependsOn });
    this.registerOutputs({ components });
  }
}

/**
 * Tell the core about a part, once its address and those of what it releases
 * are known. An address is known in a preview too.
 *
 * @internal
 */
export function reportPart(
  part: Omit<MovedPart, "component" | "urn" | "releases"> & {
    component: Input<string>;
    urn: Input<string>;
    /** For each resource it releases, the addresses it can be at. */
    releases?: Input<string[]>[];
  },
) {
  const { component, urn, releases, ...rest } = part;
  all([component, urn, all(releases ?? [])]).apply(
    ([component, urn, releases]) =>
      rpc.call("Move.Part", {
        ...rest,
        component,
        urn,
        ...(releases.length ? { releases: releases.flat() } : {}),
      } satisfies MovedPart),
  );
}
