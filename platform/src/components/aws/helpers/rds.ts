import {
  all,
  interpolate,
  type Output,
  output,
  type Resource,
} from "@pulumi/pulumi";
import { iam, rds, secretsmanager } from "@pulumi/aws";
import { plain, withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { type SizeGbTb, toGBs } from "../../size";
import type { DevReport } from "../../contract";
import { localServerPane, shownPassword } from "./local-server";

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
 * How far a database's storage can grow, in GB, from its `storage` arg.
 *
 * @param database The database, for the error messages: "MyDatabase Postgres".
 */
export function maxStorage(
  storage: Input<SizeGbTb | undefined> | undefined,
  blueGreen: Input<boolean>,
  database: string,
) {
  const limit = withDefault<SizeGbTb, number>(storage, "20 GB", (v) => {
    const size = toGBs(v);
    if (size < 20)
      throw new VisibleError(
        `Storage must be at least 20 GB for the ${database} database.`,
      );
    if (size > 65536)
      throw new VisibleError(
        `Storage cannot be greater than 65536 GB (64 TB) for the ${database} database.`,
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

/**
 * The additional users a proxy can connect as, from its `credentials`. The
 * list and each username decide which secrets are created, so they have to
 * be plain values.
 *
 * @param name The database's name, for the error messages.
 */
export function proxyCredentials(
  credentials: ProxyCredential[] | undefined,
  name: string,
): ProxyCredential[] {
  const list =
    plain(credentials, `The "proxy.credentials" of the "${name}" database`) ??
    [];
  return list.map((credential) => ({
    username: plain(
      credential.username,
      `The "username" in the "proxy.credentials" of the "${name}" database`,
    ),
    password: credential.password,
  }));
}

/** The args of the role that lets a proxy read the secrets it connects with. */
export function proxyRoleArgs(secrets: secretsmanager.Secret[]): iam.RoleArgs {
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

/**
 * The args of a proxy that connects with the credentials in the given
 * secrets.
 */
export function proxyArgs(
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

/**
 * The id of the secret that holds the master user's credentials of a
 * database SST created. One of the database's tags names it.
 *
 * @param tag The tag that holds the secret's id.
 * @param notFound The error for a database that doesn't have the tag.
 */
export function credentialsSecretOf(
  database: { tagsAll: Output<Record<string, string>> },
  tag: string,
  notFound: string,
) {
  return database.tagsAll.apply((tags) => {
    if (!tags?.[tag]) throw new VisibleError(notFound);
    return tags[tag];
  });
}

/**
 * The master user's password, read from the secret that holds the database's
 * credentials.
 *
 * @param parent The component that's reading it.
 */
export function storedPassword(secretId: Input<string>, parent: Resource) {
  return secretsmanager
    .getSecretVersionOutput({ secretId }, { parent })
    .secretString.apply((v) => JSON.parse(v).password as string);
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
 * @param what What the messages call the database, as in "your locally
 * running MySQL database", and the server, as in "your local MySQL server".
 */
export function localDatabase(
  dev: LocalDatabaseArgs,
  defaults: {
    password?: Input<string>;
    username: Input<string>;
    database: Input<string>;
    port: Input<number>;
  },
  what: { database: string; server: string },
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
  if (dev.password === undefined && defaults.password === undefined)
    throw new VisibleError(
      `You must provide the password to connect to your locally running ${what.database} either by setting the "dev.password" or by setting the top-level "password" property.`,
    );

  const connection = {
    host: output(dev.host ?? "localhost"),
    port: output(dev.port ?? defaults.port),
    // An empty one is as good as none, as in 4.x
    username: output(dev.username ? dev.username : defaults.username),
    password: output(dev.password ?? defaults.password ?? ""),
    database: output(dev.database ? dev.database : defaults.database),
  };
  return {
    connection,
    pane: localServerPane(
      interpolate`Make sure your local ${what.server} is using:

  username: "${connection.username}"
  password: "${shownPassword(connection.password)}"
  database: "${connection.database}"

Listening on "${connection.host}:${connection.port}"...`,
    ),
  };
}
