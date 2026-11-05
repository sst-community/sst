import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../parts-component";
import type { Prettify } from "../component";
import { context } from "../contract";
import { VisibleError } from "../error";
import { isALtB } from "../../util/compare-semver";
import type { SiteRouteArgs } from "./helpers/router";
import {
  type SiteBuild,
  type SsrFramework,
  type SsrSiteArgs,
  createSsrSite,
  ssrSiteParts,
} from "./helpers/ssr-site";
import type { SitePlan } from "./site-code";
import type { CdnDomainArgs } from "./cdn";
import type { FunctionArgs } from "./function";

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
   * 2. Allow you to access it in your site using the [SDK](/docs/reference/sdk/).
   *
   * @example
   *
   * Takes a list of resources to link to the function.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: FunctionArgs["link"];
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
  environment?: FunctionArgs["environment"];
  /**
   * Permissions and the resources that the [server function](#nodes-server) in your Astro site needs to access. These permissions are used to create the function's IAM role.
   *
   * :::tip
   * If you `link` the function to a resource, the permissions to access it are
   * automatically added.
   * :::
   *
   * @example
   * Allow reading and writing to an S3 bucket called `my-bucket`.
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:GetObject", "s3:PutObject"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     }
   *   ]
   * }
   * ```
   *
   * Perform all actions on an S3 bucket called `my-bucket`.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:*"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     }
   *   ]
   * }
   * ```
   *
   * Grant permissions to access all resources.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["*"],
   *       resources: ["*"]
   *     }
   *   ]
   * }
   * ```
   */
  permissions?: FunctionArgs["permissions"];
  /**
   * The command used internally to build your Astro site.
   *
   * @default The `build` script in your `package.json`: `"npm run build"`, or with `yarn`, `pnpm` or `bun` when its lockfile is in the site's folder or the app's.
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
  /**
   * Set a custom domain for your Astro site.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and Vercel. For other
   * providers, you'll need to pass in a `cert` that validates domain ownership and add the
   * DNS records.
   *
   * :::tip
   * Built-in support for AWS Route 53, Cloudflare, and Vercel. And manual setup for other
   * providers.
   * :::
   *
   * @example
   *
   * By default this assumes the domain is hosted on Route 53.
   *
   * ```js
   * {
   *   domain: "example.com"
   * }
   * ```
   *
   * For domains hosted on Cloudflare.
   *
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   *
   * Specify a `www.` version of the custom domain.
   *
   * ```js
   * {
   *   domain: {
   *     name: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   */
  domain?: string | Prettify<CdnDomainArgs>;
  /**
   * Serve your Astro site through a `Router` instead of a standalone CloudFront
   * distribution.
   *
   * By default, this component creates a new CloudFront distribution. But you might
   * want to serve it through the distribution of your `Router` as a:
   *
   * - A path like `/docs`
   * - A subdomain like `docs.example.com`
   * - Or a combined pattern like `dev.example.com/docs`
   *
   * @example
   *
   * To serve your Astro site **from a path**, you'll need to configure the root domain
   * in your `Router` component.
   *
   * ```ts title="sst.config.ts" {2}
   * const router = new sst.aws.Router("Router", {
   *   domain: "example.com"
   * });
   * ```
   *
   * Now set the `router` and the `path`.
   *
   * ```ts {3,4}
   * {
   *   router: {
   *     instance: router,
   *     path: "/docs"
   *   }
   * }
   * ```
   *
   * You also need to set the
   * [`base`](https://docs.astro.build/en/reference/configuration-reference/#base)
   * in your `astro.config.mjs`.
   *
   * :::caution
   * If routing to a path, you need to set that as the base path in your Astro
   * site as well.
   * :::
   *
   * ```js title="astro.config.mjs" {3}
   * export default defineConfig({
   *   adapter: sst(),
   *   base: "/docs"
   * });
   * ```
   *
   * To serve your Astro site **from a subdomain**, you'll need to configure the
   * domain in your `Router` component to match both the root and the subdomain.
   *
   * ```ts title="sst.config.ts" {3,4}
   * const router = new sst.aws.Router("Router", {
   *   domain: {
   *     name: "example.com",
   *     aliases: ["*.example.com"]
   *   }
   * });
   * ```
   *
   * Now set the `domain` in the `router` prop.
   *
   * ```ts {4}
   * {
   *   router: {
   *     instance: router,
   *     domain: "docs.example.com"
   *   }
   * }
   * ```
   *
   * Finally, to serve your Astro site **from a combined pattern** like
   * `dev.example.com/docs`, you'll need to configure the domain in your `Router` to
   * match the subdomain.
   *
   * ```ts title="sst.config.ts" {3,4}
   * const router = new sst.aws.Router("Router", {
   *   domain: {
   *     name: "example.com",
   *     aliases: ["*.example.com"]
   *   }
   * });
   * ```
   *
   * And set the `domain` and the `path`.
   *
   * ```ts {4,5}
   * {
   *   router: {
   *     instance: router,
   *     domain: "dev.example.com",
   *     path: "/docs"
   *   }
   * }
   * ```
   *
   * Also, make sure to set this as the `base` in your `astro.config.mjs`, like
   * above.
   */
  router?: SiteRouteArgs;
}

/**
 * The `Astro` component lets you deploy an [Astro](https://astro.build) site to AWS.
 *
 * Your Astro config needs the `astro-sst` adapter, which `sst init` adds. To add it
 * yourself, run `npm install astro-sst@npm:@sst-community/astro-sst` and set
 * `adapter: aws()` with `import aws from "astro-sst"` in your `astro.config.mjs`.
 * Version 4 of it supports Astro 5.6 and later, 6 and 7. SST's own `astro-sst` 3.x
 * only supports Astro 5.
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy the Astro site that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.Astro("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the Astro site in the `my-astro-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.Astro("MyWeb", {
 *   path: "my-astro-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Astro site.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.Astro("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.Astro("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
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
 * const bucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.Astro("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your Astro site.
 *
 * ```astro title="src/pages/index.astro"
 * ---
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ---
 * ```
 *
 * #### Switch from SST 4's `sst.aws.Astro`
 *
 * Keep the name, and `sst migrate` moves it. The site's bucket, its
 * server functions, and its CloudFront distribution or its entry in the router are kept.
 * Its files, its entries in the key-value store and its route in the router's list are
 * written again by resources of a new type, which the `sst` binary serves, and `sst
 * migrate` takes the old ones out of the state without deleting what they wrote. Its
 * CloudFront invalidation runs once more. A few things are written differently:
 *
 * - `nodes.server` holds the server of each region, by region, each an output:
 *   `nodes.server["us-east-1"]`. Without `regions`, that's the app's region. A static site
 *   has none, so a server is listed once the build says there is one.
 * - With `warm`, the server is warmed again when its code changes. `sst.aws.Astro` warmed
 *   it on every deploy. The switch warms it once.
 */
export class Astro extends component("sst:aws:Astro", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: AstroArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = createSsrSite(this.builder(), name, args, astro).url;
  }

  /**
   * The URL of the Astro site.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated CloudFront URL.
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

// What the "astro-sst" adapter says about the build, in
// `dist/sst.buildMeta.json`
interface BuildMeta {
  base: string;
  pluginVersion: string;
  outputMode: "server" | "static";
  responseMode: "stream" | "buffer";
  clientBuildOutputDir: string;
  clientBuildVersionedSubDir: string;
  routes?: { route: string; prerender?: boolean }[];
}

// How an Astro site is built, with its package manager and the "astro-sst"
// adapter, and what its server is
const astro: SsrFramework = {
  label: "Astro",
  // A static site has no server
  alwaysServes: false,
  beforeBuild: (sitePath) =>
    checkAdapter(path.resolve(context().paths.root, sitePath)),
  load: loadBuild,
};

// Reads what the adapter built
function loadBuild(builtPath: string): SiteBuild {
  const outputPath = path.resolve(context().paths.root, builtPath);
  const metaPath = path.join(outputPath, "dist", "sst.buildMeta.json");
  if (!fs.existsSync(metaPath))
    throw new VisibleError(
      `Build metadata file not found at "${metaPath}". Update your "astro-sst" adapter and rebuild your Astro site.`,
    );
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as BuildMeta;
  if (meta.pluginVersion === undefined || isALtB(meta.pluginVersion, "3.1.2"))
    throw new VisibleError(
      `Incompatible "astro-sst" adapter version detected. The Astro component requires "astro-sst" adapter version 3.1.2 or later.`,
    );

  // How a request for a page that isn't there, like /garbage, gets a 404:
  //
  // - A static site has no server. The router's lookup in S3 fails, and it
  //   serves /404.html, the plan's `custom404`.
  // - A site with a server sends the request on to it. When the 404 page is
  //   prerendered, the server can't render /404 either, so it serves the
  //   404.html file bundled into it, from `copyFiles`.
  //
  // CloudFront's custom error responses can't do it: behind a `Router`, they'd
  // apply to every route, not just the site's.
  const isStatic = meta.outputMode === "static";
  // The server's files, from the site's folder as it was given
  const serverPath = path.join(builtPath, "dist", "server");
  const notFound = path.join(outputPath, "dist", "server", "404.html");
  const plan: SitePlan = {
    base: meta.base === "/" ? undefined : meta.base,
    assets: [
      {
        from: meta.clientBuildOutputDir,
        to: "",
        cached: true,
        versionedSubDir: meta.clientBuildVersionedSubDir,
      },
    ],
    custom404:
      isStatic &&
      fs.existsSync(
        path.join(outputPath, meta.clientBuildOutputDir, "404.html"),
      )
        ? "/404.html"
        : undefined,
    // With a server, prerendered routes can't shadow server routes in the same
    // folder, like /api/list.json and /api/[id]
    ...(isStatic
      ? {}
      : {
          hasStaticRoutes: true,
          // Route patterns don't include the base path
          prerenderedDirs: (meta.routes ?? [])
            .filter((r) => r.prerender)
            .map((r) => r.route.replace(/^\/+/, "").split("/")[0])
            .filter(Boolean),
        }),
  };

  return {
    sitePath: builtPath,
    outputPath,
    plan,
    serves: !isStatic,
    server: isStatic
      ? undefined
      : {
          handler: path.join(serverPath, "entry.handler"),
          nodejs: { install: ["sharp"] },
          streaming: meta.responseMode === "stream",
          // A file to copy is found from the app's folder. For a site's
          // folder given from there, this is the path SST 4 gave.
          copyFiles: fs.existsSync(notFound)
            ? [
                {
                  from: path.relative(context().paths.root, notFound),
                  to: "404.html",
                },
              ]
            : [],
        },
  };
}

/**
 * SST's own "astro-sst" adapter, 2.x and 3.x, imports applyPolyfills, which
 * Astro 6 removed, so building an Astro 6 or 7 app with it fails with a
 * "Missing export" error that doesn't say what to do. Say it before the build.
 * A later version of SST's adapter, which may support Astro 6, isn't stopped.
 */
function checkAdapter(sitePath: string) {
  const read = (file: string) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return undefined;
    }
  };
  // Only when the app lists "astro-sst" itself: in a monorepo, another
  // package's copy could be the one that resolves.
  const appPackageJson = path.resolve(sitePath, "package.json");
  const app = read(appPackageJson);
  if (!app?.dependencies?.["astro-sst"] && !app?.devDependencies?.["astro-sst"])
    return;
  const require = createRequire(appPackageJson);
  const resolve = (pkg: string) => {
    try {
      return read(require.resolve(`${pkg}/package.json`));
    } catch {
      return undefined;
    }
  };
  // Under the alias "astro-sst", the sst-community adapter's package.json
  // still has its own name.
  const adapter = resolve("astro-sst");
  const astro = resolve("astro");
  if (adapter?.name !== "astro-sst" || !astro?.version) return;
  if (parseInt(adapter.version) >= 4 || parseInt(astro.version) < 6) return;
  throw new VisibleError(
    [
      `This app uses Astro ${astro.version} with SST's "astro-sst" adapter ${adapter.version}, which doesn't support Astro 6 or later, so the build would fail.`,
      ``,
      `Switch to the sst-community adapter, which supports Astro 6 and 7. Change the "astro-sst" line in package.json to`,
      ``,
      `  "astro-sst": "npm:@sst-community/astro-sst@^4.0.0"`,
      ``,
      `and reinstall. astro.config.mjs can keep importing "astro-sst".`,
    ].join("\n"),
  );
}
