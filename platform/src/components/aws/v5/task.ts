import {
  all,
  ComponentResourceOptions,
  type Output,
  output,
} from "@pulumi/pulumi";
import { cloudwatch, ec2, ecs, getRegionOutput, iam } from "@pulumi/aws";
import { Image } from "@pulumi/docker-build";
import { V5Args, component, many, optional } from "../../parts-component";
import { notAnOption, plain, withDefault } from "../../args";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import type { Cluster as OriginalCluster } from "../cluster";
import type { Efs as OriginalEfs } from "../efs";
import type { FargateContainerArgs } from "../fargate";
import { Function as OriginalFunction } from "../function";
import {
  type Container,
  containerImage,
  containersOf,
  cpuOf,
  executionRoleArgs,
  logGroupArgs,
  memoryOf,
  storageOf,
  taskDefinitionArgs,
  taskRoleArgs,
} from "../helpers/fargate";
import { permission } from "../permission";
import { Vpc } from "../vpc";
import type { TaskArgs as OriginalTaskArgs } from "../task";
import type { Cluster } from "./cluster";
import type { Efs } from "./efs";

const parts = {
  /**
   * The Amazon ECS Execution Role.
   */
  executionRole: iam.Role,
  /**
   * The Amazon ECS Task Role.
   */
  taskRole: iam.Role,
  /**
   * The images built for the task's containers, by the container's name. There's one
   * for each container that's built from a Dockerfile. It's added once the container's
   * image settings are known.
   */
  image: many(Image),
  /**
   * The CloudWatch log groups of the task's containers, by the container's name.
   */
  logGroup: many(cloudwatch.LogGroup),
  /**
   * The Amazon ECS Task Definition.
   */
  taskDefinition: ecs.TaskDefinition,
  /**
   * The AWS Security Group for public tasks. Only created when `public` is `true`.
   */
  publicSecurityGroup: optional(ec2.SecurityGroup),
};

export interface TaskContainerArgs
  extends Omit<FargateContainerArgs, "name" | "volumes"> {
  /**
   * The name of the container.
   *
   * This is used as the `--name` option in the Docker run command. It has to be a plain
   * value: the container's log group and image are named after it.
   */
  name: string;
  /**
   * Mount Amazon EFS file systems into the container. Same as the top-level
   * [`volumes`](#volumes).
   */
  volumes?: TaskArgs["volumes"];
}

export interface TaskArgs
  extends V5Args<
    Omit<
      OriginalTaskArgs,
      "cluster" | "containers" | "volumes" | "taskRole" | "executionRole"
    >,
    typeof parts
  > {
  /**
   * The ECS Cluster to run the task in. Create one in your app, if you haven't already.
   *
   * ```js title="sst.config.ts"
   * const vpc = new sst.aws.Vpc("MyVpc");
   * const myCluster = new sst.aws.v5.Cluster("MyCluster", { vpc });
   * ```
   *
   * And pass it in.
   *
   * ```js
   * {
   *   cluster: myCluster
   * }
   * ```
   */
  cluster: OriginalCluster | Cluster;
  /**
   * The containers to run in the task.
   *
   * :::tip
   * You can optionally run multiple containers in a task.
   * :::
   *
   * By default this starts a single container. To add multiple containers in the task, pass
   * in an array of containers args.
   *
   * ```ts
   * {
   *   containers: [
   *     {
   *       name: "app",
   *       image: "nginxdemos/hello:plain-text"
   *     },
   *     {
   *       name: "admin",
   *       image: {
   *         context: "./admin",
   *         dockerfile: "Dockerfile"
   *       }
   *     }
   *   ]
   * }
   * ```
   *
   * If you specify `containers`, you cannot list the above args at the top-level. For example,
   * you **cannot** pass in `image` at the top level.
   *
   * ```diff lang="ts"
   * {
   * -  image: "nginxdemos/hello:plain-text",
   *   containers: [
   *     {
   *       name: "app",
   *       image: "nginxdemos/hello:plain-text"
   *     },
   *     {
   *       name: "admin",
   *       image: "nginxdemos/hello:plain-text"
   *     }
   *   ]
   * }
   * ```
   *
   * You will need to pass in `image` as a part of the `containers`.
   *
   * The list, each container and its `name` have to be plain values. What's inside a
   * container can be an output.
   */
  containers?: TaskContainerArgs[];
  /**
   * Mount Amazon EFS file systems into the container.
   *
   * @example
   * Create an EFS file system.
   *
   * ```ts title="sst.config.ts"
   * const vpc = new sst.aws.Vpc("MyVpc");
   * const fileSystem = new sst.aws.v5.Efs("MyFileSystem", { vpc });
   * ```
   *
   * And pass it in.
   *
   * ```js
   * {
   *   volumes: [
   *     {
   *       efs: fileSystem,
   *       path: "/mnt/efs"
   *     }
   *   ]
   * }
   * ```
   *
   * Or pass in a the EFS file system ID.
   *
   * ```js
   * {
   *   volumes: [
   *     {
   *       efs: {
   *         fileSystem: "fs-12345678",
   *         accessPoint: "fsap-12345678"
   *       },
   *       path: "/mnt/efs"
   *     }
   *   ]
   * }
   * ```
   */
  volumes?: Input<{
    /**
     * The Amazon EFS file system to mount.
     */
    efs: Input<
      | OriginalEfs
      | Efs
      | {
          /**
           * The ID of the EFS file system.
           */
          fileSystem: Input<string>;
          /**
           * The ID of the EFS access point.
           */
          accessPoint: Input<string>;
        }
    >;
    /**
     * The path to mount the volume.
     */
    path: Input<string>;
  }>[];
}

/**
 * The `Task` component lets you create containers that are used for long running asynchronous
 * work, like data processing. It uses [Amazon ECS](https://aws.amazon.com/ecs/) on
 * [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html).
 *
 * It takes the same args as [`sst.aws.Task`](/docs/component/aws/task) and creates the same
 * resources. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a Task
 *
 * Tasks are run inside an ECS Cluster. If you haven't already, create one.
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const cluster = new sst.aws.v5.Cluster("MyCluster", { vpc });
 * ```
 *
 * Add the task to it.
 *
 * ```ts title="sst.config.ts"
 * const task = new sst.aws.v5.Task("MyTask", { cluster });
 * ```
 *
 * #### Configure the container image
 *
 * By default, the task will look for a Dockerfile in the root directory. Optionally,
 * configure the image context and dockerfile.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Task("MyTask", {
 *   cluster,
 *   image: {
 *     context: "./app",
 *     dockerfile: "Dockerfile"
 *   }
 * });
 * ```
 *
 * To add multiple containers in the task, pass in an array of containers args.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Task("MyTask", {
 *   cluster,
 *   containers: [
 *     {
 *       name: "app",
 *       image: "nginxdemos/hello:plain-text"
 *     },
 *     {
 *       name: "admin",
 *       image: {
 *         context: "./admin",
 *         dockerfile: "Dockerfile"
 *       }
 *     }
 *   ]
 * });
 * ```
 *
 * This is useful for running sidecar containers.
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your task. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {5} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.Task("MyTask", {
 *   cluster,
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources in your task.
 *
 * ```ts title="app.ts"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Task SDK
 *
 * With the [Task JS SDK](/docs/component/aws/task#sdk), you can run your tasks, stop your
 * tasks, and get the status of your tasks.
 *
 * For example, you can link the task to a function in your app.
 *
 * ```ts title="sst.config.ts" {3}
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   link: [task]
 * });
 * ```
 *
 * Then from your function run the task.
 *
 * ```ts title="src/lambda.ts"
 * import { Resource } from "sst";
 * import { task } from "sst/aws/task";
 *
 * const runRet = await task.run(Resource.MyTask);
 * const taskArn = runRet.arn;
 * ```
 *
 * If you are not using Node.js, you can use the AWS SDK instead. Here's
 * [how to run a task](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html).
 *
 * #### Use roles you already have
 *
 * Pass the role, or its name.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Task("MyTask", {
 *   cluster,
 *   existing: {
 *     taskRole: "my-task-role",
 *     executionRole: "my-execution-role"
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.Task`
 *
 * Change `sst.aws.Task` to `sst.aws.v5.Task` and keep the name. The task definition, its
 * roles, the containers' log groups and images, and the security group of a public task
 * are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const task = new sst.aws.Task("MyTask", { cluster });
 * const task = new sst.aws.v5.Task("MyTask", { cluster });
 * ```
 *
 * A few things are written differently:
 *
 * - `taskRole: "my-task-role"` becomes `existing: { taskRole: "my-task-role" }`, and the
 *   same for `executionRole`.
 * - The list of `containers`, each container and its `name` are plain values, not
 *   outputs. They decide which log groups and images are created.
 * - `nodes.taskDefinition` is the task definition, not an output of it. `nodes` also has
 *   the log groups and the images, by container name.
 * - A `transform` function for `logGroup` or `taskDefinition` is given outputs where
 *   `sst.aws.Task` gave it plain values. For `logGroup` and `image` it's also given the
 *   container's name.
 * - If you set part of the task definition's `runtimePlatform` with an object in
 *   `transform`, the rest of it is kept.
 *
 * ---
 *
 * ### Cost
 *
 * By default, this uses a _Linux/X86_ _Fargate_ container with 0.25 vCPUs at $0.04048 per
 * vCPU per hour and 0.5 GB of memory at $0.004445 per GB per hour. It includes 20GB of
 * _Ephemeral Storage_ for free with additional storage at $0.000111 per GB per hour. When
 * using an SST VPC, each task also gets a public IPv4 address at $0.005 per hour.
 *
 * It works out to $0.04048 x 0.25 + $0.004445 x 0.5 + $0.005. Or **$0.02 per hour**
 * your task runs for.
 *
 * Adjust this for the `cpu`, `memory` and `storage` you are using. And
 * check the prices for _Linux/ARM_ if you are using `arm64` as your `architecture`.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [Fargate pricing](https://aws.amazon.com/fargate/pricing/) and the
 * [Public IPv4 Address pricing](https://aws.amazon.com/vpc/pricing/) for more details.
 */
export class Task extends component("sst:aws:Task", parts) {
  private readonly run: {
    cluster: TaskArgs["cluster"];
    containers: string[];
    subnets: Output<string[]>;
    securityGroups: Output<string[]>;
    publicIp: boolean;
  };

  constructor(
    name: string,
    args: TaskArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    for (const role of ["taskRole", "executionRole"])
      notAnOption(
        args,
        role,
        `Pass the role, or its name, as "existing: { ${role} }" in the "${name}" task.`,
      );
    // An image that's built is a part. One that exists already is just the
    // image a container is given.
    notAnOption(
      args.existing ?? {},
      "image",
      `Set the "image" of the container to the image's reference in the "${name}" task.`,
    );
    if (args.public !== undefined && args.publicIp !== undefined)
      throw new VisibleError(
        `Do not set both "public" and "publicIp" for the "${name}" Task. "publicIp" has been deprecated, use "public" instead.`,
      );

    const cluster = args.cluster;
    const isPublic =
      plain(args.public, `The "public" of the "${name}" task`) ?? false;
    // In `sst dev` a stub is deployed in place of the task. It hands what
    // the task is run with to the process on the user's machine.
    const dev = $dev && args.dev !== false;
    const region = getRegionOutput({}, opts).region;
    const architecture = withDefault(args.architecture, "x86_64" as const);
    const cpu = cpuOf(args);
    const memory = memoryOf(cpu, args);
    const storage = storageOf(args);
    const containers = containersOf("task", args, name);
    const vpc = network();
    // A task in an SST VPC is in a public subnet, and needs a public IP to
    // reach the internet
    const hasPublicIp = isPublic || (args.publicIp ?? vpc.isSstVpc);

    const publicSecurityGroup = isPublic
      ? this.part("publicSecurityGroup", {
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
              cidrBlocks: ["0.0.0.0/0"],
            },
          ],
        })
      : undefined;

    const taskRole = this.part(
      "taskRole",
      taskRoleArgs(
        args,
        opts,
        dev,
        // The stub reaches the user's machine over AppSync
        dev ? [{ actions: ["appsync:*"], resources: ["*"] }] : [],
      ),
    );
    const executionRole = this.part(
      "executionRole",
      executionRoleArgs(args, opts),
    );

    // Each container that's deployed, with the image it runs and the log
    // group it writes to. In `sst dev` that's the stub alone.
    const deployed = (dev ? [stub(containers[0])] : containers).map(
      (container) => ({
        container,
        image: containerImage(this, "image", container, {
          architecture,
          link: args.link,
          region,
        }),
        logGroup: this.part(
          "logGroup",
          container.name,
          logGroupArgs(container, cluster, name),
          { ignoreChanges: ["name"] },
        ),
      }),
    );

    this.part(
      "taskDefinition",
      taskDefinitionArgs({
        name,
        cluster,
        region,
        link: args.link,
        containers: deployed,
        architecture,
        cpu,
        memory,
        storage,
        taskRole,
        executionRole,
      }),
    );

    this.run = {
      cluster,
      containers: containers.map((container) => container.name),
      subnets:
        isPublic || vpc.isSstVpc ? vpc.publicSubnets : vpc.containerSubnets,
      securityGroups: publicSecurityGroup
        ? all([vpc.securityGroups, publicSecurityGroup.id]).apply(
            ([groups, publicGroup]) => [...groups, publicGroup],
          )
        : vpc.securityGroups,
      publicIp: hasPublicIp,
    };

    // What `sst dev` runs on the user's machine when the task is started
    this.registerOutputs({
      _task: all([args.dev, containers[0].image]).apply(([dev, image]) => ({
        directory: typeof image === "string" ? "" : image?.context ?? ".",
        ...dev,
      })),
    });

    // Where the task runs: the cluster's VPC
    function network() {
      const ids = (list: Input<Input<string>[]>) =>
        output(list) as Output<string[]>;

      // "vpc" is a Vpc component
      if (cluster.vpc instanceof Vpc)
        return {
          id: cluster.vpc.id,
          isSstVpc: true,
          publicSubnets: ids(cluster.vpc.publicSubnets),
          containerSubnets: ids(cluster.vpc.publicSubnets),
          securityGroups: ids(cluster.vpc.securityGroups),
        };

      // "vpc" is object
      const custom = output(cluster.vpc);
      return {
        id: custom.apply((v) => v.id),
        isSstVpc: false,
        publicSubnets: custom.apply((v) => {
          if (isPublic && !v.publicSubnets?.length)
            throw new VisibleError(
              `Set "vpc.publicSubnets" on the Cluster to use "public" on the "${name}" Task.`,
            );
          return ids(v.publicSubnets ?? []);
        }),
        containerSubnets: custom.apply((v) => ids(v.containerSubnets)),
        securityGroups: custom.apply((v) => ids(v.securityGroups)),
      };
    }

    function stub(container: Container): Container {
      return {
        ...container,
        entrypoint: undefined,
        command: undefined,
        image: "ghcr.io/sst-community/sst/bridge-task:latest",
        environment: all([container.environment, OriginalFunction.appsync()]).apply(
          ([environment, appsync]) => ({
            ...environment,
            SST_TASK_ID: name,
            SST_REGION: process.env.SST_AWS_REGION!,
            SST_APPSYNC_HTTP: appsync.http,
            SST_APPSYNC_REALTIME: appsync.realtime,
            SST_APP: $app.name,
            SST_STAGE: $app.stage,
          }),
        ),
      };
    }
  }

  /**
   * The ARN of the ECS Task Definition.
   */
  public get taskDefinition() {
    return this.nodes.taskDefinition.arn;
  }

  /**
   * The names of the containers in the task.
   * @internal
   */
  public get containers(): Output<string[]> {
    return output(this.run.containers);
  }

  /**
   * The ARN of the cluster this task is deployed to.
   * @internal
   */
  public get cluster() {
    return output(this.run.cluster.nodes.cluster.arn);
  }

  /**
   * The security groups for the task.
   * @internal
   */
  public get securityGroups() {
    return this.run.securityGroups;
  }

  /**
   * The subnets for the task.
   * @internal
   */
  public get subnets() {
    return this.run.subnets;
  }

  /**
   * Whether to assign a public IP address to the task.
   * @internal
   */
  public get assignPublicIp() {
    return output(this.run.publicIp);
  }

  /**
   * Linking a task gives the linked resource what it needs to run it with the
   * [Task SDK](/docs/component/aws/task#sdk), and lets it run, describe and stop the task.
   */
  public link() {
    return {
      properties: {
        cluster: this.cluster,
        containers: this.containers,
        taskDefinition: this.taskDefinition,
        subnets: this.subnets,
        securityGroups: this.securityGroups,
        assignPublicIp: this.assignPublicIp,
      },
      include: [
        permission({
          actions: ["ecs:*"],
          resources: [
            this.nodes.taskDefinition.arn,
            // permissions to describe and stop the task
            this.cluster.apply(
              (v) => v.split(":cluster/").join(":task/") + "/*",
            ),
          ],
        }),
        permission({
          actions: ["iam:PassRole"],
          resources: [this.nodes.executionRole.arn, this.nodes.taskRole.arn],
        }),
      ],
    };
  }
}
