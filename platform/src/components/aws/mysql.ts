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

export interface MysqlArgs extends RdsInstanceArgs {
  /**
   * The MySQL engine version. Check out the [available versions in your region](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MySQL.Concepts.VersionMgmt.html).
   *
   * :::caution
   * Changing the version will cause the database to restart on the next `sst deploy`,
   * causing downtime. Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   * :::
   *
   * Without it, RDS creates the database with its current minor version of MySQL 8.0.
   * Changing this default doesn't change the version of a database that's already deployed.
   *
   * @default `"8.0"`
   * @example
   * ```js
   * {
   *   version: "8.4.4"
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
   * @default `"root"`
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
   * By default, your MySQL database is deployed in `sst dev`. But if you want to instead
   * connect to a locally running MySQL database, you can configure the `dev` prop.
   *
   * :::note
   * This will not create an RDS database in `sst dev`.
   * :::
   *
   * This will skip deploying an RDS database and link to the locally running MySQL database
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
   *     username: "root",
   *     password: "password",
   *     database: "local",
   *     host: "localhost",
   *     port: 3306
   *   }
   * }
   * ```
   */
  dev?: {
    /**
     * The host of the local MySQL to connect to when running in dev.
     * @default `"localhost"`
     */
    host?: Input<string>;
    /**
     * The port of the local MySQL to connect to when running in dev.
     * @default `3306`
     */
    port?: Input<number>;
    /**
     * The database of the local MySQL to connect to when running in dev.
     * @default Inherit from the top-level [`database`](#database).
     */
    database?: Input<string>;
    /**
     * The username of the local MySQL to connect to when running in dev.
     * @default Inherit from the top-level [`username`](#username).
     */
    username?: Input<string>;
    /**
     * The password of the local MySQL to connect to when running in dev. `sst dev`
     * needs this or the top-level `password`.
     * @default Inherit from the top-level [`password`](#password).
     */
    password?: Input<string>;
  };
}

export interface MysqlGetArgs extends RdsInstanceGetArgs {}

// How MySQL differs from the other databases on an RDS instance
const engine: RdsEngine = {
  engine: "mysql",
  label: "MySQL",
  server: "MySQL server",
  defaults: { version: "8.0", username: "root", port: 3306 },
  proxyFamily: "MYSQL",
  parameterGroup: (version) => ({
    family: version.apply((v) => {
      const [major, minor] = v.split(".");
      return `mysql${major}.${minor}`;
    }),
    parameters: [{ name: "require_secure_transport", value: "OFF" }],
  }),
  // Performance Insights isn't supported on .micro and .small MySQL
  // instances
  // https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.Overview.Engines.html
  performanceInsights: (instance) =>
    instance.apply((v) => !v.endsWith(".micro") && !v.endsWith(".small")),
  tags: { version: "1", password: "sst:ref:password" },
};

/**
 * The `Mysql` component lets you add a MySQL database to your app using
 * [Amazon RDS MySQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_MySQL.html).
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
 * const database = new sst.aws.Mysql("MyDatabase", { vpc });
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
 * import mysql from "mysql2/promise";
 *
 * const connection = await mysql.createConnection({
 *   user: Resource.MyDatabase.username,
 *   password: Resource.MyDatabase.password,
 *   database: Resource.MyDatabase.database,
 *   host: Resource.MyDatabase.host,
 *   port: Resource.MyDatabase.port,
 * });
 * await connection.execute("SELECT NOW()");
 * ```
 *
 * #### Running locally
 *
 * By default, your RDS MySQL database is deployed in `sst dev`. But let's say you are
 * running MySQL locally.
 *
 * ```bash
 * docker run \
 *   --rm \
 *   -p 3306:3306 \
 *   -v $(pwd)/.sst/storage/mysql:/var/lib/mysql \
 *   -e MYSQL_DATABASE=local \
 *   -e MYSQL_ROOT_PASSWORD=password \
 *   mysql:8.0
 * ```
 *
 * You can connect to it in `sst dev` by configuring the `dev` prop.
 *
 * ```ts title="sst.config.ts" {3-8}
 * const mysql = new sst.aws.Mysql("MyMysql", {
 *   vpc,
 *   dev: {
 *     username: "root",
 *     password: "password",
 *     database: "local",
 *     port: 3306
 *   }
 * });
 * ```
 *
 * This will skip deploying an RDS database and link to the locally running MySQL database
 * instead. [Check out the full example](/docs/examples/#aws-mysql-local).
 *
 * #### Switch from SST 4's `sst.aws.Mysql`
 *
 * Keep the name, and `sst migrate` moves it. The database you've
 * deployed is kept, and so is everything around it: its password, secrets, parameter group
 * and proxy. What waits for the role RDS needs before the proxy is created is a resource
 * of a new type, which the `sst` binary serves: `sst migrate` takes SST 4's out of the
 * state, and the new one finds the role.
 *
 * A few things work differently:
 *
 * - `proxy`, its list of `credentials`, and each credential's `username` are plain values,
 *   not outputs. They decide which resources are created.
 * - With `dev` set, SST 4's `Mysql` created a component for the pane `sst dev` shows, in
 *   every deploy. SST 5's tells `sst dev` itself, so a deploy drops that component. It
 *   has nothing in AWS behind it. An empty local password is shown as "[no password]" in
 *   the pane.
 * - `nodes` has every resource, not only the instance. The secret that stores the master
 *   user's credentials is `nodes.secret`. In `sst dev` with `dev` set, reading one of them
 *   fails and says why it's missing, where SST 4's `Mysql` gave `undefined`.
 * - `proxyId` fails as soon as it's read when there is no proxy, where SST 4's `Mysql` failed
 *   on deploy.
 * - If you set `tags` on the instance with an object in `transform`, it keeps the tags
 *   SST sets next to yours. They're added back when you switch.
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
 * [RDS for MySQL pricing](https://aws.amazon.com/rds/mysql/pricing/#On-Demand_DB_Instances_costs) for more details.
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
export class Mysql extends component("sst:aws:Mysql", parts) {
  private connection: RdsConnection;

  constructor(name: string, args: MysqlArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);
    this.connection = createRdsInstance(this.builder(), name, args, engine);
  }

  /**
   * The identifier of the MySQL instance.
   */
  public get id() {
    return this.connection.id;
  }

  /**
   * The name of the MySQL proxy.
   */
  public get proxyId() {
    if (!this.connection.proxyId)
      throw new VisibleError(
        `The "${this.componentName}" MySQL database has no proxy, so it has no "proxyId". Enable one with "proxy: true", or give "get" the "proxyId" of the one it has.`,
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
   * Reference an existing MySQL database with the given name. This is useful when you
   * create a MySQL database in one stage and want to share it in another. It avoids
   * having to create a new MySQL database in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share MySQL databases across stages.
   * :::
   *
   * @param name The name of the component.
   * @param args The arguments to get the MySQL database.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a database in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new database, you want to share the same database from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const database = $app.stage === "frank"
   *   ? sst.aws.Mysql.get("MyDatabase", {
   *       id: "app-dev-mydatabase",
   *       proxyId: "app-dev-mydatabase-proxy"
   *     })
   *   : new sst.aws.Mysql("MyDatabase", {
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
    args: MysqlGetArgs,
    opts?: ComponentResourceOptions,
  ) {
    return new Mysql(
      name,
      getArgs({
        existing: {
          instance: args.id,
          ...(args.proxyId ? { proxy: args.proxyId } : {}),
        },
      }) as MysqlArgs,
      opts,
    );
  }
}
