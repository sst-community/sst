import type { ComponentResourceOptions } from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import { type ComponentArgs, component } from "../../parts-component";
import { getArgs } from "../../args";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import { binding } from "../binding";
import { DEFAULT_ACCOUNT_ID } from "../account-id";
import { ownId, useExisting } from "../helpers/lookup";

const parts = {
  /**
   * The Cloudflare D1 database. Pass one you have in `existing`, or its ID.
   */
  database: cf.D1Database,
};

export interface D1Args extends ComponentArgs<typeof parts> {
  /**
   * The Cloudflare account ID to use for this D1 database.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

export interface D1GetArgs {
  /**
   * The ID of the existing D1 database.
   */
  databaseId: Input<string>;
  /**
   * The Cloudflare account ID the database belongs to.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * The `D1` component lets you add a [Cloudflare D1 database](https://developers.cloudflare.com/d1/) to
 * your app.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const db = new sst.cloudflare.v5.D1("MyDatabase");
 * ```
 *
 * #### Link to a worker
 *
 * You can link the db to a worker.
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.cloudflare.v5.Worker("MyWorker", {
 *   handler: "./index.ts",
 *   link: [db],
 *   url: true
 * });
 * ```
 *
 * Once linked, you can use the SDK to interact with the db.
 *
 * ```ts title="index.ts" {1} "Resource.MyDatabase.prepare"
 * import { Resource } from "sst";
 *
 * await Resource.MyDatabase.prepare(
 *   "SELECT id FROM todo ORDER BY id DESC LIMIT 1",
 * ).first();
 * ```
 *
 * #### Switch from `sst.cloudflare.D1`
 *
 * Change `sst.cloudflare.D1` to `sst.cloudflare.v5.D1` and keep the name. The
 * database and what's in it are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const db = new sst.cloudflare.D1("MyDatabase");
 * const db = new sst.cloudflare.v5.D1("MyDatabase");
 * ```
 *
 * A few things are different:
 *
 * - `get` takes the database's ID in an object, `get(name, { databaseId })`.
 *   The deprecated form with the ID as the second argument is gone.
 * - `get` gives the component the options it's passed, `parent` and
 *   `provider` included, where `sst.cloudflare.D1.get` gave them to the
 *   lookup alone. A D1 referenced inside another component is now inside it.
 * - The database `get` references is looked up inside the component, where
 *   `sst.cloudflare.D1.get` looked it up beside it. A switch takes the old
 *   lookup out of the state and looks the database up again, which changes
 *   nothing in Cloudflare. Its `databaseId` can be an output.
 * - You can pass a database you already have in `existing`, or its ID, in
 *   place of `get`.
 */
export class D1 extends component("sst:cloudflare:D1", parts) {
  constructor(
    name: string,
    args: D1Args = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const accountId = args.accountId ?? DEFAULT_ACCOUNT_ID;

    // A database that's already deployed is used as it is. Its ID is looked
    // up in the account, as Cloudflare's provider takes it.
    const existing = args.existing?.database;
    if (existing !== undefined) {
      useExisting(existing, accountId, (id) => this.lookupPart("database", id));
      return;
    }

    this.part("database", {
      // Named by SST, as the 4.x `D1` names it
      name: "",
      accountId,
    });
  }

  /**
   * The generated ID of the D1 database.
   */
  public get databaseId() {
    return ownId(this.nodes.database.id);
  }

  /**
   * When you link a D1 database, the database will be available to the worker and you can
   * query it using its [API methods](https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/).
   *
   * @example
   * ```ts title="index.ts" {1} "Resource.MyDatabase.prepare"
   * import { Resource } from "sst";
   *
   * await Resource.MyDatabase.prepare(
   *   "SELECT id FROM todo ORDER BY id DESC LIMIT 1",
   * ).first();
   * ```
   *
   * @internal
   */
  public link() {
    return {
      properties: { databaseId: this.databaseId },
      include: [
        binding({
          type: "d1DatabaseBindings",
          properties: { id: this.databaseId },
        }),
      ],
    };
  }

  /**
   * Reference an existing D1 Database with the given database ID. This is
   * useful when you create a D1 in one stage and want to share it in another.
   * It avoids having to create a new D1 Database in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share D1 Databases across stages.
   * :::
   *
   * @param name The name of the component.
   * @param args The database ID of the existing D1 Database.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a D1 Database in the `dev` stage. And in your personal
   * stage `giorgio`, instead of creating a new database, you want to share the
   * same database from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const d1 = $app.stage === "giorgio"
   *   ? sst.cloudflare.v5.D1.get("MyD1", { databaseId: "my-database-id" })
   *   : new sst.cloudflare.v5.D1("MyD1");
   * ```
   *
   * Here `my-database-id` is the ID of the D1 Database created in the `dev`
   * stage. You can find it by outputting the D1 Database in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   d1: d1.databaseId
   * };
   * ```
   */
  public static get(
    name: string,
    args: D1GetArgs,
    opts?: ComponentResourceOptions,
  ) {
    // The 4.x `D1` also took the ID as the second argument, deprecated
    if (typeof args !== "object" || args === null || !("databaseId" in args))
      throw new VisibleError(
        `D1.get("${name}", ...) takes the database's ID in an object: sst.cloudflare.v5.D1.get("${name}", { databaseId: ${JSON.stringify(
          typeof args === "string" ? args : "<id>",
        )} }).`,
      );
    return new D1(
      name,
      getArgs({
        accountId: args.accountId,
        existing: { database: args.databaseId },
      }),
      opts,
    );
  }
}
