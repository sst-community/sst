import { Input, Output, Resource, output } from "@pulumi/pulumi";
import { ec2 } from "@pulumi/aws";
import { knownValue } from "../../args";
import { VisibleError } from "../../error";
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
 * A VPC's private subnets, each by the key a resource made for it is kept
 * under, one in each AZ:
 *
 * - For a `Vpc` the app creates, the AZ's number, as the VPC keeps its own
 *   subnets. A V5 `Vpc` gives them as the program runs; a 4.x one, which made
 *   its subnets in the order of its AZs, once a preview knows them. Either
 *   way the keys are the same, so switching the `Vpc` keeps what's made.
 * - For a `Vpc` from `get`, the AZ's name, since its lookup keeps no order,
 *   as `subnetsByAz()` finds it.
 *
 * A promise resolves to `undefined` while a preview doesn't know the subnets.
 * Each subnet is an output of its own, so what's made with it depends on it.
 *
 * @param parent What the lookups are made for.
 * @param what What the subnets are for, for the error messages: `the "MyEfs"
 * EFS component`.
 */
export function privateSubnetsOf(
  vpc: AnyVpc,
  parent: Resource,
  what: string,
):
  | Record<string, Output<string>>
  | Promise<Record<string, Output<string>> | undefined> {
  if (vpc instanceof Vpc && vpc.privateSubnetsByAz)
    return vpc.privateSubnetsByAz;
  if (vpc instanceof OriginalVpc && !vpc.isReferenced)
    return knownValue(vpc.nodes.privateSubnets).then(
      (subnets) =>
        subnets &&
        Object.fromEntries(subnets.map((subnet, i) => [`${i + 1}`, subnet.id])),
    );
  return subnetsByAz(subnetsOf(vpc, "private"), parent, what);
}

/**
 * Subnets by the name of the AZ each is in, looked up once a preview knows
 * their ids, or `undefined` while it doesn't. Two subnets in one AZ are
 * refused. Each subnet is an output of the list's, so what's made with it
 * still depends on what made the list.
 *
 * @param parent What the lookups are made for.
 * @param what What the subnets are for, for the error messages.
 */
export function subnetsByAz(
  subnets: Output<string[]>,
  parent: Resource,
  what: string,
): Promise<Record<string, Output<string>> | undefined> {
  return knownValue(subnets).then(async (ids) => {
    if (!ids) return undefined;
    const zones = await Promise.all(
      ids.map((id) =>
        ec2
          .getSubnet({ id }, { parent })
          .then((subnet) => subnet.availabilityZone),
      ),
    );
    const byAz: Record<string, Output<string>> = {};
    const seen: Record<string, string> = {};
    zones.forEach((az, i) => {
      if (seen[az])
        throw new VisibleError(
          `Two of the subnets of ${what} are in "${az}": "${seen[az]}" and "${ids[i]}". What's made for each subnet is kept by its AZ, so there can be one in each.`,
        );
      seen[az] = ids[i];
      byAz[az] = subnets.apply((list) => list[i]);
    });
    return byAz;
  });
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
