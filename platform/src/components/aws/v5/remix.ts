import fs from "fs";
import path from "path";
import { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../../parts-component";
import type { Prettify } from "../../component";
import { context } from "../../contract";
import { plain } from "../../args";
import { configText, configValue } from "../helpers/site-build";
import type { SiteRouteArgs } from "../helpers/router";
import { BUILD_READS_IT } from "../helpers/site";
import {
  type SiteBuild,
  type SsrFramework,
  type SsrSiteArgs,
  createSsrSite,
  ssrSiteParts,
} from "../helpers/ssr-site";
import type { CdnDomainArgs } from "./cdn";
import type { FunctionArgs } from "./function";

const parts = ssrSiteParts;

export interface RemixArgs extends SsrSiteArgs, ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your Remix app is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your Remix app, this starts it in dev mode. It's run
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
   * Path to the directory where your Remix app is located.  This path is relative to your `sst.config.ts`.
   *
   * By default it assumes your Remix app is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your Remix app is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * [Link resources](/docs/linking/) to your Remix app. This will:
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
   * Set [environment variables](https://remix.run/docs/en/main/guides/envvars) in your Remix app. These are made available:
   *
   * 1. In `remix build`, they are loaded into `process.env`.
   * 2. Locally while running through `sst dev`.
   *
   * :::tip
   * You can also `link` resources to your Remix app and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
   * :::
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
  environment?: FunctionArgs["environment"];
  /**
   * Permissions and the resources that the [server function](#nodes-server) in your Remix app needs to access. These permissions are used to create the function's IAM role.
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
   *     },
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
   *     },
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
   *     },
   *   ]
   * }
   * ```
   */
  permissions?: FunctionArgs["permissions"];
  /**
   * The command used internally to build your Remix app.
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
   * Set a custom domain for your Remix app.
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
   * Serve your Remix app through a `Router` instead of a standalone CloudFront
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
   * To serve your Remix app **from a path**, you'll need to configure the root domain
   * in your `Router` component.
   *
   * ```ts title="sst.config.ts" {2}
   * const router = new sst.aws.v5.Router("Router", {
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
   * You also need to set the `base` in your `vite.config.ts`.
   *
   * :::caution
   * If routing to a path, you need to set that as the base path in your Remix
   * app as well.
   * :::
   *
   * ```js title="vite.config.ts" {3}
   * export default defineConfig({
   *   plugins: [...],
   *   base: "/docs"
   * });
   * ```
   *
   * To serve your Remix app **from a subdomain**, you'll need to configure the
   * domain in your `Router` component to match both the root and the subdomain.
   *
   * ```ts title="sst.config.ts" {3,4}
   * const router = new sst.aws.v5.Router("Router", {
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
   * Finally, to serve your Remix app **from a combined pattern** like
   * `dev.example.com/docs`, you'll need to configure the domain in your `Router` to
   * match the subdomain.
   *
   * ```ts title="sst.config.ts" {3,4}
   * const router = new sst.aws.v5.Router("Router", {
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
   * Also, make sure to set this as the `base` in your `vite.config.ts`, like
   * above.
   */
  router?: SiteRouteArgs;
  /**
   * The directory where the build output is located. This should match the value of
   * `buildDirectory` in the Remix plugin section of your Vite config.
   *
   * @default `"build"`
   */
  buildDirectory?: string;
}

/**
 * The `Remix` component lets you deploy a [Remix](https://remix.run) app to AWS.
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy a Remix app that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.Remix("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the Remix app in the `my-remix-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.Remix("MyWeb", {
 *   path: "my-remix-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Remix app.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.Remix("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.v5.Remix("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your Remix app. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {4} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.Remix("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your Remix app.
 *
 * ```ts title="app/root.tsx"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Switch from `sst.aws.Remix`
 *
 * Change `sst.aws.Remix` to `sst.aws.v5.Remix` and keep the name. The site's bucket, its
 * server functions, and its CloudFront distribution or its entry in the router are kept.
 * Its files, its entries in the key-value store and its route in the router's list are
 * written again by resources of a new type, which the `sst` binary serves, and `sst
 * migrate` takes the old ones out of the state without deleting what they wrote. Its
 * CloudFront invalidation runs once more. A few things are written differently:
 *
 * - `nodes.server` holds the server of each region, by region, each an output:
 *   `nodes.server["us-east-1"]`. Without `regions`, that's the app's region. When the site
 *   is given an AWS provider of its own, the server is listed once it's created; set
 *   `regions` to have it from the start.
 * - With `warm`, the server is warmed again when its code changes. `sst.aws.Remix` warmed
 *   it on every deploy. The switch warms it once.
 * - `buildDirectory` has to be a plain value, not an output: what's deployed is read from
 *   it.
 * - The base path is read from the Vite config in any of its extensions, like
 *   `vite.config.js`, and it's what's in the quotes after `base`. `sst.aws.Remix` read only
 *   `vite.config.ts`, and failed without it, and read on to the last quote of the line.
 * - The Vite config isn't loaded to check it. `sst.aws.Remix` loaded it with Vite after the
 *   build, and failed when that Vite wasn't found from the app.
 */
export class Remix extends component("sst:aws:Remix", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: RemixArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = createSsrSite(
      this.builder(),
      name,
      args,
      remixFramework(args),
    ).url;
  }

  /**
   * The URL of the Remix app.
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

// How a Remix app is built, with its package manager, and its server: the
// Remix server build wrapped in a Lambda handler
function remixFramework(args: RemixArgs): SsrFramework<SiteBuild> {
  let buildDirectory: string | undefined;
  return {
    label: "Remix",
    alwaysServes: true,
    check(option) {
      buildDirectory = plain(
        args.buildDirectory,
        option("buildDirectory"),
        BUILD_READS_IT,
      );
    },
    load: (builtPath) => loadBuild(builtPath, buildDirectory ?? "build"),
  };
}

// Reads what Remix built, with Vite or with Remix's own compiler
function loadBuild(builtPath: string, buildDirectory: string): SiteBuild {
  const outputPath = path.resolve(context().paths.root, builtPath);
  const viteConfig = configText(outputPath, "vite.config");
  // With Vite, the server build is `<buildDirectory>/server/index.js` and the
  // client's files are in `<buildDirectory>/client`. Remix's own compiler
  // builds the server to `build/index.js`, and the client's files are in
  // `public`.
  const serverDir = viteConfig !== undefined ? buildDirectory : "build";
  const buildPath = path.join(outputPath, serverDir);
  const handlerPath = path.join(builtPath, serverDir);

  // Wrap the server build in the Lambda handler, with the polyfills first.
  // ESBuild's `inject` puts them above the code that depends on them, which
  // an import at the top of the handler doesn't guarantee.
  const platform = path.join(
    context().paths.platform,
    "functions",
    "remix-server",
  );
  fs.mkdirSync(buildPath, { recursive: true });
  fs.writeFileSync(
    path.join(buildPath, "server.mjs"),
    [
      `// Import the server build that was produced by 'remix build'`,
      viteConfig !== undefined
        ? `import * as remixServerBuild from "./server/index.js";`
        : `import * as remixServerBuild from "./index.js";`,
      ``,
      fs.readFileSync(path.join(platform, "regional-server.mjs")),
    ].join("\n"),
  );
  const polyfill = path.join(buildPath, "polyfill.mjs");
  fs.copyFileSync(path.join(platform, "polyfill.mjs"), polyfill);

  return {
    sitePath: builtPath,
    outputPath,
    serves: true,
    plan: {
      // From `base` in the Vite config
      base: configValue(outputPath, "vite.config", "base"),
      assets: [
        viteConfig !== undefined
          ? {
              from: path.join(buildDirectory, "client"),
              to: "",
              cached: true,
              versionedSubDir: "assets",
            }
          : { from: "public", to: "", cached: true, versionedSubDir: "build" },
      ],
    },
    server: {
      handler: path.join(handlerPath, "server.handler"),
      nodejs: { esbuild: { inject: [polyfill] } },
      streaming: true,
    },
  };
}
