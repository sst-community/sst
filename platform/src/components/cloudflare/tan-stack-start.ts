import fs from "fs";
import path from "path";
import type { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../parts-component";
import { VisibleError } from "../error";
import {
  validateFrameworkConfig,
  validateNoWranglerFile,
} from "./helpers/validation";
import {
  type SsrFramework,
  type SsrSiteArgs,
  ssrSite,
  ssrSiteParts,
} from "./helpers/ssr-site";
import type { WorkerArgs } from "./worker";

const parts = ssrSiteParts;

export interface TanStackStartArgs
  extends SsrSiteArgs,
    ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your TanStack Start app is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your TanStack Start app, this starts it in dev mode. It's run
   * as a separate process in the `sst dev` multiplexer. Read more about
   * [`sst dev`](/docs/reference/cli/#dev).
   *
   * To disable dev mode, pass in `false`.
   */
  dev?:
    | false
    | {
        /**
         * The `url` when this is running in dev mode.
         *
         * Since this component is not deployed in `sst dev`, there is no real URL. But if you are
         * using this component's `url` or linking to this component's `url`, it can be useful to
         * have a placeholder URL. It avoids having to handle it being `undefined`.
         * @default `"http://url-unavailable-in-dev.mode"`
         */
        url?: Input<string>;
        /**
         * The command that `sst dev` runs to start this in dev mode.
         * @default `"npm run dev"`
         */
        command?: Input<string>;
        /**
         * Configure if you want to automatically start this when `sst dev` starts. You can still
         * start it manually later.
         * @default `true`
         */
        autostart?: Input<boolean>;
        /**
         * Change the directory from where the `command` is run.
         * @default Uses the `path`
         */
        directory?: Input<string>;
        /**
         * The title of the tab in the multiplexer.
         */
        title?: Input<string>;
      };
  /**
   * Path to the directory where your TanStack Start app is located. This path is relative to your `sst.config.ts`.
   *
   * By default it assumes your TanStack Start app is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your TanStack Start app is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * [Link resources](/docs/linking/) to your TanStack Start app. This will:
   *
   * 1. Grant the permissions needed to access the resources.
   * 2. Allow you to access it in your app using the [SDK](/docs/reference/sdk/).
   *
   * @example
   *
   * Takes a list of resources to link to the app.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   *
   * You can access the linked resources in your TanStack Start app.
   *
   * ```ts
   * import { Resource } from "sst";
   *
   * console.log(Resource.MyBucket.name);
   * ```
   */
  link?: any[];
  /**
   * Set environment variables in your TanStack Start app. These are made available:
   *
   * 1. In `vite build`, they are loaded into the build.
   * 2. At runtime as Worker bindings.
   * 3. Locally while running `vite dev` through `sst dev`.
   *
   * :::tip
   * You can also `link` resources to your TanStack Start app and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
   * :::
   *
   * @example
   * ```js
   * {
   *   environment: {
   *     API_URL: api.url,
   *     PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   *
   * You can access the environment variables in your TanStack Start app as follows:
   *
   * ```ts
   * import { env } from "cloudflare:workers";
   *
   * const apiUrl = env.API_URL;
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Set a custom domain for your TanStack Start app. Supports domains hosted on Cloudflare.
   *
   * A domain given as an object is a plain value, not an output: each of
   * its `aliases` and `redirects` creates resources of its own. Its `name`
   * can be an output, and so can a domain given as a string.
   *
   * @example
   *
   * ```js
   * {
   *   domain: "my-app.com"
   * }
   * ```
   *
   * Redirect alternate domains to the main domain.
   *
   * ```js
   * {
   *   domain: {
   *     name: "my-app.com",
   *     redirects: ["www.my-app.com"]
   *   }
   * }
   * ```
   *
   * Or keep visitors on alternate domains with aliases.
   *
   * ```js
   * {
   *   domain: {
   *     name: "app1.my-app.com",
   *     aliases: ["app2.my-app.com"]
   *   }
   * }
   * ```
   */
  domain?: WorkerArgs["domain"];
  /**
   * The command used internally to build your TanStack Start app.
   *
   * @default The `build` script in your `package.json`, run with the package manager whose lockfile is there, like `"npm run build"`.
   *
   * @example
   *
   * If you want to use a different build command.
   * ```js
   * {
   *   buildCommand: "yarn build"
   * }
   * ```
   */
  buildCommand?: string;
}

// TanStack Start's build, as Cloudflare's Vite plugin or Nitro's Cloudflare
// preset writes it
const tanStackStart: SsrFramework = {
  label: "TanStack Start",
  check(site, owner) {
    validateFrameworkConfig({
      sitePath: site,
      configName: "vite.config",
      componentName: owner,
    });
    validateNoWranglerFile(site, owner);
  },
  // The Worker's entry, which the Vite plugin builds from
  wrangler: () => ({ main: "@tanstack/react-start/server-entry" }),
  async load(site, owner) {
    const relative = (file: string) => path.relative(site, file);
    const has = (file: string) => fs.existsSync(file);
    const noFiles = (assets: string) =>
      new VisibleError(
        `The build of ${owner} has no files to serve at "${assets}".`,
      );

    // The Vite plugin writes a Wrangler config next to the Worker
    const serverDir = path.join(site, "dist", "server");
    const wranglerFile = path.join(serverDir, "wrangler.json");
    if (has(wranglerFile)) {
      const wrangler = JSON.parse(fs.readFileSync(wranglerFile, "utf-8")) as {
        main?: string;
        assets?: { directory?: string };
      };
      if (!wrangler.main)
        throw new VisibleError(
          `The build of ${owner} has no Worker: "${wranglerFile}" has no \`main\`.`,
        );
      const server = path.resolve(serverDir, wrangler.main);
      const assets = path.resolve(
        serverDir,
        wrangler.assets?.directory ?? "../client",
      );
      if (!has(server))
        throw new VisibleError(
          `The build of ${owner} has no Worker at "${server}", the \`main\` of "${wranglerFile}".`,
        );
      if (!has(assets)) throw noFiles(assets);
      return { server: relative(server), assets: relative(assets) };
    }

    // Or the Worker and its files without one
    const client = path.join(site, "dist", "client");
    for (const file of ["index.js", "index.mjs"]) {
      const server = path.join(serverDir, file);
      if (has(server) && has(client))
        return { server: relative(server), assets: relative(client) };
    }

    // Nitro's Cloudflare preset
    const nitro = path.join(site, ".output", "server", "index.mjs");
    if (has(nitro)) {
      const assets = path.join(site, ".output", "public");
      if (!has(assets)) throw noFiles(assets);
      return { server: relative(nitro), assets: relative(assets) };
    }

    throw new VisibleError(
      [
        `The build of ${owner} has no Worker in "${site}".`,
        "",
        "Expected one of:",
        "  - dist/server/wrangler.json and dist/client",
        "  - dist/server/index.js and dist/client",
        "  - .output/server/index.mjs and .output/public",
        "",
        "Use the Cloudflare deployment adapter in TanStack Start, or if your app is entirely pre-rendered, use `sst.cloudflare.StaticSite` instead.",
      ].join("\n"),
    );
  },
};

/**
 * The `TanStackStart` component lets you deploy a [TanStack Start](https://tanstack.com/start/latest) app to Cloudflare.
 *
 * :::note
 * Create a Cloudflare-compatible app with `bunx @tanstack/cli@latest create --deployment cloudflare`.
 * :::
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy the TanStack Start app that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.cloudflare.TanStackStart("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the TanStack Start app in the `my-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.cloudflare.TanStackStart("MyWeb", {
 *   path: "my-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your TanStack Start app.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.cloudflare.TanStackStart("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.cloudflare.TanStackStart("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Add domain aliases
 *
 * Allow visitors to use alternate domains without redirecting.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.cloudflare.TanStackStart("MyWeb", {
 *   domain: {
 *     name: "app1.my-app.com",
 *     aliases: ["app2.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your TanStack Start app. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {4} title="sst.config.ts"
 * const bucket = new sst.cloudflare.Bucket("MyBucket");
 *
 * new sst.cloudflare.TanStackStart("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * Add this to your `vite.config.ts` for SST to work correctly.
 *
 * ```ts title="vite.config.ts"
 * import { defineConfig } from 'vite'
 * import { tanstackStart } from '@tanstack/react-start/plugin/vite'
 * import { cloudflare } from '@cloudflare/vite-plugin'
 *
 * export default defineConfig({
 *   plugins: [
 *     cloudflare({
 *       viteEnvironment: { name: 'ssr' },
 *       configPath: process.env.SST_WRANGLER_PATH,
 *     }),
 *     tanstackStart(),
 *   ],
 * })
 * ```
 *
 * Use `sst/resource` for linked resources.
 *
 * ```ts title="src/routes/api.ts"
 * import { Resource } from "sst/resource";
 *
 * const files = await Resource.MyBucket.list();
 * ```
 *
 * [Check out the full example](/docs/examples/#cloudflare-tanstack-start).
 *
 * #### Switch from SST 4's `sst.cloudflare.TanStackStart`
 *
 * Keep the name, and `sst migrate` moves it. The app's Worker, its URL and its custom domains are kept. A few things are written
 * differently:
 *
 * - The app is built in the deploy itself, once, with the values of what it's linked to.
 *   `sst.cloudflare.TanStackStart` built it with a command it kept in the state, which goes.
 * - `sst diff` builds the app too, and writes the Wrangler config its build reads. Values
 *   that aren't known until the deploy, like those of what the same deploy creates on a new
 *   stage, are left out of that build and of that config, and so is the binding to something
 *   that isn't created yet, like a new KV namespace. `sst.cloudflare.TanStackStart` skipped
 *   its build in `sst diff` then.
 * - `sst migrate`, and a deploy that previews first, on a stage with checks or with a policy
 *   pack, build the app twice: in the preview, and in the deploy.
 * - `sst refresh` doesn't build the app, where `sst.cloudflare.TanStackStart` did. Its Worker
 *   stays as it is, and isn't listed while it runs.
 * - `path`, `buildCommand` and `link` have to be plain values, not outputs: the build reads
 *   them, or they decide what's created. A `domain` given as an object is a plain value
 *   too. Its `name` can be an output, and so can a domain given as a string.
 * - `compatibility` sets the Worker's compatibility date and flags, and the Wrangler config's.
 *   One set in `transform.server` still reaches both.
 * - In `sst dev`, reading `nodes.server` says the app runs on your machine, where
 *   `sst.cloudflare.TanStackStart` gave `undefined`.
 */
export class TanStackStart extends component(
  "sst:cloudflare:TanStackStart",
  parts,
) {
  private readonly siteUrl: Output<string | undefined>;

  constructor(
    name: string,
    args: TanStackStartArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = ssrSite(this.builder(), name, args, tanStackStart).url;
  }

  /**
   * The URL of the TanStack Start app.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated Worker URL.
   */
  public get url() {
    return this.siteUrl;
  }

  link() {
    return {
      properties: {
        url: this.url,
      },
    };
  }
}
