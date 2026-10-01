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
import type { Cluster } from "../cluster";
import { Efs } from "../efs";
import {
  type FargateBaseArgs,
  type FargateContainerArgs,
  supportedCpus,
  supportedMemories,
} from "../fargate";
import { RETENTION } from "../logging";
import type { Permission } from "../permission";
import type { ServiceArgs } from "../service";
import { bootstrap } from "./bootstrap";
import { imageBuilder } from "./container-builder";

/**
 * A container of a task or service. The name is a plain value: the
 * container's log group and image are named after it.
 */
export type Container = Omit<FargateContainerArgs, "name"> & {
  name: string;
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
  | "volumes"
  | "command"
  | "entrypoint"
> & {
  containers?: Container[];
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
  cluster: Cluster,
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
  cluster: Cluster;
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
  // Each container's volumes. A volume is given as an `Efs`, or as the ids
  // of a file system and one of its access points.
  const volumes = task.containers.map(({ container }) =>
    output(container.volumes).apply((volumes) =>
      volumes?.map((volume) => ({
        path: volume.path,
        efs:
          volume.efs instanceof Efs
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
