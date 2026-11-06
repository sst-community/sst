import { getArgs } from "../args";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { component } from "../parts-component";
import type { Input } from "../input";
import { VisibleError } from "../error";
import {
  createRdsInstance,
  type RdsConnection,
  type RdsEngine,
  type RdsInstanceArgs,
  type RdsInstanceGetArgs,
  rdsInstanceParts,
} from "./helpers/rds-instance";

// What it's built from is what every database on an RDS instance is built
// from (`helpers/rds-instance.ts`)
const parts = rdsInstanceParts;

export interface PostgresArgs extends RdsInstanceArgs {
  /**
   * The Postgres engine version. Check out the [available versions in your region](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.DBVersions.html).
   *
   * Changing this default doesn't change the version of a database that's already deployed.
   *
   * :::caution
   * Changing the version will cause the database to restart on the next `sst deploy`,
   * causing downtime. Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   * :::
   *
   * @default `"17"`
   * @example
   * ```js
   * {
   *   version: "17.1"
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
   * @default `"postgres"`
   * @example
   * ```js
   * {
   *   username: "admin"
   * }
   * ```
   */
  username?: Input<string>;
  /**
   * Configure how this component works in `sst dev`.
   *
   * By default, your Postgres database is deployed in `sst dev`. But if you want to instead
   * connect to a locally running Postgres database, you can configure the `dev` prop.
   *
   * :::note
   * This will not create an RDS database in `sst dev`.
   * :::
   *
   * This will skip deploying an RDS database and link to the locally running Postgres database
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
     * The host of the local Postgres to connect to when running in dev.
     * @default `"localhost"`
     */
    host?: Input<string>;
    /**
     * The port of the local Postgres to connect to when running in dev.
     * @default `5432`
     */
    port?: Input<number>;
    /**
     * The database of the local Postgres to connect to when running in dev.
     * @default Inherit from the top-level [`database`](#database).
     */
    database?: Input<string>;
    /**
     * The username of the local Postgres to connect to when running in dev.
     * @default Inherit from the top-level [`username`](#username).
     */
    username?: Input<string>;
    /**
     * The password of the local Postgres to connect to when running in dev. `sst dev`
     * needs this or the top-level `password`.
     * @default Inherit from the top-level [`password`](#password).
     */
    password?: Input<string>;
  };
}

export interface PostgresGetArgs extends RdsInstanceGetArgs {}

// How Postgres differs from the other databases on an RDS instance
const engine: RdsEngine = {
  engine: "postgres",
  label: "Postgres",
  server: "PostgreSQL server",
  defaults: { version: "17", username: "postgres", port: 5432 },
  proxyFamily: "POSTGRESQL",
  parameterGroup: (version) => ({
    family: version.apply((v) => `postgres${v.split(".")[0]}`),
    parameters: [
      { name: "rds.force_ssl", value: "0" },
      {
        name: "rds.logical_replication",
        value: "1",
        applyMethod: "pending-reboot",
      },
    ],
  }),
  performanceInsights: () => true,
  tags: { version: "2", password: "sst:lookup:password" },
};

/**
 * The `Postgres` component lets you add a Postgres database to your app using
 * [Amazon RDS Postgres](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html).
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the database
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const database = new sst.aws.Postgres("MyDatabase", { vpc });
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
 * import { Pool } from "pg";
 *
 * const client = new Pool({
 *   user: Resource.MyDatabase.username,
 *   password: Resource.MyDatabase.password,
 *   database: Resource.MyDatabase.database,
 *   host: Resource.MyDatabase.host,
 *   port: Resource.MyDatabase.port,
 * });
 * await client.connect();
 * ```
 *
 * #### Running locally
 *
 * By default, your RDS Postgres database is deployed in `sst dev`. But let's say you are running
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
 *   postgres:18
 * ```
 *
 * You can connect to it in `sst dev` by configuring the `dev` prop.
 *
 * ```ts title="sst.config.ts" {3-8}
 * const postgres = new sst.aws.Postgres("MyPostgres", {
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
 * This will skip deploying an RDS database and link to the locally running Postgres database
 * instead.
 *
 * #### Switch from SST 4's `sst.aws.Postgres`
 *
 * Keep the name, and `sst migrate` moves it. The database
 * you've deployed is kept, and so is everything around it: its password, secrets,
 * parameter group and proxy. What waits for the role RDS needs before the proxy is
 * created is a resource of a new type, which the `sst` binary serves: `sst migrate`
 * takes SST 4's out of the state, and the new one finds the role.
 *
 * A few things work differently:
 *
 * - `proxy`, its list of `credentials`, and each credential's `username` are plain values,
 *   not outputs. They decide which resources are created.
 * - With `dev` set, SST 4's `Postgres` created a component for the pane `sst dev` shows, in
 *   every deploy. SST 5's tells `sst dev` itself, so a deploy drops that component. It
 *   has nothing in AWS behind it. An empty local password is shown as "[no password]" in
 *   the pane.
 * - `nodes` has every resource, not only the instance. The secret that stores the master
 *   user's credentials is `nodes.secret`. In `sst dev` with `dev` set, reading one of them
 *   fails and says why it's missing, where SST 4's `Postgres` gave `undefined`.
 * - `proxyId` fails as soon as it's read when there is no proxy, where SST 4's `Postgres`
 *   failed on deploy.
 * - If you set `tags` on the instance with an object in `transform`, it keeps the tags
 *   SST sets next to yours. They're added back when you switch.
 * - SST 4's `Postgres.v1` has no 5.0 form.
 *
 * ---
 *
 * ### Cost
 *
 * By default this component uses a _Single-AZ Deployment_, _On-Demand DB Instances_ of a
 * `db.t4g.micro` at $0.016 per hour. And 20GB of _General Purpose gp3 Storage_
 * at $0.115 per GB per month.
 *
 * That works out to $0.016 x 24 x 30 + $0.115 x 20 or **$14 per month**. Adjust this for the
 * `instance` type and the `storage` you are using.
 *
 * The above are rough estimates for _us-east-1_, check out the
 * [RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/#On-Demand_DB_Instances_costs) for more details.
 *
 * #### RDS Proxy
 *
 * If you enable the `proxy`, it uses _Provisioned instances_ with 2 vCPUs at $0.015 per hour.
 *
 * That works out to an **additional** $0.015 x 2 x 24 x 30 or **$22 per month**.
 *
 * This is a rough estimate for _us-east-1_, check out the
 * [RDS Proxy pricing](https://aws.amazon.com/rds/proxy/pricing/) for more details.
 */
export class Postgres extends component("sst:aws:Postgres", parts) {
  private connection: RdsConnection;

  constructor(
    name: string,
    args: PostgresArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.connection = createRdsInstance(this.builder(), name, args, engine);
  }

  /**
   * The identifier of the Postgres instance.
   */
  public get id() {
    return this.connection.id;
  }

  /**
   * The name of the Postgres proxy.
   */
  public get proxyId() {
    if (!this.connection.proxyId)
      throw new VisibleError(
        `The "${this.componentName}" Postgres database has no proxy, so it has no "proxyId". Enable one with "proxy: true", or give "get" the "proxyId" of the one it has.`,
      );
    return this.connection.proxyId;
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
   * Linking a database gives the linked resource its host, port, database,
   * username and password.
   */
  public link() {
    return {
      properties: {
        database: this.database,
        username: this.username,
        password: this.password,
        port: this.port,
        host: this.host,
      },
    };
  }

  /**
   * Reference an existing Postgres database with the given name. This is useful when you
   * create a Postgres database in one stage and want to share it in another. It avoids
   * having to create a new Postgres database in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share Postgres databases across stages.
   * :::
   *
   * @param name The name of the component.
   * @param args The arguments to get the Postgres database.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a database in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new database, you want to share the same database from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const database = $app.stage === "frank"
   *   ? sst.aws.Postgres.get("MyDatabase", {
   *       id: "app-dev-mydatabase",
   *       proxyId: "app-dev-mydatabase-proxy"
   *     })
   *   : new sst.aws.Postgres("MyDatabase", {
   *       vpc,
   *       proxy: true
   *     });
   * ```
   *
   * Here `app-dev-mydatabase` is the ID of the database, and `app-dev-mydatabase-proxy`
   * is the ID of the proxy created in the `dev` stage. You can find these by outputting
   * the database ID and proxy ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   id: database.id,
   *   proxyId: database.proxyId
   * };
   * ```
   */
  public static get(
    name: string,
    args: PostgresGetArgs,
    opts?: ComponentResourceOptions,
  ) {
    return new Postgres(
      name,
      getArgs({
        existing: {
          instance: args.id,
          ...(args.proxyId ? { proxy: args.proxyId } : {}),
        },
      }) as PostgresArgs,
      opts,
    );
  }
}
