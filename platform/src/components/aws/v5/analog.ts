import fs from "fs";
import path from "path";
import { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../../parts-component";
import type { Prettify } from "../../component";
import { context } from "../../contract";
import { readNitro } from "../helpers/nitro";
import { configText } from "../helpers/site-build";
import type { RouteArgs } from "../helpers/router";
import {
  type ServerPlan,
  type SiteBuild,
  type SsrFramework,
  type SsrSiteArgs,
  createSsrSite,
  ssrSiteParts,
} from "../helpers/ssr-site";
import type { CdnDomainArgs } from "./cdn";
import type { FunctionArgs } from "./function";

const parts = ssrSiteParts;

export interface AnalogArgs extends SsrSiteArgs, ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your Analog app is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your Analog app, this starts it in dev mode. It's run
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
   * Path to the directory where your Analog app is located.  This path is relative to your `sst.config.ts`.
   *
   * By default it assumes your Analog app is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your Analog app is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * [Link resources](/docs/linking/) to your Analog app. This will:
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
   * Set [environment variables](https://analogjs.org/docs/guides/migrating#using-environment-variables) in your Analog app. These are made available:
   *
   * 1. In `ng build`, they are loaded into `process.env`.
   * 2. Locally while running `sst dev ng serve`.
   *
   * :::tip
   * You can also `link` resources to your Analog app and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
   * :::
   *
   * Only variables prefixed with `VITE_` are available in the browser.
   *
   * @example
   * ```js
   * {
   *   environment: {
   *     API_URL: api.url,
   *     // Accessible in the browser
   *     VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   */
  environment?: FunctionArgs["environment"];
  /**
   * Permissions and the resources that the [server function](#nodes-server) in your Analog app needs to access. These permissions are used to create the function's IAM role.
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
   * The command used internally to build your Analog app.
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
   * Set a custom domain for your Analog app.
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
   * Serve your Analog app through a `Router` instead of a standalone CloudFront
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
   * To serve your Analog app **from a path**, you'll need to configure the root domain
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
   * You also need to set the `base` and `apiPrefix` options in your `vite.config.ts`.
   * The `apiPrefix` value should not begin with a slash.
   *
   * :::caution
   * If routing to a path, you need to set that as the base path in your Analog
   * app as well.
   * :::
   *
   * ```js title="vite.config.ts" {5,8}
   * export default defineConfig(({ mode }) => ({
   *   plugins: [
   *     analog({
   *       // Does NOT start with a slash
   *       apiPrefix: "docs/api"
   *     })
   *   ],
   *   base: "/docs"
   * }));
   * ```
   *
   * To serve your Analog app **from a subdomain**, you'll need to configure the
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
   * Finally, to serve your Analog app **from a combined pattern** like
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
   * Also, make sure to set the base path and API prefix in your `vite.config.ts`,
   * like above.
   */
  router?: RouteArgs;
}

/**
 * The `Analog` component lets you deploy a [Analog](https://analogjs.org) app to AWS.
 *
 * :::note
 * Your Analog app has to be built with Nitro's `aws-lambda` preset: set `nitro.preset` in
 * the `analog()` plugin's options to `"aws-lambda"` in your `vite.config.ts`.
 * :::
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy an Analog app that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.Analog("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the Analog app in the `my-analog-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.Analog("MyWeb", {
 *   path: "my-analog-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Analog app.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.Analog("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.v5.Analog("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your Analog app. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {4} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.Analog("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your Analog app.
 *
 * ```ts title="src/app/app.config.ts"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Switch from `sst.aws.Analog`
 *
 * Change `sst.aws.Analog` to `sst.aws.v5.Analog` and keep the name. The site's bucket, its
 * server functions, and its CloudFront distribution or its entry in the router are kept.
 * Its files and its entries in the key-value store are written again by resources of a new
 * type, which the `sst` binary serves, and `sst migrate` takes the old ones out of the
 * state without deleting what they wrote. A few things are written differently:
 *
 * - The site is built in the deploy itself, once, with the values of what it's linked to.
 *   `sst.aws.Analog` built it with a command it kept in the state, which goes.
 * - `sst diff` builds the site too, to show what the build creates. Values that aren't
 *   known until the deploy, like those of what the same deploy creates on a new stage, are
 *   left out of that build, and a link none of whose properties are known is passed with
 *   only its `type`. A build that checks its environment, or reads a link while it
 *   prerenders, has to allow for that. `sst.aws.Analog` skipped its build in `sst diff`
 *   then.
 * - `sst migrate`, and a deploy that previews first, on a stage with checks or with a
 *   policy pack, build the site twice: in the preview, and in the deploy.
 * - `sst refresh` doesn't build the site, where `sst.aws.Analog` did. What's made from the
 *   build, like the servers in `nodes.server`, stays as it is, and isn't listed while it
 *   runs.
 * - `regions`, `warm`, `protection`, `edge`, `router`, `invalidation` and `server` have to
 *   be plain values, not outputs: they decide what's created. So do `path` and
 *   `buildCommand`, which the build reads, and the `name`, `aliases` and `redirects` of
 *   `domain`.
 * - `route` and `cdn` are gone. Serve the site through a Router with `router`.
 * - `nodes.server` holds the server of each region, by region, each an output:
 *   `nodes.server["us-east-1"]`. Without `regions`, that's the app's region. When the site
 *   is given an AWS provider of its own, the server is listed once it's created; set
 *   `regions` to have it from the start. In `sst dev`, the function the site runs as is
 *   `transform.devServer`, not `transform.server`.
 * - `assets.textEncoding` sets the charset of text files. `sst.aws.Analog` ignored it and
 *   wrote `UTF-8`.
 * - With `warm`, the server is warmed again when its code changes. `sst.aws.Analog` warmed
 *   it on every deploy. The switch warms it once.
 * - With `warm`, the warmer's function, rule, target and permission move into the site.
 * - With `awsLambda: { streaming: true }` in Nitro's config, the server's URL streams its
 *   responses. `sst.aws.Analog` ignored it and buffered them.
 * - The base path is read from `vite.config` with any extension, like `.js` or `.mts`.
 *   `sst.aws.Analog` read only `vite.config.ts`, and failed without it.
 */
export class Analog extends component("sst:aws:Analog", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: AnalogArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = createSsrSite(this.builder(), name, args, analog).url;
  }

  /**
   * The URL of the Analog app.
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

// An Analog app's build, and its server
interface AnalogBuild extends SiteBuild {
  server: ServerPlan;
}

// How an Analog app is built, with its package manager and Nitro's
// "aws-lambda" preset, and what its server is
const analog: SsrFramework<AnalogBuild> = {
  label: "Analog",
  alwaysServes: true,
  // Nitro's client files aren't in a versioned folder
  versionedFiles: false,
  load: loadBuild,
  server: (build) => build.server,
};

// Reads what Nitro built
function loadBuild(builtPath: string): AnalogBuild {
  const outputPath = path.resolve(context().paths.root, builtPath);
  const output = path.join("dist", "analog");
  const nitro = readNitro(path.join(outputPath, output), "Analog", [
    "Set it in your `vite.config.ts`:",
    "  // vite.config.ts",
    "  export default defineConfig({",
    "    plugins: [",
    "      analog({",
    "        nitro: {",
    '          preset: "aws-lambda",',
    "          awsLambda: { streaming: true }, // optional",
    "        },",
    "      }),",
    "    ],",
    "  });",
  ]);

  return {
    sitePath: builtPath,
    outputPath,
    serves: true,
    plan: {
      // From `base` in the Vite config
      base: configText(outputPath, "vite.config")?.match(
        /base: ['"](.*)['"]/,
      )?.[1],
      assets: [
        {
          from: path.join(output, "public"),
          to: "",
          cached: true,
        },
      ],
    },
    server: {
      description: "Server handler for Analog",
      handler: "index.handler",
      bundle: path.join(builtPath, output, "server"),
      streaming: nitro.streaming,
    },
  };
}
