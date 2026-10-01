import {
  ComponentResourceOptions,
  interpolate,
  jsonStringify,
  Output,
  output,
} from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { iam, rds, secretsmanager } from "@pulumi/aws";
import { V5Args, component, many, optional } from "../parts-component";
import { plain, withDefault } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { DevCommand } from "../experimental/dev-command";
import {
  maxStorage,
  proxyArgs,
  proxyCredentials,
  proxyRoleArgs,
  replicaArgs,
  storedPassword,
} from "./helpers/rds";
import { RdsRoleLookup } from "./providers/rds-role-lookup";
import { Vpc } from "./vpc";
import { Vpc as VpcV1 } from "./vpc-v1";
import type { PostgresArgs, PostgresGetArgs } from "./postgres";

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

export interface PostgresV5ProxyArgs {
  /**
   * Additional credentials the proxy can use to connect to the database. You don't
   * need to specify the master user credentials as they are always added by default.
   *
   * :::note
   * This component will not create the Postgres users listed here. You need to
   * create them manually in the database.
   * :::
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
   * You can use a `Secret` to manage the password.
   *
   * ```js
   * {
   *   credentials: [
   *     {
   *       username: "metabase",
   *       password: new sst.Secret("MyDBPassword").value
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

export interface PostgresV5Args
  extends V5Args<Omit<PostgresArgs, "proxy" | "replicas">, typeof parts> {
  /**
   * Enable [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) for the database.
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
  proxy?: boolean | PostgresV5ProxyArgs;
  /**
   * @internal
   */
  replicas?: number;
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
 * The `PostgresV5` component lets you add a Postgres database to your app using
 * [Amazon RDS Postgres](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html).
 *
 * It takes the same args as [`Postgres`](/docs/component/aws/postgres) and creates the same
 * resources. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the database
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const database = new sst.aws.PostgresV5("MyDatabase", { vpc });
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
 * const postgres = new sst.aws.PostgresV5("MyPostgres", {
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
 * #### Switch from `Postgres`
 *
 * Change `Postgres` to `PostgresV5` and keep the name. The database you've deployed is kept,
 * and so is everything around it: its password, secrets, parameter group and proxy.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const database = new sst.aws.Postgres("MyDatabase", { vpc });
 * const database = new sst.aws.PostgresV5("MyDatabase", { vpc });
 * ```
 *
 * A few things are written differently:
 *
 * - `proxy`, its list of `credentials`, and each credential's `username` are plain values,
 *   not outputs. They decide which resources are created.
 * - `nodes` has every resource, not only the instance. The secret that stores the master
 *   user's credentials is `nodes.secret`.
 * - `proxyId` fails as soon as it's read when there is no proxy, where `Postgres` failed
 *   on deploy.
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
export class PostgresV5 extends component("sst:aws:PostgresV5", parts) {
  private connection: Connection;

  constructor(
    name: string,
    args: PostgresV5Args,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const self = this;

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

    if (args.vpc instanceof VpcV1)
      throw new VisibleError(
        `You are using the "Vpc.v1" component. Please migrate to the latest "Vpc" component.`,
      );

    const username = withDefault(args.username, "postgres");
    const dbName = withDefault(args.database, $app.name.replaceAll("-", "_"));

    // In `sst dev`, a Postgres server on the user's machine stands in for the
    // database. This is the only place the component handles dev mode.
    const local = args.dev ? runLocally(args.dev) : undefined;
    if (local && $dev) {
      this.runsLocally();
      this.connection = local;
      return;
    }

    const proxy = plain(args.proxy, `The "proxy" of the "${name}" database`);
    const replicas =
      plain(args.replicas, `The "replicas" of the "${name}" database`) ?? 0;
    const engineVersion = withDefault(args.version, "17");
    const instanceType = withDefault(args.instance, "t4g.micro");
    const blueGreen = withDefault(args.blueGreen, false);
    const vpc =
      args.vpc instanceof Vpc
        ? output({ subnets: args.vpc.privateSubnets })
        : output(args.vpc);
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

    const subnetGroup = this.part("subnetGroup", { subnetIds: vpc.subnets });

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
          // The same value `Postgres` writes, so either component can
          // reference a database the other created.
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

    function createProxy(proxy: PostgresV5ProxyArgs) {
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
        proxyArgs("POSTGRESQL", logins, role, vpc.subnets),
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

    // A database created by `Postgres` or `PostgresV5` is tagged with the
    // secret that holds its password.
    function passwordOf(instance: rds.Instance) {
      return storedPassword(
        instance,
        "sst:lookup:password",
        `Failed to get password for Postgres ${name}.`,
        self,
      );
    }

    function runLocally(dev: NonNullable<PostgresV5Args["dev"]>): Connection {
      if ($dev && dev.password === undefined && args.password === undefined)
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

      new DevCommand(`${name}Dev`, {
        dev: {
          title: name,
          autostart: true,
          command: `sst print-and-not-quit`,
        },
        environment: {
          SST_DEV_COMMAND_MESSAGE: interpolate`Make sure your local PostgreSQL server is using:

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
   *   ? sst.aws.PostgresV5.get("MyDatabase", {
   *       id: "app-dev-mydatabase",
   *       proxyId: "app-dev-mydatabase-proxy"
   *     })
   *   : new sst.aws.PostgresV5("MyDatabase", {
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
    return new PostgresV5(
      name,
      {
        existing: {
          instance: args.id,
          ...(args.proxyId ? { proxy: args.proxyId } : {}),
        },
      } as PostgresV5Args,
      opts,
    );
  }
}
