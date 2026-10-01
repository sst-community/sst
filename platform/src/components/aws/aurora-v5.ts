import {
  all,
  ComponentResourceOptions,
  interpolate,
  jsonStringify,
  Output,
  output,
} from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { iam, rds, secretsmanager } from "@pulumi/aws";
import {
  type LinkInclude,
  V5Args,
  component,
  many,
  optional,
} from "../parts-component";
import { plain, withDefault } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { toSeconds } from "../duration";
import { transformPart } from "../transform";
import { DevCommand } from "../experimental/dev-command";
import {
  credentialsSecretOf,
  proxyArgs,
  proxyCredentials,
  proxyRoleArgs,
  storedPassword,
} from "./helpers/rds";
import { permission } from "./permission";
import { RdsRoleLookup } from "./providers/rds-role-lookup";
import { Vpc } from "./vpc";
import type { AuroraArgs } from "./aurora";

const parts = {
  /**
   * The random password of the master user. It's created when you don't set a `password`.
   */
  password: optional(RandomPassword),
  /**
   * The Secrets Manager secret that stores the master user's username and password.
   */
  secret: secretsmanager.Secret,
  /**
   * The version of the secret holding the current username and password.
   */
  secretVersion: secretsmanager.SecretVersion,
  /**
   * The RDS subnet group.
   */
  subnetGroup: rds.SubnetGroup,
  /**
   * The RDS instance parameter group.
   */
  instanceParameterGroup: rds.ParameterGroup,
  /**
   * The RDS cluster parameter group.
   */
  clusterParameterGroup: rds.ClusterParameterGroup,
  /**
   * The RDS Cluster.
   */
  cluster: rds.Cluster,
  /**
   * The primary database instance in the RDS Cluster.
   */
  instance: rds.ClusterInstance,
  /**
   * The read-only replicas in the RDS Cluster, by number, from `0`.
   */
  replica: many(rds.ClusterInstance),
  /**
   * The secrets that store the additional credentials the proxy can use, by username.
   */
  proxySecret: many(secretsmanager.Secret),
  /**
   * The versions of the secrets holding the additional credentials, by username.
   */
  proxySecretVersion: many(secretsmanager.SecretVersion),
  /**
   * The IAM role that lets the proxy read the secrets.
   */
  proxyRole: optional(iam.Role),
  /**
   * Waits for the service-linked role RDS needs before the proxy is created.
   */
  proxyRoleLookup: optional(RdsRoleLookup),
  /**
   * The RDS Proxy. For a cluster referenced with `get`, it's added once the
   * cluster's tags are read.
   */
  proxy: optional(rds.Proxy),
  /**
   * The proxy's default target group.
   */
  proxyTargetGroup: optional(rds.ProxyDefaultTargetGroup),
  /**
   * The proxy's target: the cluster.
   */
  proxyTarget: optional(rds.ProxyTarget),
};

export interface AuroraV5ProxyArgs {
  /**
   * Add extra credentials the proxy can use to connect to the database.
   *
   * Your app will use the master `username` and `password`. So you don't need to specify
   * them here.
   *
   * These credentials are for any other services that need to connect to your database
   * directly.
   *
   * :::tip
   * You need to create these credentials manually in the database.
   * :::
   *
   * These credentials are not automatically created. You'll need to create these
   * credentials manually in the database.
   *
   * The list and each username have to be plain values. A password can be an output.
   *
   * @example
   * ```js
   * {
   *   credentials: [
   *     {
   *       username: "metabase",
   *       password: "Passw0rd!"
   *     }
   *   ]
   * }
   * ```
   *
   * You can use a [`Secret`](/docs/component/secret) to manage the password.
   *
   * ```js
   * {
   *   credentials: [
   *     {
   *       username: "metabase",
   *       password: (new sst.Secret("MyDBPassword")).value
   *     }
   *   ]
   * }
   * ```
   */
  credentials?: {
    /**
     * The username of the user.
     */
    username: string;
    /**
     * The password of the user.
     */
    password: Input<string>;
  }[];
}

export interface AuroraV5Args
  extends V5Args<Omit<AuroraArgs, "proxy" | "replicas">, typeof parts> {
  /**
   * The number of read-only Aurora replicas to create.
   *
   * By default, the cluster has one primary DB instance that is used for both writes and
   * reads. You can add up to 15 read-only replicas to offload the read traffic from the
   * primary instance.
   *
   * This has to be a plain value.
   *
   * @default `0`
   * @example
   * ```js
   * {
   *   replicas: 2
   * }
   * ```
   */
  replicas?: number;
  /**
   * Enable [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
   * for the database.
   *
   * Amazon RDS Proxy sits between your application and the database and manages connections to
   * it. It's useful for serverless applications, or Lambda functions where each invocation
   * might create a new connection.
   *
   * There's an [extra cost](#cost) attached to enabling this. Check out the [RDS Proxy
   * pricing](https://aws.amazon.com/rds/proxy/pricing/) for more details.
   *
   * Whether there is a proxy has to be a plain value.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   proxy: true
   * }
   * ```
   */
  proxy?: boolean | AuroraV5ProxyArgs;
}

/** What the rest of the app reads from the database, deployed or local. */
interface Connection {
  id: Output<string>;
  clusterArn: Output<string>;
  secretArn: Output<string>;
  host: Output<string>;
  /** Where read-only connections go. */
  reader: Output<string>;
  port: Output<number>;
  username: Output<string>;
  password: Output<string>;
  database: Output<string>;
  /** The proxy connections go through, when there's one to deploy or look up. */
  proxy?: Output<rds.Proxy | undefined>;
  /** What a linked resource is allowed to do with the database. */
  include: LinkInclude[];
}

const acus = (acu: string) => parseFloat(acu.split(" ")[0]);

/**
 * The `AuroraV5` component lets you add a Aurora Postgres or MySQL cluster to your app
 * using [Amazon Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html).
 *
 * It takes the same args as [`Aurora`](/docs/component/aws/aurora) and creates the same
 * resources. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create an Aurora Postgres cluster
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const database = new sst.aws.AuroraV5("MyDatabase", {
 *   engine: "postgres",
 *   vpc
 * });
 * ```
 *
 * #### Create an Aurora MySQL cluster
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const database = new sst.aws.AuroraV5("MyDatabase", {
 *   engine: "mysql",
 *   vpc
 * });
 * ```
 *
 * #### Change the scaling config
 *
 * ```js title="sst.config.ts"
 * new sst.aws.AuroraV5("MyDatabase", {
 *   engine: "postgres",
 *   scaling: {
 *     min: "2 ACU",
 *     max: "128 ACU"
 *   },
 *   vpc
 * });
 * ```
 *
 * #### Link to a resource
 *
 * You can link your database to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [database],
 *   vpc
 * });
 * ```
 *
 * Once linked, you can connect to it from your function code.
 *
 * ```ts title="app/page.tsx" {1,5-9}
 * import { Resource } from "sst";
 * import postgres from "postgres";
 *
 * const sql = postgres({
 *   username: Resource.MyDatabase.username,
 *   password: Resource.MyDatabase.password,
 *   database: Resource.MyDatabase.database,
 *   host: Resource.MyDatabase.host,
 *   port: Resource.MyDatabase.port
 * });
 * ```
 *
 * #### Enable the RDS Data API
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.AuroraV5("MyDatabase", {
 *   engine: "postgres",
 *   dataApi: true,
 *   vpc
 * });
 * ```
 *
 * When using the Data API, connecting to the database does not require a persistent
 * connection, and works over HTTP. You also don't need the `sst tunnel` or a VPN to connect
 * to it from your local machine.
 *
 * ```ts title="app/page.tsx" {1,6,7,8}
 * import { Resource } from "sst";
 * import { drizzle } from "drizzle-orm/aws-data-api/pg";
 * import { RDSDataClient } from "@aws-sdk/client-rds-data";
 *
 * drizzle(new RDSDataClient({}), {
 *   database: Resource.MyDatabase.database,
 *   secretArn: Resource.MyDatabase.secretArn,
 *   resourceArn: Resource.MyDatabase.clusterArn
 * });
 * ```
 *
 * #### Running locally
 *
 * By default, your Aurora database is deployed in `sst dev`. But let's say you are running
 * Postgres locally.
 *
 * ```bash
 * docker run \
 *   --rm \
 *   -p 5432:5432 \
 *   -v $(pwd)/.sst/storage/postgres:/var/lib/postgresql/data \
 *   -e POSTGRES_USER=postgres \
 *   -e POSTGRES_PASSWORD=password \
 *   -e POSTGRES_DB=local \
 *   postgres:17
 * ```
 *
 * You can connect to it in `sst dev` by configuring the `dev` prop.
 *
 * ```ts title="sst.config.ts" {4-9}
 * new sst.aws.AuroraV5("MyDatabase", {
 *   engine: "postgres",
 *   vpc,
 *   dev: {
 *     username: "postgres",
 *     password: "password",
 *     database: "local",
 *     port: 5432
 *   }
 * });
 * ```
 *
 * This will skip deploying the database and link to the locally running Postgres database
 * instead.
 *
 * #### Switch from `Aurora`
 *
 * Change `Aurora` to `AuroraV5` and keep the name. The cluster you've deployed is kept,
 * and so is everything around it: its instances, password, secrets, parameter groups and
 * proxy.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const database = new sst.aws.Aurora("MyDatabase", { engine: "postgres", vpc });
 * const database = new sst.aws.AuroraV5("MyDatabase", { engine: "postgres", vpc });
 * ```
 *
 * A few things are written differently:
 *
 * - `replicas`, `proxy`, its list of `credentials`, and each credential's `username` are
 *   plain values, not outputs. They decide which resources are created.
 * - `nodes` has every resource, not only the cluster and the instance. The secret that
 *   stores the master user's credentials is `nodes.secret`.
 * - `transform.instance` still applies to the primary instance and to each replica. To
 *   change only the replicas, use `transform.replica`, which is applied after it.
 * - If you set `tags` on the cluster with an object in `transform`, it keeps the tags SST
 *   sets next to yours. They're added back when you switch.
 *
 * ---
 *
 * ### Cost
 *
 * This component has one DB instance that is used for both writes and reads. The
 * instance can scale from the minimum number of ACUs to the maximum number of ACUs. By default,
 * this uses a `min` of 0 ACUs and a `max` of 4 ACUs.
 *
 * When the database is paused, you are not charged for the ACUs.
 *
 * Each ACU costs $0.12 per hour for both `postgres` and `mysql` engine. The storage costs
 * $0.01 per GB per month for standard storage.
 *
 * So if your database is constantly using 1GB of memory or 0.5 ACUs, then you are charged
 * $0.12 x 0.5 x 24 x 30 or **$43 per month**. And add the storage costs to this as well.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing) for more details.
 *
 * #### RDS Proxy
 *
 * If you enable the `proxy`, it uses _Aurora Capacity Units_ with a minumum of 8 ACUs at
 * $0.015 per ACU hour.
 *
 * That works out to an **additional** $0.015 x 8 x 24 x 30 or **$86 per month**. Adjust
 * this if you end up using more than 8 ACUs.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [RDS Proxy pricing](https://aws.amazon.com/rds/proxy/pricing/) for more details.
 *
 * #### RDS Data API
 *
 * If you enable `dataApi`, you get charged an **additional** $0.35 per million requests for
 * the first billion requests. After that, it's $0.20 per million requests.
 *
 * Check out the [RDS Data API pricing](https://aws.amazon.com/rds/aurora/pricing/#Data_API_costs)
 * for more details.
 */
export class AuroraV5 extends component("sst:aws:AuroraV5", parts) {
  private connection: Connection;

  constructor(
    name: string,
    args: AuroraV5Args,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const self = this;

    // A cluster that's already deployed
    const existing = this.existingPart("cluster");
    if (existing) {
      this.connection = reference(existing);
      return;
    }

    const proxy = plain(args.proxy, `The "proxy" of the "${name}" database`);
    const replicas =
      plain(args.replicas, `The "replicas" of the "${name}" database`) ?? 0;
    if (replicas > 15)
      throw new VisibleError(
        `Cannot create more than 15 read-only replicas for the "${name}" Aurora database.`,
      );

    const engine = output(args.engine);
    const username = all([args.username, engine]).apply(
      ([username, engine]) =>
        username ?? { postgres: "postgres", mysql: "root" }[engine],
    );
    const dbName = withDefault(args.database, $app.name.replaceAll("-", "_"));

    // In `sst dev`, a database on the user's machine stands in for the
    // cluster. This is the only place the component handles dev mode.
    const local = args.dev ? runLocally(args.dev) : undefined;
    if (local && $dev) {
      this.runsLocally();
      this.connection = local;
      return;
    }

    const version = all([args.version, engine]).apply(
      ([version, engine]) =>
        version ?? { postgres: "17", mysql: "3.08.0" }[engine],
    );
    const family = all([engine, version]).apply(([engine, version]) => {
      if (engine === "postgres")
        return `aurora-postgresql${version.split(".")[0]}`;
      return version.startsWith("2") ? `aurora-mysql5.7` : `aurora-mysql8.0`;
    });
    const scaling = output(args.scaling).apply((scaling) => {
      const max = scaling?.max ?? "4 ACU";
      const min = scaling?.min ?? "0 ACU";
      // A cluster that scales down to nothing is paused when it's idle
      const pauses = acus(min) === 0;
      if (scaling?.pauseAfter && !pauses)
        throw new VisibleError(
          `Cannot configure "pauseAfter" when the minimum ACU is not 0 for the "${name}" Aurora database.`,
        );
      return {
        max,
        min,
        pauseAfter: pauses ? scaling?.pauseAfter ?? "5 minutes" : undefined,
      };
    });
    const vpc =
      args.vpc instanceof Vpc
        ? output({
            subnets: args.vpc.privateSubnets,
            securityGroups: args.vpc.securityGroups,
          })
        : output(args.vpc);
    // An engine version the user didn't choose isn't moved once it's deployed
    const pinned = (field: string) => (args.version ? [] : [field]);
    const parameterGroupOpts = {
      ignoreChanges: pinned("family"),
      // Necessary for the subnet to be deleted after the instance.
      // This is either a Pulumi bug or an undocumented feature.
      deleteBeforeReplace: false,
    };

    const password = args.password
      ? output(args.password)
      : this.part("password", { length: 32, special: false }).result;

    const secret = this.part("secret", { recoveryWindowInDays: 0 });
    this.part("secretVersion", {
      secretId: secret.id,
      secretString: jsonStringify({ username, password }),
    });

    const subnetGroup = this.part("subnetGroup", { subnetIds: vpc.subnets });

    const instanceParameterGroup = this.part(
      "instanceParameterGroup",
      { family, parameters: [] },
      parameterGroupOpts,
    );
    const clusterParameterGroup = this.part(
      "clusterParameterGroup",
      { family, parameters: [] },
      parameterGroupOpts,
    );

    // The cluster is tagged with its proxy, so the proxy comes first
    const rdsProxy = proxy
      ? createProxy(proxy === true ? {} : proxy)
      : undefined;

    const cluster = this.part(
      "cluster",
      {
        engine: engine.apply((engine) =>
          engine === "postgres"
            ? rds.EngineType.AuroraPostgresql
            : rds.EngineType.AuroraMysql,
        ),
        engineMode: "provisioned",
        engineVersion: all([engine, version]).apply(([engine, version]) => {
          if (engine === "postgres") return version;
          return version.startsWith("2")
            ? `5.7.mysql_aurora.${version}`
            : `8.0.mysql_aurora.${version}`;
        }),
        databaseName: dbName,
        masterUsername: username,
        masterPassword: password,
        dbClusterParameterGroupName: clusterParameterGroup.name,
        dbInstanceParameterGroupName: instanceParameterGroup.name,
        serverlessv2ScalingConfiguration: scaling.apply((scaling) => ({
          maxCapacity: acus(scaling.max),
          minCapacity: acus(scaling.min),
          secondsUntilAutoPause: scaling.pauseAfter
            ? toSeconds(scaling.pauseAfter)
            : undefined,
        })),
        applyImmediately: true,
        allowMajorVersionUpgrade: true,
        skipFinalSnapshot: true,
        storageEncrypted: true,
        enableHttpEndpoint: withDefault(args.dataApi, false),
        dbSubnetGroupName: subnetGroup.name,
        vpcSecurityGroupIds: vpc.securityGroups,
        // What a component that references this cluster looks up
        tags: {
          "sst:ref:password": secret.id,
          ...(rdsProxy ? { "sst:ref:proxy": rdsProxy.id } : {}),
        },
      },
      { ignoreChanges: pinned("engineVersion") },
    );

    const instanceArgs = {
      clusterIdentifier: cluster.id,
      instanceClass: "db.serverless",
      engine: cluster.engine.apply((v) => v as rds.EngineType),
      engineVersion: cluster.engineVersion,
      dbSubnetGroupName: cluster.dbSubnetGroupName,
      dbParameterGroupName: instanceParameterGroup.name,
      autoMinorVersionUpgrade: false,
    };
    const instance = this.part("instance", instanceArgs);

    for (let i = 0; i < replicas; i++) {
      // The instance's transform applies to each replica too, as it does in
      // `Aurora`. The replica's own transform is applied after it.
      const [, replicaArgs, replicaOpts] = transformPart(
        args.transform?.instance,
        `${name}Replica${i}`,
        { ...instanceArgs, promotionTier: 15 },
        { ignoreChanges: pinned("engineVersion") },
      );
      this.part("replica", `${i}`, replicaArgs, replicaOpts);
    }

    if (rdsProxy) {
      const targetGroup = this.part("proxyTargetGroup", {
        dbProxyName: rdsProxy.name,
      });
      this.part("proxyTarget", {
        dbProxyName: rdsProxy.name,
        targetGroupName: targetGroup.name,
        dbClusterIdentifier: cluster.clusterIdentifier,
      });
    }

    this.connection = connectTo(
      cluster,
      instance,
      secret,
      password,
      output(rdsProxy),
    );

    function createProxy(proxy: AuroraV5ProxyArgs) {
      // A secret for each additional user the proxy can connect as
      const secrets = proxyCredentials(proxy.credentials, name).map(
        ({ username, password }) => {
          const secret = self.part("proxySecret", username, {
            recoveryWindowInDays: 0,
          });
          self.part("proxySecretVersion", username, {
            secretId: secret.id,
            secretString: jsonStringify({ username, password }),
          });
          return secret;
        },
      );
      // The proxy can connect as the master user and as each of those
      const logins = [secret, ...secrets];

      const role = self.part("proxyRole", proxyRoleArgs(logins));
      const lookup = self.part("proxyRoleLookup", {
        name: "AWSServiceRoleForRDS",
      });
      return self.part(
        "proxy",
        proxyArgs(
          engine.apply((engine) =>
            engine === "postgres" ? "POSTGRESQL" : "MYSQL",
          ),
          logins,
          role,
          vpc.subnets,
        ),
        { dependsOn: [lookup] },
      );
    }

    // A cluster created by `Aurora` or `AuroraV5` is tagged with the secret
    // that holds its credentials, and with its proxy when it has one. The
    // rest is found from those.
    function reference(cluster: rds.Cluster) {
      const instance =
        self.existingPart("instance") ??
        self.lookupPart(
          "instance",
          all([
            cluster.id,
            rds.getInstancesOutput(
              { filters: [{ name: "db-cluster-id", values: [cluster.id] }] },
              { parent: self },
            ).instanceIdentifiers,
          ]).apply(([id, instances]) => {
            if (!instances.length)
              throw new VisibleError(
                `Database instance not found in cluster ${id}`,
              );
            return instances[0];
          }),
        );

      const secret =
        self.existingPart("secret") ??
        self.lookupPart(
          "secret",
          credentialsSecretOf(
            cluster,
            "sst:ref:password",
            `Failed to get password for Aurora ${name}.`,
          ),
        );

      const proxy = self.existingPart("proxy");

      return connectTo(
        cluster,
        instance,
        secret,
        args.password
          ? output(args.password)
          : storedPassword(secret.id, self),
        proxy
          ? output(proxy)
          : cluster.tagsAll.apply((tags) =>
              tags?.["sst:ref:proxy"]
                ? self.lookupPart("proxy", tags["sst:ref:proxy"])
                : undefined,
            ),
      );
    }

    function connectTo(
      cluster: rds.Cluster,
      instance: rds.ClusterInstance,
      secret: secretsmanager.Secret,
      password: Output<string>,
      proxy: Output<rds.Proxy | undefined>,
    ): Connection {
      return {
        id: cluster.id,
        clusterArn: cluster.arn,
        secretArn: secret.arn,
        // Connections go through the proxy when there is one
        host: all([cluster.endpoint, proxy]).apply(
          ([endpoint, proxy]) =>
            proxy?.endpoint ?? output(endpoint.split(":")[0]),
        ),
        reader: cluster.readerEndpoint.apply(
          (endpoint) => endpoint.split(":")[0],
        ),
        port: instance.port,
        username: cluster.masterUsername,
        password,
        database: cluster.databaseName,
        proxy,
        include: [
          permission({
            actions: ["secretsmanager:GetSecretValue"],
            resources: [secret.arn],
          }),
          permission({
            actions: [
              "rds-data:BatchExecuteStatement",
              "rds-data:BeginTransaction",
              "rds-data:CommitTransaction",
              "rds-data:ExecuteStatement",
              "rds-data:RollbackTransaction",
            ],
            resources: [cluster.arn],
          }),
        ],
      };
    }

    function runLocally(dev: NonNullable<AuroraV5Args["dev"]>): Connection {
      if ($dev && dev.password === undefined && args.password === undefined)
        throw new VisibleError(
          `You must provide the password to connect to your locally running database either by setting the "dev.password" or by setting the top-level "password" property.`,
        );

      const host = output(dev.host ?? "localhost");
      const local = {
        id: output("placeholder"),
        clusterArn: output("placeholder"),
        secretArn: output("placeholder"),
        host,
        reader: host,
        port: all([dev.port, engine]).apply(
          ([port, engine]) => port ?? { postgres: 5432, mysql: 3306 }[engine],
        ),
        username: dev.username ? output(dev.username) : username,
        password: output(dev.password ?? args.password ?? ""),
        database: dev.database ? output(dev.database) : dbName,
        include: [],
      };

      new DevCommand(`${name}Dev`, {
        dev: {
          title: name,
          autostart: true,
          command: `sst print-and-not-quit`,
        },
        environment: {
          SST_DEV_COMMAND_MESSAGE: interpolate`Make sure your local database is using:

  username: "${local.username}"
  password: "${local.password}"
  database: "${local.database}"

Listening on "${local.host}:${local.port}"...`,
        },
      });

      return local;
    }
  }

  /**
   * The ID of the RDS Cluster.
   */
  public get id() {
    return this.connection.id;
  }

  /**
   * The ARN of the RDS Cluster.
   */
  public get clusterArn() {
    return this.connection.clusterArn;
  }

  /**
   * The ARN of the master user secret.
   */
  public get secretArn() {
    return this.connection.secretArn;
  }

  /** The username of the master user. */
  public get username() {
    return this.connection.username;
  }

  /** The password of the master user. */
  public get password() {
    return this.connection.password;
  }

  /**
   * The name of the database.
   */
  public get database() {
    return this.connection.database;
  }

  /**
   * The port of the database.
   */
  public get port() {
    return this.connection.port;
  }

  /**
   * The host of the database.
   */
  public get host() {
    return this.connection.host;
  }

  /**
   * The reader endpoint of the database.
   */
  public get reader() {
    const { reader, proxy } = this.connection;
    if (!proxy) return reader;
    return all([reader, proxy]).apply(([reader, proxy]) => {
      if (proxy)
        throw new VisibleError(
          "Reader endpoint is not currently supported for RDS Proxy. Please contact us on Discord or open a GitHub issue.",
        );
      return reader;
    });
  }

  /**
   * Linking a database gives the linked resource what it needs to connect:
   * the host, port, database, username and password, and the ARNs of the
   * cluster and its secret for the RDS Data API.
   */
  public link() {
    const { reader, proxy } = this.connection;
    return {
      properties: {
        clusterArn: this.clusterArn,
        secretArn: this.secretArn,
        database: this.database,
        username: this.username,
        password: this.password,
        port: this.port,
        host: this.host,
        // A proxy has no reader endpoint
        reader: proxy
          ? all([reader, proxy]).apply(([reader, proxy]) =>
              proxy ? undefined : reader,
            )
          : reader,
      },
      include: this.connection.include,
    };
  }

  /**
   * Reference an existing Aurora cluster with its RDS cluster ID. This is useful when you
   * create a Aurora cluster in one stage and want to share it in another. It avoids having to
   * create a new Aurora cluster in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share Aurora clusters across stages.
   * :::
   *
   * @param name The name of the component.
   * @param id The ID of the existing Aurora cluster.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a cluster in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new cluster, you want to share the same cluster from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const database = $app.stage === "frank"
   *   ? sst.aws.AuroraV5.get("MyDatabase", "app-dev-mydatabase")
   *   : new sst.aws.AuroraV5("MyDatabase", { engine: "postgres", vpc });
   * ```
   *
   * Here `app-dev-mydatabase` is the ID of the cluster created in the `dev` stage.
   * You can find this by outputting the cluster ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return database.id;
   * ```
   */
  public static get(
    name: string,
    id: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new AuroraV5(
      name,
      { existing: { cluster: id } } as AuroraV5Args,
      opts,
    );
  }
}
