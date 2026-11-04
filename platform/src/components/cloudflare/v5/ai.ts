import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { component } from "../../parts-component";
import { binding } from "../binding";

// Workers AI is a binding a Worker gets. Nothing is created in Cloudflare.
const parts = {};

export interface AiArgs {}

/**
 * The `Ai` component lets you add a [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) binding to
 * your app.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const ai = new sst.cloudflare.v5.Ai("MyAi");
 * ```
 *
 * #### Link to a worker
 *
 * You can link AI to a worker.
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.cloudflare.v5.Worker("MyWorker", {
 *   handler: "./index.ts",
 *   link: [ai],
 *   url: true
 * });
 * ```
 *
 * Once linked, you can use the SDK to interact with the AI binding.
 *
 * ```ts title="index.ts" {3}
 * import { Resource } from "sst";
 *
 * const result = await Resource.MyAi.run("@cf/meta/llama-3-8b-instruct", {
 *   prompt: "What is the origin of the phrase 'Hello, World'"
 * });
 * ```
 *
 * #### Switch from `sst.cloudflare.Ai`
 *
 * Change `sst.cloudflare.Ai` to `sst.cloudflare.v5.Ai` and keep the name. It
 * creates nothing in Cloudflare, and a Worker it's linked to gets the same
 * binding, so nothing there changes.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const ai = new sst.cloudflare.Ai("MyAi");
 * const ai = new sst.cloudflare.v5.Ai("MyAi");
 * ```
 */
export class Ai extends component("sst:cloudflare:Ai", parts) {
  constructor(
    name: string,
    args: AiArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);
  }

  /**
   * When you link an AI binding, it will be available to the worker and you can
   * interact with it using its [API methods](https://developers.cloudflare.com/workers-ai/).
   *
   * @example
   * ```ts title="index.ts" {3}
   * import { Resource } from "sst";
   *
   * const result = await Resource.MyAi.run("@cf/meta/llama-3-8b-instruct", {
   *   prompt: "What is the origin of the phrase 'Hello, World'"
   * });
   * ```
   *
   * @internal
   */
  public link() {
    return {
      properties: {},
      include: [binding({ type: "aiBindings", properties: {} })],
    };
  }
}
