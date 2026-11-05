import fs from "fs";
import path from "path";
import type { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../parts-component";
import { VisibleError } from "../error";
import { isALteB } from "../../util/compare-semver";
import { getPackageVersion } from "../../util/package";
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

export interface AstroArgs extends SsrSiteArgs, ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your Astro site is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your Astro site, this starts it in dev mode. It's run
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
   * Path to the directory where your Astro site is located. This path is relative to your `sst.config.ts`.
   *
   * By default it assumes your Astro site is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your Astro site is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * [Link resources](/docs/linking/) to your Astro site. This will:
   *
   * 1. Grant the permissions needed to access the resources.
   * 2. Allow you to access them in your site using `sst/resource`.
   *
   * @example
   *
   * Takes a list of resources to link to the site.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   *
   * Access linked resources in your site with
   * [`sst/resource`](/docs/reference/sdk/#sstresource). This works in both
   * `sst dev` and after deploy.
   *
   * ```astro
   * ---
   * import { Resource } from "sst/resource";
   *
   * const files = await Resource.MyBucket.list();
   * ---
   * ```
   */
  link?: any[];
  /**
   * Set [environment variables](https://docs.astro.build/en/guides/environment-variables/) in your Astro site.
   *
   * :::tip
   * You can also `link` resources to your Astro site and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
   * :::
   *
   * Recall that in Astro, you need to prefix your environment variables with `PUBLIC_` to access them on the client-side. [Read more here](https://docs.astro.build/en/guides/environment-variables/).
   *
   * @example
   * ```js
   * {
   *   environment: {
   *     API_URL: api.url,
   *     // Accessible on the client-side
   *     PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Set a custom domain for your Astro site. Supports domains hosted on Cloudflare.
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
   * The command used internally to build your Astro site.
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

// Astro's build, as Cloudflare's adapter writes it
const astro: SsrFramework = {
  label: "Astro",
  check(site, owner) {
    // Astro 6 and later read SST's Wrangler config. Without a version in the
    // site's `package.json`, it's taken as one of them.
    const version = getPackageVersion(site, "astro");
    if (!version || isALteB("6.0.0", version))
      validateFrameworkConfig({
        sitePath: site,
        configName: "astro.config",
        componentName: owner,
      });
    validateNoWranglerFile(site, owner);
  },
  async load(site, owner) {
    const dist = path.join(site, "dist");
    const relative = (file: string) => path.relative(site, file);

    // Astro 5 writes the Worker and its files into `dist/`, so the Worker's
    // own code is left out of the files it serves
    const legacy = path.join(dist, "_worker.js", "index.js");
    if (fs.existsSync(legacy)) {
      const ignoreFile = path.join(dist, ".assetsignore");
      const ignored = fs.existsSync(ignoreFile)
        ? fs.readFileSync(ignoreFile, "utf-8").split("\n")
        : [];
      if (!ignored.includes("_worker.js") || !ignored.includes("_routes.json"))
        fs.appendFileSync(ignoreFile, "\n_worker.js\n_routes.json");
      return { server: relative(legacy), assets: relative(dist) };
    }

    // Astro 6 and later write a Wrangler config next to the Worker
    const wranglerFile = path.join(dist, "server", "wrangler.json");
    if (fs.existsSync(wranglerFile)) {
      const wrangler = JSON.parse(fs.readFileSync(wranglerFile, "utf-8")) as {
        main?: string;
        assets?: { directory?: string };
      };
      const serverDir = path.dirname(wranglerFile);
      const server = path.resolve(serverDir, wrangler.main ?? "entry.mjs");
      const assets = wrangler.assets?.directory
        ? path.resolve(serverDir, wrangler.assets.directory)
        : path.join(dist, "client");
      if (fs.existsSync(server))
        return { server: relative(server), assets: relative(assets) };
    }

    throw new VisibleError(
      [
        `The build of ${owner} has no Worker in "${dist}".`,
        "",
        "Astro 5 writes it to `dist/_worker.js/index.js`, and Astro 6 and later to the `main` of `dist/server/wrangler.json`.",
        "If your Astro site is entirely pre-rendered, use `sst.cloudflare.StaticSite` instead.",
      ].join("\n"),
    );
  },
};

/**
 * The `Astro` component lets you deploy an [Astro](https://astro.build) site to Cloudflare.
 *
 * :::caution
 * Features like `sst dev` support and `sst/resource` bindings require Astro v6 or newer.
 * :::
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy the Astro site that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.cloudflare.Astro("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the Astro site in the `my-astro-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.cloudflare.Astro("MyWeb", {
 *   path: "my-astro-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Astro site.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.cloudflare.Astro("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.cloudflare.Astro("MyWeb", {
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
 * new sst.cloudflare.Astro("MyWeb", {
 *   domain: {
 *     name: "app1.my-app.com",
 *     aliases: ["app2.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your Astro site. This will grant permissions
 * to the resources and allow you to access it in your site.
 *
 * ```ts {4} title="sst.config.ts"
 * const bucket = new sst.cloudflare.Bucket("MyBucket");
 *
 * new sst.cloudflare.Astro("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * Add this to your `astro.config.mjs` for SST to work correctly.
 *
 * ```js title="astro.config.mjs"
 * import { defineConfig } from "astro/config";
 * import cloudflare from "@astrojs/cloudflare";
 *
 * export default defineConfig({
 *   adapter: cloudflare({
 *     configPath: process.env.SST_WRANGLER_PATH,
 *   }),
 * });
 * ```
 *
 * Use `sst/resource` for linked resources.
 *
 * ```astro title="src/pages/index.astro"
 * ---
 * import { Resource } from "sst/resource";
 *
 * const files = await Resource.MyBucket.list();
 * ---
 * ```
 *
 * [Check out the full example](/docs/examples/#cloudflare-astro).
 *
 * #### Switch from SST 4's `sst.cloudflare.Astro`
 *
 * Keep the name, and `sst migrate` moves it. The site's
 * Worker, its URL and its custom domains are kept. A few things are written differently:
 *
 * - The site is built in the deploy itself, once, with the values of what it's linked to.
 *   SST 4's `Astro` built it with a command it kept in the state, which goes.
 * - `sst diff` builds the site too, and writes the Wrangler config its build reads. Values
 *   that aren't known until the deploy, like those of what the same deploy creates on a new
 *   stage, are left out of that build and of that config, and so is the binding to something
 *   that isn't created yet, like a new KV namespace. SST 4's `Astro` skipped its build
 *   in `sst diff` then.
 * - `sst migrate`, and a deploy that previews first, on a stage with checks or with a policy
 *   pack, build the site twice: in the preview, and in the deploy.
 * - `sst refresh` doesn't build the site, where SST 4's `Astro` did. Its Worker stays as
 *   it is, and isn't listed while it runs.
 * - `path`, `buildCommand` and `link` have to be plain values, not outputs: the build reads
 *   them, or they decide what's created. A `domain` given as an object is a plain value
 *   too. Its `name` can be an output, and so can a domain given as a string.
 * - `compatibility` sets the Worker's compatibility date and flags, and the Wrangler config's.
 *   One set in `transform.server` still reaches both.
 * - In `sst dev`, reading `nodes.server` says the site runs on your machine, where
 *   SST 4's `Astro` gave `undefined`.
 */
export class Astro extends component("sst:cloudflare:Astro", parts) {
  private readonly siteUrl: Output<string | undefined>;

  constructor(
    name: string,
    args: AstroArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = ssrSite(this.builder(), name, args, astro).url;
  }

  /**
   * The URL of the Astro site.
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
