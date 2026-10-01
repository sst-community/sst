import {
  all,
  ComponentResourceOptions,
  type Output,
  output,
} from "@pulumi/pulumi";
import { ec2, efs } from "@pulumi/aws";
import { V5Args, component, many } from "../../parts-component";
import { withDefault } from "../../args";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import { type TakesVpc, isVpc } from "../helpers/vpc";
import type { EfsArgs as OriginalEfsArgs } from "../efs";

const parts = {
  /**
   * The Amazon EFS file system.
   */
  fileSystem: efs.FileSystem,
  /**
   * The security group of the mount targets. It lets in traffic from inside the VPC.
   */
  securityGroup: ec2.SecurityGroup,
  /**
   * The mount targets of the file system, by the id of the subnet each one is in.
   * They're added once the subnets are known.
   */
  mountTarget: many(efs.MountTarget),
  /**
   * The Amazon EFS access point.
   */
  accessPoint: efs.AccessPoint,
};

export interface EfsArgs
  extends V5Args<TakesVpc<OriginalEfsArgs>, typeof parts> {}

/**
 * The `Efs` component lets you add [Amazon Elastic File System (EFS)](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html) to your app.
 *
 * It takes the same args as [`sst.aws.Efs`](/docs/component/aws/efs) and creates the same
 * resources. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the file system
 *
 * ```js title="sst.config.ts" {2}
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const efs = new sst.aws.v5.Efs("MyEfs", { vpc });
 * ```
 *
 * This needs a VPC.
 *
 * #### Attach it to a Lambda function
 *
 * ```ts title="sst.config.ts" {4}
 * new sst.aws.v5.Function("MyFunction", {
 *   vpc,
 *   handler: "lambda.handler",
 *   volume: { efs, path: "/mnt/efs" }
 * });
 * ```
 *
 * This is now mounted at `/mnt/efs` in the Lambda function.
 *
 * #### Attach it to a container
 *
 * ```ts title="sst.config.ts" {4-6}
 * const cluster = new sst.aws.v5.Cluster("MyCluster", { vpc });
 * new sst.aws.v5.Service("MyService", {
 *   cluster,
 *   volumes: [
 *     { efs, path: "/mnt/efs" }
 *   ]
 * });
 * ```
 *
 * Mounted at `/mnt/efs` in the container.
 *
 * #### Switch from `sst.aws.Efs`
 *
 * Change `sst.aws.Efs` to `sst.aws.v5.Efs` and keep the name. The file system, its mount
 * targets, their security group and the access point are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const efs = new sst.aws.Efs("MyEfs", { vpc });
 * const efs = new sst.aws.v5.Efs("MyEfs", { vpc });
 * ```
 *
 * A few things work differently:
 *
 * - Switch what mounts the file system first, or along with it. A `sst.aws.v5.Function`,
 *   `sst.aws.v5.Service` and `sst.aws.v5.Task` take either one. A
 *   [`sst.aws.Function`](/docs/component/aws/function),
 *   [`sst.aws.Service`](/docs/component/aws/service) and
 *   [`sst.aws.Task`](/docs/component/aws/task) only know `sst.aws.Efs`.
 * - `nodes.fileSystem` and `nodes.accessPoint` are the resources, not outputs of them.
 *   `nodes` also has the security group, and the mount targets by subnet id.
 * - The mount targets can be transformed. A transform function is also given the id
 *   of the subnet.
 * - A file system from `get` is looked up inside the component, with its access point.
 *   `sst.aws.Efs.get` looked them up at the top of the app, so a deploy drops those two
 *   lookups from its state and reads the same resources again.
 * - If you set part of the access point's `posixUser` or `rootDirectory` with an object
 *   in `transform`, the rest of it is kept.
 *
 * ---
 *
 * ### Cost
 *
 * By default this component uses _Regional (Multi-AZ) with Elastic Throughput_. The pricing is
 * pay-per-use.
 *
 * - For storage: $0.30 per GB per month
 * - For reads: $0.03 per GB per month
 * - For writes: $0.06 per GB per month
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [EFS pricing](https://aws.amazon.com/efs/pricing/) for more details.
 */
export class Efs extends component("sst:aws:Efs", parts) {
  // What mounts the file system reads these. They're known once it can be
  // mounted: when its mount targets are there.
  private mounted: { id: Output<string>; accessPoint: Output<string> };

  constructor(name: string, args: EfsArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const self = this;

    // A file system that's already deployed, with the access point it has
    const existing = this.existingPart("fileSystem");
    if (existing) {
      const accessPoint =
        this.existingPart("accessPoint") ??
        this.lookupPart("accessPoint", firstAccessPointOf(existing));
      this.mounted = { id: existing.id, accessPoint: accessPoint.id };
      return;
    }

    const vpc = network();

    const fileSystem = this.part("fileSystem", {
      performanceMode: withDefault(args.performance, "general-purpose", (v) =>
        v === "general-purpose" ? "generalPurpose" : "maxIO",
      ),
      throughputMode: withDefault(args.throughput, "elastic"),
      encrypted: true,
    });

    const securityGroup = this.part("securityGroup", {
      description: "Managed by SST",
      vpcId: vpc.id,
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
      ingress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          // Restricts inbound traffic to only within the VPC
          cidrBlocks: [vpc.cidrBlock],
        },
      ],
    });

    // One in each subnet. Which subnets there are is known on deploy.
    const mountTargets = vpc.subnets.apply((subnets) =>
      subnets.map((subnet) =>
        this.part("mountTarget", subnet, {
          fileSystemId: fileSystem.id,
          subnetId: subnet,
          securityGroups: [securityGroup.id],
        }),
      ),
    );

    // A function can't be created with a file system that has no mount target
    // in its subnets yet. The access point waits for them, so whatever mounts
    // it does too.
    const accessPoint = this.part(
      "accessPoint",
      {
        fileSystemId: fileSystem.id,
        posixUser: { uid: 0, gid: 0 },
        rootDirectory: { path: "/" },
      },
      { dependsOn: mountTargets },
    );

    this.mounted = {
      id: all([fileSystem.id, accessPoint.id]).apply(([id]) => id),
      accessPoint: accessPoint.id,
    };

    // Where the mount targets go: the private subnets of a `Vpc`, or the
    // subnets that were given
    function network() {
      if (isVpc(args.vpc))
        return output({
          id: args.vpc.id,
          subnets: args.vpc.privateSubnets,
          cidrBlock: args.vpc.nodes.vpc.cidrBlock,
        });

      return output(args.vpc).apply((vpc) => {
        // `vpc.id` wasn't always required, so a config can be without it
        if (!vpc.id)
          throw new VisibleError(
            `Missing "vpc.id" for the "${name}" EFS component. The VPC id is required to create the security group for the EFS mount targets.`,
          );

        // Looked up for its CIDR block. It isn't one of the component's own
        // resources, so it isn't a part.
        const lookup = ec2.Vpc.get(
          `${name}Vpc`,
          vpc.id,
          undefined,
          self.delegateOpts(),
        );
        return {
          id: vpc.id,
          subnets: vpc.subnets,
          cidrBlock: lookup.cidrBlock,
        };
      });
    }

    function firstAccessPointOf(fileSystem: efs.FileSystem) {
      return efs
        .getAccessPointsOutput(
          { fileSystemId: fileSystem.id },
          { parent: self },
        )
        .apply((found) => {
          if (!found.ids.length)
            throw new VisibleError(
              `The file system of the "${name}" EFS component has no access point. Create one, and pass it in "existing.accessPoint".`,
            );
          return found.ids[0];
        });
    }
  }

  /**
   * The ID of the EFS file system.
   */
  public get id() {
    return this.mounted.id;
  }

  /**
   * The ID of the EFS access point.
   */
  public get accessPoint() {
    return this.mounted.accessPoint;
  }

  /**
   * Reference an existing EFS file system with the given file system ID. This is useful when
   * you create a EFS file system in one stage and want to share it in another. It avoids
   * having to create a new EFS file system in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share EFS file systems across stages.
   * :::
   *
   * @param name The name of the component.
   * @param fileSystemID The ID of the existing EFS file system.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a EFS file system in the `dev` stage. And in your personal stage
   * `frank`, instead of creating a new file system, you want to share the same file system
   * from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const efs = $app.stage === "frank"
   *   ? sst.aws.v5.Efs.get("MyEfs", "app-dev-myefs")
   *   : new sst.aws.v5.Efs("MyEfs", { vpc });
   * ```
   *
   * Here `app-dev-myefs` is the ID of the file system created in the `dev` stage.
   * You can find this by outputting the file system ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   id: efs.id
   * };
   * ```
   */
  public static get(
    name: string,
    fileSystemID: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Efs(
      name,
      { existing: { fileSystem: fileSystemID } } as EfsArgs,
      opts,
    );
  }
}
