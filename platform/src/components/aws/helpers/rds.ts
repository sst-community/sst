import {
  all,
  interpolate,
  jsonStringify,
  type Output,
  output,
} from "@pulumi/pulumi";
import { RandomPassword, type RandomPasswordArgs } from "@pulumi/random";
import { iam, rds, secretsmanager } from "@pulumi/aws";
import { many, optional } from "../../parts-component";
import { plain, withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { type SizeGbTb, toGBs } from "../../size";
import type { DevReport } from "../../contract";
import { RdsRoleLookup } from "../providers/rds-role-lookup";
import { devValue, localPassword, localServerPane } from "./local-server";

// What the databases on RDS share: the `Aurora`, and the `Postgres` and the
// `Mysql` on an RDS instance (`rds-instance.ts`).

/**
 * An RDS Proxy in front of the database.
 */
export interface ProxyArgs {
  /**
   * Additional credentials the proxy can use to connect to the database. You don't
   * need to specify the master user credentials as they are always added by default.
   *
   * :::note
   * This component will not create the database users listed here. You need to
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
   * You can use a [`Secret`](/docs/component/secret) to manage the password.
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

/** A user the proxy can connect to the database as, besides the master user. */
export type ProxyCredential = NonNullable<ProxyArgs["credentials"]>[number];

/**
 * The parts that hold the master user's password, next to the secret it's
 * stored in, which each database declares itself.
 */
export const rdsCredentialParts = {
  /**
   * The random password of the master user. It's created when you don't set a `password`.
   */
  password: optional(RandomPassword),
  /**
   * The version of the secret holding the current username and password. Not created by
   * `get`.
   */
  secretVersion: optional(secretsmanager.SecretVersion),
};

/**
 * The parts of an RDS Proxy in front of a database.
 */
export const rdsProxyParts = {
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
   * The RDS Proxy. One that's looked up for `get` may only be added once the database's
   * tags are read.
   */
  proxy: optional(rds.Proxy),
  /**
   * The proxy's default target group.
   */
  proxyTargetGroup: optional(rds.ProxyDefaultTargetGroup),
  /**
   * The proxy's target: the database.
   */
  proxyTarget: optional(rds.ProxyTarget),
};

/**
 * What creating the master user's credentials needs from a database: its
 * own `part()`, as `this.builder()` gives it.
 */
export interface RdsCredentialsBuilder {
  part(key: "password", args: RandomPasswordArgs): RandomPassword;
  part(key: "secret", args: secretsmanager.SecretArgs): secretsmanager.Secret;
  part(
    key: "secretVersion",
    args: secretsmanager.SecretVersionArgs,
  ): secretsmanager.SecretVersion;
}

/**
 * What creating a proxy needs from a database: its own `part()`, as
 * `this.builder()` gives it.
 */
export interface RdsProxyBuilder {
  part(
    key: "proxySecret",
    id: string,
    args: secretsmanager.SecretArgs,
  ): secretsmanager.Secret;
  part(
    key: "proxySecretVersion",
    id: string,
    args: secretsmanager.SecretVersionArgs,
  ): secretsmanager.SecretVersion;
  part(key: "proxyRole", args: iam.RoleArgs): iam.Role;
  part(key: "proxyRoleLookup", args: { name: Input<string> }): RdsRoleLookup;
  part(
    key: "proxy",
    args: rds.ProxyArgs,
    opts?: { dependsOn: RdsRoleLookup[] },
  ): rds.Proxy;
  part(
    key: "proxyTargetGroup",
    args: rds.ProxyDefaultTargetGroupArgs,
  ): rds.ProxyDefaultTargetGroup;
  part(key: "proxyTarget", args: rds.ProxyTargetArgs): rds.ProxyTarget;
}

/**
 * Create the master user's password, unless one is given, and the secret
 * that stores it with the username.
 */
export function createCredentials(
  builder: RdsCredentialsBuilder,
  username: Input<string>,
  password: Input<string> | undefined,
) {
  const value = password
    ? output(password)
    : builder.part("password", { length: 32, special: false }).result;
  const secret = builder.part("secret", { recoveryWindowInDays: 0 });
  builder.part("secretVersion", {
    secretId: secret.id,
    secretString: jsonStringify({ username, password: value }),
  });
  return { password: value, secret };
}

/**
 * Create a proxy in front of a database, with a secret for each additional
 * user it can connect as. Its target is created with `createRdsProxyTarget()`,
 * once the database is.
 *
 * @param master The secret that stores the master user's credentials.
 * @param owner The database, for the error messages: `the "MyDatabase"
 * Postgres database`.
 */
export function createRdsProxy(
  builder: RdsProxyBuilder,
  proxy: ProxyArgs,
  {
    master,
    engineFamily,
    subnets,
    owner,
  }: {
    master: secretsmanager.Secret;
    engineFamily: Input<"POSTGRESQL" | "MYSQL">;
    subnets: Input<Input<string>[]>;
    owner: string;
  },
): rds.Proxy {
  // A secret for each additional user the proxy can connect as
  const secrets = proxyCredentials(proxy.credentials, owner).map(
    ({ username, password }) => {
      const secret = builder.part("proxySecret", username, {
        recoveryWindowInDays: 0,
      });
      builder.part("proxySecretVersion", username, {
        secretId: secret.id,
        secretString: jsonStringify({ username, password }),
      });
      return secret;
    },
  );
  // The proxy can connect as the master user and as each of those
  const logins = [master, ...secrets];

  const role = builder.part("proxyRole", proxyRoleArgs(logins));
  const lookup = builder.part("proxyRoleLookup", {
    name: "AWSServiceRoleForRDS",
  });
  return builder.part("proxy", proxyArgs(engineFamily, logins, role, subnets), {
    dependsOn: [lookup],
  });
}

/**
 * Point a proxy at its database: an instance, or an Aurora cluster.
 */
export function createRdsProxyTarget(
  builder: RdsProxyBuilder,
  proxy: rds.Proxy,
  target:
    | { dbInstanceIdentifier: Input<string> }
    | { dbClusterIdentifier: Input<string> },
) {
  const targetGroup = builder.part("proxyTargetGroup", {
    dbProxyName: proxy.name,
  });
  builder.part("proxyTarget", {
    dbProxyName: proxy.name,
    targetGroupName: targetGroup.name,
    ...target,
  });
}

/**
 * How far a database's storage can grow, in GB, from its `storage` arg.
 *
 * @param owner The database, for the error messages: `the "MyDatabase"
 * Postgres database`.
 */
export function maxStorage(
  storage: Input<SizeGbTb | undefined> | undefined,
  blueGreen: Input<boolean>,
  owner: string,
) {
  const limit = withDefault<SizeGbTb, number>(storage, "20 GB", (v) => {
    const size = toGBs(v);
    if (size < 20)
      throw new VisibleError(
        `The "storage" of ${owner} is ${v}. It has to be at least 20 GB.`,
      );
    if (size > 65536)
      throw new VisibleError(
        `The "storage" of ${owner} is ${v}. It can't be more than 65536 GB (64 TB).`,
      );
    return size;
  });
  // Blue/green deployments require maxAllocatedStorage to be at least
  // 10% higher than allocatedStorage for autoscaling headroom.
  return all([limit, blueGreen]).apply(([limit, blueGreen]) =>
    blueGreen ? Math.max(limit, 22) : limit,
  );
}

/** The args of a read replica of a database instance. */
export function replicaArgs(
  instance: rds.Instance,
  replica: number,
): rds.InstanceArgs {
  return {
    replicateSourceDb: instance.identifier,
    dbName: instance.dbName.apply((dbName) => `${dbName}_replica${replica}`),
    dbSubnetGroupName: instance.dbSubnetGroupName,
    availabilityZone: instance.availabilityZone,
    engine: instance.engine,
    engineVersion: instance.engineVersion,
    instanceClass: instance.instanceClass,
    username: instance.username,
    password: instance.password.apply((v) => v!),
    parameterGroupName: instance.parameterGroupName,
    applyImmediately: true,
    skipFinalSnapshot: true,
    storageEncrypted: instance.storageEncrypted.apply((v) => v!),
    storageType: instance.storageType,
    allocatedStorage: instance.allocatedStorage,
    maxAllocatedStorage: instance.maxAllocatedStorage.apply((v) => v!),
  };
}

// The additional users a proxy can connect as, from its `credentials`. The
// list and each username decide which secrets are created, so they have to
// be plain values.
function proxyCredentials(
  credentials: ProxyCredential[] | undefined,
  owner: string,
): ProxyCredential[] {
  const list = plain(credentials, `The "proxy.credentials" of ${owner}`) ?? [];
  return list.map((credential) => ({
    username: plain(
      credential.username,
      `The "username" in the "proxy.credentials" of ${owner}`,
    ),
    password: credential.password,
  }));
}

// The args of the role that lets a proxy read the secrets it connects with
function proxyRoleArgs(secrets: secretsmanager.Secret[]): iam.RoleArgs {
  return {
    assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
      Service: "rds.amazonaws.com",
    }),
    inlinePolicies: [
      {
        name: "inline",
        policy: iam.getPolicyDocumentOutput({
          statements: [
            {
              actions: ["secretsmanager:GetSecretValue"],
              resources: secrets.map((secret) => secret.arn),
            },
          ],
        }).json,
      },
    ],
  };
}

// The args of a proxy that connects with the credentials in the given secrets
function proxyArgs(
  engineFamily: Input<"POSTGRESQL" | "MYSQL">,
  secrets: secretsmanager.Secret[],
  role: iam.Role,
  subnets: Input<Input<string>[]>,
): rds.ProxyArgs {
  return {
    engineFamily,
    auths: secrets.map((secret) => ({
      authScheme: "SECRETS",
      iamAuth: "DISABLED",
      secretArn: secret.arn,
    })),
    roleArn: role.arn,
    vpcSubnetIds: subnets,
  };
}

/** A database on the user's machine, which `sst dev` connects to. */
export interface LocalDatabaseArgs {
  host?: Input<string>;
  port?: Input<number>;
  database?: Input<string>;
  username?: Input<string>;
  password?: Input<string>;
}

/**
 * What `sst dev` connects to in place of a database SST deploys, and the pane
 * that says how the server on the user's machine has to be set up. What
 * `dev` doesn't say comes from the component's own args.
 *
 * @param dev The component's `dev`.
 * @param defaults The component's password, username and database, and the
 * engine's port.
 * @param owner The database, for the error messages: `the "MyDatabase"
 * Postgres database`.
 * @param server What the pane calls the server, as in "your local MySQL
 * server".
 */
export function localDatabase(
  dev: LocalDatabaseArgs,
  defaults: {
    password?: Input<string>;
    username: Input<string>;
    database: Input<string>;
    port: Input<number>;
  },
  owner: string,
  server: string,
): {
  connection: {
    host: Output<string>;
    port: Output<number>;
    username: Output<string>;
    password: Output<string>;
    database: Output<string>;
  };
  pane: DevReport;
} {
  const connection = {
    host: devValue(dev.host, "localhost"),
    port: devValue(dev.port, defaults.port),
    // An empty one is as good as none, as in 4.x
    username: devValue(dev.username, defaults.username, true),
    password: localPassword(dev.password, defaults.password, owner),
    database: devValue(dev.database, defaults.database, true),
  };
  const { username, password, database, host, port } = connection;
  return {
    connection,
    pane: localServerPane(
      server,
      { username, password, database },
      interpolate`${host}:${port}`,
    ),
  };
}
