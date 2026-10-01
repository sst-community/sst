import { Vpc as OriginalVpc } from "../vpc";

/**
 * A `Vpc` component. Today that's the 4.x `Vpc`. When it's ported, the V5 one
 * is added here and to `isVpc()`, and every V5 component that takes a VPC
 * takes either. They read its `id`, `publicSubnets`, `privateSubnets`,
 * `securityGroups`, `nodes.vpc` and `nodes.cloudmapNamespace`.
 */
export type AnyVpc = OriginalVpc;

/** Whether a `vpc` arg is a `Vpc` component, and not the ids of a VPC. */
export function isVpc(vpc: unknown): vpc is AnyVpc {
  return vpc instanceof OriginalVpc;
}

// The args of a component that takes a VPC, with a `vpc` that can be either
// kind of `Vpc`:
//
//   interface RedisArgs extends V5Args<TakesVpc<OriginalRedisArgs>, typeof parts> {}
//
// (Not a doc comment: an interface that extends this would show it as its own
// description in the generated docs.)
export type TakesVpc<Args> = {
  [K in keyof Args]: K extends "vpc"
    ? AnyVpc | Exclude<Args[K], OriginalVpc>
    : Args[K];
};
