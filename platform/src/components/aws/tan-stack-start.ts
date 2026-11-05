import fs from "fs";
import path from "path";
import { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../parts-component";
import type { Prettify } from "../component";
import { nitroSite } from "./helpers/nitro";
import { configText } from "./helpers/site-build";
import type { SiteRouteArgs } from "./helpers/router";
import {
  type SsrFramework,
  type SsrSiteArgs,
  createSsrSite,
  ssrSiteParts,
} from "./helpers/ssr-site";
import type { CdnDomainArgs } from "./cdn";
import type { FunctionArgs } from "./function";

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
   * Path to the directory where your TanStack Start app is located.  This path is relative to your `sst.config.ts`.
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
   * Set environment variables in your TanStack Start app. These are made available:
   *
   * 1. In `vite build`, they are loaded into `process.env`.
   * 2. Locally while running `sst dev`.
   *
   * Commands started by the build command inherit these variables. A standalone
   * `vite preview` command runs outside SST; use
   * `sst shell --target MyWeb -- vite preview` to expose them to the preview
   * process. Client values in `import.meta.env` remain the values embedded by
   * the build.
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
   *     STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   */
  environment?: FunctionArgs["environment"];
  /**
   * Permissions and the resources that the [server function](#nodes-server) in your TanStack Start app needs to access. These permissions are used to create the function's IAM role.
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
   * The command used internally to build your TanStack Start app.
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
   * Set a custom domain for your TanStack Start app.
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
   * Serve your TanStack Start app through a `Router` instead of a standalone CloudFront
   * distribution.
   *
   * By default, this component creates a new CloudFront distribution. But you might
   * want to serve it through the distribution of your `Router`.
   *
   * To serve your TanStack Start app **from a subdomain**, you'll need to
   * configure the domain in your `Router` component to match both the root and the
   * subdomain.
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
   * To serve your TanStack Start app **from a path**, like `/docs` or
   * `dev.example.com/docs`, set the `path` too.
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
   * Also set it as the `base` in your `vite.config.ts`, and as the `basepath` of your
   * TanStack router. The site reads the base path from the router's `basepath` in the
   * build, and fails the deploy when it's missing or doesn't start with the `path`.
   */
  router?: SiteRouteArgs;
}

/**
 * The `TanStackStart` component lets you deploy a [TanStack Start](https://tanstack.com/start/latest) app to AWS.
 *
 * :::note
 * You need to make sure the `vite.config.ts` is configured with the `aws-lambda` nitro preset.
 * :::
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy a TanStack Start app that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.TanStackStart("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the TanStack Start app in the `my-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.TanStackStart("MyWeb", {
 *   path: "my-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your TanStack Start app.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.TanStackStart("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.TanStackStart("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
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
 * const bucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.TanStackStart("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your TanStack Start app.
 *
 * ```ts title="src/app.tsx"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Switch from SST 4's `sst.aws.TanStackStart`
 *
 * Keep the name, and `sst migrate` moves it. The
 * site's bucket, its server functions, and its CloudFront distribution or its entry in the
 * router are kept. Its files, its entries in the key-value store and its route in the
 * router's list are written again by resources of a new type, which the `sst` binary
 * serves, and `sst migrate` takes the old ones out of the state without deleting what they
 * wrote. Its CloudFront invalidation runs once more. A few things are written differently:
 *
 * - `nodes.server` holds the server of each region, by region, each an output:
 *   `nodes.server["us-east-1"]`. Without `regions`, that's the app's region. When the site
 *   is given an AWS provider of its own, the server is listed once it's created; set
 *   `regions` to have it from the start.
 * - With `warm`, the server is warmed again when its code changes. SST 4's `TanStackStart`
 *   warmed it on every deploy. The switch warms it once.
 * - The base path is read from the server's code where TanStack Start's builds with Nitro 3
 *   put it, `.output/server/_ssr/ssr.mjs`, as well as where earlier ones did.
 *   SST 4's `TanStackStart` read only the earlier place, so a site under a router's `path`
 *   failed to deploy with a current TanStack Start.
 * - A build whose Nitro preset isn't found is refused with where to set it for the site's
 *   own setup: `vite.config.ts` in the site's folder, or `app.config.ts`.
 *   SST 4's `TanStackStart` looked for `vite.config.ts` in the folder above the site's.
 */
export class TanStackStart extends component("sst:aws:TanstackStart", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: TanStackStartArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = createSsrSite(this.builder(), name, args, tanStackStart).url;
  }

  /**
   * The URL of the TanStack Start app.
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

// How a TanStack Start app is built, with its package manager and Nitro's
// "aws-lambda" preset, and what its server is
const tanStackStart: SsrFramework = {
  label: "TanStackStart",
  alwaysServes: true,
  // Nitro's client files aren't in a versioned folder
  versionedFiles: false,
  load(builtPath) {
    const build = nitroSite(builtPath, {
      framework: "TanStack Start",
      howToSet: howToSetPreset,
      description: "Server handler for TanStack",
      base: baseOf,
      // Requests to `_server` and `api` go to the server
      serverPaths: ["_server", "api"],
    });
    // The server's folder on this machine, as SST 4 gave it, so the server
    // is built from the same args
    return {
      ...build,
      server: {
        ...build.server!,
        bundle: path.join(build.outputPath, ".output", "server"),
      },
    };
  },
};

// The server's code sets the router's base path, `ROUTER_BASEPATH =
// "/docs"`: in `_ssr/ssr.mjs`, or before Nitro 3 in `chunks/_/server.mjs`
function baseOf(outputPath: string) {
  const serverPath = path.join(outputPath, ".output", "server");
  for (const file of [
    path.join("chunks", "_", "server.mjs"),
    path.join("_ssr", "ssr.mjs"),
  ]) {
    try {
      const base = fs
        .readFileSync(path.join(serverPath, file), "utf-8")
        .match(/ROUTER_BASEPATH = "(.*)"/)?.[1];
      if (base !== undefined) return base;
    } catch (e) {}
  }
}

// Where the "aws-lambda" preset is set: in `vite.config.ts`, or with Vinxi,
// in `app.config.ts`
function howToSetPreset(outputPath: string) {
  const isVite = configText(outputPath, "vite.config") !== undefined;
  return isVite
    ? [
        "Add the nitro preset to your `vite.config.ts`:",
        "  // vite.config.ts",
        '  import { nitro } from "nitro/vite"',
        "",
        "  export default defineConfig({",
        "    plugins: [nitro(), tanstackStart(), ...],",
        "    nitro: {",
        '      preset: "aws-lambda",',
        "      awsLambda: { streaming: true }, // optional",
        "    },",
        "  });",
      ]
    : [
        "Update your `app.config.ts`:",
        "  // app.config.ts",
        "  export default defineConfig({",
        "    server: {",
        '      preset: "aws-lambda",',
        "      awsLambda: { streaming: true }, // optional",
        "    },",
        "  });",
      ];
}
