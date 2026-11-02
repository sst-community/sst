import {
  all,
  ComponentResourceOptions,
  interpolate,
  jsonStringify,
  Output,
  output,
} from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { elasticache, secretsmanager } from "@pulumi/aws";
import { type ComponentArgs, component, optional } from "../../parts-component";
import { ifSet, plain, withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { toGBs } from "../../size";
import { type AnyVpc, assertVpcIds, isVpc, subnetsOf } from "../helpers/vpc";
import { localServerPane, shownPassword } from "../helpers/local-server";

const parts = {
  /**
   * The random password clients authenticate with. A serverless cache with
   * `password: false` has none.
   */
  authToken: optional(RandomPassword),
  /**
   * The Secrets Manager secret that stores the auth token of a cluster.
   */
  secret: optional(secretsmanager.Secret),
  /**
   * The version of the secret holding the current auth token.
   */
  secretVersion: optional(secretsmanager.SecretVersion),
  /**
   * The ElastiCache subnet group of a cluster.
   */
  subnetGroup: optional(elasticache.SubnetGroup),
  /**
   * The ElastiCache parameter group of a cluster.
   */
  parameterGroup: optional(elasticache.ParameterGroup),
  /**
   * The ElastiCache replication group. There's none when `serverless` is set.
   */
  cluster: optional(elasticache.ReplicationGroup),
  /**
   * The ElastiCache serverless cache, when `serverless` is set.
   */
  serverlessCache: optional(elasticache.ServerlessCache),
  /**
   * The `default` user of a serverless cache, which has the password.
   */
  user: optional(elasticache.User),
  /**
   * The user group a serverless cache takes its passwords from.
   */
  userGroup: optional(elasticache.UserGroup),
};

export interface RedisArgs extends ComponentArgs<typeof parts> {
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
   * When this is set, `instance`, `cluster` and `parameters` are ignored, and the subnet
   * group, parameter group and cluster aren't created, so their transforms don't run. Use
   * `transform.serverlessCache` instead. The password is set through an ElastiCache user
   * and user group that SST creates for the cache.
   *
   * This has to be a plain value, not an output: it decides which resources are created.
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
   * Create a `Vpc` component.
   *
   * ```js
   * const myVpc = new sst.aws.v5.Vpc("MyVpc");
   * ```
   *
   * And pass it in. The cluster is in its private subnets.
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
   *     subnets: ["subnet-0db7376a7ad4db5fd", "subnet-06fc7ee8319b2c0ce"],
   *     securityGroups: ["sg-0399348378a4c256c"]
   *   }
   * }
   * ```
   */
  vpc:
    | AnyVpc
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
   * Redis server instead. `sst dev` shows what the local server has to be set up with, in a
   * pane of its own.
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
}

/** What the rest of the app reads from the cluster, deployed or local. */
interface Connection {
  clusterId: Output<string>;
  host: Output<string>;
  port: Output<number>;
  username: Output<string>;
  /** A serverless cache with `password: false` has none. */
  password?: Output<string>;
}

/**
 * The `Redis` component lets you add a Redis cluster to your app using
 * [Amazon ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/WhatIs.html).
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the cluster
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.v5.Vpc("MyVpc");
 * const redis = new sst.aws.v5.Redis("MyRedis", { vpc });
 * ```
 *
 * #### Create a serverless Redis
 *
 * You can also create a serverless Redis instance that automatically scales based on usage.
 * Check out the [serverless example](/docs/examples/#aws-redis-serverless). It connects with the same
 * `username` and `password` as a provisioned Redis.
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.v5.Vpc("MyVpc");
 * const redis = new sst.aws.v5.Redis("MyRedis", {
 *   vpc,
 *   serverless: true
 * });
 * ```
 *
 * Configure serverless limits.
 *
 * ```js title="sst.config.ts"
 * const redis = new sst.aws.v5.Redis("MyRedis", {
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
 * new sst.aws.v5.Nextjs("MyWeb", {
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
 * const redis = new sst.aws.v5.Redis("MyRedis", {
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
 * #### Switch from `sst.aws.Redis`
 *
 * Change `sst.aws.Redis` to `sst.aws.v5.Redis` and keep the name. The cluster or serverless
 * cache you've deployed is kept, and so is its password.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const redis = new sst.aws.Redis("MyRedis", { vpc });
 * const redis = new sst.aws.v5.Redis("MyRedis", { vpc });
 * ```
 *
 * A few things work differently:
 *
 * - The deprecated `nodes` is gone. Where `cluster` isn't set, pass the same number as
 *   `cluster.nodes`. Where `cluster` or `serverless` is set, `sst.aws.Redis` ignored it, so
 *   remove it. Either way nothing in AWS changes.
 * - A `transform.cluster` function is given `clusterMode`, `numNodeGroups`,
 *   `replicasPerNodeGroup` and `automaticFailoverEnabled` as outputs, where `sst.aws.Redis`
 *   gave plain values. A function that reads one of them to decide what to set has to
 *   decide inside an `apply`, or from your own config.
 * - With `dev` set, `sst.aws.Redis` created a component for the pane `sst dev` shows, in
 *   every deploy. The V5 one tells `sst dev` itself, so a deploy drops that component. It
 *   has nothing in AWS behind it.
 * - `nodes.cluster` is the cluster, not an output of it. `nodes.cluster` and
 *   `nodes.serverlessCache` are `undefined` when the other kind is deployed, where
 *   `sst.aws.Redis` threw an error. `nodes` also has the auth token and its secret, the
 *   subnet group, the parameter group, and a serverless cache's user and user group.
 * - If you set `tags` on the cluster with an object in `transform`, it keeps the tags SST
 *   sets next to yours. They're added back when you switch.
 * - `sst.aws.Redis.v1` has no V5 form.
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
 * Adjust this for the `instance` type and number of `cluster.nodes` you are using.
 *
 * With `serverless`, you pay for the data stored and the ECPUs used instead. A serverless cache
 * is billed for at least 1 GB of storage, even when idle, and setting a `minimum` raises that floor.
 * The `maximum` limits cap what it can cost. Check out the
 * [ElastiCache Serverless pricing](https://aws.amazon.com/elasticache/pricing/).
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/) for more details.
 */
export class Redis extends component("sst:aws:Redis", parts) {
  private connection: Connection;

  constructor(name: string, args: RedisArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const self = this;

    // `sst.aws.Redis` also took the number of nodes as `nodes`, when neither
    // `cluster` nor `serverless` was set. Left in, it would be ignored and
    // the cluster resharded, so it's refused, with what keeps the cluster.
    const nodes = (args as { nodes?: unknown }).nodes;
    if (nodes !== undefined)
      throw new VisibleError(
        args.cluster !== undefined || args.serverless || nodes === 0
          ? `The "nodes" arg of the "${name}" Redis component is gone, and \`sst.aws.Redis\` ignored it here. Remove it; nothing in AWS changes.`
          : `The "nodes" arg of the "${name}" Redis component is now "cluster.nodes". Pass the same number as \`cluster: { nodes }\`; nothing in AWS changes.`,
      );

    // In `sst dev`, a Redis server on the user's machine stands in for the
    // cluster, one that's already deployed too. This is the only place the
    // component handles dev mode.
    const dev = plain(args.dev, `The "dev" of the "${name}" Redis`);
    if (dev && $dev) {
      this.runsLocally();
      this.connection = runLocally(dev);
      return;
    }

    // A cluster that's already deployed
    const existing = this.existingPart("cluster");
    if (existing) {
      this.connection = connectTo(existing, authTokenOf(existing));
      return;
    }

    const engine = withDefault(args.engine, "redis");
    const version = all([engine, args.version]).apply(
      ([engine, v]) => v ?? (engine === "redis" ? "7.1" : "7.2"),
    );
    const vpc = vpcOf(name, args.vpc);

    const serverless = plain(
      args.serverless,
      `The "serverless" of the "${name}" Redis`,
    );
    if (serverless) {
      this.connection = createServerless(serverless === true ? {} : serverless);
      return;
    }

    const instance = withDefault(args.instance, "t4g.micro");
    const clustered = output(args.cluster).apply((v) => {
      if (v === false) return undefined;
      if (v === true || v === undefined) return { nodes: 1 };
      return v;
    });

    const authToken = this.part("authToken", {
      length: 32,
      special: true,
      overrideSpecial: "!&#$^<>-",
    }).result;

    const secret = this.part("secret", { recoveryWindowInDays: 0 });
    this.part("secretVersion", {
      secretId: secret.id,
      secretString: jsonStringify({ authToken }),
    });

    const subnetGroup = this.part("subnetGroup", {
      description: "Managed by SST",
      subnetIds: vpc.subnets,
    });

    const parameterGroup = this.part(
      "parameterGroup",
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
        parameters: all([args.parameters ?? {}, clustered]).apply(
          ([parameters, clustered]) => [
            {
              name: "cluster-enabled",
              value: clustered ? "yes" : "no",
            },
            ...Object.entries(parameters).map(([name, value]) => ({
              name,
              value,
            })),
          ],
        ),
      },
      {
        // Necessary for the parameter group to be deleted AFTER upgrading the instance.
        // This is either a Pulumi bug or an undocumented feature.
        deleteBeforeReplace: false,
      },
    );

    const cluster = this.part("cluster", {
      description: "Managed by SST",
      engine,
      engineVersion: version,
      nodeType: interpolate`cache.${instance}`,
      dataTieringEnabled: instance.apply((v) => v.startsWith("r6gd.")),
      port: 6379,
      clusterMode: clustered.apply((v) => (v ? "enabled" : "disabled")),
      numNodeGroups: ifSet(clustered, (v) => v.nodes),
      replicasPerNodeGroup: ifSet(clustered, () => 0),
      automaticFailoverEnabled: ifSet(clustered, () => true),
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
        // The same value `sst.aws.Redis` writes, so either component can
        // reference a cluster the other created
        "sst:component-version": "2",
        "sst:ref:secret": secret.id,
      },
    });
    this.connection = connectTo(cluster, authToken);

    // A serverless cache in place of the cluster, with a password by default.
    // It takes the password from a user group, which needs a user named
    // "default".
    function createServerless(
      options: Exclude<NonNullable<RedisArgs["serverless"]>, boolean>,
    ): Connection {
      const password =
        (options.password ?? true)
          ? self.part("authToken", {
              length: 32,
              special: true,
              overrideSpecial: "!&#$^<>-",
            }).result
          : undefined;
      const userGroup = password
        ? self.part("userGroup", {
            // Named by SST: an empty id is filled in from the part's name
            userGroupId: "",
            engine,
            userIds: [
              self.part("user", {
                userId: "",
                userName: "default",
                engine,
                accessString: "on ~* +@all",
                authenticationMode: { type: "password", passwords: [password] },
              }).userId,
            ],
          })
        : undefined;

      const limits = serverlessLimits(name, options);
      const cache = self.part("serverlessCache", {
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
        cacheUsageLimits: all([limits.storage, limits.ecpuPerSecond]).apply(
          ([storage, ecpu]) => ({
            dataStorage: {
              minimum: storage.minimum,
              maximum: storage.maximum,
              unit: "GB",
            },
            ecpuPerSeconds: [{ minimum: ecpu.minimum, maximum: ecpu.maximum }],
          }),
        ),
        securityGroupIds: vpc.securityGroups,
        subnetIds: vpc.subnets,
        userGroupId: userGroup?.userGroupId,
        tags: { "sst:component-version": "2" },
      });

      return {
        clusterId: cache.id,
        username: output("default"),
        password,
        host: cache.endpoints.apply((endpoints) => {
          const address = endpoints?.[0]?.address;
          if (!address)
            throw new VisibleError(
              "The serverless Redis cache has no endpoint address yet.",
            );
          return address;
        }),
        port: cache.endpoints.apply(
          (endpoints) => endpoints?.[0]?.port ?? 6379,
        ),
      };
    }

    function connectTo(
      cluster: elasticache.ReplicationGroup,
      authToken: Output<string>,
    ): Connection {
      return {
        clusterId: cluster.id,
        username: output("default"),
        password: authToken,
        host: cluster.clusterEnabled.apply((enabled) =>
          enabled
            ? cluster.configurationEndpointAddress
            : cluster.primaryEndpointAddress,
        ),
        port: cluster.port.apply((v) => v!),
      };
    }

    // A cluster created by this component, or by `sst.aws.Redis`, is tagged
    // with the secret that holds its auth token
    function authTokenOf(cluster: elasticache.ReplicationGroup) {
      const secretId = cluster.tagsAll.apply((tags) => {
        if (!tags?.["sst:ref:secret"])
          throw new VisibleError(
            `Failed to lookup secret for Redis cluster "${name}".`,
          );
        return tags["sst:ref:secret"];
      });
      return secretsmanager
        .getSecretVersionOutput({ secretId }, { parent: self })
        .secretString.apply((v) => JSON.parse(v).authToken as string);
    }

    // What `sst dev` connects to, and the pane that says how the local server
    // has to be set up
    function runLocally(dev: NonNullable<RedisArgs["dev"]>): Connection {
      const local = {
        clusterId: output("placeholder"),
        host: output(dev.host ?? "localhost"),
        port: output(dev.port ?? 6379),
        username: output(dev.username ?? "default"),
        password: output(dev.password ?? ""),
      };

      self.report({
        dev: localServerPane(
          interpolate`Make sure your local Redis server is using:

  username: "${local.username}"
  password: "${shownPassword(local.password)}"

Listening on "${local.host}:${local.port}"...`,
        ),
      });

      return local;
    }
  }

  /**
   * The ID of the Redis cluster, or of the serverless cache when `serverless` is set.
   * `Redis.get` only works with the ID of a cluster.
   */
  public get clusterId() {
    return this.connection.clusterId;
  }

  /**
   * The username to connect to the Redis cluster.
   */
  public get username() {
    return this.connection.username;
  }

  /**
   * The password to connect to the Redis cluster. This is `undefined` for a serverless
   * cache with `password: false`.
   */
  public get password(): Output<string> | undefined {
    return this.connection.password;
  }

  /**
   * The host to connect to the Redis cluster.
   */
  public get host() {
    return this.connection.host;
  }

  /**
   * The port to connect to the Redis cluster.
   */
  public get port() {
    return this.connection.port;
  }

  /**
   * Linking a cluster gives the linked resource its host, port, username and
   * password, if it has one.
   */
  public link() {
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
   *   ? sst.aws.v5.Redis.get("MyRedis", "app-dev-myredis")
   *   : new sst.aws.v5.Redis("MyRedis", { vpc });
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
      { existing: { cluster: clusterId } } as RedisArgs,
      opts,
    );
  }
}

/**
 * The subnets and security groups the cluster is in: a `Vpc`'s private
 * subnets, or the ids it was given.
 */
function vpcOf(name: string, vpc: RedisArgs["vpc"]) {
  if (isVpc(vpc)) {
    // The two `Vpc`s type these differently
    const securityGroups: Input<Input<string>[]> = vpc.securityGroups;
    return {
      subnets: subnetsOf(vpc, "private"),
      securityGroups: output(securityGroups),
    };
  }

  assertVpcIds(vpc, `the "${name}" Redis component`);
  const ids = output(vpc);
  return { subnets: ids.subnets, securityGroups: ids.securityGroups };
}

/**
 * The usage limits of a serverless cache, checked: storage in whole GB, 10 at
 * most by default, and ECPUs per second, 5,000 at most by default. They can be
 * outputs, so they're read once known.
 */
function serverlessLimits(
  name: string,
  options: Exclude<NonNullable<RedisArgs["serverless"]>, boolean>,
) {
  return {
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
        checkRange(
          name,
          "ecpuPerSecond",
          "",
          minimum,
          maximum,
          max === undefined,
        );
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
