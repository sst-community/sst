import type { ComponentResourceOptions } from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import { type ComponentArgs, component } from "../parts-component";
import { getArgs } from "../args";
import { VisibleError } from "../error";
import type { Input } from "../input";
import { binding } from "./binding";
import { DEFAULT_ACCOUNT_ID } from "./account-id";
import { ownId, useExisting } from "./helpers/lookup";

const parts = {
  /**
   * The Cloudflare KV namespace. Pass one you have in `existing`, or its ID.
   */
  namespace: cf.WorkersKvNamespace,
};

export interface KvArgs extends ComponentArgs<typeof parts> {
  /**
   * The Cloudflare account ID to use for this KV namespace.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

export interface KvGetArgs {
  /**
   * The ID of the existing KV namespace.
   */
  namespaceId: Input<string>;
  /**
   * The Cloudflare account ID the namespace belongs to.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * The `Kv` component lets you add a [Cloudflare KV storage namespace](https://developers.cloudflare.com/kv/) to
 * your app.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const storage = new sst.cloudflare.Kv("MyStorage");
 * ```
 *
 * #### Link to a worker
 *
 * You can link KV to a worker.
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.cloudflare.Worker("MyWorker", {
 *   handler: "./index.ts",
 *   link: [storage],
 *   url: true
 * });
 * ```
 *
 * Once linked, you can use the SDK to interact with the namespace.
 *
 * ```ts title="index.ts" {3}
 * import { Resource } from "sst";
 *
 * await Resource.MyStorage.get("someKey");
 * ```
 *
 * #### Switch from SST 4's `sst.cloudflare.Kv`
 *
 * Keep the name, and `sst migrate` moves it. The
 * namespace and what's in it are kept.
 *
 * A few things are different:
 *
 * - The deprecated `id` is gone. Use `namespaceId`, which is the same value.
 * - `get` takes the same args. The namespace it references is looked up
 *   inside the component, where `sst.cloudflare.Kv.get` looked it up beside
 *   it. A switch takes the old lookup out of the state and looks the
 *   namespace up again, which changes nothing in Cloudflare. Its
 *   `namespaceId` can be an output.
 * - You can pass a namespace you already have in `existing`, or its ID, in
 *   place of `get`.
 */
export class Kv extends component("sst:cloudflare:Kv", parts) {
  constructor(
    name: string,
    args: KvArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const accountId = args.accountId ?? DEFAULT_ACCOUNT_ID;

    // A namespace that's already deployed is used as it is. Its ID is looked
    // up in the account, as Cloudflare's provider takes it.
    const existing = args.existing?.namespace;
    if (existing !== undefined) {
      useExisting(existing, accountId, (id) =>
        this.lookupPart("namespace", id),
      );
      return;
    }

    this.part("namespace", {
      // Named by SST, as the 4.x `Kv` names it
      title: "",
      accountId,
    });
  }

  /**
   * The generated ID of the KV namespace.
   */
  public get namespaceId() {
    return ownId(this.nodes.namespace.id);
  }

  /** @internal */
  public get id(): never {
    throw new VisibleError(
      `"id" isn't a property of the "${this.componentName}" KV namespace. Use "namespaceId", which is the same value.`,
    );
  }

  /**
   * When you link a KV storage, the storage will be available to the worker and you can
   * interact with it using its [API methods](https://developers.cloudflare.com/kv/api/).
   *
   * @example
   * ```ts title="index.ts" {3}
   * import { Resource } from "sst";
   *
   * await Resource.MyStorage.get("someKey");
   * ```
   *
   * @internal
   */
  public link() {
    return {
      properties: { namespaceId: this.namespaceId },
      include: [
        binding({
          type: "kvNamespaceBindings",
          properties: { namespaceId: this.namespaceId },
        }),
      ],
    };
  }

  /**
   * Reference an existing KV namespace with the given ID. This is useful when you
   * create a KV namespace in one stage and want to share it in another.
   *
   * :::tip
   * You can use the `static get` method to share KV namespaces across stages.
   * :::
   *
   * @param name The name of the component.
   * @param args The arguments to get the KV namespace.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a KV namespace in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new namespace, you want to share the same one from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const storage = $app.stage === "frank"
   *   ? sst.cloudflare.Kv.get("MyStorage", {
   *       namespaceId: "a1b2c3d4e5f6",
   *     })
   *   : new sst.cloudflare.Kv("MyStorage");
   * ```
   */
  public static get(
    name: string,
    args: KvGetArgs,
    opts?: ComponentResourceOptions,
  ) {
    return new Kv(
      name,
      getArgs({
        accountId: args.accountId,
        existing: { namespace: args.namespaceId },
      }),
      opts,
    );
  }
}
