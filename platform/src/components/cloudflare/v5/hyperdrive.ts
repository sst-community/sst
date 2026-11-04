import { type ComponentResourceOptions, output, secret } from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import { type ComponentArgs, component } from "../../parts-component";
import { getArgs, usedAsItIs } from "../../args";
import type { Input } from "../../input";
import { type DurationHours, toSeconds } from "../../duration";
import { binding } from "../binding";
import { DEFAULT_ACCOUNT_ID } from "../account-id";
import { ownId, useExisting } from "../helpers/lookup";

const parts = {
  /**
   * The Cloudflare Hyperdrive config. To use one you have, reference it with
   * `get`.
   */
  hyperdrive: cf.HyperdriveConfig,
};

export interface HyperdriveArgs extends ComponentArgs<typeof parts> {
  /**
   * Configure caching for SQL queries sent through Hyperdrive.
   *
   * :::tip
   * Caching is enabled by default. Pass `false` to disable it.
   * :::
   *
   * @example
   * Disable caching.
   * ```js
   * {
   *   caching: false
   * }
   * ```
   *
   * Customize cache durations.
   * ```js
   * {
   *   caching: {
   *     maxAge: "30 minutes",
   *     staleWhileRevalidate: "30 seconds"
   *   }
   * }
   * ```
   */
  caching?: Input<
    | false
    | {
        /**
         * The maximum duration items should persist in the cache. Can be up to 1 hour.
         *
         * @default `"60 seconds"`
         *
         * @example
         * ```js
         * {
         *   caching: {
         *     maxAge: "30 minutes"
         *   }
         * }
         * ```
         */
        maxAge?: Input<DurationHours>;
        /**
         * The duration the cache may serve a stale response while it's being revalidated.
         *
         * @default `"15 seconds"`
         *
         * @example
         * ```js
         * {
         *   caching: {
         *     staleWhileRevalidate: "30 seconds"
         *   }
         * }
         * ```
         */
        staleWhileRevalidate?: Input<DurationHours>;
      }
  >;
  /**
   * Configure mTLS authentication when connecting to the origin database.
   */
  mtls?: Input<{
    /**
     * Define CA certificate ID obtained after uploading CA cert.
     */
    caCertificateId?: Input<string>;
    /**
     * Define mTLS certificate ID obtained after uploading client cert.
     */
    mtlsCertificateId?: Input<string>;
    /**
     * Set SSL mode to 'require', 'verify-ca', or 'verify-full' to verify the CA.
     */
    sslmode?: Input<string>;
  }>;
  /**
   * The (soft) maximum number of connections the Hyperdrive is allowed to make to the origin database.
   */
  connectionLimit?: Input<number>;
  /**
   * The connection details for the origin database Hyperdrive connects to.
   *
   * They're kept secret in the state, the password with the rest, whether or
   * not the password is a secret.
   *
   * @example
   * ```js
   * {
   *   origin: {
   *     database: "app",
   *     host: "db.example.com",
   *     password: new sst.Secret("DatabasePassword").value,
   *     scheme: "postgres",
   *     user: "postgres"
   *   }
   * }
   * ```
   */
  origin: Input<{
    /**
     * Defines the Client ID of the Access token to use when connecting to the origin database.
     */
    accessClientId?: Input<string>;
    /**
     * Defines the Client Secret of the Access Token to use when connecting to the origin database. The API never returns this write-only value.
     */
    accessClientSecret?: Input<string>;
    /**
     * Set the name of your origin database.
     */
    database: Input<string>;
    /**
     * Defines the host (hostname or IP) of your origin database.
     */
    host: Input<string>;
    /**
     * Set the password needed to access your origin database. The API never returns this write-only value.
     */
    password: Input<string>;
    /**
     * Defines the port of your origin database. Defaults to 5432 for PostgreSQL or 3306 for MySQL if not specified.
     */
    port?: Input<number>;
    /**
     * Specifies the URL scheme used to connect to your origin database.
     */
    scheme: Input<"postgres" | "mysql">;
    /**
     * Set the user of your origin database.
     */
    user: Input<string>;
  }>;
  /**
   * The Cloudflare account ID to use for this Hyperdrive.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

export interface HyperdriveGetArgs {
  /**
   * The ID of the existing Hyperdrive config.
   */
  hyperdriveId: Input<string>;
  /**
   * The Cloudflare account ID the Hyperdrive config belongs to.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * The `Hyperdrive` component lets you add a [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) to
 * your app.
 *
 * Hyperdrive can connect Workers to PostgreSQL and MySQL databases.
 * Set `origin.scheme` to `"postgres"` or `"mysql"`.
 *
 * @example
 *
 * #### PostgreSQL example
 *
 * ```ts title="sst.config.ts"
 * const hyperdrive = new sst.cloudflare.v5.Hyperdrive("PostgresDatabase", {
 *   origin: {
 *     database: "app",
 *     host: "db.example.com",
 *     password: new sst.Secret("PostgresPassword").value,
 *     scheme: "postgres",
 *     user: "postgres",
 *   },
 * })
 * ```
 *
 * [Check out the PlanetScale](/docs/examples/#cloudflare-hyperdrive-planetscale)
 * or the [AWS RDS Postgres](/docs/examples/#cloudflare-hyperdrive-with-aws-postgres) examples for a complete guide.
 *
 * #### MySQL example
 *
 * ```ts title="sst.config.ts"
 * const hyperdrive = new sst.cloudflare.v5.Hyperdrive("MySQLDatabase", {
 *   origin: {
 *     database: "app",
 *     host: "db.example.com",
 *     password: new sst.Secret("MySQLPassword").value,
 *     scheme: "mysql",
 *     user: "root",
 *   },
 * })
 * ```
 *
 * #### Link to a worker
 *
 * You can link Hyperdrive to a worker.
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.cloudflare.v5.Worker("MyWorker", {
 *   handler: "./index.ts",
 *   link: [hyperdrive],
 *   url: true,
 * })
 * ```
 *
 * Once linked, you can use the SDK to access the Hyperdrive binding in your worker.
 *
 * ```ts title="index.ts" {4}
 * import postgres from "postgres"
 * import { Resource } from "sst/resource"
 *
 * const sql = postgres(Resource.PostgresDatabase.connectionString)
 * ```
 *
 * It also works with MySQL:
 *
 * ```ts title="index.ts" {4}
 * import mysql from "mysql2/promise"
 * import { Resource } from "sst/resource"
 *
 * const db = await mysql.createConnection(Resource.MySQLDatabase.connectionString)
 * ```
 *
 * #### Switch from `sst.cloudflare.Hyperdrive`
 *
 * Change `sst.cloudflare.Hyperdrive` to `sst.cloudflare.v5.Hyperdrive` and
 * keep the name. The Hyperdrive config is kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const hyperdrive = new sst.cloudflare.Hyperdrive("MyDatabase", { origin });
 * const hyperdrive = new sst.cloudflare.v5.Hyperdrive("MyDatabase", { origin });
 * ```
 *
 * A few things are different:
 *
 * - `origin` is kept secret in the state, whether or not its `password` is a
 *   secret. `sst.cloudflare.Hyperdrive` kept it in plain text when the
 *   password was a plain string; the switch marks it secret, which changes
 *   nothing in Cloudflare.
 * - `get` takes the same args. The config it references is looked up inside
 *   the component, where `sst.cloudflare.Hyperdrive.get` looked it up beside
 *   it. A switch takes the old lookup out of the state and looks the config
 *   up again, which changes nothing in Cloudflare. Its `hyperdriveId` can be
 *   an output.
 * - A config you already have, or its ID, can also be given in `existing`.
 *   `origin`, `caching`, `mtls` and `connectionLimit` are refused next to it,
 *   since it's used the way it is, but `origin` is required, so the args need
 *   a cast. Reference one with `get` instead, which needs none.
 */
export class Hyperdrive extends component("sst:cloudflare:Hyperdrive", parts) {
  constructor(
    name: string,
    args: HyperdriveArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const accountId = args.accountId ?? DEFAULT_ACCOUNT_ID;

    // A config that's already deployed is used as it is. Its ID is looked up
    // in the account, as Cloudflare's provider takes it.
    const existing = args.existing?.hyperdrive;
    if (existing !== undefined) {
      usedAsItIs(
        args,
        ["origin", "caching", "mtls", "connectionLimit"],
        "hyperdrive",
        `the "${name}" Hyperdrive`,
      );
      useExisting(existing, accountId, (id) =>
        this.lookupPart("hyperdrive", id),
      );
      return;
    }

    this.part("hyperdrive", {
      accountId,
      caching: cachingOf(args.caching),
      mtls: args.mtls,
      // Named by SST, as the 4.x `Hyperdrive` names it
      name: "",
      // The whole of it, as the 4.x `Hyperdrive` kept it when the password
      // was a secret
      origin: secret(output(args.origin)),
      originConnectionLimit: args.connectionLimit,
    });
  }

  /**
   * The generated ID of the Hyperdrive config.
   */
  public get id() {
    return ownId(this.nodes.hyperdrive.id);
  }

  /**
   * The generated name of the Hyperdrive config.
   */
  public get name() {
    return this.nodes.hyperdrive.name;
  }

  /**
   * When you link Hyperdrive to a worker, the Hyperdrive binding will be available in the
   * worker and you can use its `connectionString` to connect with a PostgreSQL or MySQL client.
   *
   * @example
   * ```ts title="index.ts" {3}
   * import postgres from "postgres"
   * import { Resource } from "sst"
   *
   * const sql = postgres(Resource.PostgresDatabase.connectionString)
   * ```
   *
   * For MySQL:
   *
   * ```ts title="index.ts" {3}
   * import mysql from "mysql2/promise"
   * import { Resource } from "sst"
   *
   * const db = await mysql.createConnection(Resource.MySQLDatabase.connectionString)
   * ```
   *
   * @internal
   */
  public link() {
    return {
      properties: { id: this.id },
      include: [
        binding({
          type: "hyperdriveBindings",
          properties: { id: this.id },
        }),
      ],
    };
  }

  /**
   * Reference an existing Hyperdrive config with the given ID. This is useful when you
   * create a Hyperdrive config in one stage and want to share it in another.
   *
   * :::tip
   * You can use the `static get` method to share Hyperdrive configs across stages.
   * :::
   *
   * @param name The name of the component.
   * @param args The arguments to get the Hyperdrive config.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a Hyperdrive config in the `dev` stage. And in your personal stage
   * `frank`, instead of creating a new one, you want to share the same one from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const hyperdrive = $app.stage === "frank"
   *   ? sst.cloudflare.v5.Hyperdrive.get("MyDatabase", {
   *       hyperdriveId: "a1b2c3d4e5f6",
   *     })
   *   : new sst.cloudflare.v5.Hyperdrive("MyDatabase", { ... });
   * ```
   */
  public static get(
    name: string,
    args: HyperdriveGetArgs,
    opts?: ComponentResourceOptions,
  ) {
    return new Hyperdrive(
      name,
      getArgs({
        accountId: args.accountId,
        existing: { hyperdrive: args.hyperdriveId },
      } as HyperdriveArgs),
      opts,
    );
  }
}

// What Cloudflare takes for `caching`: nothing when it's left out, so
// Hyperdrive's defaults apply
function cachingOf(caching: HyperdriveArgs["caching"]) {
  if (caching === undefined) return undefined;
  return output(caching).apply((caching) => {
    if (caching === false) return { disabled: true };
    return {
      maxAge: caching.maxAge ? toSeconds(caching.maxAge) : undefined,
      staleWhileRevalidate: caching.staleWhileRevalidate
        ? toSeconds(caching.staleWhileRevalidate)
        : undefined,
    };
  });
}
