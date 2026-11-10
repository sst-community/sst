import type { Vpc } from "./vpc";
import { all, ComponentResourceOptions, Output, output } from "@pulumi/pulumi";
import { rds, secretsmanager } from "@pulumi/aws";
import {
  type ComponentArgs,
  type LinkInclude,
  component,
  many,
  optional,
} from "../parts-component";
import { knownValue, plain, withDefault, onlyExisting, getArgs } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { type DurationHours, toSeconds } from "../duration";
import { transformPart } from "../transform";
import { context } from "../contract";
import {
  createCredentials,
  createRdsProxy,
  createRdsProxyTarget,
  localDatabase,
  type ProxyArgs,
  rdsCredentialParts,
  rdsProxyParts,
} from "./helpers/rds";
import { secretField, tagOf } from "./helpers/secret";
import { permission } from "./permission";
import { subnetsAndSecurityGroupsOf } from "./helpers/vpc";

const parts = {
  /**
   * The Secrets Manager secret that stores the master user's username and password. Next
   * to an existing `cluster`, it's the one given here, or the one the cluster is tagged
   * with.
   */
  secret: secretsmanager.Secret,
  ...rdsCredentialParts,
  /**
   * The RDS subnet group. Not created by `get`.
   */
  subnetGroup: optional(rds.SubnetGroup),
  /**
   * The RDS instance parameter group. Not created by `get`.
   */
  instanceParameterGroup: optional(rds.ParameterGroup),
  /**
   * The RDS cluster parameter group. Not created by `get`.
   */
  clusterParameterGroup: optional(rds.ClusterParameterGroup),
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
  ...rdsProxyParts,
};

type ACU = `${number} ACU`;

export interface AuroraArgs extends ComponentArgs<typeof parts> {
  /**
   * The Aurora engine to use.
   *
   * :::danger
   * Changing the engine will cause the database to be destroyed and recreated.
   * :::
   *
   * @example
   * ```js
   * {
   *   engine: "postgres"
   * }
   * ```
   */
  engine: Input<"postgres" | "mysql">;
  /**
   * The version of the Aurora engine.
   *
   * The default is `"17"` for Postgres and `"3.08.0"` for MySQL. Changing this default
   * doesn't change the version of a cluster that's already deployed.
   *
   * Check out the [available Postgres versions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html#Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.apg) and [available MySQL versions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html#Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.amy) in your region.
   *
   * :::tip
   * Not all versions support scaling to 0 with auto-pause and resume.
   * :::
   *
   * Auto-pause and resume is only supported in the following versions:
   * - Aurora PostgreSQL 16.3 and higher
   * - Aurora PostgreSQL 15.7 and higher
   * - Aurora PostgreSQL 14.12 and higher
   * - Aurora PostgreSQL 13.15 and higher
   * - Aurora MySQL 3.08.0 and higher
   *
   * :::caution
   * Changing the version will cause the database to restart on the next `sst deploy`,
   * causing downtime. Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   * :::
   *
   * @default `"17"` for Postgres, `"3.08.0"` for MySQL
   * @example
   * ```js
   * {
   *   version: "17.3"
   * }
   * ```
   */
  version?: Input<string>;
  /**
   * The username of the master user.
   *
   * :::danger
   * Changing the username will cause the database to be destroyed and recreated.
   * :::
   *
   * @default `"postgres"` for Postgres, `"root"` for MySQL
   * @example
   * ```js
   * {
   *   username: "admin"
   * }
   * ```
   */
  username?: Input<string>;
  /**
   * The password of the master user.
   * @default A random password is generated.
   * @example
   * ```js
   * {
   *   password: "Passw0rd!"
   * }
   * ```
   *
   * You can use a [`Secret`](/docs/component/secret) to manage the password.
   *
   * ```js
   * {
   *   password: new sst.Secret("MyDBPassword").value
   * }
   * ```
   *
   * Whether it's set decides whether a password is generated, so it has to be set or left
   * out, not given as an output that may be `undefined`.
   */
  password?: Input<string>;
  /**
   * Name of a database that is automatically created inside the cluster.
   *
   * The name must begin with a letter and contain only lowercase letters, numbers, or
   * underscores.
   *
   * By default, it takes the name of the app, and replaces the hyphens with underscores.
   *
   * :::danger
   * Changing the database name will cause the database to be destroyed and recreated.
   * :::
   *
   * @default Based on the name of the current app
   * @example
   * ```js
   * {
   *   database: "acme"
   * }
   * ```
   */
  database?: Input<string>;
  /**
   * The Aurora Serverless v2 scaling config.
   *
   * By default, the cluster has one DB instance that is used for both writes and reads. The
   * instance can scale from a minimum number of ACUs to the maximum number of ACUs.
   *
   * :::tip
   * Pick the `min` and `max` ACUs based on the baseline and peak memory usage of your app.
   * :::
   *
   * An ACU or _Aurora Capacity Unit_ is roughly equivalent to 2 GB of memory and a corresponding
   * amount of CPU and network resources. So pick the minimum and maximum based on the baseline
   * and peak memory usage of your app.
   *
   * If you set a `min` of 0 ACUs, the database will be paused when there are no active
   * connections in the `pauseAfter` specified time period.
   *
   * This is useful for dev environments since you are not charged when the database is paused.
   * But it's not recommended for production environments because it takes around 15 seconds for
   * the database to resume.
   *
   * @default `{min: "0 ACU", max: "4 ACU"}`
   */
  scaling?: Input<{
    /**
     * The minimum number of ACUs or _Aurora Capacity Units_. Ranges from 0 to 256, in
     * increments of 0.5. Where each ACU is roughly equivalent to 2 GB of memory.
     *
     * If you set this to 0 ACUs, the database will be paused when there are no active
     * connections in the `pauseAfter` specified time period.
     *
     * :::note
     * If you set a `min` ACU to 0, the database will be paused after the `pauseAfter` time
     * period.
     * :::
     *
     * On the next database connection, the database will resume. It takes about 15 seconds for
     * the database to resume.
     *
     * :::tip
     * Avoid setting a low number of `min` ACUs for production workloads.
     * :::
     *
     * For your production workloads, setting a minimum of 0.5 ACUs might not be a great idea
     * because:
     *
     * 1. It takes longer to scale from a low number of ACUs to a much higher number.
     * 2. Query performance depends on the buffer cache. So if frequently accessed data cannot
     *   fit into the buffer cache, you might see uneven performance.
     * 3. The max connections for a 0.5 ACU instance is capped at 2000.
     *
     * You can [read more here](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.setting-capacity.html#aurora-serverless-v2.setting-capacity.incompatible_parameters).
     *
     * @default `0 ACU`
     * @example
     * ```js
     * {
     *   scaling: {
     *     min: "2 ACU"
     *   }
     * }
     * ```
     */
    min?: Input<ACU>;
    /**
     * The maximum number of ACUs or _Aurora Capacity Units_. Ranges from 1 to 128 on older
     * engine versions, and higher on recent ones, in increments of 0.5. Where each ACU is
     * roughly equivalent to 2 GB of memory. Check out the [capacity
     * limits](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.setting-capacity.html).
     *
     * @default `4 ACU`
     * @example
     * ```js
     * {
     *   scaling: {
     *     max: "128 ACU"
     *   }
     * }
     * ```
     */
    max?: Input<ACU>;
    /**
     * The amount of time before the database is paused when there are no active connections.
     * Only applies when the `min` is set to 0 ACUs.
     *
     * :::note
     * This only applies when the `min` is set to 0 ACUs.
     * :::
     *
     * Must be between `"5 minutes"` and `"24 hours"`. So if the `min` is set to 0 ACUs, by
     * default, the database will be auto-paused after `"5 minutes"`.
     *
     * When the database is paused, you are not charged for the ACUs. On the next database
     * connection, the database will resume. It takes about 15 seconds for the database to
     * resume.
     *
     * :::tip
     * Auto-pause is not recommended for production environments.
     * :::
     *
     * Auto-pause is useful for minimizing costs in the development environments where the
     * database is not used frequently. It's not recommended for production environments.
     *
     * @default `"5 minutes"`
     * @example
     * ```js
     * {
     *   scaling: {
     *     pauseAfter: "20 minutes"
     *   }
     * }
     * ```
     */
    pauseAfter?: Input<DurationHours>;
  }>;
  /**
   * The number of read-only Aurora replicas to create.
   *
   * By default, the cluster has one primary DB instance that is used for both writes and
   * reads. You can add up to 15 read-only replicas to offload the read traffic from the
   * primary instance.
   *
   * This has to be a plain value, not an output: it decides which resources are created.
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
   * Enable [RDS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html)
   * for the database.
   *
   * The RDS Data API provides a secure HTTP endpoint and does not need a persistent connection.
   * You also don't need the `sst tunnel` or a VPN to connect to it from your local machine.
   *
   * RDS Data API is [billed per request](#cost). Check out the [RDS Data API
   * pricing](https://aws.amazon.com/rds/aurora/pricing/#Data_API_costs) for more details.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   dataApi: true
   * }
   * ```
   */
  dataApi?: Input<boolean>;
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
   * This has to be a plain value, not an output: it decides which resources are created.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   proxy: true
   * }
   * ```
   */
  proxy?: boolean | ProxyArgs;
  /**
   * The VPC to use for the database cluster.
   *
   * @example
   * Create a `Vpc` component.
   *
   * ```js
   * const myVpc = new sst.aws.Vpc("MyVpc");
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
    | Vpc
    | Input<{
        /**
         * A list of subnet IDs in the VPC to deploy the Aurora cluster in.
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
   * By default, your Aurora database is deployed in `sst dev`. But if you want to instead
   * connect to a locally running database, you can configure the `dev` prop.
   *
   * This will skip deploying an Aurora database and link to the locally running database
   * instead. `sst dev` shows what the local database has to be set up with, in a pane of its
   * own.
   *
   * This has to be a plain value, not an output: it decides whether the database is
   * deployed. The values inside it can be outputs.
   *
   * @example
   *
   * Setting the `dev` prop also means that any linked resources will connect to the right
   * database both in `sst dev` and `sst deploy`.
   *
   * ```ts
   * {
   *   dev: {
   *     username: "postgres",
   *     password: "password",
   *     database: "postgres",
   *     host: "localhost",
   *     port: 5432
   *   }
   * }
   * ```
   */
  dev?: {
    /**
     * The host of the local database to connect to when running in dev.
     * @default `"localhost"`
     */
    host?: Input<string>;
    /**
     * The port of the local database to connect to when running in dev.
     * @default `5432` for Postgres, `3306` for MySQL
     */
    port?: Input<number>;
    /**
     * The database of the local database to connect to when running in dev.
     * @default Inherit from the top-level [`database`](#database).
     */
    database?: Input<string>;
    /**
     * The username of the local database to connect to when running in dev.
     * @default Inherit from the top-level [`username`](#username).
     */
    username?: Input<string>;
    /**
     * The password of the local database to connect to when running in dev. `sst dev`
     * needs this or the top-level `password`.
     * @default Inherit from the top-level [`password`](#password).
     */
    password?: Input<string>;
  };
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
 * The `Aurora` component lets you add a Aurora Postgres or MySQL cluster to your app
 * using [Amazon Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html).
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create an Aurora Postgres cluster
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const database = new sst.aws.Aurora("MyDatabase", {
 *   engine: "postgres",
 *   vpc
 * });
 * ```
 *
 * #### Create an Aurora MySQL cluster
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const database = new sst.aws.Aurora("MyDatabase", {
 *   engine: "mysql",
 *   vpc
 * });
 * ```
 *
 * #### Change the scaling config
 *
 * ```js title="sst.config.ts"
 * new sst.aws.Aurora("MyDatabase", {
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
 * new sst.aws.Aurora("MyDatabase", {
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
 * new sst.aws.Aurora("MyDatabase", {
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
 * #### Switch from SST 4's `sst.aws.Aurora`
 *
 * Keep the name, and `sst migrate` moves it. The cluster you've
 * deployed is kept, and so is everything around it: its instances, password, secrets,
 * parameter groups and proxy. What waits for the role RDS needs before the proxy is
 * created is a resource of a new type, which the `sst` binary serves: `sst migrate`
 * takes SST 4's out of the state, and the new one finds the role.
 *
 * A few things work differently:
 *
 * - `replicas`, `proxy`, its list of `credentials`, and each credential's `username` are
 *   plain values, not outputs. They decide which resources are created.
 * - With `dev` set, SST 4's `Aurora` created a component for the pane `sst dev` shows, in
 *   every deploy. SST 5's tells `sst dev` itself, so a deploy drops that component. It
 *   has nothing in AWS behind it. An empty local password is shown as "[no password]" in
 *   the pane.
 * - `nodes` has every resource, not only the cluster and the instance. The secret that
 *   stores the master user's credentials is `nodes.secret`. In `sst dev` with `dev` set,
 *   reading one of them fails and says why it's missing, where SST 4's `Aurora` gave
 *   `undefined`.
 * - `transform.instance` still applies to the primary instance and to each replica. To
 *   change only the replicas, use `transform.replica`, which is applied after it. A
 *   function there is applied once to each replica. SST 4's applied it to the instance's
 *   args, then made each replica from those and applied it again, so a function that adds
 *   to what it's given, like a tag counted up or an item pushed onto a list, gave a
 *   replica it twice.
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
export class Aurora extends component("sst:aws:Aurora", parts) {
  private connection: Connection;

  constructor(name: string, args: AuroraArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const self = this;

    const engine = output(args.engine);
    const username = all([args.username, engine]).apply(
      ([username, engine]) =>
        username ?? { postgres: "postgres", mysql: "root" }[engine],
    );
    const dbName = withDefault(
      args.database,
      context().app.name.replaceAll("-", "_"),
    );

    const owner = `the "${name}" Aurora database`;

    // Given a cluster that's already deployed, it uses its instance, secret
    // and proxy, and creates nothing else
    if (args.existing?.cluster !== undefined)
      onlyExisting(
        args.existing,
        ["cluster", "instance", "secret", "proxy"],
        owner,
      );

    // In `sst dev`, a database on the user's machine stands in for the
    // cluster, one that's already deployed too. This is the only place the
    // component handles dev mode.
    const dev = plain(args.dev, `The "dev" of ${owner}`);
    if (dev && context().dev) {
      this.runsLocally();
      this.connection = runLocally(dev);
      return;
    }

    // A cluster that's already deployed
    const existing = this.existingPart("cluster");
    if (existing) {
      this.connection = reference(existing);
      return;
    }

    const proxy = plain(args.proxy, `The "proxy" of ${owner}`);
    const replicas = plain(args.replicas, `The "replicas" of ${owner}`) ?? 0;
    if (replicas > 15)
      throw new VisibleError(
        `The "replicas" of ${owner} is ${replicas}. It can have 15 read-only replicas at most.`,
      );

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
          `The "scaling.pauseAfter" of ${owner} is only for a cluster that scales down to 0 ACU, and its "scaling.min" is ${min}. Remove "pauseAfter", or set "min" to "0 ACU".`,
        );
      return {
        max,
        min,
        pauseAfter: pauses ? scaling?.pauseAfter ?? "5 minutes" : undefined,
      };
    });
    const vpc = subnetsAndSecurityGroupsOf(args.vpc, owner);
    // An engine version the user didn't choose isn't moved once it's deployed
    const pinned = (field: string) => (args.version ? [] : [field]);
    const parameterGroupOpts = {
      ignoreChanges: pinned("family"),
      // Necessary for the subnet to be deleted after the instance.
      // This is either a Pulumi bug or an undocumented feature.
      deleteBeforeReplace: false,
    };

    const builder = this.builder();
    const { password, secret } = createCredentials(
      builder,
      username,
      args.password,
    );

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
      ? createRdsProxy(builder, proxy === true ? {} : proxy, {
          master: secret,
          engineFamily: engine.apply((engine) =>
            engine === "postgres" ? "POSTGRESQL" : "MYSQL",
          ),
          subnets: vpc.subnets,
          owner,
        })
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

    // Made again for each instance: a transform function changes the args
    // it's given, so a replica made from the instance's would have the
    // instance's transform applied to it twice, as SST 4's did
    const instanceArgs = () => ({
      clusterIdentifier: cluster.id,
      instanceClass: "db.serverless",
      engine: cluster.engine.apply((v) => v as rds.EngineType),
      engineVersion: cluster.engineVersion,
      dbSubnetGroupName: cluster.dbSubnetGroupName,
      dbParameterGroupName: instanceParameterGroup.name,
      autoMinorVersionUpgrade: false,
    });
    const instance = this.part("instance", instanceArgs());

    for (let i = 0; i < replicas; i++) {
      // The instance's transform applies to each replica too, as it does in
      // `Aurora`. The replica's own transform is applied after it.
      const replicaDefaults = { ...instanceArgs(), promotionTier: 15 };
      const [, replicaArgs, replicaOpts] = transformPart(
        args.transform?.instance,
        `${name}Replica${i}`,
        replicaDefaults,
        { parent: self, ignoreChanges: pinned("engineVersion") },
      );
      const replica = this.part("replica", `${i}`, replicaArgs, replicaOpts);
      this.reportTransformMerge(
        replica.urn,
        replicaDefaults,
        args.transform?.instance,
      );
    }

    if (rdsProxy)
      createRdsProxyTarget(builder, rdsProxy, {
        dbClusterIdentifier: cluster.clusterIdentifier,
      });

    this.connection = connectTo(
      cluster,
      instance,
      secret,
      password,
      output(rdsProxy),
    );

    // A cluster created by this component, or by the 4.x one, is tagged with
    // the secret that holds its credentials, and with its proxy when it has
    // one. The rest is found from those.
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
                `The "${name}" Aurora database can't find an instance in its cluster, "${id}".`,
              );
            return instances[0];
          }),
        );

      const secret =
        self.existingPart("secret") ??
        self.lookupPart(
          "secret",
          tagOf(
            cluster,
            "sst:ref:password",
            `The "${name}" Aurora database can't find its secret: its cluster has no "sst:ref:password" tag, which names the secret that holds its password. Pass the secret in "existing.secret".`,
          ),
        );

      // The proxy the cluster is tagged with is looked up once a preview
      // knows the tags, not inside an `apply`: until then it isn't in
      // `nodes`, and `host` waits for it.
      const proxy =
        self.existingPart("proxy") ??
        self.after(knownValue(cluster.tagsAll), (tags) =>
          tags?.["sst:ref:proxy"]
            ? self.lookupPart("proxy", tags["sst:ref:proxy"])
            : undefined,
        );

      return connectTo(
        cluster,
        instance,
        secret,
        args.password
          ? output(args.password)
          : secretField(secret.id, "password", self),
        output(proxy),
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

    // What `sst dev` connects to, and the pane that says how the local
    // database has to be set up
    function runLocally(dev: NonNullable<AuroraArgs["dev"]>): Connection {
      const local = localDatabase(
        dev,
        {
          password: args.password,
          username,
          database: dbName,
          port: engine.apply(
            (engine) => ({ postgres: 5432, mysql: 3306 })[engine],
          ),
        },
        owner,
        "database",
      );
      self.report({ dev: local.pane });
      return {
        id: output("placeholder"),
        clusterArn: output("placeholder"),
        secretArn: output("placeholder"),
        ...local.connection,
        reader: local.connection.host,
        include: [],
      };
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
          `The "${this.componentName}" Aurora database connects through its proxy, which has no reader endpoint. Connect to its "host".`,
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
   * Its instance, the secret with its password, and its proxy when it has one are found
   * from the cluster. The proxy is looked up once the cluster's tags are read, so it's in
   * `nodes` only after that.
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
   *   ? sst.aws.Aurora.get("MyDatabase", "app-dev-mydatabase")
   *   : new sst.aws.Aurora("MyDatabase", { engine: "postgres", vpc });
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
    return new Aurora(
      name,
      getArgs({ existing: { cluster: id } }) as AuroraArgs,
      opts,
    );
  }
}
