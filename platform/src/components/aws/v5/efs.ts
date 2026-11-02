import {
  ComponentResourceOptions,
  type Output,
  all,
  output,
} from "@pulumi/pulumi";
import { ec2, efs } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
} from "../../parts-component";
import { withDefault } from "../../args";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import {
  type AnyVpc,
  assertVpcIds,
  isVpc,
  privateSubnetsOf,
  subnetsByAz,
} from "../helpers/vpc";

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
   * The mount targets of the file system, one in each availability zone. In a `Vpc` your
   * app creates, they're kept by the AZ's number, as the VPC keeps its subnets. In any
   * other VPC, one from `get` or one given by its ids, they're kept by the AZ's name.
   */
  mountTarget: many(deferred(efs.MountTarget)),
  /**
   * The Amazon EFS access point.
   */
  accessPoint: efs.AccessPoint,
};

export interface EfsArgs extends ComponentArgs<typeof parts> {
  /**
   * The throughput mode for the EFS file system.
   *
   * The default `elastic` mode scales up or down based on the workload. However, if you know
   * your access patterns, you can use `provisioned` to have a fixed throughput.
   *
   * Or you can use `bursting` to scale with the amount of storage you're using. It also
   * supports bursting to higher levels for up to 12 hours per day.
   *
   * @default `"elastic"`
   *
   * @example
   * ```ts
   * {
   *   throughput: "bursting"
   * }
   * ```
   */
  throughput?: Input<"provisioned" | "bursting" | "elastic">;
  /**
   * The performance mode for the EFS file system.
   *
   * The `max-io` mode can support higher throughput, but with slightly higher latency. It's
   * recommended for larger workloads like data analysis or media processing.
   *
   * Both the modes are priced the same, but `general-purpose` is recommended for most use cases.
   *
   * @default `"general-purpose"`
   * @example
   * ```ts
   * {
   *   performance: "max-io"
   * }
   * ```
   */
  performance?: Input<"general-purpose" | "max-io">;
  /**
   * The VPC to use for the EFS file system. A mount target is created in each private
   * subnet of a `Vpc`, or in each subnet you give.
   *
   * @example
   * Create a VPC component.
   *
   * ```js
   * const myVpc = new sst.aws.v5.Vpc("MyVpc");
   * ```
   *
   * And pass it in.
   *
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   *
   * Or pass in the ids of a VPC.
   *
   * ```js
   * {
   *   vpc: {
   *     id: "vpc-0d19d2b8ca2b268a1",
   *     subnets: ["subnet-0db7376a7ad4db5fd", "subnet-06fc7ee8319b2c0ce"]
   *   }
   * }
   * ```
   *
   * Keep giving the VPC the same way. The mount targets in a `Vpc` your app creates are
   * kept by the AZ's number, and in any other VPC by the AZ's name, so passing the `Vpc`
   * in place of its ids, or the other way around, makes them again, which EFS refuses
   * while the old ones are there.
   */
  vpc:
    | AnyVpc
    | Input<{
        /**
         * The ID of the VPC.
         */
        id: Input<string>;
        /**
         * A list of subnet IDs in the VPC to create the EFS mount targets in, one in each
         * availability zone.
         *
         * Each mount target is kept by its subnet's AZ, which is looked up, so the order of
         * the list doesn't matter, and adding or removing a subnet changes only its AZ's.
         * Subnets your app creates in the same deploy can't be looked up by a preview, so
         * `sst diff` doesn't show their mount targets until they're there.
         */
        subnets: Input<Input<string>[]>;
      }>;
}

/**
 * The `Efs` component lets you add [Amazon Elastic File System (EFS)](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the file system
 *
 * ```js title="sst.config.ts" {2}
 * const vpc = new sst.aws.v5.Vpc("MyVpc");
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
 *   `nodes` also has the security group and the mount targets.
 * - Each mount target is kept by its availability zone, where `sst.aws.Efs` kept it by
 *   its subnet's id: by the AZ's number in a `Vpc` your app creates, and by the AZ's name
 *   in any other VPC. So a subnet that's replaced replaces its mount target, removing the
 *   old one first, since EFS allows one in each AZ. Switching keeps them all, and so does
 *   switching the `Vpc` too.
 * - The mount targets can be transformed. A transform function is also given the key
 *   it's kept by.
 * - The VPC given by its ids is looked up with a function, where `sst.aws.Efs` read it
 *   into the state, so a deploy drops that read.
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
  // The subnet of each mount target, by its key
  private subnets: Record<string, Input<string>> = {};

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

    // One in each AZ. Where the subnets are known as the program runs,
    // they're created with the rest; otherwise once a preview knows them.
    const mountTargets = (subnets: Record<string, Input<string>> = {}) =>
      Object.entries(subnets).map(([key, subnet]) => {
        this.subnets[key] = subnet;
        return this.part(
          "mountTarget",
          key,
          {
            fileSystemId: fileSystem.id,
            subnetId: subnet,
            securityGroups: [securityGroup.id],
          },
          // EFS allows one in each AZ, so a new one can't be made beside it
          { deleteBeforeReplace: true },
        );
      });
    const mounts =
      vpc.subnets instanceof Promise
        ? output(this.after(vpc.subnets, mountTargets))
        : mountTargets(vpc.subnets);

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
      { dependsOn: mounts },
    );

    this.mounted = {
      id: all([fileSystem.id, accessPoint.id]).apply(([id]) => id),
      accessPoint: accessPoint.id,
    };

    // Where the mount targets go: the private subnets of a `Vpc`, or the
    // subnets that were given
    function network() {
      if (isVpc(args.vpc))
        return {
          id: args.vpc.id,
          cidrBlock: args.vpc.nodes.vpc.cidrBlock,
          subnets: privateSubnetsOf(
            args.vpc,
            self,
            `the "${name}" EFS component`,
          ),
        };

      assertVpcIds(args.vpc, `the "${name}" EFS component`);
      const vpc = output(args.vpc).apply((vpc) => {
        // `vpc.id` wasn't always required, so a config can be without it
        if (!vpc.id)
          throw new VisibleError(
            `Missing "vpc.id" for the "${name}" EFS component. The VPC id is required to create the security group for the EFS mount targets.`,
          );
        if (!vpc.subnets)
          throw new VisibleError(
            `Missing "vpc.subnets" for the "${name}" EFS component. The mount targets are created in them.`,
          );
        return vpc;
      });
      return {
        id: vpc.id,
        cidrBlock: ec2.getVpcOutput({ id: vpc.id }, { parent: self }).cidrBlock,
        subnets: subnetsByAz(vpc.subnets, self, `the "${name}" EFS component`),
      };
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
   * The subnet of a mount target, by the key it's kept by.
   * @internal
   */
  public subnetOf(key: string): Input<string> | undefined {
    return this.subnets[key];
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
