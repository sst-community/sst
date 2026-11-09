import { interpolate, type Output, output } from "@pulumi/pulumi";
import { rds, secretsmanager } from "@pulumi/aws";
import {
  type ComponentArgs,
  type PartsBuilder,
  many,
  optional,
} from "../../parts-component";
import { mapArg, plain, withDefault, onlyExisting } from "../../args";
import type { Input } from "../../input";
import type { SizeGbTb } from "../../size";
import { context } from "../../contract";
import {
  createCredentials,
  createRdsProxy,
  createRdsProxyTarget,
  type LocalDatabaseArgs,
  localDatabase,
  maxStorage,
  type ProxyArgs,
  rdsCredentialParts,
  rdsProxyParts,
  replicaArgs,
} from "./rds";
import { secretField, tagOf } from "./secret";
import { subnetsAndSecurityGroupsOf } from "./vpc";
import type { Vpc } from "../vpc";

// What the `Postgres` and the `Mysql` share: a database on an RDS instance,
// with its secret, its parameter group, read replicas and a proxy. Each
// engine says how it differs (`RdsEngine`), and each component keeps its
// own class, docs, and the args that read differently for it.

/**
 * The parts of a database on an RDS instance.
 */
export const rdsInstanceParts = {
  /**
   * The Secrets Manager secret that stores the master user's username and password. Not
   * created by `get`. Next to an existing `instance`, the password is read from the one
   * given here, or from the one the instance is tagged with.
   */
  secret: optional(secretsmanager.Secret),
  ...rdsCredentialParts,
  /**
   * The RDS subnet group. Not created by `get`.
   */
  subnetGroup: optional(rds.SubnetGroup),
  /**
   * The RDS parameter group. Not created by `get`.
   */
  parameterGroup: optional(rds.ParameterGroup),
  /**
   * The RDS database instance.
   */
  instance: rds.Instance,
  /**
   * The read replicas of the database instance, by number, from `0`.
   */
  replica: many(rds.Instance),
  ...rdsProxyParts,
};

/**
 * The args of a database on an RDS instance that read the same for every
 * engine. Each component adds its `version`, `username` and `dev`.
 */
export interface RdsInstanceArgs
  extends ComponentArgs<typeof rdsInstanceParts> {
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
   * const myVpc = new sst.aws.Vpc("MyVpc");
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
    | Vpc
    | Input<{
        /**
         * A list of subnet IDs in the VPC.
         */
        subnets: Input<Input<string>[]>;
      }>;
}

/** The args each engine's component documents in its own words. */
interface EngineArgs {
  version?: Input<string>;
  username?: Input<string>;
  dev?: LocalDatabaseArgs;
}

/** What referencing an existing database takes. */
export interface RdsInstanceGetArgs {
  /**
   * The ID of the database.
   */
  id: Input<string>;
  /**
   * The ID of the proxy. Leave it out for a database without one. Given as an output, it
   * has to resolve to the proxy's ID: whether it's set decides whether a proxy is looked
   * up.
   */
  proxyId?: Input<string>;
}

/** How a database engine on an RDS instance differs from another. */
export interface RdsEngine {
  /** What RDS calls the engine. */
  engine: "postgres" | "mysql";
  /** What the messages call the database: "Postgres", "MySQL". */
  label: string;
  /** What the pane in `sst dev` calls the local server: "PostgreSQL server". */
  server: string;
  /** The defaults of `version` and `username`, and the local server's port. */
  defaults: { version: string; username: string; port: number };
  /** What RDS Proxy calls the engine. */
  proxyFamily: "POSTGRESQL" | "MYSQL";
  /** The parameter group's family for an engine version, and its parameters. */
  parameterGroup(
    version: Output<string>,
  ): Pick<rds.ParameterGroupArgs, "family" | "parameters">;
  /** Whether an instance type has Performance Insights. */
  performanceInsights(instance: Output<string>): Input<boolean>;
  /**
   * The tags the 4.x component writes on the instance, so either component
   * can reference a database the other created: its version, and the tag that
   * names the secret with the password.
   */
  tags: { version: string; password: string };
}

/** What the rest of the app reads from the database, deployed or local. */
export interface RdsConnection {
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
 * Build a database on an RDS instance for a component: the one the user has,
 * a server on their machine in `sst dev`, or a new one.
 */
export function createRdsInstance(
  builder: PartsBuilder<typeof rdsInstanceParts>,
  name: string,
  args: RdsInstanceArgs & EngineArgs,
  engine: RdsEngine,
): RdsConnection {
  const { part, existingPart } = builder;
  const self = builder.component;
  const owner = `the "${name}" ${engine.label} database`;

  const username = withDefault(args.username, engine.defaults.username);
  const dbName = withDefault(
    args.database,
    context().app.name.replaceAll("-", "_"),
  );

  // Given a database that's already deployed, it uses its secret and its
  // proxy, and creates nothing else
  if (args.existing?.instance !== undefined)
    onlyExisting(args.existing, ["instance", "secret", "proxy"], owner);

  // In `sst dev`, a server on the user's machine stands in for the
  // database, one that's already deployed too. This is the only place the
  // component handles dev mode.
  const dev = plain(args.dev, `The "dev" of ${owner}`);
  if (dev && context().dev) {
    builder.runsLocally();
    const local = localDatabase(
      dev,
      {
        password: args.password,
        username,
        database: dbName,
        port: engine.defaults.port,
      },
      owner,
      engine.server,
    );
    builder.report({ dev: local.pane });
    return {
      id: output("placeholder"),
      proxyId: output("placeholder"),
      ...local.connection,
    };
  }

  // A database that's already deployed
  const existing = existingPart("instance");
  if (existing)
    return connectTo(
      existing,
      args.password ? output(args.password) : passwordOf(existing),
      existingPart("proxy"),
    );

  const proxy = plain(args.proxy, `The "proxy" of ${owner}`);
  const replicas = plain(args.replicas, `The "replicas" of ${owner}`) ?? 0;
  const engineVersion = withDefault(args.version, engine.defaults.version);
  const instanceType = withDefault(args.instance, "t4g.micro");
  const blueGreen = withDefault(args.blueGreen, false);
  // A `Vpc`'s private subnets, or those given. The database takes no
  // security groups.
  const subnets = subnetsAndSecurityGroupsOf(
    args.vpc as Parameters<typeof subnetsAndSecurityGroupsOf>[0],
    owner,
  ).subnets;
  // An engine version the user didn't choose isn't moved once it's deployed
  const pinned = (field: string) => (args.version ? [] : [field]);

  const { password, secret } = createCredentials(
    builder,
    username,
    args.password,
  );

  const subnetGroup = part("subnetGroup", { subnetIds: subnets });

  const parameterGroup = part(
    "parameterGroup",
    engine.parameterGroup(output(engineVersion)),
    {
      ignoreChanges: pinned("family"),
      // Necessary for the parameter group to be deleted AFTER upgrading the instance.
      // This is either a Pulumi bug or an undocumented feature.
      deleteBeforeReplace: false,
    },
  );

  const instance = part(
    "instance",
    {
      dbName,
      dbSubnetGroupName: subnetGroup.name,
      engine: engine.engine,
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
      maxAllocatedStorage: maxStorage(args.storage, blueGreen, owner),
      multiAz: withDefault(args.multiAz, false),
      backupRetentionPeriod: 7,
      performanceInsightsEnabled: engine.performanceInsights(
        output(instanceType),
      ),
      blueGreenUpdate: mapArg(blueGreen, (bg) => ({ enabled: bg })),
      tags: {
        "sst:component-version": engine.tags.version,
        [engine.tags.password]: secret.id,
      },
    },
    { deleteBeforeReplace: true, ignoreChanges: pinned("engineVersion") },
  );

  for (let i = 0; i < replicas; i++) {
    part("replica", `${i}`, replicaArgs(instance, i), {
      ignoreChanges: pinned("engineVersion"),
    });
  }

  if (!proxy) return connectTo(instance, password);
  const rdsProxy = createRdsProxy(builder, proxy === true ? {} : proxy, {
    master: secret,
    engineFamily: engine.proxyFamily,
    subnets,
    owner,
  });
  createRdsProxyTarget(builder, rdsProxy, {
    dbInstanceIdentifier: instance.identifier,
  });
  return connectTo(instance, password, rdsProxy);

  function connectTo(
    instance: rds.Instance,
    password: Output<string>,
    proxy?: rds.Proxy,
  ): RdsConnection {
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

  // The master user's password: in the secret the user gave, or in the one
  // a database created by the component, or by its 4.x form, is tagged with
  function passwordOf(instance: rds.Instance) {
    const secret = existingPart("secret");
    return secretField(
      secret
        ? secret.id
        : tagOf(
            instance,
            engine.tags.password,
            `The "${name}" ${engine.label} database can't find its password: its instance has no "${engine.tags.password}" tag, which names the secret that holds it. Pass the secret in "existing.secret", or set "password".`,
          ),
      "password",
      self,
    );
  }
}
