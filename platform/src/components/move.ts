import { type Input, all } from "@pulumi/pulumi";
import { rpc } from "./rpc/rpc";

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
  /** The addresses of the resources it takes the place of. */
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
 * Tell the core about a part, once its address and those of what it releases
 * are known. An address is known in a preview too.
 *
 * @internal
 */
export function reportPart(
  part: Omit<MovedPart, "component" | "urn" | "releases"> & {
    component: Input<string>;
    urn: Input<string>;
    releases?: Input<string>[];
  },
) {
  const { component, urn, releases, ...rest } = part;
  all([component, urn, all(releases ?? [])]).apply(
    ([component, urn, releases]) =>
      rpc.call("Move.Part", {
        ...rest,
        component,
        urn,
        ...(releases.length ? { releases } : {}),
      } satisfies MovedPart),
  );
}
