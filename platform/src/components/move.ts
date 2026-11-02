import { type Input, ComponentResource, all } from "@pulumi/pulumi";
import { rpc } from "./rpc/rpc";
import { perRun } from "../util/lazy";
import { VisibleError } from "./error";
import { takenOverTypes } from "./takeover";

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
 * The type of the marker that says a stage is on SST 5's components, and
 * which components it has in their 5.0 form. The core refuses to deploy a
 * stage that has something deployed and no marker, except with `sst migrate`
 * (`pkg/project/moved.go`).
 *
 * @internal
 */
export const movedMarker = "sst:sst:Moved";

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

/**
 * The types of the components the stage has in their 5.0 form as this run
 * starts. A new stage starts with every component that has one. On a stage
 * that has moved, they're those the marker lists, and those the stage has
 * none of: a component that has gained a 5.0 form since the stage moved, and
 * that the stage has, is still in its SST 4 form, and switching it is a move.
 * A stage that hasn't moved has none.
 *
 * @internal
 */
export const movedTypes = perRun((): Set<string> => {
  if (stageEmpty()) return takenOverTypes();
  if (!stageMoved()) return new Set();
  const has = new Set($cli.state.types ?? []);
  return new Set([
    ...($cli.state.components ?? []),
    ...[...takenOverTypes()].filter((type) => !has.has(type)),
  ]);
});

// What this run has seen and done: the types of the SST 4 components it
// created that have a 5.0 form, and those the marker it left lists
const run = perRun(() => ({
  oldForms: new Set<string>(),
  newForms: new Set<string>(),
  left: undefined as Set<string> | undefined,
}));

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
  if (movedTypes().has(type) || run().left?.has(type))
    throw new VisibleError(
      stageEmpty()
        ? `"${name}" is SST 4's ${className}. A new stage starts on SST 5's components: use its 5.0 form.`
        : `"${name}" is SST 4's ${className}, and this stage has moved to its 5.0 form. Use the 5.0 form: a stage doesn't go back to SST 4's components by a deploy.`,
    );
  if (moving() && run().newForms.has(type)) throw splitError(name, "old", type);
  run().oldForms.add(type);
}

/**
 * Note a component created in its 5.0 form, which takes over from components
 * of `from`. Outside a move, it's refused on a stage that has moved but still
 * has those in their SST 4 form: switching one is a move, which releases what
 * it can't carry over.
 *
 * @internal
 */
export function newFormCreated(from: string, type: string, name: string) {
  if (moving()) {
    if (run().oldForms.has(from)) throw splitError(name, "new", from);
    run().newForms.add(from);
    return;
  }
  if (!stageMoved() || movedTypes().has(from)) return;
  throw new VisibleError(
    `"${name}" is SST 5's ${type.replaceAll(
      ":",
      ".",
    )}, and this stage still has SST 4's ${from.replaceAll(
      ":",
      ".",
    )}. Switching to it is a move: \`sst migrate --check\` shows what it does, and \`sst migrate\` makes it.`,
  );
}

/**
 * Leave the marker in the state, with the types of the components the stage
 * has in their 5.0 form. A run on a stage that has moved, or a new one,
 * leaves it before the app's program runs, so a deploy that fails partway
 * keeps it. A move leaves it once the program has run, with every component
 * that has a 5.0 form but those it kept in their SST 4 form, which a later
 * move switches. A deploy that doesn't leave it takes it out of the state.
 *
 * @internal
 */
export function leaveMarker(when: "before" | "after") {
  let components: Set<string> | undefined;
  if (when === "before" && !moving() && (stageMoved() || stageEmpty()))
    components = movedTypes();
  if (when === "after" && moving())
    components = new Set(
      [...takenOverTypes()].filter((type) => !run().oldForms.has(type)),
    );
  if (!components) return undefined;
  run().left = components;
  new Moved([...components].sort());
  return components;
}

// The marker, which lists the types in its outputs
class Moved extends ComponentResource {
  constructor(components: string[]) {
    super(movedMarker, "Moved", {}, {});
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
