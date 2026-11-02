import { type Input, ComponentResource, all } from "@pulumi/pulumi";
import { rpc } from "./rpc/rpc";
import { perRun } from "../util/lazy";
import { VisibleError } from "./error";

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
 * The type of the marker that says a stage is on SST 5's components. The core
 * refuses to deploy a stage that has something deployed and no marker, except
 * with `sst migrate` (`pkg/project/moved.go`).
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

/**
 * Whether the stage is on SST 5's components, outside a move: it has moved,
 * or it's new.
 *
 * @internal
 */
export function onSst5() {
  if (typeof $cli === "undefined" || moving()) return false;
  return $cli.state?.moved === true || $cli.state?.empty === true;
}

// The SST 4 components this run created that have a 5.0 form
const oldForms = perRun(() => [] as string[]);

/**
 * Note a component created in its SST 4 form when it has a 5.0 form. It's
 * refused on a stage that's on SST 5's components: a new one, which can only
 * start on them, or one that has moved, whose state has the 5.0 form, which
 * deploying the 4.x one would delete what it wrote, like a site's files.
 *
 * @internal
 */
export function oldFormCreated(type: string, name: string) {
  if (stageMoved() || onSst5())
    throw new VisibleError(
      `"${name}" is SST 4's ${type.replaceAll(
        ":",
        ".",
      )}, and this stage is on SST 5's components. Use its 5.0 form.` +
        (stageMoved()
          ? " A stage that has moved doesn't go back to SST 4's components by a deploy."
          : ""),
    );
  oldForms().push(name);
}

/**
 * Leave the marker in the state. A run on a stage that's on SST 5's
 * components leaves it before the app's program runs, so a deploy that fails
 * partway still has it; a move, once the program has run, when no component
 * is left in its SST 4 form while it has a 5.0 one. A stage that keeps one
 * hasn't moved, and only `sst migrate` deploys it. A deploy that doesn't
 * leave the marker takes it out of the state.
 *
 * @internal
 */
export function leaveMarker(when: "before" | "after") {
  const leaves =
    when === "before" ? onSst5() : moving() && oldForms().length === 0;
  if (leaves) new ComponentResource(movedMarker, "Moved", {}, {});
  return leaves;
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
