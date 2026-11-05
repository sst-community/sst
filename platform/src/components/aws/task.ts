import {
  all,
  ComponentResourceOptions,
  type Output,
  output,
} from "@pulumi/pulumi";
import { ec2, ecs } from "@pulumi/aws";
import { type ComponentArgs, component, optional } from "../parts-component";
import { notAnExistingPart, plain } from "../args";
import { VisibleError } from "../error";
import { devStub, context } from "../contract";
import {
  type Container,
  type ContainerArgs,
  type FargateBaseArgs,
  createTaskDefinition,
  fargateTaskOf,
  fargateTaskParts,
  givenTaskDefinition,
  rolesToPass,
  taskRoleArgs,
} from "./helpers/fargate";
import { securityGroupArgs } from "./helpers/load-balancer-args";
import { permission } from "./permission";
import type { Input } from "../input";

const parts = {
  ...fargateTaskParts,
  /**
   * The Amazon ECS Task Definition.
   */
  taskDefinition: ecs.TaskDefinition,
  /**
   * The AWS Security Group for public tasks. Only created when `public` is `true`.
   */
  publicSecurityGroup: optional(ec2.SecurityGroup),
};

export interface TaskArgs extends ComponentArgs<typeof parts>, FargateBaseArgs {
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
  containers?: ContainerArgs[];
  /**
   * Make the task publicly accessible from the internet.
   *
   * :::note
   * Tasks in a `Vpc` are placed in public subnets with a public IP by default for
   * outbound internet access. The `public` property controls whether the task is
   * _reachable_ from the internet.
   * :::
   *
   * A public task runs in the cluster's public subnets, with a security group that lets
   * anything in. If the cluster was given the ids of a VPC, give it `vpc.publicSubnets`
   * too.
   *
   * It has to be a plain value: it decides whether the security group is created.
   *
   * @default false
   *
   * @example
   * ```ts
   * {
   *   public: true
   * }
   * ```
   */
  public?: boolean;
  /**
   * Give the task a public IP address, so it can reach the internet from a public subnet
   * without a NAT.
   *
   * A task in a `Vpc` has one by default, since it runs in the VPC's public subnets. A
   * task in a cluster that was given the ids of a VPC doesn't, unless you set this. A
   * `public` task always has one.
   *
   * It only helps in a public subnet: in a cluster given the ids of a VPC, the task runs in
   * `vpc.containerSubnets`, and in private subnets a public IP does nothing. In a `Vpc`,
   * `false` leaves the task in a public subnet with no way out, so it can't pull its image
   * or send its logs unless the VPC has endpoints for them.
   *
   * @default `true` in a `Vpc`, `false` otherwise
   * @example
   * ```ts
   * {
   *   publicIp: true
   * }
   * ```
   */
  publicIp?: boolean;
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` a _stub_ version of your task is deployed.
   * :::
   *
   * By default, your task is not deployed in `sst dev`. Instead, you can set the `dev.command`
   * and it'll run locally in a **Tasks** tab in the `sst dev` multiplexer.
   *
   * Here's what happens when you run `sst dev`:
   *
   * 1. A _stub_ version of your task is deployed. This is a minimal image that starts up
   *    faster.
   * 2. When your task is started through the SDK, the stub version is provisioned. This can
   *    take roughly **10 - 20 seconds**.
   * 3. The stub version proxies the payload to your local machine using the same events
   *    system used by [Live](/docs/live/).
   * 4. The `dev.command` is called to run your task locally. Once complete, the stub version
   *    of your task is stopped as well.
   *
   * The advantage with this approach is that you can test your task locally even if it's invoked
   * remotely, or through a cron job.
   *
   * :::note
   * You are charged for the time it takes to run the stub version of your task.
   * :::
   *
   * Since the stub version runs while your task is running, you are charged for the time it
   * takes to run. This is roughly **$0.02 per hour**.
   *
   * What the `dev.command` prints shows in the **Tasks** tab. To also print it in the
   * task's log group, through the stub, set `SST_DEV_CLOUDWATCH_LOGS=true` when you run
   * `sst dev`. [Read more about logs](/docs/live/#logs).
   *
   * To disable this and deploy your task in `sst dev`, pass in `false`. Read more about
   * [Live](/docs/live/) and [`sst dev`](/docs/reference/cli/#dev).
   *
   * It has to be a plain value: it decides whether the stub is deployed.
   */
  dev?:
    | false
    | {
        /**
         * The command that `sst dev` runs in dev mode.
         */
        command?: Input<string>;
        /**
         * Change the directory from where the `command` is run.
         * @default The `image.context` of the first container, or your app's root when
         * its image is a reference
         */
        directory?: Input<string>;
      };
}

/**
 * The `Task` component lets you create containers that are used for long running asynchronous
 * work, like data processing. It uses [Amazon ECS](https://aws.amazon.com/ecs/) on
 * [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html).
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a Task
 *
 * Tasks are run inside an ECS Cluster. If you haven't already, create one.
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const cluster = new sst.aws.Cluster("MyCluster", { vpc });
 * ```
 *
 * Add the task to it.
 *
 * ```ts title="sst.config.ts"
 * const task = new sst.aws.Task("MyTask", { cluster });
 * ```
 *
 * #### Configure the container image
 *
 * By default, the task will look for a Dockerfile in the root directory. Optionally,
 * configure the image context and dockerfile.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Task("MyTask", {
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
 * new sst.aws.Task("MyTask", {
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
 * const bucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.Task("MyTask", {
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
 * With the [Task JS SDK](/docs/component/aws/v5/task#sdk), you can run your tasks, stop your
 * tasks, and get the status of your tasks.
 *
 * For example, you can link the task to a function in your app.
 *
 * ```ts title="sst.config.ts" {3}
 * new sst.aws.Function("MyFunction", {
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
 * new sst.aws.Task("MyTask", {
 *   cluster,
 *   existing: {
 *     taskRole: "my-task-role",
 *     executionRole: "my-execution-role"
 *   }
 * });
 * ```
 *
 * A role you pass is used as it is. What `link` grants isn't added to the task role, and
 * `permissions` next to it is refused: add them to the role itself. In `sst dev` neither is
 * what the stub needs: to reach your machine, and to let your AWS account assume the role.
 *
 * #### Run a task definition you already have
 *
 * Pass the task definition, or its ARN, and the task runs it the way it is.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Task("MyTask", {
 *   cluster,
 *   existing: {
 *     taskDefinition: "arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:3"
 *   }
 * });
 * ```
 *
 * The task then creates no roles, images or log groups: the task definition has its
 * containers, and what they run with. So the args that would make one, like `image`,
 * `containers`, `cpu`, `link` and `permissions`, are refused, and so are roles, images and
 * log groups in `existing`. What the task is linked to runs the task definition's
 * containers, and can pass its roles. In `sst dev` the task definition runs too, with no
 * stub in its place, so `dev` is refused.
 *
 * #### Switch from SST 4's `sst.aws.Task`
 *
 * Keep the name, and `sst migrate` moves it. The task definition, its
 * roles, the containers' log groups and images, and the security group of a public task
 * are kept.
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
 * - `dev` is a plain value: it decides whether the stub is deployed.
 * - With `containers`, the top-level `image`, `command`, `entrypoint`, `logging`,
 *   `environment`, `environmentFiles`, `volumes` and `ssm` are refused: set them on each
 *   container. `sst.aws.Task` refused some of them and dropped the others.
 * - A container's own `environmentFiles` are granted to the execution role, which
 *   `sst.aws.Task` left out. A task whose containers have them gets its execution role
 *   updated in place when you switch.
 * - `permissions` next to a `taskRole` in `existing` are refused. `sst.aws.Task` left them
 *   out of the role it was given.
 * - `nodes.taskRole` and `nodes.executionRole` may be `undefined`: they aren't created for
 *   a task definition you pass in `existing`.
 * - `cluster` takes either `Cluster`, and refuses anything else. A `cpu`, `memory` or
 *   `storage` Fargate doesn't offer is refused as the config is read.
 *
 * ---
 *
 * ### Cost
 *
 * By default, this uses a _Linux/X86_ _Fargate_ container with 0.25 vCPUs at $0.04048 per
 * vCPU per hour and 0.5 GB of memory at $0.004445 per GB per hour. It includes 20GB of
 * _Ephemeral Storage_ for free with additional storage at $0.000111 per GB per hour. In a
 * `Vpc`, or with `publicIp`, each task also gets a public IPv4 address at $0.005 per hour.
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
    containers: Output<string[]>;
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

    const owner = `the "${name}" task`;
    // A task definition that's already deployed is run the way it is, in
    // `sst dev` too. What would make one is refused, and nothing it would be
    // made with is created.
    const given = args.existing?.taskDefinition !== undefined;
    if (given)
      givenTaskDefinition(
        args,
        "task",
        owner,
        args.dev === false ? [] : ["dev"],
      );

    const task = fargateTaskOf(this.builder(), "task", name, args);
    const { cluster, containers } = task;
    const vpc = task.network;
    const isPublic =
      plain(args.public, `The "public" of the "${name}" task`) ?? false;
    if (isPublic && args.publicIp === false)
      throw new VisibleError(
        `"publicIp" can't be false when "public" is true in the "${name}" task: a public task has a public IP.`,
      );
    if (!isPublic)
      notAnExistingPart(
        args.existing,
        "publicSecurityGroup",
        owner,
        `It's only created when "public" is true.`,
      );
    // In `sst dev` a stub is deployed in place of the task. It hands what
    // the task is run with to the process on the user's machine.
    const dev =
      !given &&
      plain(args.dev, `The "dev" of the "${name}" task`) !== false &&
      context().dev;
    // A task in a `Vpc` is in a public subnet, and needs a public IP to
    // reach the internet
    const hasPublicIp = isPublic || (args.publicIp ?? vpc.isSstVpc);

    const publicSecurityGroup = isPublic
      ? this.part("publicSecurityGroup", securityGroupArgs(vpc.id))
      : undefined;

    let taskDefinition: ecs.TaskDefinition;
    if (given) taskDefinition = this.existingPart("taskDefinition")!;
    else {
      const taskRole = this.part(
        "taskRole",
        taskRoleArgs(
          args,
          this,
          dev,
          // The stub reaches the user's machine through the stage's transport
          dev ? output(devStub()).apply((stub) => stub.permissions) : [],
        ),
      );

      // The containers that are deployed. In `sst dev` that's the stub alone.
      taskDefinition = createTaskDefinition(
        this.builder(),
        name,
        task,
        args.link,
        dev ? [stub(containers[0])] : containers,
        taskRole,
      );
    }

    this.run = {
      cluster,
      // What the task is run with names each container. A task definition
      // that's given has containers of its own.
      containers: given
        ? taskDefinition.containerDefinitions.apply((definitions) =>
            (JSON.parse(definitions ?? "[]") as { name: string }[]).map(
              (container) => container.name,
            ),
          )
        : output(containers.map((container) => container.name)),
      subnets: isPublic
        ? vpc.publicSubnets.apply((subnets) => {
            if (!subnets.length)
              throw new VisibleError(
                `The "${name}" task is "public", and the "vpc" of its cluster has no "publicSubnets". Set them on the cluster.`,
              );
            return subnets;
          })
        : vpc.containerSubnets,
      securityGroups: publicSecurityGroup
        ? all([vpc.securityGroups, publicSecurityGroup.id]).apply(
            ([groups, publicGroup]) => [...groups, publicGroup],
          )
        : vpc.securityGroups,
      publicIp: hasPublicIp,
    };

    // What `sst dev` runs on the user's machine when the stub is started.
    // There's no stub for a task definition that's given.
    if (!given)
      this.report({
        task: all([args.dev, containers[0].image]).apply(([dev, image]) => ({
          directory: typeof image === "string" ? "" : image?.context ?? ".",
          ...dev,
        })),
      });

    function stub(container: Container): Container {
      return {
        ...container,
        entrypoint: undefined,
        command: undefined,
        image: "ghcr.io/sst-community/sst/bridge-task:latest",
        environment: all([container.environment, devStub()]).apply(
          ([environment, stub]) => ({
            ...environment,
            SST_TASK_ID: name,
            SST_REGION: process.env.SST_AWS_REGION!,
            ...stub.environment,
            SST_APP: context().app.name,
            SST_STAGE: context().app.stage,
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
    return this.run.containers;
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
   * [Task SDK](/docs/component/aws/v5/task#sdk), and lets it run, describe and stop the task.
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
          resources: rolesToPass(this.nodes.taskDefinition),
        }),
      ],
    };
  }
}
