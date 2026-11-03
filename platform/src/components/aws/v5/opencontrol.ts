import { ComponentResourceOptions, output } from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { type ComponentArgs, component, deferred } from "../../parts-component";
import { plain } from "../../args";
import { VisibleError } from "../../error";
import { Function, type FunctionArgs } from "./function";
import { functionPart } from "../helpers/function-part";

const parts = () => ({
  /**
   * The password the server is given, as `OPENCONTROL_KEY`.
   */
  key: RandomPassword,
  /**
   * The function the server runs in, reached through its URL. It's an output of the
   * [`Function`](/docs/component/aws/v5/function) component.
   */
  server: deferred(Function),
});

export interface OpenControlArgs extends ComponentArgs<typeof parts> {
  /**
   * The function that's running your OpenControl server: its handler, or its args. It has
   * to be a plain value, since the function is created from it.
   *
   * @example
   * ```js
   * {
   *   server: "src/server.handler"
   * }
   * ```
   *
   * You can also pass in the full `FunctionArgs`.
   *
   * ```js
   * {
   *   server: {
   *     handler: "src/server.handler",
   *     link: [table]
   *   }
   * }
   * ```
   *
   * Since the `server` function is a Hono app, you want to export it with the Lambda adapter.
   *
   * ```ts title="src/server.ts"
   * import { handle } from "hono/aws-lambda";
   * import { create } from "opencontrol";
   *
   * const app = create({
   *   // ...
   * });
   *
   * export const handler = handle(app);
   * ```
   *
   * Learn more in the [OpenControl docs](https://opencontrol.ai) on how to
   * configure the `server` function.
   */
  server: string | FunctionArgs;
}

/**
 * The `OpenControl` component has been deprecated. It should not be used for new projects.
 *
 * :::caution
 * This component has been deprecated.
 * :::
 *
 * The `OpenControl` component lets you deploy your
 * [OpenControl](https://opencontrol.ai) server to
 * [AWS Lambda](https://aws.amazon.com/lambda/).
 *
 * @deprecated Use OpenControl outside of SST instead.
 *
 * @example
 *
 * #### Create an OpenControl server
 *
 * ```ts title="sst.config.ts"
 * const server = new sst.aws.v5.OpenControl("MyServer", {
 *   server: "src/server.handler"
 * });
 * ```
 *
 * #### Link your AI API keys
 *
 * ```ts title="sst.config.ts" {6}
 * const anthropicKey = new sst.Secret("AnthropicKey");
 *
 * const server = new sst.aws.v5.OpenControl("MyServer", {
 *   server: {
 *     handler: "src/server.handler",
 *     link: [anthropicKey]
 *   }
 * });
 * ```
 *
 * #### Link your resources
 *
 * If your tools are need access to specific resources, you can link them to the
 * OpenControl server.
 *
 * ```ts title="sst.config.ts" {6}
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.OpenControl("MyServer", {
 *   server: {
 *     handler: "src/server.handler",
 *     link: [bucket]
 *   }
 * });
 * ```
 *
 * #### Give AWS permissions
 *
 * If you are using the AWS tool within OpenControl, you will need to give
 * your OpenControl server permissions to access your AWS account.
 *
 * ```ts title="sst.config.ts" {4-6}
 * new sst.aws.v5.OpenControl("OpenControl", {
 *   server: {
 *     handler: "src/server.handler",
 *     policies: $dev
 *       ? ["arn:aws:iam::aws:policy/AdministratorAccess"]
 *       : ["arn:aws:iam::aws:policy/ReadOnlyAccess"]
 *   }
 * });
 * ```
 *
 * Here we are giving it admin access in dev but read-only access in prod.
 *
 * #### Define your server
 *
 * Your `server` function might look like this.
 *
 * ```ts title="src/server.ts"
 * import { Resource } from "sst";
 * import { create } from "opencontrol";
 * import { tool } from "opencontrol/tool";
 * import { handle } from "hono/aws-lambda";
 * import { createAnthropic } from "@ai-sdk/anthropic";
 *
 * const myTool = tool({
 *   name: "my_tool",
 *   description: "Get the most popular greeting",
 *   async run() {
 *     return "Hello, world!";
 *   }
 * });
 *
 * const app = create({
 *   model: createAnthropic({
 *     apiKey: Resource.AnthropicKey.value,
 *   })("claude-3-7-sonnet-20250219"),
 *   tools: [myTool],
 * });
 *
 * export const handler = handle(app);
 * ```
 *
 * Learn more in the [OpenControl docs](https://opencontrol.ai) on how to configure
 * the `server` function.
 *
 * #### Switch from `sst.aws.OpenControl`
 *
 * Change `sst.aws.OpenControl` to `sst.aws.v5.OpenControl` and keep the name. The server's
 * function and its URL, and the key, are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * new sst.aws.OpenControl("MyServer", { server: "src/server.handler" });
 * new sst.aws.v5.OpenControl("MyServer", { server: "src/server.handler" });
 * ```
 *
 * A few things work differently:
 *
 * - `server` has to be a plain value, not an output: the function is created from it.
 *   Its args are typed as [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s;
 *   args written the way `sst.aws.Function` takes them still work, but don't type-check.
 * - Inside the server's args, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - A function given by its ARN is refused: the server is reached through the URL of a
 *   function the component creates.
 * - `nodes.server` is still an output, now of a
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function), so its own `nodes` are
 *   the 5.0 ones.
 * - `nodes` also has the key.
 */
export class OpenControl extends component("sst:aws:OpenControl", parts) {
  constructor(
    name: string,
    args: OpenControlArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const server = plain(
      args?.server,
      `The "server" of the "${name}" OpenControl server`,
    );
    if (!server)
      throw new VisibleError(
        `The "${name}" OpenControl server needs a "server": the handler of the function that runs it, or the function's args.`,
      );
    if (typeof server === "string" && server.startsWith("arn:"))
      throw new VisibleError(
        `The "server" of the "${name}" OpenControl server is the ARN of a function. Pass the handler or the function's args: the server is reached through the URL of a function the component creates.`,
      );
    // The server is a function it creates, with the key and a URL
    const existing = args.existing ?? {};
    if (existing.server !== undefined)
      throw new VisibleError(
        `"existing.server" isn't an option for the "${name}" OpenControl server. Pass the handler or the function's args in "server": it creates the function, gives it the key and a URL.`,
      );
    if (existing.key !== undefined)
      throw new VisibleError(
        `"existing.key" isn't an option for the "${name}" OpenControl server. It generates the key, and gives it to the server as "OPENCONTROL_KEY". Change how in "transform.key".`,
      );

    const key = this.part("key", { length: 16, special: false }).result;
    functionPart(this, "server", server, {
      link: [],
      // An output, as SST 4's was: with an `OPENCONTROL_KEY` of the app's
      // own, the environment is still kept secret and waits on the key.
      environment: output({ OPENCONTROL_KEY: key }),
      url: { cors: false },
      _skipHint: true,
    });

    this.report({ hint: this.url });
  }

  /**
   * The URL of the OpenControl server.
   */
  public get url() {
    return this.nodes.server.apply((server) => server.url);
  }

  /**
   * The password for the OpenControl server.
   */
  public get password() {
    return this.nodes.key.result;
  }
}
