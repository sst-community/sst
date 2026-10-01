import { Input, Resource, interpolate } from "@pulumi/pulumi";
import type { OldAddress } from "../../takeover";

/**
 * The old address of a resource that 4.x kept in a component of its own,
 * next to the one it belongs to now. A subscription was kept this way: in a
 * subscriber component beside the queue or topic it subscribes to.
 *
 * @param type The type of the component it was in.
 * @param component The name of the component it was in.
 * @param child What the resource was called inside it, added to that name.
 * @param beside The component that one was created next to, when 4.x gave it
 * that component's parent. Leave it out when 4.x always created it at the top
 * of the app.
 */
export function childOf(
  type: string,
  component: Input<string>,
  child: string,
  beside?: Resource,
): OldAddress {
  return {
    parent: { type, name: component, beside },
    name: interpolate`${component}${child}`,
  };
}
