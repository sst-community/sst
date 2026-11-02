import fs from "fs";
import path from "path";
import {
  all,
  type ComponentResourceOptions,
  interpolate,
  jsonStringify,
  type Output,
  output,
  secret,
} from "@pulumi/pulumi";
import {
  cloudwatch,
  ecr,
  ecs,
  getCallerIdentityOutput,
  getPartitionOutput,
  iam,
} from "@pulumi/aws";
import { type Image, type ImageArgs, Platform } from "@pulumi/docker-build";
import { plain } from "../../args";
import { toNumber } from "../../cpu";
import { toSeconds } from "../../duration";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import { Link } from "../../link";
import { physicalName } from "../../naming";
import type { ManyPart, Parts, PartsComponent } from "../../parts-component";
import { toGBs, toMBs } from "../../size";
import { transformPart } from "../../transform";
import type { Cluster as OriginalCluster } from "../cluster";
import { Efs as OriginalEfs } from "../efs";
import { RETENTION } from "../logging";
import type { Permission } from "../permission";
import type { Cluster } from "../v5/cluster";
import { Efs } from "../v5/efs";
import type { FunctionPermissionArgs } from "../v5/function";
import type { ServiceArgs } from "../service";
import { bootstrap } from "./bootstrap";
import { imageBuilder } from "./container-builder";
import { isVpc } from "./vpc";

// The CPU a task can have, in CPU units, and the memory it can have with each,
// in MB
export const supportedCpus = {
  "0.25 vCPU": 256,
  "0.5 vCPU": 512,
  "1 vCPU": 1024,
  "2 vCPU": 2048,
  "4 vCPU": 4096,
  "8 vCPU": 8192,
  "16 vCPU": 16384,
};

export const supportedMemories = {
  "0.25 vCPU": {
    "0.5 GB": 512,
    "1 GB": 1024,
    "2 GB": 2048,
  },
  "0.5 vCPU": {
    "1 GB": 1024,
    "2 GB": 2048,
    "3 GB": 3072,
    "4 GB": 4096,
  },
  "1 vCPU": {
    "2 GB": 2048,
    "3 GB": 3072,
    "4 GB": 4096,
    "5 GB": 5120,
    "6 GB": 6144,
    "7 GB": 7168,
    "8 GB": 8192,
  },
  "2 vCPU": {
    "4 GB": 4096,
    "5 GB": 5120,
    "6 GB": 6144,
    "7 GB": 7168,
    "8 GB": 8192,
    "9 GB": 9216,
    "10 GB": 10240,
    "11 GB": 11264,
    "12 GB": 12288,
    "13 GB": 13312,
    "14 GB": 14336,
    "15 GB": 15360,
    "16 GB": 16384,
  },
  "4 vCPU": {
    "8 GB": 8192,
    "9 GB": 9216,
    "10 GB": 10240,
    "11 GB": 11264,
    "12 GB": 12288,
    "13 GB": 13312,
    "14 GB": 14336,
    "15 GB": 15360,
    "16 GB": 16384,
    "17 GB": 17408,
    "18 GB": 18432,
    "19 GB": 19456,
    "20 GB": 20480,
    "21 GB": 21504,
    "22 GB": 22528,
    "23 GB": 23552,
    "24 GB": 24576,
    "25 GB": 25600,
    "26 GB": 26624,
    "27 GB": 27648,
    "28 GB": 28672,
    "29 GB": 29696,
    "30 GB": 30720,
  },
  "8 vCPU": {
    "16 GB": 16384,
    "20 GB": 20480,
    "24 GB": 24576,
    "28 GB": 28672,
    "32 GB": 32768,
    "36 GB": 36864,
    "40 GB": 40960,
    "44 GB": 45056,
    "48 GB": 49152,
    "52 GB": 53248,
    "56 GB": 57344,
    "60 GB": 61440,
  },
  "16 vCPU": {
    "32 GB": 32768,
    "40 GB": 40960,
    "48 GB": 49152,
    "56 GB": 57344,
    "64 GB": 65536,
    "72 GB": 73728,
    "80 GB": 81920,
    "88 GB": 90112,
    "96 GB": 98304,
    "104 GB": 106496,
    "112 GB": 114688,
    "120 GB": 122880,
  },
};

/** Where a task or service runs: the VPC of its cluster. */
export type Network = {
  /** A `Vpc`, as opposed to a VPC given by its ids. */
  isSstVpc: boolean;
  id: Output<string>;
  publicSubnets: Output<string[]>;
  containerSubnets: Output<string[]>;
  /** The subnets of a load balancer that is, or isn't, public. */
  loadBalancerSubnets: (isPublic: Input<boolean>) => Output<string[]>;
  securityGroups: Output<string[]>;
  cloudmapNamespaceId: Output<string | undefined>;
  cloudmapNamespaceName: Output<string | undefined>;
};

/**
 * The VPC of a cluster, read the same way whether the cluster was given a
 * `Vpc` or the ids of one.
 */
export function networkOf(cluster: OriginalCluster | Cluster): Network {
  const ids = (list: Input<Input<string>[]> | undefined) =>
    output(list ?? []) as Output<string[]>;

  if (isVpc(cluster.vpc)) {
    const vpc = cluster.vpc;
    return {
      isSstVpc: true,
      id: vpc.id,
      publicSubnets: ids(vpc.publicSubnets),
      // In a `Vpc` the containers run in the public subnets
      containerSubnets: ids(vpc.publicSubnets),
      loadBalancerSubnets: (isPublic) =>
        output(isPublic).apply((v) =>
          ids(v ? vpc.publicSubnets : vpc.privateSubnets),
        ),
      securityGroups: ids(vpc.securityGroups),
      cloudmapNamespaceId: vpc.nodes.cloudmapNamespace.id,
      cloudmapNamespaceName: vpc.nodes.cloudmapNamespace.name,
    };
  }

  const custom = output(cluster.vpc);
  return {
    isSstVpc: false,
    id: custom.apply((v) => v.id),
    publicSubnets: custom.apply((v) => ids(v.publicSubnets)),
    containerSubnets: custom.apply((v) => ids(v.containerSubnets)),
    loadBalancerSubnets: () => custom.apply((v) => ids(v.loadBalancerSubnets)),
    securityGroups: custom.apply((v) => ids(v.securityGroups)),
    cloudmapNamespaceId: custom.apply((v) => v.cloudmapNamespaceId),
    cloudmapNamespaceName: custom.apply((v) => v.cloudmapNamespaceName),
  };
}

/**
 * What a V5 task and a V5 service take that the 4.x ones don't: either kind
 * of cluster, and either kind of file system.
 */
export interface FargateArgs {
  /**
   * The ECS Cluster to use. Create one in your app, if you haven't already.
   *
   * ```js title="sst.config.ts"
   * const vpc = new sst.aws.v5.Vpc("MyVpc");
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
   * Mount Amazon EFS file systems into the container.
   *
   * @example
   * Create an EFS file system.
   *
   * ```ts title="sst.config.ts"
   * const vpc = new sst.aws.v5.Vpc("MyVpc");
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
 * What a task and a service both run, and with what.
 */
export interface FargateBaseArgs extends FargateArgs {
  /**
   * The CPU architecture of the container.
   * @default `"x86_64"`
   * @example
   * ```js
   * {
   *   architecture: "arm64"
   * }
   * ```
   */
  architecture?: Input<"x86_64" | "arm64">;
  /**
   * The amount of CPU allocated to the container. If there are multiple containers, this is
   * the total amount of CPU shared across all the containers.
   *
   * :::note
   * [View the valid combinations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#fargate-tasks-size) of CPU and memory.
   * :::
   *
   * @default `"0.25 vCPU"`
   * @example
   * ```js
   * {
   *   cpu: "1 vCPU"
   * }
   * ```
   */
  cpu?: keyof typeof supportedCpus;
  /**
   * The amount of memory allocated to the container. If there are multiple containers, this is
   * the total amount of memory shared across all the containers.
   *
   * :::note
   * [View the valid combinations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#fargate-tasks-size) of CPU and memory.
   * :::
   *
   * @default `"0.5 GB"`
   *
   * @example
   * ```js
   * {
   *   memory: "2 GB"
   * }
   * ```
   */
  memory?: `${number} GB`;
  /**
   * The amount of ephemeral storage (in GB) allocated to the container.
   *
   * @default `"20 GB"`
   *
   * @example
   * ```js
   * {
   *   storage: "100 GB"
   * }
   * ```
   */
  storage?: `${number} GB`;
  /**
   * [Link resources](/docs/linking/) to your containers. This will:
   *
   * 1. Grant the permissions needed to access the resources.
   * 2. Allow you to access it in your app using the [SDK](/docs/reference/sdk/).
   *
   * @example
   *
   * Takes a list of components to link to the containers.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: Input<any[]>;
  /**
   * Permissions and the resources that you need to access. These permissions are
   * used to create the [task role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html).
   *
   * :::tip
   * If you `link` a resource, the permissions to access it are automatically added.
   * :::
   *
   * @example
   * Allow the container to read and write to an S3 bucket called `my-bucket`.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:GetObject", "s3:PutObject"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     },
   *   ]
   * }
   * ```
   *
   * Allow the container to perform all actions on an S3 bucket called `my-bucket`.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:*"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     },
   *   ]
   * }
   * ```
   *
   * Granting the container permissions to access all resources.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["*"],
   *       resources: ["*"]
   *     },
   *   ]
   * }
   * ```
   */
  permissions?: Input<FunctionPermissionArgs[]>;
  /**
   * Configure the Docker build command for building the image or specify a pre-built image.
   *
   * @default Build a Docker image from the Dockerfile in the root directory.
   * @example
   *
   * Building a Docker image.
   *
   * Prior to building the image, SST will automatically add the `.sst` directory
   * to the `.dockerignore` if not already present.
   *
   * ```js
   * {
   *   image: {
   *     context: "./app",
   *     dockerfile: "Dockerfile",
   *     args: {
   *       MY_VAR: "value"
   *     }
   *   }
   * }
   * ```
   *
   * Alternatively, you can pass in a pre-built image.
   *
   * ```js
   * {
   *   image: "nginxdemos/hello:plain-text"
   * }
   * ```
   */
  image?: Input<
    | string
    | {
        /**
         * The path to the [Docker build context](https://docs.docker.com/build/building/context/#local-context). The path is relative to your project's `sst.config.ts`.
         * @default `"."`
         * @example
         *
         * To change where the Docker build context is located.
         *
         * ```js
         * {
         *   context: "./app"
         * }
         * ```
         */
        context?: Input<string>;
        /**
         * The path to the [Dockerfile](https://docs.docker.com/reference/cli/docker/image/build/#file).
         * The path is relative to the build `context`.
         * @default `"Dockerfile"`
         * @example
         * To use a different Dockerfile.
         * ```js
         * {
         *   dockerfile: "Dockerfile.prod"
         * }
         * ```
         */
        dockerfile?: Input<string>;
        /**
         * Key-value pairs of [build args](https://docs.docker.com/build/guide/build-args/) to pass to the Docker build command.
         * @example
         * ```js
         * {
         *   args: {
         *     MY_VAR: "value"
         *   }
         * }
         * ```
         */
        args?: Input<Record<string, Input<string>>>;
        /**
         * Key-value pairs of [build secrets](https://docs.docker.com/build/building/secrets/) to pass to the Docker build.
         *
         * Unlike build args, secrets are not persisted in the final image. They are
         * available in the Dockerfile via [`--mount=type=secret`](https://docs.docker.com/build/building/secrets/#secret-mounts).
         *
         * @example
         * ```js
         * {
         *   secrets: {
         *     MY_TOKEN: "my-secret-token",
         *   }
         * }
         * ```
         *
         * Then in the Dockerfile, reference it as a file:
         * ```dockerfile title="Dockerfile"
         * RUN --mount=type=secret,id=MY_TOKEN \
         *   cat /run/secrets/MY_TOKEN
         * ```
         *
         * Or as an environment variable:
         * ```dockerfile title="Dockerfile"
         * RUN --mount=type=secret,id=MY_TOKEN,env=MY_TOKEN \
         *   echo $MY_TOKEN
         * ```
         */
        secrets?: Input<Record<string, Input<string>>>;
        /**
         * Tags to apply to the Docker image.
         * @example
         * ```js
         * {
         *   tags: ["v1.0.0", "commit-613c1b2"]
         * }
         * ```
         */
        tags?: Input<Input<string>[]>;
        /**
         * The stage to build up to in a [multi-stage Dockerfile](https://docs.docker.com/build/building/multi-stage/#stop-at-a-specific-build-stage).
         * @example
         * ```js
         * {
         *   target: "stage1"
         * }
         * ```
         */
        target?: Input<string>;
        /**
         * Controls whether Docker build cache is enabled.
         * @default `true`
         * @example
         * Disable Docker build caching, useful for environments like Localstack where
         * ECR cache export is not supported.
         * ```js
         * {
         *   image: {
         *     cache: false
         *   }
         * }
         * ```
         */
        cache?: Input<boolean>;
      }
  >;
  /**
   * The command to override the default command in the container.
   * @example
   * ```js
   * {
   *   command: ["npm", "run", "start"]
   * }
   * ```
   */
  command?: Input<Input<string>[]>;
  /**
   * The entrypoint that overrides the default entrypoint in the container.
   * @example
   * ```js
   * {
   *   entrypoint: ["/usr/bin/my-entrypoint"]
   * }
   * ```
   */
  entrypoint?: Input<string[]>;
  /**
   * Key-value pairs of values that are set as [container environment variables](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/taskdef-envfiles.html).
   * The keys need to:
   *
   * 1. Start with a letter.
   * 2. Be at least 2 characters long.
   * 3. Contain only letters, numbers, or underscores.
   *
   * @example
   *
   * ```js
   * {
   *   environment: {
   *     DEBUG: "true"
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * A list of Amazon S3 object ARNs pointing to [environment files](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/use-environment-file.html)
   * used to load environment variables into the container.
   *
   * Each file must be a plain text file in `.env` format.
   *
   * @example
   * Create an S3 bucket and upload an environment file.
   *
   * ```ts title="sst.config.ts"
   * const bucket = new sst.aws.v5.Bucket("EnvBucket");
   * const file = new aws.s3.BucketObjectv2("EnvFile", {
   *   bucket: bucket.name,
   *   key: "test.env",
   *   content: ["FOO=hello", "BAR=world"].join("\n"),
   * });
   * ```
   *
   * And pass in the ARN of the environment file.
   *
   * ```js title="sst.config.ts"
   * {
   *   environmentFiles: [file.arn]
   * }
   * ```
   */
  environmentFiles?: Input<Input<string>[]>;
  /**
   * Key-value pairs of AWS Systems Manager Parameter Store parameter ARNs or AWS Secrets
   * Manager secret ARNs. The values will be loaded into the container as environment
   * variables.
   * @example
   * ```js
   * {
   *   ssm: {
   *     DATABASE_PASSWORD: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-123abc"
   *   }
   * }
   * ```
   */
  ssm?: Input<Record<string, Input<string>>>;
  /**
   * Configure the logs in CloudWatch.
   * @default `{ retention: "1 month" }`
   * @example
   * ```js
   * {
   *   logging: {
   *     retention: "forever"
   *   }
   * }
   * ```
   */
  logging?: Input<{
    /**
     * The duration the logs are kept in CloudWatch.
     * @default `"1 month"`
     */
    retention?: Input<keyof typeof RETENTION>;
    /**
     * The name of the CloudWatch log group. If omitted, the name is made from the cluster's
     * name, the app, the stage, the name you give this component with a random suffix, and
     * the container's name.
     *
     * It's read when the log group is created. Changing it later changes nothing.
     * @default `"/sst/cluster/${CLUSTER_NAME}/${APP}-${STAGE}-${NAME}-${SUFFIX}/${CONTAINER_NAME}"`
     */
    name?: Input<string>;
  }>;
}

/**
 * A container to run, and what it runs.
 */
export interface ContainerArgs {
  /**
   * The name of the container.
   *
   * This is used as the `--name` option in the Docker run command. It has to be a plain
   * value: the container's log group and image are named after it.
   */
  name: string;
  /**
   * The amount of CPU allocated to the container.
   *
   * By default, a container can use up to all the CPU allocated to all the containers. If set,
   * this container is capped at this allocation even if more idle CPU is available.
   *
   * The sum of all the containers' CPU must be less than or equal to the total available CPU.
   *
   * @example
   * ```js
   * {
   *   cpu: "0.25 vCPU"
   * }
   * ```
   */
  cpu?: `${number} vCPU`;
  /**
   * The amount of memory allocated to the container.
   *
   * By default, a container can use up to all the memory allocated to all the containers. If
   * set, the container is capped at this allocation. If exceeded, the container will be killed
   * even if there is idle memory available.
   *
   * The sum of all the containers' memory must be less than or equal to the total available
   * memory.
   *
   * @example
   * ```js
   * {
   *   memory: "0.5 GB"
   * }
   * ```
   */
  memory?: `${number} GB`;
  /**
   * Configure the Docker image for the container. Same as the top-level [`image`](#image).
   */
  image?: Input<
    | string
    | {
        /**
         * The path to the Docker build context. Same as the top-level
         * [`image.context`](#image-context).
         */
        context?: Input<string>;
        /**
         * The path to the Dockerfile. Same as the top-level
         * [`image.dockerfile`](#image-dockerfile).
         */
        dockerfile?: Input<string>;
        /**
         * Key-value pairs of build args. Same as the top-level [`image.args`](#image-args).
         */
        args?: Input<Record<string, Input<string>>>;
        /**
         * Key-value pairs of [build secrets](https://docs.docker.com/build/building/secrets/) to pass to the Docker build.
         *
         * Unlike build args, secrets are not persisted in the final image. They are
         * available in the Dockerfile via [`--mount=type=secret`](https://docs.docker.com/build/building/secrets/#secret-mounts).
         *
         * @example
         * ```js
         * {
         *   secrets: {
         *     MY_TOKEN: "my-secret-token",
         *   }
         * }
         * ```
         *
         * Then in the Dockerfile, reference it as a file:
         * ```dockerfile title="Dockerfile"
         * RUN --mount=type=secret,id=MY_TOKEN \
         *   cat /run/secrets/MY_TOKEN
         * ```
         *
         * Or as an environment variable:
         * ```dockerfile title="Dockerfile"
         * RUN --mount=type=secret,id=MY_TOKEN,env=MY_TOKEN \
         *   echo $MY_TOKEN
         * ```
         */
        secrets?: Input<Record<string, Input<string>>>;
        /**
         * Tags to apply to the Docker image.
         * @example
         * ```js
         * {
         *   tags: ["v1.0.0", "commit-613c1b2"]
         * }
         * ```
         */
        tags?: Input<Input<string>[]>;
        /**
         * The stage to build up to. Same as the top-level [`image.target`](#image-target).
         */
        target?: Input<string>;
        /**
         * Controls whether Docker build cache is enabled. Same as the top-level
         * [`image.cache`](#image-cache).
         * @default `true`
         */
        cache?: Input<boolean>;
      }
  >;
  /**
   * The command to override the default command in the container. Same as the top-level
   * [`command`](#command).
   */
  command?: Input<string[]>;
  /**
   * The entrypoint to override the default entrypoint in the container. Same as the top-level
   * [`entrypoint`](#entrypoint).
   */
  entrypoint?: Input<string[]>;
  /**
   * Key-value pairs of values that are set as container environment variables. Same as the
   * top-level [`environment`](#environment).
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * A list of Amazon S3 file paths of environment files to load environment variables
   * from. Same as the top-level [`environmentFiles`](#environmentFiles).
   */
  environmentFiles?: Input<Input<string>[]>;
  /**
   * Configure the logs in CloudWatch. Same as the top-level [`logging`](#logging).
   */
  logging?: Input<{
    /**
     * The duration the logs are kept in CloudWatch. Same as the top-level [`logging.retention`](#logging-retention).
     */
    retention?: Input<keyof typeof RETENTION>;
    /**
     * The name of the CloudWatch log group. Same as the top-level [`logging.name`](#logging-name).
     */
    name?: Input<string>;
  }>;
  /**
   * Key-value pairs of AWS Systems Manager Parameter Store parameter ARNs or AWS Secrets
   * Manager secret ARNs. The values will be loaded into the container as environment
   * variables. Same as the top-level [`ssm`](#ssm).
   */
  ssm?: FargateBaseArgs["ssm"];
  /**
   * Mount Amazon EFS file systems into the container. Same as the top-level
   * [`volumes`](#volumes).
   */
  volumes?: FargateArgs["volumes"];
}

/**
 * A container as the helpers here read it: a task's, or a service's with its
 * health check and what `sst dev` runs.
 */
export type Container = ContainerArgs & {
  health?: ServiceArgs["health"];
  dev?: ServiceArgs["dev"];
};

/** What a task or service says about its containers. */
type ContainersArgs = Pick<
  FargateBaseArgs,
  | "image"
  | "logging"
  | "environment"
  | "environmentFiles"
  | "ssm"
  | "command"
  | "entrypoint"
> & {
  containers?: Container[];
  volumes?: FargateArgs["volumes"];
  health?: ServiceArgs["health"];
  dev?: ServiceArgs["dev"];
};

/**
 * The containers of a task or service: the ones it lists, or a single one
 * named after the component, made from its top-level args.
 *
 * @param type What the component is, for the error messages.
 * @param name The component's name.
 */
export function containersOf(
  type: "service" | "task",
  args: ContainersArgs,
  name: string,
): Container[] {
  const containers = plain(
    args.containers,
    `The "containers" of the "${name}" ${type}`,
  );
  if (
    containers &&
    (args.image ||
      args.logging ||
      args.environment ||
      args.environmentFiles ||
      args.volumes ||
      args.health ||
      args.ssm)
  )
    throw new VisibleError(
      type === "service"
        ? `You cannot provide both "containers" and "image", "logging", "environment", "environmentFiles", "volumes", "health" or "ssm".`
        : `You cannot provide both "containers" and "image", "logging", "environment", "environmentFiles", "volumes" or "ssm".`,
    );

  if (!containers)
    return [
      {
        name,
        image: args.image,
        logging: args.logging,
        environment: args.environment,
        environmentFiles: args.environmentFiles,
        ssm: args.ssm,
        volumes: args.volumes,
        command: args.command as Container["command"],
        entrypoint: args.entrypoint,
        health: type === "service" ? args.health : undefined,
        dev: type === "service" ? args.dev : undefined,
      },
    ];

  return containers.map((container, i) => {
    const what = `ontainer ${i + 1} of the "${name}" ${type}`;
    plain(container, `C${what}`);
    plain(container.name, `The "name" of c${what}`);
    return container;
  });
}

/** The CPU of a task, checked against what Fargate offers. */
export function cpuOf(args: Pick<FargateBaseArgs, "cpu">) {
  return output(args.cpu ?? "0.25 vCPU").apply((v) => {
    if (!supportedCpus[v])
      throw new Error(
        `Unsupported CPU: ${v}. The supported values for CPU are ${Object.keys(
          supportedCpus,
        ).join(", ")}`,
      );
    return v;
  });
}

/** The memory of a task, checked against what Fargate offers for its CPU. */
export function memoryOf(
  cpu: ReturnType<typeof cpuOf>,
  args: Pick<FargateBaseArgs, "memory">,
) {
  return all([cpu, args.memory ?? "0.5 GB"]).apply(([cpu, v]) => {
    if (!(v in supportedMemories[cpu]))
      throw new Error(
        `Unsupported memory: ${v}. The supported values for memory for a ${cpu} CPU are ${Object.keys(
          supportedMemories[cpu],
        ).join(", ")}`,
      );
    return v;
  });
}

/** The ephemeral storage of a task, checked against what Fargate offers. */
export function storageOf(args: Pick<FargateBaseArgs, "storage">) {
  return output(args.storage ?? "20 GB").apply((v) => {
    const storage = toGBs(v);
    if (storage < 20 || storage > 200)
      throw new Error(
        `Unsupported storage: ${v}. The supported value for storage is between "20 GB" and "200 GB"`,
      );
    return v;
  });
}

/**
 * The args of the role a task's containers run as: what the component is
 * linked to and given permission for, and what ECS Exec needs.
 *
 * @param opts The component's options, for the provider to look the account up with.
 * @param dev Whether the stub that runs in `sst dev` is deployed. The account
 * can then assume the role, which is how the local process gets its permissions.
 * @param additional Permissions the component adds.
 */
export function taskRoleArgs(
  args: Pick<FargateBaseArgs, "permissions" | "link">,
  opts: ComponentResourceOptions,
  dev: boolean,
  additional: FargateBaseArgs["permissions"] = [],
): iam.RoleArgs {
  const policy = all([
    args.permissions ?? [],
    Link.getInclude<Permission>("aws.permission", args.link),
    additional ?? [],
  ]).apply(([argsPermissions, linkPermissions, additionalPermissions]) =>
    iam.getPolicyDocumentOutput({
      statements: [
        ...argsPermissions,
        ...linkPermissions,
        ...additionalPermissions,
        {
          actions: [
            "ssmmessages:CreateControlChannel",
            "ssmmessages:CreateDataChannel",
            "ssmmessages:OpenControlChannel",
            "ssmmessages:OpenDataChannel",
          ],
          resources: ["*"],
        },
      ].map((item) => ({
        effect: (() => {
          const effect = item.effect ?? "allow";
          return effect.charAt(0).toUpperCase() + effect.slice(1);
        })(),
        actions: item.actions,
        resources: item.resources,
        conditions: "conditions" in item ? item.conditions : undefined,
      })),
    }),
  );

  return {
    assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
      Service: "ecs-tasks.amazonaws.com",
      ...(dev ? { AWS: getCallerIdentityOutput({}, opts).accountId } : {}),
    }),
    inlinePolicies: policy.apply(({ statements }) =>
      statements ? [{ name: "inline", policy: policy.json }] : [],
    ),
  };
}

/**
 * The args of the role ECS starts a task with: it pulls the images and reads
 * the secrets and environment files the containers are given.
 *
 * @param opts The component's options, for the provider to look the partition up with.
 */
export function executionRoleArgs(
  args: Pick<FargateBaseArgs, "environmentFiles">,
  opts: ComponentResourceOptions,
): iam.RoleArgs {
  return {
    assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
      Service: "ecs-tasks.amazonaws.com",
    }),
    managedPolicyArns: [
      interpolate`arn:${
        getPartitionOutput({}, opts).partition
      }:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`,
    ],
    inlinePolicies: [
      {
        name: "inline",
        policy: iam.getPolicyDocumentOutput({
          statements: [
            {
              sid: "ReadSsmAndSecrets",
              actions: [
                "ssm:GetParameters",
                "ssm:GetParameter",
                "ssm:GetParameterHistory",
                "secretsmanager:GetSecretValue",
              ],
              resources: ["*"],
            },
            ...(args.environmentFiles
              ? [
                  {
                    sid: "ReadEnvironmentFiles",
                    actions: ["s3:GetObject"],
                    resources: args.environmentFiles,
                  },
                ]
              : []),
          ],
        }).json,
      },
    ],
  };
}

/**
 * The args of a container's log group.
 *
 * @param name The component's name.
 */
export function logGroupArgs(
  container: Container,
  cluster: OriginalCluster | Cluster,
  name: string,
): cloudwatch.LogGroupArgs {
  const logging = all([container.logging, cluster.nodes.cluster.name]).apply(
    ([logging, clusterName]) => ({
      retention: logging?.retention ?? "1 month",
      name:
        logging?.name ??
        // In the case of shared Cluster across stage, log group name can thrash
        // if Task name is the same. Need to suffix the task name with random hash.
        `/sst/cluster/${clusterName}/${physicalName(64, name)}/${container.name}`,
    }),
  );
  return {
    name: logging.name,
    retentionInDays: logging.apply((logging) => RETENTION[logging.retention]),
  };
}

/**
 * The image a container runs: the one it names, or one built from its
 * Dockerfile and pushed to the app's registry.
 *
 * An image that's built is a part of the component, declared as
 * `many(Image)` and kept under the container's name. It's created once the
 * container's image settings are known, so it appears in `nodes` then.
 *
 * @param component The task or service the container belongs to.
 * @param key The part the built image is kept as.
 * @param build What every image of the component is built with: the
 * architecture, what's linked, and the region to push to.
 */
export function containerImage<P extends Parts>(
  component: PartsComponent<P>,
  key: ImageKeys<P>,
  container: Container,
  build: {
    architecture: Input<"x86_64" | "arm64">;
    link: FargateBaseArgs["link"];
    region: Output<string>;
  },
): Output<string> {
  const bootstrapData = build.region.apply((region) =>
    bootstrap.forRegion(region),
  );
  const linkEnvs = Link.propertiesToEnv(Link.getProperties(build.link));

  return all([container.image, build.architecture]).apply(
    ([image, architecture]) => {
      if (typeof image === "string") return output(image);

      const contextPath = path.join($cli.paths.root, image?.context ?? ".");
      const dockerfile = image?.dockerfile ?? "Dockerfile";
      ignoreSstDirectory(contextPath, dockerfile);

      const part = component.partHandle(key, container.name);
      const built = imageBuilder(
        ...transformPart<ImageArgs>(
          part.transform,
          part.name,
          {
            context: { location: contextPath },
            dockerfile: { location: path.join(contextPath, dockerfile) },
            buildArgs: image?.args,
            secrets: all([linkEnvs, image?.secrets ?? {}]).apply(
              ([link, secrets]) => ({ ...link, ...secrets }),
            ),
            target: image?.target,
            platforms: [
              architecture === "arm64"
                ? Platform.Linux_arm64
                : Platform.Linux_amd64,
            ],
            tags: [container.name, ...(image?.tags ?? [])].map(
              (tag) => interpolate`${bootstrapData.assetEcrUrl}:${tag}`,
            ),
            registries: [
              ecr
                .getAuthorizationTokenOutput(
                  { registryId: bootstrapData.assetEcrRegistryId },
                  { parent: component },
                )
                .apply((authToken) => ({
                  address: authToken.proxyEndpoint,
                  password: secret(authToken.password),
                  username: authToken.userName,
                })),
            ],
            ...(image?.cache !== false
              ? {
                  cacheFrom: [
                    {
                      registry: {
                        ref: interpolate`${bootstrapData.assetEcrUrl}:${container.name}-cache`,
                      },
                    },
                  ],
                  cacheTo: [
                    {
                      registry: {
                        ref: interpolate`${bootstrapData.assetEcrUrl}:${container.name}-cache`,
                        imageManifest: true,
                        ociMediaTypes: true,
                        mode: "max",
                      },
                    },
                  ],
                }
              : {}),
            push: true,
          },
          part.opts,
        ),
      );

      return interpolate`${bootstrapData.assetEcrUrl}@${built.digest}`;
    },
  );
}

// The `.sst` directory holds SST's own files, which don't belong in an
// image: add it to the Dockerfile's ignore file.
function ignoreSstDirectory(contextPath: string, dockerfile: string) {
  const dockerIgnorePath = fs.existsSync(
    path.join(contextPath, `${dockerfile}.dockerignore`),
  )
    ? path.join(contextPath, `${dockerfile}.dockerignore`)
    : path.join(contextPath, ".dockerignore");

  const lines = fs.existsSync(dockerIgnorePath)
    ? fs.readFileSync(dockerIgnorePath).toString().split("\n")
    : [];
  if (!lines.find((line) => line === ".sst"))
    fs.writeFileSync(
      dockerIgnorePath,
      [...lines, "", "# sst", ".sst"].join("\n"),
    );
}

/**
 * The args of a task definition that runs the given containers on Fargate.
 */
export function taskDefinitionArgs(task: {
  /** The component's name. */
  name: string;
  cluster: OriginalCluster | Cluster;
  region: Output<string>;
  link: FargateBaseArgs["link"];
  /** Each container, with the image it runs and the log group it writes to. */
  containers: {
    container: Container;
    image: Input<string>;
    logGroup: cloudwatch.LogGroup;
  }[];
  architecture: Input<"x86_64" | "arm64">;
  cpu: ReturnType<typeof cpuOf>;
  memory: ReturnType<typeof memoryOf>;
  storage: ReturnType<typeof storageOf>;
  taskRole: iam.Role;
  executionRole: iam.Role;
}): ecs.TaskDefinitionArgs {
  const linkEnvs = Link.propertiesToEnv(Link.getProperties(task.link));
  // Each container's volumes, as the ids of a file system and its access point
  const volumes = task.containers.map(({ container }) =>
    output(container.volumes).apply((volumes) =>
      volumes?.map((volume) => ({
        path: volume.path,
        efs:
          volume.efs instanceof OriginalEfs || volume.efs instanceof Efs
            ? {
                fileSystem: volume.efs.id,
                accessPoint: volume.efs.accessPoint,
              }
            : volume.efs,
      })),
    ),
  );
  const containers = output(
    task.containers.map(({ container, image, logGroup }, i) => ({
      ...container,
      image,
      logGroup: logGroup.name,
      volumes: volumes[i],
    })),
  );

  const containerDefinitions = containers.apply((containers) =>
    containers.map((container) => ({
      name: container.name,
      image: container.image,
      cpu: container.cpu ? toNumber(container.cpu) : undefined,
      memory: container.memory ? toMBs(container.memory) : undefined,
      command: container.command,
      entrypoint: container.entrypoint,
      healthCheck: container.health && {
        command: container.health.command,
        startPeriod: toSeconds(container.health.startPeriod ?? "0 seconds"),
        timeout: toSeconds(container.health.timeout ?? "5 seconds"),
        interval: toSeconds(container.health.interval ?? "30 seconds"),
        retries: container.health.retries ?? 3,
      },
      pseudoTerminal: true,
      portMappings: [{ containerPortRange: "1-65535" }],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": container.logGroup,
          "awslogs-region": task.region,
          "awslogs-stream-prefix": "/service",
        },
      },
      environment: linkEnvs.apply((linkEnvs) =>
        Object.entries({
          ...container.environment,
          ...linkEnvs,
        }).map(([name, value]) => ({ name, value })),
      ),
      environmentFiles: container.environmentFiles?.map((file) => ({
        type: "s3",
        value: file,
      })),
      linuxParameters: {
        initProcessEnabled: true,
      },
      mountPoints: container.volumes?.map((volume) => ({
        sourceVolume: volume.efs.accessPoint,
        containerPath: volume.path,
      })),
      secrets: Object.entries(container.ssm ?? {}).map(([name, valueFrom]) => ({
        name,
        valueFrom,
      })),
    })),
  );

  return {
    family: interpolate`${task.cluster.nodes.cluster.name}-${task.name}`,
    trackLatest: true,
    cpu: task.cpu.apply((v) => toNumber(v).toString()),
    memory: task.memory.apply((v) => toMBs(v).toString()),
    networkMode: "awsvpc",
    // Fargate includes 20 GB, which isn't something to ask for
    ephemeralStorage: task.storage.apply((storage) => {
      const sizeInGib = toGBs(storage);
      return sizeInGib === 20 ? undefined : { sizeInGib };
    }) as ecs.TaskDefinitionArgs["ephemeralStorage"],
    requiresCompatibilities: ["FARGATE"],
    runtimePlatform: {
      cpuArchitecture: output(task.architecture).apply((v) => v.toUpperCase()),
      operatingSystemFamily: "LINUX",
    },
    executionRoleArn: task.executionRole.arn,
    taskRoleArn: task.taskRole.arn,
    // A volume that several containers mount is listed once. This is read
    // from the volumes alone: an image that's built is a secret, and what's
    // made from it would be one too.
    volumes: output(volumes).apply((volumes) => {
      const uniqueAccessPoints: Set<string> = new Set();
      return volumes.flatMap((mounted) =>
        (mounted ?? []).flatMap((volume) => {
          if (uniqueAccessPoints.has(volume.efs.accessPoint)) return [];
          uniqueAccessPoints.add(volume.efs.accessPoint);
          return {
            name: volume.efs.accessPoint,
            efsVolumeConfiguration: {
              fileSystemId: volume.efs.fileSystem,
              transitEncryption: "ENABLED",
              authorizationConfig: {
                accessPointId: volume.efs.accessPoint,
              },
            },
          };
        }),
      );
    }),
    containerDefinitions: jsonStringify(containerDefinitions),
  };
}

type ImageKeys<P extends Parts> = {
  [K in keyof P]: P[K] extends ManyPart<typeof Image> ? K : never;
}[keyof P] &
  string;
