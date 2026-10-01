import { ComponentResourceOptions, output } from "@pulumi/pulumi";
import { ecs } from "@pulumi/aws";
import { V5Args, component } from "../../parts-component";
import { VisibleError } from "../../error";
import { Vpc } from "../vpc";
import { Vpc as VpcV1 } from "../vpc-v1";
import type {
  Cluster as OriginalCluster,
  ClusterArgs as OriginalClusterArgs,
  ClusterGetArgs,
} from "../cluster";

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

export interface ClusterArgs
  extends V5Args<OriginalClusterArgs, typeof parts> {}

/**
 * The `Cluster` component lets you create an [ECS cluster](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/clusters.html)
 * for your app.
 *
 * It takes the same args as [`sst.aws.Cluster`](/docs/component/aws/cluster) and creates the
 * same resources. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the cluster
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const cluster = new sst.aws.v5.Cluster("MyCluster", { vpc });
 * ```
 *
 * #### Add a service
 *
 * A [`Service`](/docs/component/aws/v5/service) is a set of containers that are always
 * running, like a web or application server. They're restarted if they fail.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Service("MyService", { cluster });
 * ```
 *
 * #### Add a task
 *
 * A [`Task`](/docs/component/aws/v5/task) is a set of containers that's started for long
 * running asynchronous work, like data processing.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Task("MyTask", { cluster });
 * ```
 *
 * #### Switch from `sst.aws.Cluster`
 *
 * Change `sst.aws.Cluster` to `sst.aws.v5.Cluster` and keep the name. The cluster you've
 * deployed is kept, and so is everything that runs in it.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const cluster = new sst.aws.Cluster("MyCluster", { vpc });
 * const cluster = new sst.aws.v5.Cluster("MyCluster", { vpc });
 * ```
 *
 * A few things work differently:
 *
 * - Switch the services and tasks in the cluster first, or along with it. A
 *   `sst.aws.v5.Service` and a `sst.aws.v5.Task` take either cluster. A
 *   [`sst.aws.Service`](/docs/component/aws/service) and a
 *   [`sst.aws.Task`](/docs/component/aws/task) are typed for `sst.aws.Cluster` alone.
 * - The deprecated `addService` and `addTask` are gone. Create the service or the task,
 *   and pass it the cluster. Those methods also gave it the cluster's `provider`, so pass
 *   that along if the cluster has one.
 * - `sst.aws.Cluster.v1` has no V5 form.
 * - `get` takes any ECS cluster. `sst.aws.Cluster.get` refused one without the version
 *   tag SST puts on the clusters it creates.
 * - `nodes.cluster` is the cluster, not an output of it. `nodes` also has the capacity
 *   providers.
 * - If you set `tags` on the cluster with an object in `transform`, it keeps the tag SST
 *   sets next to yours. It's added back when you switch.
 */
export class Cluster extends component("sst:aws:Cluster", parts) {
  private network: OriginalCluster["vpc"];

  constructor(
    name: string,
    args: ClusterArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    this.network = networkOf(name, args.vpc);

    // A cluster that's already deployed is used as it is
    if (this.existingPart("cluster")) return;

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
      `"addService" isn't a method of the "${this.componentName}" cluster. Create the service and pass it the cluster: new sst.aws.v5.Service("${name}", { cluster, ...args })`,
    );
  }

  /** @internal */
  public addTask(name: string): never {
    throw new VisibleError(
      `"addTask" isn't a method of the "${this.componentName}" cluster. Create the task and pass it the cluster: new sst.aws.v5.Task("${name}", { cluster, ...args })`,
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
   *   ? sst.aws.v5.Cluster.get("MyCluster", {
   *       id: "arn:aws:ecs:us-east-1:123456789012:cluster/app-dev-MyCluster",
   *       vpc,
   *     })
   *   : new sst.aws.v5.Cluster("MyCluster", { vpc });
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
      { vpc: args.vpc, existing: { cluster: args.id } },
      opts,
    );
  }
}

// The VPC as the services and tasks in the cluster read it: the component, or
// the ids with the subnets of the containers under one name
function networkOf(
  name: string,
  vpc: ClusterArgs["vpc"],
): OriginalCluster["vpc"] {
  if (vpc instanceof VpcV1)
    throw new VisibleError(
      `You are using the "Vpc.v1" component. Please migrate to the latest "Vpc" component.`,
    );

  if (vpc instanceof Vpc) return vpc;

  return output(vpc).apply((vpc) => {
    if (vpc.containerSubnets && vpc.serviceSubnets)
      throw new VisibleError(
        `You cannot provide both "vpc.containerSubnets" and "vpc.serviceSubnets" in the "${name}" Cluster component. The "serviceSubnets" property has been deprecated. Use "containerSubnets" instead.`,
      );
    if (!vpc.containerSubnets && !vpc.serviceSubnets)
      throw new VisibleError(
        `Missing "vpc.containerSubnets" for the "${name}" Cluster component.`,
      );
    if (!vpc.cloudmapNamespaceId !== !vpc.cloudmapNamespaceName)
      throw new VisibleError(
        `You must provide both "vpc.cloudmapNamespaceId" and "vpc.cloudmapNamespaceName" for the "${name}" Cluster component.`,
      );

    return {
      ...vpc,
      containerSubnets: (vpc.containerSubnets ?? vpc.serviceSubnets)!,
      serviceSubnets: undefined,
    };
  });
}
