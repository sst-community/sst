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

/**
 * The old address of a resource that 4.x kept in a component of its own,
 * inside the component it belongs to now. A 4.x site kept its warmer this way:
 * in a `Cron` inside the site.
 *
 * @param type The type of the component it was in.
 * @param component The name of the component it was in.
 * @param child What the resource was called inside it, added to that name.
 * @param owner The component it belongs to now, which that one was in.
 */
export function childWithin(
  type: string,
  component: Input<string>,
  child: string,
  owner: Resource,
): OldAddress {
  return {
    parent: { type, name: component, within: owner },
    name: interpolate`${component}${child}`,
  };
}

/**
 * The old addresses of the function a 4.x subscriber component created. It was
 * named after the component with `Function` added, and later after the
 * component alone, with an alias to the first name. A stage has whichever the
 * 4.x it last deployed with used, and the function's own resources are named
 * after it.
 *
 * Pulumi takes the first address it finds. Two subscribers whose names differ
 * by a `Function` at the end, like `Foo` and `FooFunction`, have the same
 * address, one in each naming, so the later naming is looked for first. 4.x
 * itself fails on such a pair on a stage deployed before the rename.
 *
 * @param type The type of the subscriber component.
 * @param component The name of the subscriber component.
 * @param beside The component the subscriber component was created next to,
 * when 4.x gave it that component's parent.
 */
export function subscriberFunction(
  type: string,
  component: Input<string>,
  beside?: Resource,
): OldAddress[] {
  return [
    childOf(type, component, "", beside),
    childOf(type, component, "Function", beside),
  ];
}
