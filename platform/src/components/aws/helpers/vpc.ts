import { Input, Output, output } from "@pulumi/pulumi";
import { Vpc as OriginalVpc } from "../vpc";
import { Vpc } from "../v5/vpc";

/**
 * A `Vpc` component: the 4.x one or the V5 one. Every V5 component that takes
 * a VPC takes either. They read its `id`, `publicSubnets`, `privateSubnets`,
 * `securityGroups`, `nodes.vpc` and `nodes.cloudmapNamespace`, which the two
 * give alike, and whether it has a NAT with `hasNat()`.
 */
export type AnyVpc = OriginalVpc | Vpc;

/** Whether a `vpc` arg is a `Vpc` component, and not the ids of a VPC. */
export function isVpc(vpc: unknown): vpc is AnyVpc {
  return vpc instanceof OriginalVpc || vpc instanceof Vpc;
}

/** The ids of a VPC's public or private subnets, from either kind of `Vpc`. */
export function subnetsOf(
  vpc: AnyVpc,
  kind: "public" | "private",
): Output<string[]> {
  const ids: Input<Input<string>[]> =
    kind === "public" ? vpc.publicSubnets : vpc.privateSubnets;
  return output(ids);
}

/**
 * Whether a VPC's private subnets reach the internet through a NAT.
 * `undefined` when that isn't known, as for a V5 `Vpc` that's referenced.
 */
export function hasNat(vpc: AnyVpc): Output<boolean | undefined> {
  if (vpc instanceof Vpc) return output(vpc.hasNat);
  return output([vpc.nodes.natGateways, vpc.nodes.natInstances]).apply(
    ([natGateways, natInstances]) =>
      natGateways.length > 0 || natInstances.length > 0,
  );
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
