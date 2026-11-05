import { ComponentResourceOptions, Output, output } from "@pulumi/pulumi";
import { ecs } from "@pulumi/aws";
import { type ComponentArgs, component } from "../parts-component";
import { notAnExistingPart, getArgs } from "../args";
import { VisibleError } from "../error";
import type { Input } from "../input";
import { type AnyVpc, assertVpcIds, isVpc } from "./helpers/vpc";

const parts = {
  /**
   * The Amazon ECS Cluster.
   */
  cluster: ecs.Cluster,
  /**
   * The capacity providers the cluster's services and tasks can run on: Fargate and
   * Fargate Spot. A cluster passed in `existing` keeps the ones it has, and this isn't
   * created.
   */
  capacityProviders: ecs.ClusterCapacityProviders,
};

export interface ClusterArgs extends ComponentArgs<typeof parts> {
  /**
   * The VPC the cluster's services and tasks run in.
   *
   * @example
   * Create a `Vpc` component.
   *
   * ```js title="sst.config.ts"
   * const myVpc = new sst.aws.Vpc("MyVpc");
   * ```
   *
   * Or reference an existing VPC.
   *
   * ```js title="sst.config.ts"
   * const myVpc = sst.aws.Vpc.get("MyVpc", "vpc-12345678901234567");
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
   * In a `Vpc`, the containers and a public load balancer are in its public subnets, and
   * the containers get a public IP to reach the internet. An internal load balancer is in
   * its private subnets.
   *
   * You can also pass the ids of a VPC. Every load balancer is then in
   * `loadBalancerSubnets`, and the containers don't get a public IP, so put them in
   * subnets that reach the internet through a NAT. For example, a `Vpc`'s private
   * subnets:
   *
   * ```js
   * const myVpc = new sst.aws.Vpc("MyVpc", { nat: "managed" });
   * ```
   *
   * ```js
   * {
   *   vpc: {
   *     id: myVpc.id,
   *     securityGroups: myVpc.securityGroups,
   *     containerSubnets: myVpc.privateSubnets,
   *     loadBalancerSubnets: myVpc.publicSubnets,
   *     cloudmapNamespaceId: myVpc.nodes.cloudmapNamespace.id,
   *     cloudmapNamespaceName: myVpc.nodes.cloudmapNamespace.name
   *   }
   * }
   * ```
   *
   * A `Task` can be given a public IP with its `publicIp` instead.
   */
  vpc:
    | AnyVpc
    | Input<{
        /**
         * The ID of the VPC.
         */
        id: Input<string>;
        /**
         * A list of VPC security group IDs for the services and tasks.
         */
        securityGroups: Input<Input<string>[]>;
        /**
         * A list of subnet IDs in the VPC to place the containers in.
         */
        containerSubnets: Input<Input<string>[]>;
        /**
         * A list of public subnet IDs in the VPC. A `Task` with `public` set runs in
         * these.
         */
        publicSubnets?: Input<Input<string>[]>;
        /**
         * A list of subnet IDs in the VPC to place the load balancer in.
         */
        loadBalancerSubnets: Input<Input<string>[]>;
        /**
         * The ID of the Cloud Map namespace the services are registered in. Given with
         * `cloudmapNamespaceName`.
         */
        cloudmapNamespaceId?: Input<string>;
        /**
         * The name of the Cloud Map namespace the services are registered in. Given with
         * `cloudmapNamespaceId`.
         */
        cloudmapNamespaceName?: Input<string>;
      }>;
}

export interface ClusterGetArgs {
  /**
   * The ID of the cluster.
   */
  id: Input<string>;
  /**
   * The VPC the cluster's services and tasks run in.
   */
  vpc: ClusterArgs["vpc"];
}

/**
 * The `Cluster` component lets you create an [ECS cluster](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/clusters.html)
 * for your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the cluster
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const cluster = new sst.aws.Cluster("MyCluster", { vpc });
 * ```
 *
 * #### Add a service
 *
 * A [`Service`](/docs/component/aws/v5/service) is a set of containers that are always
 * running, like a web or application server. They're restarted if they fail.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Service("MyService", { cluster });
 * ```
 *
 * #### Add a task
 *
 * A [`Task`](/docs/component/aws/v5/task) is a set of containers that's started for long
 * running asynchronous work, like data processing.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Task("MyTask", { cluster });
 * ```
 *
 * #### Switch from SST 4's `sst.aws.Cluster`
 *
 * Keep the name, and `sst migrate` moves it. The cluster you've
 * deployed is kept, and so is everything that runs in it.
 *
 * A few things work differently:
 *
 * - Switch the services and tasks in the cluster first, or along with it. A
 *   `sst.aws.Service` and a `sst.aws.Task` take either cluster. A
 *   [`sst.aws.Service`](/docs/component/aws/service) and a
 *   [`sst.aws.Task`](/docs/component/aws/task) are typed for `sst.aws.Cluster` alone.
 * - The deprecated `addService` and `addTask` are gone. Create the service or the task,
 *   and pass it the cluster. Those methods also gave it the cluster's `provider`, so pass
 *   that along if the cluster has one.
 * - The deprecated `vpc.serviceSubnets` is gone. Pass the same subnets as
 *   `vpc.containerSubnets`; nothing in AWS changes.
 * - `forceUpgrade` isn't taken: remove it. It upgraded a cluster from `Cluster.v1`, and
 *   `sst.aws.Cluster.v1` has no V5 form.
 * - `get` takes any ECS cluster. `sst.aws.Cluster.get` refused one without the version
 *   tag SST puts on the clusters it creates.
 * - `nodes.cluster` is the cluster, not an output of it. `nodes` also has the capacity
 *   providers.
 * - If you set `tags` on the cluster with an object in `transform`, it keeps the tag SST
 *   sets next to yours. It's added back when you switch.
 */
export class Cluster extends component("sst:aws:Cluster", parts) {
  private network: ReturnType<typeof vpcOf>;

  constructor(
    name: string,
    args: ClusterArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    this.network = vpcOf(name, args.vpc);

    // A cluster that's already deployed is used as it is
    if (this.existingPart("cluster")) {
      notAnExistingPart(
        args.existing,
        "capacityProviders",
        `the "${name}" cluster`,
        `The "cluster" it's given keeps the capacity providers it has.`,
      );
      return;
    }

    const cluster = this.part("cluster", {
      // The same value the 4.x `Cluster` writes. Its `get` reads this tag,
      // and refuses a cluster that doesn't have it.
      tags: { "sst:ref:version": "2.0" },
    });

    this.part("capacityProviders", {
      clusterName: cluster.name,
      capacityProviders: ["FARGATE", "FARGATE_SPOT"],
    });
  }

  /**
   * The cluster ID.
   */
  public get id() {
    return this.nodes.cluster.id;
  }

  /**
   * Where the cluster's services and tasks run: the `Vpc`, or the ids it was
   * given in its place.
   * @internal
   */
  public get vpc() {
    return this.network;
  }

  /** @internal */
  public addService(name: string): never {
    throw new VisibleError(
      `"addService" isn't a method of the "${this.componentName}" cluster. Create the service and pass it the cluster: new sst.aws.Service("${name}", { cluster, ...args })`,
    );
  }

  /** @internal */
  public addTask(name: string): never {
    throw new VisibleError(
      `"addTask" isn't a method of the "${this.componentName}" cluster. Create the task and pass it the cluster: new sst.aws.Task("${name}", { cluster, ...args })`,
    );
  }

  /**
   * Reference an existing ECS Cluster with the given ID. This is useful when you
   * create a cluster in one stage and want to share it in another. It avoids
   * having to create a new cluster in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share cluster across stages.
   * :::
   *
   * @param name The name of the component.
   * @param args The arguments to get the cluster.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a cluster in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new cluster, you want to share the same cluster from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const cluster = $app.stage === "frank"
   *   ? sst.aws.Cluster.get("MyCluster", {
   *       id: "arn:aws:ecs:us-east-1:123456789012:cluster/app-dev-MyCluster",
   *       vpc,
   *     })
   *   : new sst.aws.Cluster("MyCluster", { vpc });
   * ```
   *
   * Here `arn:aws:ecs:us-east-1:123456789012:cluster/app-dev-MyCluster` is the ID of the
   * cluster created in the `dev` stage. You can find these by outputting the cluster ID
   * in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   id: cluster.id,
   * };
   * ```
   */
  public static get(
    name: string,
    args: ClusterGetArgs,
    opts?: ComponentResourceOptions,
  ) {
    return new Cluster(
      name,
      getArgs({ vpc: args.vpc, existing: { cluster: args.id } }),
      opts,
    );
  }
}

// The VPC as the services and tasks in the cluster read it: the component, or
// the ids it was given
function vpcOf(name: string, vpc: ClusterArgs["vpc"]) {
  if (isVpc(vpc)) return vpc;

  assertVpcIds(vpc, `the "${name}" cluster`);

  // The ids are checked as they're given, so what's missing fails a preview
  // even where their values aren't known yet, and once more when they are
  if (!Output.isInstance(vpc) && !(vpc instanceof Promise)) checkIds(name, vpc);
  return output(vpc).apply((vpc) => {
    checkIds(name, vpc);
    return vpc;
  });
}

function checkIds(
  name: string,
  vpc: {
    containerSubnets?: unknown;
    cloudmapNamespaceId?: unknown;
    cloudmapNamespaceName?: unknown;
  },
) {
  // 4.x also took the subnets of the containers as `serviceSubnets`
  if ((vpc as { serviceSubnets?: unknown }).serviceSubnets)
    throw new VisibleError(
      `"vpc.serviceSubnets" isn't an option for the "${name}" cluster. It's "vpc.containerSubnets" now.`,
    );
  if (!vpc.containerSubnets)
    throw new VisibleError(
      `The "vpc" of the "${name}" cluster has no "containerSubnets". Give the subnets its containers run in.`,
    );
  if (!vpc.cloudmapNamespaceId !== !vpc.cloudmapNamespaceName)
    throw new VisibleError(
      `The "vpc" of the "${name}" cluster has one of "cloudmapNamespaceId" and "cloudmapNamespaceName". Give both, or neither.`,
    );
}
