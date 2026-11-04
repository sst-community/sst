import { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../../parts-component";
import type { Prettify } from "../../component";
import { nitroSite } from "../helpers/nitro";
import { configValue } from "../helpers/site-build";
import type { SiteRouteArgs } from "../helpers/router";
import {
  type SsrFramework,
  type SsrSiteArgs,
  createSsrSite,
  ssrSiteParts,
} from "../helpers/ssr-site";
import type { CdnDomainArgs } from "./cdn";
import type { FunctionArgs } from "./function";

const parts = ssrSiteParts;

export interface SolidStartArgs
  extends SsrSiteArgs,
    ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your SolidStart app is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your SolidStart app, this starts it in dev mode. It's run
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
   * Path to the directory where your SolidStart app is located.  This path is relative to your `sst.config.ts`.
   *
   * By default it assumes your SolidStart app is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your SolidStart app is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * [Link resources](/docs/linking/) to your SolidStart app. This will:
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
   * Set in your SolidStart app. These are made available:
   *
   * 1. In `vinxi build`, they are loaded into `process.env`.
   * 2. Locally while running through `sst dev`.
   *
   * :::tip
   * You can also `link` resources to your SolidStart app and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
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
   * Permissions and the resources that the [server function](#nodes-server) in your SolidStart app needs to access. These permissions are used to create the function's IAM role.
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
   * The command used internally to build your SolidStart app.
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
   * Set a custom domain for your SolidStart app.
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
   * Serve your SolidStart app through a `Router` instead of a standalone CloudFront
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
   * To serve your SolidStart app **from a path**, you'll need to configure the root domain
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
   * You also need to set the `baseURL` property in your `app.config.ts` without a
   * trailing slash.
   *
   * :::caution
   * If routing to a path, you need to set that as the base path in your
   * SolidStart app as well.
   * :::
   *
   * ```js title="app.config.ts" {3}
   * export default defineConfig({
   *   server: { preset: "aws-lambda" },
   *   baseURL: "/docs"
   * });
   * ```
   *
   * To serve your SolidStart app **from a subdomain**, you'll need to configure the
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
   * Finally, to serve your SolidStart app **from a combined pattern** like
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
   * Also, make sure to set the baseURL in your `app.config.ts`, like above.
   */
  router?: SiteRouteArgs;
}

/**
 * The `SolidStart` component lets you deploy a [SolidStart](https://start.solidjs.com) app to AWS.
 *
 * :::note
 * Your SolidStart app has to be built with Nitro's `aws-lambda` preset: set `server.preset`
 * to `"aws-lambda"` in your `app.config.ts`.
 * :::
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy a SolidStart app that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.SolidStart("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the SolidStart app in the `my-solid-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.SolidStart("MyWeb", {
 *   path: "my-solid-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your SolidStart app.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.SolidStart("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.v5.SolidStart("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your SolidStart app. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {4} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.SolidStart("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your SolidStart app.
 *
 * ```ts title="src/app.tsx"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Switch from `sst.aws.SolidStart`
 *
 * Change `sst.aws.SolidStart` to `sst.aws.v5.SolidStart` and keep the name. The site's
 * bucket, its server functions, and its CloudFront distribution or its entry in the router
 * are kept. Its files and its entries in the key-value store are written again by resources
 * of a new type, which the `sst` binary serves, and `sst migrate` takes the old ones out of
 * the state without deleting what they wrote. A few things are written differently:
 *
 * - The site is built in the deploy itself, once, with the values of what it's linked to.
 *   `sst.aws.SolidStart` built it with a command it kept in the state, which goes.
 * - `sst diff` builds the site too, to show what the build creates. Values that aren't
 *   known until the deploy, like those of what the same deploy creates on a new stage, are
 *   left out of that build, and a link none of whose properties are known is passed with
 *   only its `type`. A build that checks its environment, or reads a link while it
 *   prerenders, has to allow for that. `sst.aws.SolidStart` skipped its build in `sst diff`
 *   then.
 * - `sst migrate`, and a deploy that previews first, on a stage with checks or with a
 *   policy pack, build the site twice: in the preview, and in the deploy.
 * - `sst refresh` doesn't build the site, where `sst.aws.SolidStart` did. What's made from
 *   the build, like the servers in `nodes.server`, stays as it is, and isn't listed while
 *   it runs.
 * - `regions`, `warm`, `protection`, `edge`, `router`, `invalidation` and `server` have to
 *   be plain values, not outputs: they decide what's created. So do `path` and
 *   `buildCommand`, which the build reads, and the `name`, `aliases` and `redirects` of
 *   `domain`.
 * - `route` and `cdn` are gone. Serve the site through a Router with `router`.
 * - `router` takes `instance`, `path` and `domain`. `rewrite`, `readTimeout`,
 *   `keepAliveTimeout`, `connectionTimeout` and `connectionAttempts` in it are refused:
 *   `sst.aws.SolidStart` ignored them.
 * - `nodes.server` holds the server of each region, by region, each an output:
 *   `nodes.server["us-east-1"]`. Without `regions`, that's the app's region. When the site
 *   is given an AWS provider of its own, the server is listed once it's created; set
 *   `regions` to have it from the start.
 * - In `sst dev`, the function the site runs as is `transform.devServer`, not
 *   `transform.server`. Reading what isn't created there in `nodes`, like `nodes.server`,
 *   says the site runs on your machine, where `sst.aws.SolidStart` gave `undefined`.
 * - `assets.textEncoding` sets the charset of text files. `sst.aws.SolidStart` ignored it
 *   and wrote `UTF-8`.
 * - With `warm`, the server is warmed again when its code changes. `sst.aws.SolidStart`
 *   warmed it on every deploy. The switch warms it once.
 * - With `warm`, the warmer's function, rule, target and permission move into the site.
 * - The base path is read from `app.config` with any extension, like `.js` or `.mjs`, and
 *   it's what's in the quotes after `baseURL`. `sst.aws.SolidStart` read only
 *   `app.config.ts`, and failed without it, and read on to the last quote of the line.
 */
export class SolidStart extends component("sst:aws:SolidStart", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: SolidStartArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = createSsrSite(this.builder(), name, args, solidStart).url;
  }

  /**
   * The URL of the SolidStart app.
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

// How a SolidStart app is built, with its package manager and Nitro's
// "aws-lambda" preset, and what its server is
const solidStart: SsrFramework = {
  label: "SolidStart",
  alwaysServes: true,
  // Nitro's client files aren't in a versioned folder
  versionedFiles: false,
  load: (builtPath) =>
    nitroSite(builtPath, {
      framework: "SolidStart",
      howToSet: [
        "Set it in your `app.config.ts`:",
        "  // app.config.ts",
        "  export default defineConfig({",
        "    server: {",
        '      preset: "aws-lambda",',
        "      awsLambda: { streaming: true }, // optional",
        "    },",
        "  });",
      ],
      description: "Server handler for Solid",
      // From `baseURL` in the app's config
      base: (outputPath) => configValue(outputPath, "app.config", "baseURL"),
      // Requests to `_server` go to the server
      serverPaths: ["_server"],
      hasStaticRoutes: true,
    }),
};
