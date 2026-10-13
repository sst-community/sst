import {
  all,
  ComponentResourceOptions,
  interpolate,
  jsonStringify,
  Output,
  output,
} from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { Component, Transform, transform } from "../component.js";
import { Link } from "../link.js";
import { Input } from "../input.js";
import { elasticache, secretsmanager } from "@pulumi/aws";
import { Vpc } from "./vpc.js";
import { toGBs } from "../size.js";
import { VisibleError } from "../error.js";
import { DevCommand } from "../experimental/dev-command.js";
import { Redis as RedisV1 } from "./redis-v1";

export interface RedisArgs {
  /**
   * The Redis engine to use. The following engines are supported:
   *
   * - `"redis"`: The open-source version of Redis.
   * - `"valkey"`: [Valkey](https://valkey.io/) is a Redis-compatible in-memory key-value store.
   *
   * :::danger
   * Changing the engine will cause the database to be destroyed and recreated.
   * :::
   *
   * @default `"redis"`
   */
  engine?: Input<"redis" | "valkey">;
  /**
   * The version of Redis.
   *
   * The default is `"7.1"` for the `"redis"` engine and `"7.2"` for the `"valkey"` engine.
   *
   * Check out the [supported versions](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/supported-engine-versions.html).
   *
   * :::caution
   * Changing the version will cause the instance to restart on the next `sst deploy`,
   * causing downtime. Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   * :::
   *
   * @default `"7.1"` for Redis, `"7.2"` for Valkey
   * @example
   * ```js
   * {
   *   version: "6.2"
   * }
   * ```
   */
  version?: Input<string>;
  /**
   * The type of instance to use for the nodes of the Redis instance. Check out the [supported instance types](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/CacheNodes.SupportedTypes.html).
   *
   * :::caution
   * Changing the instance type will cause the instance to restart on the next `sst deploy`,
   * causing downtime. Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   * :::
   *
   * @default `"t4g.micro"`
   * @example
   * ```js
   * {
   *   instance: "m7g.xlarge"
   * }
   * ```
   */
  instance?: Input<string>;
  /**
   * @deprecated The `cluster.nodes` prop is now the recommended way to configure the
   * number of nodes in the cluster.
   */
  nodes?: Input<number>;
  /**
   * Configure cluster mode for Redis.
   *
   * @default `{ nodes: 1 }`
   * @example
   * Disable cluster mode.
   * ```js
   * {
   *   cluster: false
   * }
   * ```
   */
  cluster?: Input<
    | boolean
    | {
        /**
         * The number of nodes to use for the Redis cluster.
         *
         * @default `1`
         * @example
         * ```js
         * {
         *   nodes: 4
         * }
         * ```
         */
        nodes: Input<number>;
      }
  >;
  /**
   * Key-value pairs that define custom parameters for the Redis's parameter group.
   * These values override the defaults set by AWS.
   *
   * @example
   * ```js
   * {
   *   parameters: {
   *     "maxmemory-policy": "noeviction"
   *   }
   * }
   * ```
   */
  parameters?: Input<Record<string, Input<string>>>;
  /**
   * Use [Amazon ElastiCache Serverless](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.serverless.html)
   * instead of a provisioned cluster. It scales with your usage and you pay for the data
   * stored and the compute you use.
   *
   * A serverless cache needs `version` 7 or later, which the defaults are. A lower `version`
   * fails with an error. Only the major part of `version` is used, so `"7.2"` is sent as `"7"`
   * and ElastiCache picks the minor version.
   *
   * When this is set, `instance`, `cluster`, `nodes` and `parameters` are ignored, and
   * `transform.subnetGroup`, `transform.parameterGroup` and `transform.cluster` don't run.
   * Use `transform.serverlessCache` instead. The password is set through an ElastiCache user
   * and user group that SST creates for the cache.
   *
   * :::danger
   * Turning this on or off for an existing Redis replaces it with a different kind of cache,
   * and its data is lost.
   * :::
   *
   * A serverless cache always uses TLS. By default SST also gives it a generated password for
   * the `default` user, like a provisioned cluster, so the linked resource has the same `host`,
   * `port`, `username` and `password`, and the code that connects to it doesn't change. Turn it
   * off with `password: false`.
   *
   * :::note
   * `Redis.get` only works with provisioned clusters.
   * :::
   *
   * @default `false`
   * @example
   * Use the default limits.
   * ```js
   * {
   *   serverless: true
   * }
   * ```
   *
   * Set your own limits. These cap how far the cache scales, and so what it can cost.
   * ```js
   * {
   *   serverless: {
   *     storage: { maximum: "100 GB" },
   *     ecpuPerSecond: { maximum: 50000 }
   *   }
   * }
   * ```
   */
  serverless?:
    | boolean
    | {
        /**
         * Protect the cache with a password. SST generates one for the `default` user and links
         * it as `password`, like a provisioned cluster. Without a password, anything that can
         * reach the cache inside the VPC can read and write it.
         *
         * Set this to `false` for a cache with no password. Then the link has `host`, `port` and
         * `username`, and no `password`.
         *
         * Linked resources get the password, and `sst shell` has it in `Resource.MyRedis.password`.
         *
         * With a password, the deploy role needs these ElastiCache actions, on top of the ones for
         * the cache: `elasticache:CreateUser`, `elasticache:DescribeUsers`, `elasticache:DeleteUser`,
         * `elasticache:CreateUserGroup`, `elasticache:DescribeUserGroups` and
         * `elasticache:DeleteUserGroup`. Changing a setting later may also call the matching
         * `Modify` actions.
         *
         * :::danger
         * Turning this on or off for an existing cache changes how clients connect, so apps
         * that were linked before have to be deployed again.
         * :::
         *
         * @default `true`
         */
        password?: boolean;
        /**
         * The amount of data the cache can store, in whole GB. A fraction is rounded up. A
         * `minimum` and a `maximum` have to be at least `1 GB`, and the `minimum` can't be above
         * the `maximum`.
         *
         * @default `{ maximum: "10 GB" }`
         * @example
         * ```js
         * {
         *   storage: { minimum: "1 GB", maximum: "100 GB" }
         * }
         * ```
         */
        storage?: Input<{
          /**
           * The smallest amount of storage the cache keeps available.
           */
          minimum?: Input<`${number} GB`>;
          /**
           * The most data the cache can store.
           */
          maximum?: Input<`${number} GB`>;
        }>;
        /**
         * The ElastiCache Processing Units (ECPU) the cache can use per second. A `minimum` and
         * a `maximum` have to be at least `1`, and the `minimum` can't be above the `maximum`.
         *
         * @default `{ maximum: 5000 }`
         * @example
         * ```js
         * {
         *   ecpuPerSecond: { minimum: 1000, maximum: 50000 }
         * }
         * ```
         */
        ecpuPerSecond?: Input<{
          /**
           * The smallest number of ECPUs per second the cache keeps available.
           */
          minimum?: Input<number>;
          /**
           * The most ECPUs per second the cache can use.
           */
          maximum?: Input<number>;
        }>;
      };
  /**
   * The VPC to use for the Redis instance.
   *
   * @example
   * Create a VPC component.
   *
   * ```js
   * const myVpc = new sst.aws.Vpc("MyVpc");
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
   * Or pass in a custom VPC configuration.
   *
   * ```js
   * {
   *   vpc: {
   *     subnets: ["subnet-0db7376a7ad4db5fd ", "subnet-06fc7ee8319b2c0ce"],
   *     securityGroups: ["sg-0399348378a4c256c"]
   *   }
   * }
   * ```
   */
  vpc:
    | Vpc
    | Input<{
        /**
         * A list of subnet IDs in the VPC to deploy the Redis instance in.
         */
        subnets: Input<Input<string>[]>;
        /**
         * A list of VPC security group IDs.
         */
        securityGroups: Input<Input<string>[]>;
      }>;
  /**
   * Configure how this component works in `sst dev`.
   *
   * By default, your Redis instance is deployed in `sst dev`. But if you want to instead
   * connect to a locally running Redis server, you can configure the `dev` prop.
   *
   * :::note
   * By default, this creates a new Redis ElastiCache instance even in `sst dev`.
   * :::
   *
   * This will skip deploying a Redis ElastiCache instance and link to the locally running
   * Redis server instead.
   *
   * @example
   *
   * Setting the `dev` prop also means that any linked resources will connect to the right
   * Redis instance both in `sst dev` and `sst deploy`.
   *
   * ```ts
   * {
   *   dev: {
   *     host: "localhost",
   *     port: 6379
   *   }
   * }
   * ```
   */
  dev?: {
    /**
     * The host of the local Redis server to connect to when running in dev.
     * @default `"localhost"`
     */
    host?: Input<string>;
    /**
     * The port of the local Redis server when running in dev.
     * @default `6379`
     */
    port?: Input<number>;
    /**
     * The username of the local Redis server to connect to when running in dev.
     * @default `"default"`
     */
    username?: Input<string>;
    /**
     * The password of the local Redis server to connect to when running in dev.
     * @default No password
     */
    password?: Input<string>;
  };
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the Redis subnet group.
     */
    subnetGroup?: Transform<elasticache.SubnetGroupArgs>;
    /**
     * Transform the Redis parameter group.
     */
    parameterGroup?: Transform<elasticache.ParameterGroupArgs>;
    /**
     * Transform the Redis cluster.
     */
    cluster?: Transform<elasticache.ReplicationGroupArgs>;
    /**
     * Transform the Redis serverless cache.
     */
    serverlessCache?: Transform<elasticache.ServerlessCacheArgs>;
  };
}

interface RedisRef {
  ref: boolean;
  clusterId: Input<string>;
}

/**
 * The `Redis` component lets you add a Redis cluster to your app using
 * [Amazon ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/WhatIs.html).
 *
 * @example
 *
 * #### Create the cluster
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const redis = new sst.aws.Redis("MyRedis", { vpc });
 * ```
 *
 * #### Create a serverless Redis
 *
 * You can also create a serverless Redis instance that automatically scales based on usage.
 * Check out the [serverless example](/docs/examples/#aws-redis-serverless). It connects with the same
 * `username` and `password` as a provisioned Redis.
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const redis = new sst.aws.Redis("MyRedis", {
 *   vpc,
 *   serverless: true
 * });
 * ```
 *
 * Configure serverless limits.
 *
 * ```js title="sst.config.ts"
 * const redis = new sst.aws.Redis("MyRedis", {
 *   vpc,
 *   serverless: {
 *     storage: { maximum: "100 GB" },
 *     ecpuPerSecond: { maximum: 50000 }
 *   }
 * });
 * ```
 *
 * #### Link to a resource
 *
 * You can link your cluster to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [redis],
 *   vpc
 * });
 * ```
 *
 * Once linked, you can connect to it from your function code.
 *
 * ```ts title="app/page.tsx" {1,6,7,12,13}
 * import { Resource } from "sst";
 * import { Cluster } from "ioredis";
 *
 * const client = new Cluster(
 *   [{
 *     host: Resource.MyRedis.host,
 *     port: Resource.MyRedis.port
 *   }],
 *   {
 *     redisOptions: {
 *       tls: { checkServerIdentity: () => undefined },
 *       username: Resource.MyRedis.username,
 *       password: Resource.MyRedis.password
 *     }
 *   }
 * );
 * ```
 *
 * #### Running locally
 *
 * By default, your Redis cluster is deployed in `sst dev`. But let's say you are running Redis
 * locally.
 *
 * ```bash
 * docker run \
 *   --rm \
 *   -p 6379:6379 \
 *   -v $(pwd)/.sst/storage/redis:/data \
 *   redis:latest
 * ```
 *
 * You can connect to it in `sst dev` by configuring the `dev` prop.
 *
 * ```ts title="sst.config.ts" {3-6}
 * const redis = new sst.aws.Redis("MyRedis", {
 *   vpc,
 *   dev: {
 *     host: "localhost",
 *     port: 6379
 *   }
 * });
 * ```
 *
 * This will skip deploying a Redis ElastiCache cluster and link to the locally running Redis
 * server instead. [Check out the full example](/docs/examples/#aws-redis-local).
 *
 * ---
 *
 * ### Cost
 *
 * By default this component uses _On-demand nodes_ with a single `cache.t4g.micro` instance.
 *
 * The default `redis` engine costs $0.016 per hour. That works out to $0.016 x 24 x 30 or **$12 per month**.
 *
 * If the `valkey` engine is used, the cost is $0.0128 per hour. That works out to $0.0128 x 24 x 30 or **$9 per month**.
 *
 * Adjust this for the `instance` type and number of `nodes` you are using.
 *
 * With `serverless`, you pay for the data stored and the ECPUs used instead. A serverless cache
 * is billed for at least 1 GB of storage, even when idle, and setting a `minimum` raises that floor.
 * The `maximum` limits cap what it can cost. Check out the
 * [ElastiCache Serverless pricing](https://aws.amazon.com/elasticache/pricing/).
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/) for more details.
 */
export class Redis extends Component implements Link.Linkable {
  private cluster?: Output<elasticache.ReplicationGroup>;
  private serverlessCache?: elasticache.ServerlessCache;
  private _authToken?: Output<string>;
  private dev?: {
    enabled: boolean;
    host: Output<string>;
    port: Output<number>;
    username: Output<string>;
    password?: Output<string>;
  };
  public static v1 = RedisV1;

  constructor(name: string, args: RedisArgs, opts?: ComponentResourceOptions) {
    super(__pulumiType, name, args, opts);
    const _version = 2;
    const self = this;

    if (args && "ref" in args) {
      const ref = reference();
      this.cluster = output(ref.cluster);
      this._authToken = ref.authToken;
      return;
    }

    registerVersion();
    const engine = output(args.engine).apply((v) => v ?? "redis");
    const version = all([engine, args.version]).apply(
      ([engine, v]) => v ?? (engine === "redis" ? "7.1" : "7.2"),
    );

    const dev = registerDev();
    if (dev?.enabled) {
      this.dev = dev;
      return;
    }

    const vpc = normalizeVpc();
    const serverless = normalizeServerless();
    if (serverless) {
      const auth = serverless.password ? createServerlessAuth() : undefined;
      this._authToken = auth?.password;
      this.serverlessCache = createServerlessCache(serverless, auth?.userGroup);
      return;
    }
    const instance = output(args.instance).apply((v) => v ?? "t4g.micro");
    const argsCluster = normalizeCluster();

    const { authToken, secret } = createAuthToken();
    this._authToken = authToken;

    const subnetGroup = createSubnetGroup();
    const parameterGroup = createParameterGroup();
    const cluster = createCluster();

    this.cluster = cluster;

    function reference() {
      const ref = args as unknown as RedisRef;
      const cluster = elasticache.ReplicationGroup.get(
        `${name}Cluster`,
        ref.clusterId,
        undefined,
        { parent: self },
      );

      const input = cluster.tagsAll.apply((tags) => {
        registerVersion(
          tags?.["sst:component-version"]
            ? parseInt(tags["sst:component-version"])
            : undefined,
        );

        if (!tags?.["sst:ref:secret"])
          throw new VisibleError(
            `Failed to lookup secret for Redis cluster "${name}".`,
          );

        return {
          secretRef: tags?.["sst:ref:secret"],
        };
      });

      const secret = secretsmanager.getSecretVersionOutput(
        { secretId: input.secretRef },
        { parent: self },
      );
      const authToken = secret.secretString.apply((v) => {
        return JSON.parse(v).authToken as string;
      });

      return { cluster, authToken };
    }

    function registerVersion(overrideVersion?: number) {
      const oldVersion = overrideVersion ?? $cli.state.version[name];
      self.registerVersion({
        new: _version,
        old: oldVersion,
        message: [
          `There is a new version of "Redis" that has breaking changes.`,
          ``,
          `To continue using the previous version, rename "Redis" to "Redis.v${oldVersion}".`,
          `Or recreate this component to update - https://sst-community.github.io/sst/docs/components/#versioning`,
        ].join("\n"),
      });
    }

    function registerDev() {
      if (!args.dev) return undefined;

      const dev = {
        enabled: $dev,
        host: output(args.dev.host ?? "localhost"),
        port: output(args.dev.port ?? 6379),
        username: output(args.dev.username ?? "default"),
        password: args.dev.password ? output(args.dev.password) : undefined,
      };

      new DevCommand(`${name}Dev`, {
        dev: {
          title: name,
          autostart: true,
          command: `sst print-and-not-quit`,
        },
        environment: {
          SST_DEV_COMMAND_MESSAGE: interpolate`Make sure your local Redis server is using:

  username: "${dev.username}"
  password: "${dev.password ?? "\x1b[38;5;8m[no password]\x1b[0m"}"

Listening on "${dev.host}:${dev.port}"...`,
        },
      });

      return dev;
    }

    function normalizeVpc() {
      // "vpc" is a Vpc component
      if (args.vpc instanceof Vpc) {
        return output({
          subnets: args.vpc.privateSubnets,
          securityGroups: args.vpc.securityGroups,
        });
      }

      // "vpc" is object
      return output(args.vpc);
    }

    function normalizeCluster() {
      return all([args.cluster, args.nodes]).apply(([v, nodes]) => {
        if (v === false) return undefined;
        if (v === true) return { nodes: 1 };
        if (v === undefined) {
          if (nodes) return { nodes };
          return { nodes: 1 };
        }
        return v;
      });
    }

    function normalizeServerless() {
      const v = args.serverless;
      if (!v) return undefined;
      const options = v === true ? {} : v;
      return {
        password: options.password ?? true,
        // The limits can be outputs, so flatten them before reading any value
        storage: output(options.storage)
          .apply((v) => all([v?.minimum, v?.maximum]))
          .apply(([min, max]) => {
            const minimum = min ? Math.ceil(toGBs(min)) : undefined;
            const maximum = max ? Math.ceil(toGBs(max)) : 10;
            checkRange(name, "storage", "GB", minimum, maximum, !max);
            return { minimum, maximum };
          }),
        ecpuPerSecond: output(options.ecpuPerSecond)
          .apply((v) => all([v?.minimum, v?.maximum]))
          .apply(([min, max]) => {
            const minimum = min;
            const maximum = max ?? 5000;
            checkRange(name, "ecpuPerSecond", "", minimum, maximum, max === undefined);
            return { minimum, maximum };
          }),
      };
    }

    function checkRange(
      name: string,
      key: string,
      unit: string,
      minimum: number | undefined,
      maximum: number,
      maximumIsDefault: boolean,
    ) {
      const suffix = unit ? ` ${unit}` : "";
      for (const [limit, value] of [
        ["minimum", minimum],
        ["maximum", maximum],
      ] as const) {
        if (value !== undefined && value < 1)
          throw new VisibleError(
            `In the Redis component "${name}", \`serverless.${key}.${limit}\` has to be at least 1${suffix}.`,
          );
      }
      if (minimum !== undefined && minimum > maximum)
        throw new VisibleError(
          `In the Redis component "${name}", \`serverless.${key}.minimum\` (${minimum}${suffix}) is above \`serverless.${key}.maximum\` (${maximum}${suffix}${maximumIsDefault ? ", the default" : ""}). Set a \`maximum\` that is at least the \`minimum\`.`,
        );
    }

    function createAuthToken() {
      const authToken = new RandomPassword(
        `${name}AuthToken`,
        {
          length: 32,
          special: true,
          overrideSpecial: "!&#$^<>-",
        },
        { parent: self },
      ).result;

      const secret = new secretsmanager.Secret(
        `${name}ProxySecret`,
        {
          recoveryWindowInDays: 0,
        },
        { parent: self },
      );

      new secretsmanager.SecretVersion(
        `${name}ProxySecretVersion`,
        {
          secretId: secret.id,
          secretString: jsonStringify({ authToken }),
        },
        { parent: self },
      );

      return { secret, authToken };
    }

    function createSubnetGroup() {
      return new elasticache.SubnetGroup(
        ...transform(
          args.transform?.subnetGroup,
          `${name}SubnetGroup`,
          {
            description: "Managed by SST",
            subnetIds: vpc.subnets,
          },
          { parent: self },
        ),
      );
    }

    function createParameterGroup() {
      return new elasticache.ParameterGroup(
        ...transform(
          args.transform?.parameterGroup,
          `${name}ParameterGroup`,
          {
            description: "Managed by SST",
            family: all([engine, version]).apply(([engine, version]) => {
              const majorVersion = version.split(".")[0];
              const defaultFamily = `${engine}${majorVersion}`;
              return (
                {
                  redis4: "redis4.0",
                  redis5: "redis5.0",
                  redis6: "redis6.x",
                }[defaultFamily] ?? defaultFamily
              );
            }),
            parameters: all([args.parameters ?? {}, argsCluster]).apply(
              ([parameters, argsCluster]) => [
                {
                  name: "cluster-enabled",
                  value: argsCluster ? "yes" : "no",
                },
                ...Object.entries(parameters).map(([name, value]) => ({
                  name,
                  value,
                })),
              ],
            ),
          },
          {
            parent: self,
            // Necessary for the parameter group to be deleted AFTER upgrading the instance.
            // This is either a Pulumi bug or an undocumented feature.
            deleteBeforeReplace: false,
          },
        ),
      );
    }

    function createCluster() {
      return argsCluster.apply(
        (argsCluster) =>
          new elasticache.ReplicationGroup(
            ...transform(
              args.transform?.cluster,
              `${name}Cluster`,
              {
                description: "Managed by SST",
                engine,
                engineVersion: version,
                nodeType: interpolate`cache.${instance}`,
                dataTieringEnabled: instance.apply((v) =>
                  v.startsWith("r6gd."),
                ),
                port: 6379,
                ...(argsCluster
                  ? {
                      clusterMode: "enabled",
                      numNodeGroups: argsCluster.nodes,
                      replicasPerNodeGroup: 0,
                      automaticFailoverEnabled: true,
                    }
                  : {
                      clusterMode: "disabled",
                    }),
                multiAzEnabled: false,
                applyImmediately: true,
                autoMinorVersionUpgrade: false,
                atRestEncryptionEnabled: true,
                transitEncryptionEnabled: true,
                transitEncryptionMode: "required",
                authTokenUpdateStrategy: "ROTATE",
                authToken,
                subnetGroupName: subnetGroup.name,
                parameterGroupName: parameterGroup.name,
                securityGroupIds: vpc.securityGroups,
                tags: {
                  "sst:component-version": _version.toString(),
                  "sst:ref:secret": secret.id,
                },
              },
              { parent: self },
            ),
          ),
      );
    }

    function createServerlessAuth() {
      const password = new RandomPassword(
        `${name}AuthToken`,
        {
          length: 32,
          special: true,
          overrideSpecial: "!&#$^<>-",
        },
        { parent: self },
      ).result;

      // A serverless cache takes its passwords from a user group. The group needs
      // a user named "default", this one has the password.
      const user = new elasticache.User(
        `${name}User`,
        {
          // the id is named by SST, an empty string leaves it to the naming rule
          userId: "",
          userName: "default",
          engine,
          accessString: "on ~* +@all",
          authenticationMode: {
            type: "password",
            passwords: [password],
          },
        },
        { parent: self },
      );
      const userGroup = new elasticache.UserGroup(
        `${name}UserGroup`,
        {
          userGroupId: "",
          engine,
          userIds: [user.userId],
        },
        { parent: self },
      );

      return { password, userGroup };
    }

    function createServerlessCache(
      serverless: NonNullable<ReturnType<typeof normalizeServerless>>,
      userGroup: elasticache.UserGroup | undefined,
    ) {
      return new elasticache.ServerlessCache(
        ...transform(
          args.transform?.serverlessCache,
          `${name}ServerlessCache`,
          {
            description: "Managed by SST",
            engine,
            majorEngineVersion: version.apply((v) => {
              const major = v.split(".")[0];
              if (parseInt(major) < 7)
                throw new VisibleError(
                  `In the Redis component "${name}", \`serverless\` needs version 7 or later, but \`version\` is "${v}".`,
                );
              return major;
            }),
            cacheUsageLimits: all([
              serverless.storage,
              serverless.ecpuPerSecond,
            ]).apply(([storage, ecpu]) => ({
              dataStorage: {
                minimum: storage.minimum,
                maximum: storage.maximum,
                unit: "GB",
              },
              ecpuPerSeconds: [
                {
                  minimum: ecpu.minimum,
                  maximum: ecpu.maximum,
                },
              ],
            })),
            securityGroupIds: vpc.securityGroups,
            subnetIds: vpc.subnets,
            userGroupId: userGroup?.userGroupId,
            tags: {
              "sst:component-version": _version.toString(),
            },
          },
          { parent: self },
        ),
      );
    }
  }

  /**
   * The ID of the Redis cluster, or of the serverless cache when `serverless` is set.
   * `Redis.get` only works with the ID of a cluster.
   */
  public get clusterId() {
    if (this.dev) return output("placeholder");
    if (this.serverlessCache) return this.serverlessCache.id;
    return this.cluster!.id;
  }

  /**
   * The username to connect to the Redis cluster.
   */
  public get username() {
    return this.dev ? this.dev.username : output("default");
  }

  /**
   * The password to connect to the Redis cluster. This is `undefined` for a serverless cache
   * with `password: false`.
   */
  public get password(): Output<string> | undefined {
    return this.dev ? this.dev.password ?? output("") : this._authToken;
  }

  /**
   * The host to connect to the Redis cluster.
   */
  public get host() {
    if (this.dev) return this.dev.host;
    if (this.serverlessCache) {
      return this.serverlessCache.endpoints.apply((endpoints) => {
        const address = endpoints?.[0]?.address;
        if (!address)
          throw new VisibleError(
            "The serverless Redis cache has no endpoint address yet.",
          );
        return address;
      });
    }
    return this.cluster!.clusterEnabled.apply((enabled) =>
      enabled
        ? this.cluster!.configurationEndpointAddress
        : this.cluster!.primaryEndpointAddress,
    );
  }

  /**
   * The port to connect to the Redis cluster.
   */
  public get port() {
    if (this.dev) return this.dev.port;
    if (this.serverlessCache) {
      return this.serverlessCache.endpoints.apply(
        (endpoints) => endpoints?.[0]?.port ?? 6379,
      );
    }
    return this.cluster!.port.apply((v) => v!);
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    const _this = this;
    return {
      /**
       * The ElastiCache Redis cluster. This throws when `serverless` is set, use
       * `serverlessCache` instead.
       */
      get cluster() {
        if (_this.dev)
          throw new VisibleError("Cannot access `nodes.cluster` in dev mode.");
        if (_this.serverlessCache)
          throw new VisibleError(
            "Cannot access `nodes.cluster` when `serverless` is set, use `nodes.serverlessCache`.",
          );
        return _this.cluster!;
      },
      /**
       * The ElastiCache Redis serverless cache. This throws when `serverless` is not set, use
       * `cluster` instead.
       */
      get serverlessCache() {
        if (_this.dev)
          throw new VisibleError(
            "Cannot access `nodes.serverlessCache` in dev mode.",
          );
        if (!_this.serverlessCache)
          throw new VisibleError(
            "Cannot access `nodes.serverlessCache` when `serverless` is not set, use `nodes.cluster`.",
          );
        return _this.serverlessCache;
      },
    };
  }

  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        host: this.host,
        port: this.port,
        username: this.username,
        ...(this.password ? { password: this.password } : {}),
      },
    };
  }

  /**
   * Reference an existing Redis cluster with the given cluster name. This is useful when you
   * create a Redis cluster in one stage and want to share it in another. It avoids having to
   * create a new Redis cluster in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share Redis clusters across stages.
   * :::
   *
   * :::caution
   * This only works with a provisioned cluster. The `clusterId` of a cache created with
   * `serverless` can't be used here and fails with a "Failed to lookup secret" error.
   * :::
   *
   * @param name The name of the component.
   * @param clusterId The id of the existing Redis cluster.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a cluster in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new cluster, you want to share the same cluster from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const redis = $app.stage === "frank"
   *   ? sst.aws.Redis.get("MyRedis", "app-dev-myredis")
   *   : new sst.aws.Redis("MyRedis");
   * ```
   *
   * Here `app-dev-myredis` is the ID of the cluster created in the `dev` stage.
   * You can find this by outputting the cluster ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   cluster: redis.clusterId
   * };
   * ```
   */
  public static get(
    name: string,
    clusterId: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Redis(
      name,
      {
        ref: true,
        clusterId,
      } as unknown as RedisArgs,
      opts,
    );
  }
}

const __pulumiType = "sst:aws:Redis";
// @ts-expect-error
Redis.__pulumiType = __pulumiType;
