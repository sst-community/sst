import { Input, Output, Resource, all, output } from "@pulumi/pulumi";
import { ec2 } from "@pulumi/aws";
import { knownValue } from "../../args";
import { VisibleError } from "../../error";
import { warnOnce } from "../../../util/warn";
import { Vpc } from "../vpc";

/**
 * A `Vpc` component. Every component that takes a VPC reads its `id`,
 * `publicSubnets`, `privateSubnets`, `securityGroups`, `nodes.vpc` and
 * `nodes.cloudmapNamespace`, and whether it has a NAT with `hasNat()`.
 */
export type AnyVpc = Vpc;

/** Whether a `vpc` arg is a `Vpc` component, and not the ids of a VPC. */
export function isVpc(vpc: unknown): vpc is AnyVpc {
  return vpc instanceof Vpc;
}

/**
 * Refuse a resource in place of a VPC's ids, in a `vpc` arg that isn't a
 * `Vpc`. Another resource, like a `Vpc.v1` or an `aws.ec2.Vpc`, would
 * otherwise be read as the ids.
 *
 * @param what The component, for the error: `the "MyCluster" cluster`.
 */
export function assertVpcIds(vpc: unknown, what: string) {
  if (Resource.isInstance(vpc))
    throw new VisibleError(
      `The "vpc" of ${what} isn't a "Vpc" component. Pass a "Vpc", or the ids of a VPC.`,
    );
}

/**
 * The subnets and security groups a component in a VPC is put in: a `Vpc`'s
 * private subnets and its security groups, or the ids it was given. For a
 * `Vpc`, each is an output of its own, so what takes only the subnets doesn't
 * wait for the security groups.
 *
 * @param what The component, for the error: `the "MyCluster" cluster`.
 */
export function subnetsAndSecurityGroupsOf(
  vpc:
    | AnyVpc
    | Input<{
        subnets: Input<Input<string>[]>;
        securityGroups: Input<Input<string>[]>;
      }>,
  what: string,
) {
  if (isVpc(vpc)) {
    // Inputs, as `Vpc` types them
    const securityGroups: Input<Input<string>[]> = vpc.securityGroups;
    return {
      subnets: subnetsOf(vpc, "private"),
      securityGroups: output(securityGroups),
    };
  }
  assertVpcIds(vpc, what);
  const ids = output(vpc);
  return { subnets: ids.subnets, securityGroups: ids.securityGroups };
}

/**
 * The private subnets and security groups that a Lambda function, or what
 * Lambda runs like one, sends its traffic through: a `Vpc`'s, or the ids it's
 * given. For a `Vpc` with no NAT, what's in its private subnets can't reach
 * the internet, so that's a warning, given once.
 *
 * @param what The component, for the errors: `the "MyFunction" function`.
 * @param noNat The warning for a `Vpc` with no NAT, given the VPC's id.
 */
export function privateNetworkOf(
  vpc:
    | AnyVpc
    | Input<{
        privateSubnets: Input<Input<string>[]>;
        securityGroups: Input<Input<string>[]>;
      }>,
  what: string,
  noNat: (id: string) => string,
): { privateSubnets: Output<string[]>; securityGroups: Output<string[]> } {
  if (isVpc(vpc)) {
    // Inputs, as `Vpc` types them
    const privateSubnets: Input<Input<string>[]> = vpc.privateSubnets;
    const securityGroups: Input<Input<string>[]> = vpc.securityGroups;
    // What's put in the VPC waits for the warning
    const warned = all([vpc.id, hasNat(vpc)]).apply(([id, nat]) => {
      if (nat === false) warnOnce(noNat(id));
    });
    return {
      privateSubnets: all([warned, privateSubnets]).apply(([, ids]) => ids),
      securityGroups: all([warned, securityGroups]).apply(([, ids]) => ids),
    };
  }

  assertVpcIds(vpc, what);
  const ids = output(vpc).apply((vpc) => {
    // 4.x took the subnets as `vpc.subnets`
    if ((vpc as { subnets?: unknown }).subnets)
      throw new VisibleError(
        `"vpc.subnets" isn't an option for ${what}. It's "vpc.privateSubnets" now.`,
      );
    return vpc;
  });
  return {
    privateSubnets: ids.privateSubnets,
    securityGroups: ids.securityGroups,
  };
}

/** The ids of a VPC's public or private subnets. */
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
 *   subnets, which it gives as the program runs. SST 4's `Vpc` made its
 *   subnets in the order of its AZs, so the keys are the same, and a move
 *   keeps what's made.
 * - For a `Vpc` from `get`, the AZ's name, since its lookup keeps no order,
 *   as `subnetsByAz()` finds it.
 *
 * A promise resolves to `undefined` while a preview doesn't know the subnets.
 * Each subnet is an output of its own, so what's made with it depends on it.
 *
 * @param parent What the lookups are made for.
 * @param what What the subnets are for, for the error messages: `the "MyEfs"
 * file system`.
 */
export function privateSubnetsOf(
  vpc: AnyVpc,
  parent: Resource,
  what: string,
):
  | Record<string, Output<string>>
  | Promise<Record<string, Output<string>> | undefined> {
  if (vpc.privateSubnetsByAz) return vpc.privateSubnetsByAz;
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
 * `undefined` when that isn't known, as for a `Vpc` that's referenced.
 */
export function hasNat(vpc: AnyVpc): Output<boolean | undefined> {
  return output(vpc.hasNat);
}
