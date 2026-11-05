import { ComponentResourceOptions } from "@pulumi/pulumi";
import { component } from "../parts-component";
import { VisibleError } from "../error";
import type { Input } from "../input";
import { context } from "../contract";

// It creates nothing: it tells `sst dev` what to run
const parts = {};

export interface DevCommandArgs {
  /**
   * What `sst dev` runs, and how.
   */
  dev: {
    /**
     * The command that `sst dev` runs.
     *
     * @example
     * ```js
     * {
     *   dev: {
     *     command: "npx drizzle-kit studio"
     *   }
     * }
     * ```
     */
    command: Input<string>;
    /**
     * Configure if you want to automatically start this when `sst dev` starts. You can still
     * start it manually later.
     * @default `true`
     */
    autostart?: Input<boolean>;
    /**
     * Change the directory from where the `command` is run, from your app's folder.
     * @default Your app's folder.
     */
    directory?: Input<string>;
    /**
     * The title of the tab in the multiplexer.
     *
     * @default The name of the component.
     */
    title?: Input<string>;
  };
  /**
   * [Link resources](/docs/linking/) to your command. This will allow you to access it in your
   * command using the [SDK](/docs/reference/sdk/).
   *
   * @example
   *
   * Takes a list of resources to link.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: Input<any[]>;
  /**
   * Set environment variables for this command.
   *
   * @example
   * ```js
   * {
   *   environment: {
   *     API_URL: api.url,
   *     STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * The AWS role the command runs as, like a service's task role.
   * @internal
   */
  aws?: {
    role: Input<string>;
  };
}

/**
 * The `DevCommand` lets you run a command in a separate pane when you run `sst dev`.
 *
 * :::note
 * This is an experimental feature and the API may change in the future.
 * :::
 *
 * The `sst dev` CLI starts a multiplexer with panes for separate processes. This component
 * allows you to add a process to it.
 *
 * :::tip
 * This component does not do anything on deploy.
 * :::
 *
 * This component only works in `sst dev`. It does not do anything in `sst deploy`.
 *
 * @example
 *
 * #### Run Drizzle Studio
 *
 * For example, you can use this to run Drizzle Studio locally.
 *
 * ```ts title="sst.config.ts"
 * new sst.x.DevCommand("Studio", {
 *   link: [rds],
 *   dev: {
 *     autostart: true,
 *     command: "npx drizzle-kit studio"
 *   }
 * });
 * ```
 *
 * Here `npx drizzle-kit studio` will be run in `sst dev` and will show up under the **Studio**
 * tab. It'll also have access to the links from `rds`.
 *
 * #### Switch from SST 4's `sst.x.DevCommand`
 *
 * Keep the name, and `sst migrate` moves it. Neither creates
 * anything in AWS.
 *
 * A few things work differently:
 *
 * - `dev.command` is required. SST 4's `DevCommand`
 *   took one without it, and `sst dev` ran nothing.
 * - What `sst dev` runs is kept in the state in `sst dev` alone. SST 4's `DevCommand` kept it,
 *   with its environment, in every deploy, so a deploy takes it out.
 */
export class DevCommand extends component("sst:sst:DevCommand", parts) {
  constructor(
    name: string,
    args: DevCommandArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    // `sst.x.DevCommand` took a command it would never run
    if (!args?.dev?.command)
      throw new VisibleError(
        `The "${name}" DevCommand has no "dev.command". Give it the command \`sst dev\` runs.`,
      );

    // What it runs matters to `sst dev` alone
    if (!context().dev) return;
    this.report({
      dev: {
        command: args.dev.command,
        autostart: args.dev.autostart,
        directory: args.dev.directory,
        title: args.dev.title,
        link: args.link,
        environment: args.environment,
        aws: args.aws,
      },
    });
  }
}
