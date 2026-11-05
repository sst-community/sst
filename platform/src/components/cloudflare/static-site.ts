import fs from "fs";
import path from "path";
import {
  type ComponentResourceOptions,
  type Input,
  type Output,
  output,
} from "@pulumi/pulumi";
import { type ComponentArgs, component, named } from "../parts-component";
import { notAnOption, plain, plainDeep } from "../args";
import { context } from "../contract";
import { VisibleError } from "../error";
import {
  BUILD_READS_IT,
  capitalized,
  siteDev,
  sitePathOf,
} from "../aws/helpers/site";
import { buildSite, writeViteTypes } from "../aws/helpers/site-build";
import { workerSite } from "./helpers/site";
import { Worker, type WorkerArgs, checkDomain } from "./worker";

const parts = {
  /**
   * The Worker that serves the site's files.
   */
  server: named(Worker, "Router"),
};

export interface StaticSiteArgs extends ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your static site is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your static site, this starts it in dev mode. It's run
   * as a separate process in the `sst dev` multiplexer. Read more about
   * [`sst dev`](/docs/reference/cli/#dev).
   *
   * To disable dev mode, pass in `false`.
   *
   * @example
   * Use a custom dev command.
   * ```js
   * {
   *   dev: {
   *     command: "yarn dev"
   *   }
   * }
   * ```
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
   * Path to the directory where your static site is located. By default this assumes your static site is in the root of your SST app.
   *
   * This directory will be uploaded as static assets. The path is relative to your `sst.config.ts`.
   *
   * :::note
   * If the `build` options are specified, `build.output` will be uploaded as static assets instead.
   * :::
   *
   * If you are using a static site generator, like Vite, you'll need to configure the `build` options. When these are set, the `build.output` directory will be uploaded as static assets instead.
   *
   * @default `"."`
   *
   * @example
   *
   * Change where your static site is located.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * Configure if your static site needs to be built. This is useful if you are using a static site generator.
   *
   * The `build.output` directory will be uploaded as static assets.
   *
   * @example
   * For a Vite project using npm this might look like this.
   *
   * ```js
   * {
   *   build: {
   *     command: "npm run build",
   *     output: "dist"
   *   }
   * }
   * ```
   */
  build?: {
    /**
     * The command that builds the static site. It's run before your site is deployed. This is run at the root of your site, `path`.
     * @example
     * ```js
     * {
     *   build: {
     *     command: "yarn build"
     *   }
     * }
     * ```
     */
    command: string;
    /**
     * The directory where the build output of your static site is generated. This will be uploaded.
     *
     * The path is relative to the root of your site, `path`.
     * @example
     * ```js
     * {
     *   build: {
     *     output: "build"
     *   }
     * }
     * ```
     */
    output: string;
  };
  /**
   * Set environment variables for your static site. These are made available:
   *
   * 1. Locally while running your site through `sst dev`.
   * 2. In the build process when running `build.command`.
   * 3. To the Worker that serves your site, as its environment variables.
   *
   * @example
   * ```js
   * environment: {
   *   API_URL: api.url
   *   STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   * }
   * ```
   *
   * Some static site generators like Vite have their [concept of environment variables](https://vitejs.dev/guide/env-and-mode), and you can use this option to set them.
   *
   * :::note
   * If your site has a `vite.config.ts` or `vite.config.js`, the types for these are generated in `src/sst-env.d.ts`.
   * :::
   *
   * These can be accessed as `import.meta.env` in your site. And only the ones prefixed with `VITE_` can be accessed in the browser.
   *
   * ```js
   * environment: {
   *   API_URL: api.url
   *   // Accessible in the browser
   *   VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Set a custom domain for your static site. Supports domains hosted on Cloudflare.
   *
   * A domain given as an object is a plain value, not an output: each of
   * its `aliases` and `redirects` creates resources of its own. Its `name`
   * can be an output, and so can a domain given as a string.
   *
   * :::tip
   * You can migrate an externally hosted domain to Cloudflare by
   * [following this guide](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
   * :::
   *
   * @example
   *
   * ```js
   * {
   *   domain: "domain.com"
   * }
   * ```
   *
   * Redirect alternate domains to the main domain.
   *
   * ```js
   * {
   *   domain: {
   *     name: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   *
   * Or keep visitors on alternate domains with aliases.
   *
   * ```js
   * {
   *   domain: {
   *     name: "app1.domain.com",
   *     aliases: ["app2.domain.com"]
   *   }
   * }
   * ```
   */
  domain?: WorkerArgs["domain"];
  /**
   * Configure trailing slash behavior for HTML pages.
   *
   * - `"auto"`: Individual files served without slash, folder indexes with slash
   * - `"force"`: All HTML pages served with trailing slash
   * - `"drop"`: All HTML pages served without trailing slash
   *
   * @default `"auto"`
   *
   * @example
   *
   * #### Force trailing slashes
   *
   * ```js
   * {
   *   trailingSlash: "force"
   * }
   * ```
   */
  trailingSlash?: Input<"auto" | "force" | "drop">;
  /**
   * Configure the response when a request does not match a static asset.
   *
   * - `"single-page-application"`: Serve `index.html` for unmatched routes (SPA mode)
   * - `"404"`: Serve the nearest `404.html` file with a `404` status
   *
   * @default `"single-page-application"`
   */
  notFound?: Input<"single-page-application" | "404">;
  /**
   * The Cloudflare account ID to use for this site and its Worker.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * The `StaticSite` component lets you deploy a static website to Cloudflare. It uses [Cloudflare Workers](https://developers.cloudflare.com/workers/) with [static assets](https://developers.cloudflare.com/workers/static-assets/) to serve your files.
 *
 * It can also `build` your site by running your static site generator, like [Vite](https://vitejs.dev) and uploading the build output as static assets.
 *
 * @example
 *
 * #### Minimal example
 *
 * Simply uploads the current directory as a static site.
 *
 * ```js
 * new sst.cloudflare.StaticSite("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Change the `path` that should be uploaded.
 *
 * ```js
 * new sst.cloudflare.StaticSite("MyWeb", {
 *   path: "path/to/site"
 * });
 * ```
 *
 * #### Deploy a Vite SPA
 *
 * Use [Vite](https://vitejs.dev) to deploy a React/Vue/Svelte/etc. SPA by specifying the `build` config.
 *
 * ```js
 * new sst.cloudflare.StaticSite("MyWeb", {
 *   build: {
 *     command: "npm run build",
 *     output: "dist"
 *   },
 *   notFound: "single-page-application"
 * });
 * ```
 *
 * #### Deploy a Jekyll site
 *
 * Use [Jekyll](https://jekyllrb.com) to deploy a static site.
 *
 * ```js
 * new sst.cloudflare.StaticSite("MyWeb", {
 *   build: {
 *     command: "bundle exec jekyll build",
 *     output: "_site"
 *   },
 *   notFound: "404"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your site.
 *
 * ```js {2}
 * new sst.cloudflare.StaticSite("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4}
 * new sst.cloudflare.StaticSite("MyWeb", {
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
 * ```js {4}
 * new sst.cloudflare.StaticSite("MyWeb", {
 *   domain: {
 *     name: "app1.my-app.com",
 *     aliases: ["app2.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Set environment variables
 *
 * Set `environment` variables for the build process of your static site. These will be used locally and on deploy.
 *
 * For some static site generators like Vite, [environment variables](https://vitejs.dev/guide/env-and-mode) prefixed with `VITE_` can be accessed in the browser.
 *
 * ```ts {5-7}
 * const bucket = new sst.cloudflare.Bucket("MyBucket");
 *
 * new sst.cloudflare.StaticSite("MyWeb", {
 *   environment: {
 *     BUCKET_NAME: bucket.name,
 *     // Accessible in the browser
 *     VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
 *   },
 *   build: {
 *     command: "npm run build",
 *     output: "dist"
 *   }
 * });
 * ```
 *
 * #### Switch from SST 4's `sst.cloudflare.StaticSiteV2`
 *
 * Change `sst.cloudflare.StaticSiteV2` to `sst.cloudflare.StaticSite`, without the
 * version, and keep the name. The site's Worker, its URL and its custom domains are kept.
 * A few things are written differently:
 *
 * - With `build`, the site is built in the deploy itself, once.
 *   SST 4's `StaticSiteV2` built it with a command it kept in the state, which goes.
 * - `sst diff` builds the site too, to see what it uploads. Values that aren't known until the
 *   deploy, like those of what the same deploy creates on a new stage, are left out of that
 *   build's `environment`. SST 4's `StaticSiteV2` skipped its build in `sst diff` then.
 * - The build gets `SST=1` and `SST_RESOURCE_App` in its environment, as the other sites'
 *   builds do, and not what the CLI is given for its own calls to Cloudflare.
 * - `sst migrate`, and a deploy that previews first, on a stage with checks or with a policy
 *   pack, build the site twice: in the preview, and in the deploy.
 * - `sst refresh` doesn't build the site, where SST 4's `StaticSiteV2` did. Its Worker
 *   stays as it is, and isn't listed while it runs.
 * - `path` and `build` have to be plain values, not outputs: the build reads them. A
 *   `domain` given as an object is a plain value too, as it decides what's created. Its
 *   `name` can be an output, and so can a domain given as a string.
 * - `indexPage` and `errorPage` are gone, and refused: Cloudflare serves the files as they're
 *   named. SST 4's Worker was given them as `INDEX_PAGE` and `ERROR_PAGE`, and served those
 *   files for `/` and for a page that isn't there. Name the home page `index.html`, and the
 *   error page `404.html` with `notFound: "404"`, which serves the nearest one. If you set
 *   either, the switch updates the Worker in place, without those two variables.
 * - With `dev: false`, `sst dev` deploys the site and doesn't also start it with
 *   `npm run dev`, as SST 4's `StaticSiteV2` did. `sst shell --target` gets no
 *   environment from a deployed site.
 * - `trailingSlash` and `notFound` can be outputs.
 *   SST 4's `StaticSiteV2` served an output given for either as the default.
 * - Vite's types are written when the keys of `environment` are known, in `sst diff` too.
 *   SST 4's `StaticSiteV2` waited for every value.
 * - In `sst dev`, reading `nodes.server` says the site runs on your machine, where
 *   SST 4's `StaticSiteV2` gave `undefined`.
 * - SST 4's first, deprecated SST 4's `StaticSite` has the same type, but this isn't
 *   what replaces it: it kept the site's files in a KV namespace, which a switch would
 *   delete. Move it to SST 4's `StaticSiteV2` with SST 4, and deploy, before the
 *   stage moves; otherwise `sst migrate --check` refuses the switch. A
 *   `$transform(sst.cloudflare.StaticSite, ...)` applies to this one too.
 */
export class StaticSite extends component("sst:cloudflare:StaticSite", parts) {
  private readonly siteUrl: Output<string | undefined>;

  constructor(
    name: string,
    args: StaticSiteArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const owner = `the "${name}" static site`;
    const option = (arg: string) => `The "${arg}" of ${owner}`;
    for (const deprecated of ["indexPage", "errorPage"])
      notAnOption(
        args,
        deprecated,
        `Cloudflare serves the site's files: set "notFound" to "404" to serve the nearest "404.html", or to "single-page-application" to serve "index.html".`,
        owner,
      );
    const sitePath = sitePathOf(args.path, owner);
    const dev = plain(args.dev, option("dev"));
    const build = plainDeep(args.build, option("build"), BUILD_READS_IT);
    const domain = checkDomain(args.domain, owner);
    const root = context().paths.root;

    this.siteUrl = workerSite(this.builder(), name, args, {
      owner,
      dev,
      server: {
        accountId: args.accountId,
        // SST's own Worker, which hands each request to the site's files
        handler: path.join(
          context().paths.platform,
          "functions",
          "cf-static-site-router-worker-experimental",
        ),
        environment: args.environment,
        domain,
      },
      assets: {
        htmlHandling: output(args.trailingSlash).apply((slash) =>
          slash === "force"
            ? "force-trailing-slash"
            : slash === "drop"
              ? "drop-trailing-slash"
              : "auto-trailing-slash",
        ),
        notFoundHandling: output(args.notFound).apply((notFound) =>
          notFound === "404" ? "404-page" : "single-page-application",
        ),
      },
      // The environment, once Vite's types for it are written
      devReport: () => ({
        ...siteDev(dev || undefined, sitePath),
        environment: output(
          writeViteTypes(sitePath, undefined, args.environment).then(
            () => args.environment ?? {},
          ),
        ),
      }),
      build: async () => {
        await writeViteTypes(sitePath, undefined, args.environment);
        if (!build) return { assets: sitePath };
        await buildSite({
          name,
          sitePath,
          command: build.command,
          environment: args.environment,
        });
        const outputPath = path.join(sitePath, build.output);
        if (!fs.existsSync(path.resolve(root, outputPath)))
          throw new VisibleError(
            `${capitalized(owner)} has no build output at "${path.resolve(
              root,
              outputPath,
            )}". Set "build.output" to the folder its build writes.`,
          );
        return { assets: outputPath };
      },
    }).url;
  }

  /**
   * The URL of the website.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated worker URL.
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
