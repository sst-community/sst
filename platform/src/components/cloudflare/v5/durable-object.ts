import {
  type ComponentResourceOptions,
  type Output,
  output,
} from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../../parts-component";
import type { Input } from "../../input";
import { binding } from "../binding";

// A Durable Object is a class in the code of the worker it's linked to:
// nothing is created for it
const parts = {};

export interface DurableObjectArgs extends ComponentArgs<typeof parts> {
  /**
   * The name of the class in your worker handler file that extends `DurableObject`.
   *
   * @example
   * ```js
   * {
   *   className: "Counter"
   * }
   * ```
   */
  className: Input<string>;
}

/**
 * Use the `DurableObject` component to register a
 * [Cloudflare Durable Object](https://developers.cloudflare.com/durable-objects/)
 * for a worker.
 *
 * Create the Durable Object and then link it to a
 * [`sst.cloudflare.v5.Worker`](/docs/component/cloudflare/v5/worker). SST adds
 * the Durable Object binding automatically. The `className` must match the
 * exported Durable Object class name in your worker code.
 *
 * Durable Objects require migrations on the worker. Use the Worker's
 * `migrations` field like Wrangler's top-level `migrations` config: keep the
 * full ordered history there, and SST uses it to build the Cloudflare migration
 * payload for the Worker.
 *
 * On the first deploy, add the class with `newSqliteClasses`. If you later
 * rename the class, keep the original migration and add a new migration with a
 * unique tag and `renamedClasses`.
 *
 * @example
 *
 * ```ts title="sst.config.ts"
 * const counter = new sst.cloudflare.v5.DurableObject("Counter", {
 *   className: "Counter",
 * });
 *
 * new sst.cloudflare.v5.Worker("Api", {
 *   handler: "src/worker.ts",
 *   link: [counter],
 *   migrations: [{
 *     tag: "v1",
 *     newSqliteClasses: [counter.className],
 *   }],
 *   url: true,
 * });
 * ```
 *
 * To rename a deployed class from `Counter` to `CounterV2`, update `className`
 * and the exported class name, then append a migration.
 *
 * ```ts title="sst.config.ts"
 * const counter = new sst.cloudflare.v5.DurableObject("Counter", {
 *   className: "CounterV2",
 * });
 *
 * new sst.cloudflare.v5.Worker("Api", {
 *   handler: "src/worker.ts",
 *   link: [counter],
 *   migrations: [
 *     {
 *       tag: "v1",
 *       newSqliteClasses: ["Counter"],
 *     },
 *     {
 *       tag: "v2",
 *       renamedClasses: [{ from: "Counter", to: counter.className }],
 *     },
 *   ],
 *   url: true,
 * });
 * ```
 *
 * ```ts title="src/worker.ts"
 * import { Resource } from "sst";
 * import { DurableObject } from "cloudflare:workers";
 *
 * export default {
 *   async fetch() {
 *     const stub = Resource.Counter.getByName("global");
 *     return stub.fetch("https://counter/");
 *   },
 * };
 *
 * export class Counter extends DurableObject {
 *   async fetch() {
 *     return new Response("hello from the durable object");
 *   }
 * }
 * ```
 *
 * #### Switch from `sst.cloudflare.DurableObject`
 *
 * Change `sst.cloudflare.DurableObject` to `sst.cloudflare.v5.DurableObject`
 * and keep the name. It creates nothing in Cloudflare, and a worker linked to
 * it gets the same binding.
 */
export class DurableObject extends component(
  "sst:cloudflare:DurableObject",
  parts,
) {
  constructor(
    name: string,
    args: DurableObjectArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.exportedClass = output(args.className);
  }

  private exportedClass!: Output<string>;

  /**
   * The exported Durable Object class name.
   */
  public get className() {
    return this.exportedClass;
  }

  /**
   * When you link a Durable Object to a worker, SST adds a Cloudflare Durable
   * Object namespace binding.
   *
   * @internal
   */
  public link() {
    const properties = { className: this.className };
    return {
      properties,
      include: [
        binding({ type: "durableObjectNamespaceBindings", properties }),
      ],
    };
  }
}
