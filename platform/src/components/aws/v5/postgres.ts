import {
  ComponentResourceOptions,
  interpolate,
  jsonStringify,
  Output,
  output,
} from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { iam, rds, secretsmanager } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  many,
  optional,
} from "../../parts-component";
import { plain, withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import type { SizeGbTb } from "../../size";
import {
  credentialsSecretOf,
  maxStorage,
  proxyArgs,
  type ProxyArgs,
  proxyCredentials,
  proxyRoleArgs,
  replicaArgs,
  storedPassword,
} from "../helpers/rds";
import { RdsRoleLookup } from "../providers/rds-role-lookup";
import { type AnyVpc, assertVpcIds, isVpc, subnetsOf } from "../helpers/vpc";
import { localServerPane, shownPassword } from "../helpers/local-server";

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
   * The RDS parameter group.
   */
  parameterGroup: rds.ParameterGroup,
  /**
   * The RDS database instance.
   */
  instance: rds.Instance,
  /**
   * The read replicas of the database instance, by number, from `0`.
   */
  replica: many(rds.Instance),
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
   * The RDS Proxy.
   */
  proxy: optional(rds.Proxy),
  /**
   * The proxy's default target group.
   */
  proxyTargetGroup: optional(rds.ProxyDefaultTargetGroup),
  /**
   * The proxy's target: the database instance.
   */
  proxyTarget: optional(rds.ProxyTarget),
};

export interface PostgresArgs extends ComponentArgs<typeof parts> {
  /**
   * The Postgres engine version. Check out the [available versions in your region](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.DBVersions.html).
   *
   * Without a `version`, a database that's deployed keeps the version it has, so a newer
   * default doesn't upgrade it.
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
   */
  password?: Input<string>;
  /**
   * Name of a database that is automatically created.
   *
   * The name must begin with a letter and contain only lowercase letters, numbers, or
   * underscores. By default, it takes the name of the app, and replaces the hyphens with
   * underscores.
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
   * The type of instance to use for the database. Check out the [supported instance types](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Types.html).
   *
   * :::caution
   * Changing the instance type will cause the database to restart on the next `sst deploy`,
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
   * The maximum storage limit for the database.
   *
   * RDS will autoscale your storage to match your usage up to the given limit.
   *
   * :::note
   * You are only billed for the storage you use, not the maximum limit.
   * :::
   *
   * By default, [gp3 storage volumes](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html#Concepts.Storage.GeneralSSD)
   * are used without additional provisioned IOPS. This provides good baseline
   * performance for most use cases.
   *
   * The minimum storage size is 20 GB. And the maximum storage size is 64 TB.
   *
   * @default `"20 GB"`
   * @example
   * ```js
   * {
   *   storage: "100 GB"
   * }
   * ```
   */
  storage?: Input<SizeGbTb>;
  /**
   * Enable [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) for the database.
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
   * Enable [Multi-AZ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html)
   * deployment for the database.
   *
   * This creates a standby replica for the database in another availability zone (AZ). The
   * standby database provides automatic failover in case the primary database fails. However,
   * when the primary database is healthy, the standby database is not used for serving read
   * traffic.
   *
   * :::caution
   * Using Multi-AZ will approximately double the cost of the database since it will be
   * deployed in two AZs.
   * :::
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   multiAz: true
   * }
   * ```
   */
  multiAz?: Input<boolean>;
  /**
   * Enable [Blue/Green deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/blue-green-deployments.html)
   * for version, instance type, and parameter group upgrades.
   * Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   *
   * When enabled, a staging (green) instance is created, updated,
   * verified, then promoted to replace the production (blue) instance.
   * This minimizes downtime during upgrades.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   blueGreen: true
   * }
   * ```
   */
  blueGreen?: Input<boolean>;
  /**
   * @internal
   */
  replicas?: number;
  /**
   * The VPC subnets to use for the database.
   *
   * @example
   * Create a `Vpc` component.
   *
   * ```ts title="sst.config.ts"
   * const myVpc = new sst.aws.v5.Vpc("MyVpc");
   * ```
   *
   * And pass it in. The database will be placed in the private subnets.
   *
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   *
   * Or pass in the subnets of your own VPC.
   *
   * ```js
   * {
   *   vpc: {
   *     subnets: ["subnet-0db7376a7ad4db5fd", "subnet-06fc7ee8319b2c0ce"]
   *   }
   * }
   * ```
   */
  vpc:
    | AnyVpc
    | Input<{
        /**
         * A list of subnet IDs in the VPC.
         */
        subnets: Input<Input<string>[]>;
      }>;
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

export interface PostgresGetArgs {
  /**
   * The ID of the database.
   */
  id: Input<string>;
  /**
   * The ID of the proxy.
   */
  proxyId?: Input<string>;
}

/** What the rest of the app reads from the database, deployed or local. */
interface Connection {
  id: Output<string>;
  /** Not set when the database has no proxy. */
  proxyId?: Output<string>;
  host: Output<string>;
  port: Output<number>;
  username: Output<string>;
  password: Output<string>;
  database: Output<string>;
}

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
 * const vpc = new sst.aws.v5.Vpc("MyVpc");
 * const database = new sst.aws.v5.Postgres("MyDatabase", { vpc });
 * ```
 *
 * #### Link to a resource
 *
 * You can link your database to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
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
 * const postgres = new sst.aws.v5.Postgres("MyPostgres", {
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
 * instead. [Check out the full example](/docs/examples/#aws-postgres-local).
 *
 * #### Switch from `sst.aws.Postgres`
 *
 * Change `sst.aws.Postgres` to `sst.aws.v5.Postgres` and keep the name. The database
 * you've deployed is kept, and so is everything around it: its password, secrets,
 * parameter group and proxy.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const database = new sst.aws.Postgres("MyDatabase", { vpc });
 * const database = new sst.aws.v5.Postgres("MyDatabase", { vpc });
 * ```
 *
 * A few things work differently:
 *
 * - `proxy`, its list of `credentials`, each credential's `username`, and `dev` are plain
 *   values, not outputs. They decide which resources are created.
 * - With `dev` set, `sst.aws.Postgres` created a component for the pane `sst dev` shows, in
 *   every deploy. The V5 one tells `sst dev` itself, so a deploy drops that component. It
 *   has nothing in AWS behind it.
 * - `nodes` has every resource, not only the instance. The secret that stores the master
 *   user's credentials is `nodes.secret`. In `sst dev` with `dev` set, reading one of them
 *   fails and says why it's missing, where `sst.aws.Postgres` gave `undefined`.
 * - `proxyId` fails as soon as it's read when there is no proxy, where `sst.aws.Postgres`
 *   failed on deploy.
 * - If you set `tags` on the instance with an object in `transform`, it keeps the tags
 *   SST sets next to yours. They're added back when you switch.
 * - `sst.aws.Postgres.v1` has no V5 form.
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
  private connection: Connection;

  constructor(
    name: string,
    args: PostgresArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const self = this;

    const username = withDefault(args.username, "postgres");
    const dbName = withDefault(args.database, $app.name.replaceAll("-", "_"));

    // In `sst dev`, a Postgres server on the user's machine stands in for the
    // database, one that's already deployed too. This is the only place the
    // component handles dev mode.
    const dev = plain(args.dev, `The "dev" of the "${name}" database`);
    if (dev && $dev) {
      this.runsLocally();
      this.connection = runLocally(dev);
      return;
    }

    // A database that's already deployed
    const existing = this.existingPart("instance");
    if (existing) {
      this.connection = connectTo(
        existing,
        args.password ? output(args.password) : passwordOf(existing),
        this.existingPart("proxy"),
      );
      return;
    }

    const proxy = plain(args.proxy, `The "proxy" of the "${name}" database`);
    const replicas =
      plain(args.replicas, `The "replicas" of the "${name}" database`) ?? 0;
    const engineVersion = withDefault(args.version, "17");
    const instanceType = withDefault(args.instance, "t4g.micro");
    const blueGreen = withDefault(args.blueGreen, false);
    const subnets = subnetsFor(name, args.vpc);
    // An engine version the user didn't choose isn't moved once it's deployed
    const pinned = (field: string) => (args.version ? [] : [field]);

    const password = args.password
      ? output(args.password)
      : this.part("password", { length: 32, special: false }).result;

    const secret = this.part("secret", { recoveryWindowInDays: 0 });
    this.part("secretVersion", {
      secretId: secret.id,
      secretString: jsonStringify({ username, password }),
    });

    const subnetGroup = this.part("subnetGroup", { subnetIds: subnets });

    const parameterGroup = this.part(
      "parameterGroup",
      {
        family: engineVersion.apply((v) => `postgres${v.split(".")[0]}`),
        parameters: [
          { name: "rds.force_ssl", value: "0" },
          {
            name: "rds.logical_replication",
            value: "1",
            applyMethod: "pending-reboot",
          },
        ],
      },
      {
        ignoreChanges: pinned("family"),
        // Necessary for the parameter group to be deleted AFTER upgrading the instance.
        // This is either a Pulumi bug or an undocumented feature.
        deleteBeforeReplace: false,
      },
    );

    const instance = this.part(
      "instance",
      {
        dbName,
        dbSubnetGroupName: subnetGroup.name,
        engine: "postgres",
        engineVersion,
        instanceClass: interpolate`db.${instanceType}`,
        username,
        password,
        parameterGroupName: parameterGroup.name,
        applyImmediately: true,
        allowMajorVersionUpgrade: true,
        autoMinorVersionUpgrade: false,
        skipFinalSnapshot: true,
        storageEncrypted: true,
        storageType: "gp3",
        allocatedStorage: 20,
        maxAllocatedStorage: maxStorage(
          args.storage,
          blueGreen,
          `${name} Postgres`,
        ),
        multiAz: withDefault(args.multiAz, false),
        backupRetentionPeriod: 7,
        performanceInsightsEnabled: true,
        blueGreenUpdate: blueGreen.apply((bg) => ({ enabled: bg })),
        tags: {
          // The same value `sst.aws.Postgres` writes, so either component can
          // reference a database the other created
          "sst:component-version": "2",
          "sst:lookup:password": secret.id,
        },
      },
      { deleteBeforeReplace: true, ignoreChanges: pinned("engineVersion") },
    );

    for (let i = 0; i < replicas; i++) {
      this.part("replica", `${i}`, replicaArgs(instance, i), {
        ignoreChanges: pinned("engineVersion"),
      });
    }

    this.connection = connectTo(
      instance,
      password,
      proxy ? createProxy(proxy === true ? {} : proxy) : undefined,
    );

    function createProxy(proxy: ProxyArgs) {
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
      const rdsProxy = self.part(
        "proxy",
        proxyArgs("POSTGRESQL", logins, role, subnets),
        { dependsOn: [lookup] },
      );
      const targetGroup = self.part("proxyTargetGroup", {
        dbProxyName: rdsProxy.name,
      });
      self.part("proxyTarget", {
        dbProxyName: rdsProxy.name,
        targetGroupName: targetGroup.name,
        dbInstanceIdentifier: instance.identifier,
      });

      return rdsProxy;
    }

    function connectTo(
      instance: rds.Instance,
      password: Output<string>,
      proxy?: rds.Proxy,
    ): Connection {
      return {
        id: instance.identifier,
        proxyId: proxy?.id,
        // Connections go through the proxy when there is one
        host: proxy
          ? proxy.endpoint
          : instance.endpoint.apply((endpoint) => endpoint.split(":")[0]),
        port: instance.port,
        username: instance.username,
        password,
        database: instance.dbName,
      };
    }

    // A database created by this component, or by `sst.aws.Postgres`, is
    // tagged with the secret that holds its password
    function passwordOf(instance: rds.Instance) {
      return storedPassword(
        credentialsSecretOf(
          instance,
          "sst:lookup:password",
          `Failed to get password for Postgres ${name}.`,
        ),
        self,
      );
    }

    // What `sst dev` connects to, and the pane that says how the local
    // database has to be set up
    function runLocally(dev: NonNullable<PostgresArgs["dev"]>): Connection {
      if (dev.password === undefined && args.password === undefined)
        throw new VisibleError(
          `You must provide the password to connect to your locally running Postgres database either by setting the "dev.password" or by setting the top-level "password" property.`,
        );

      const local = {
        id: output("placeholder"),
        proxyId: output("placeholder"),
        host: output(dev.host ?? "localhost"),
        port: output(dev.port ?? 5432),
        username: dev.username ? output(dev.username) : username,
        password: output(dev.password ?? args.password ?? ""),
        database: dev.database ? output(dev.database) : dbName,
      };

      self.report({
        dev: localServerPane(
          interpolate`Make sure your local PostgreSQL server is using:

  username: "${local.username}"
  password: "${shownPassword(local.password)}"
  database: "${local.database}"

Listening on "${local.host}:${local.port}"...`,
        ),
      });

      return local;
    }
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
        `Proxy is not enabled. Enable it with "proxy: true".`,
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
   *   ? sst.aws.v5.Postgres.get("MyDatabase", {
   *       id: "app-dev-mydatabase",
   *       proxyId: "app-dev-mydatabase-proxy"
   *     })
   *   : new sst.aws.v5.Postgres("MyDatabase", {
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
      {
        existing: {
          instance: args.id,
          ...(args.proxyId ? { proxy: args.proxyId } : {}),
        },
      } as PostgresArgs,
      opts,
    );
  }
}

/** The subnets the database is in: a `Vpc`'s private ones, or those given. */
function subnetsFor(name: string, vpc: PostgresArgs["vpc"]) {
  if (isVpc(vpc)) return subnetsOf(vpc, "private");
  assertVpcIds(vpc, `the "${name}" Postgres component`);
  return output(vpc).subnets;
}
