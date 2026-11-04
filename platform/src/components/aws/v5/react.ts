import fs from "fs";
import path from "path";
import { ComponentResourceOptions, Input, Output } from "@pulumi/pulumi";
import { type ComponentArgs, component } from "../../parts-component";
import type { Prettify } from "../../component";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import { configValue } from "../helpers/site-build";
import type { SiteRouteArgs } from "../helpers/router";
import { capitalized } from "../helpers/site";
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

export interface ReactArgs extends SsrSiteArgs, ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your React app is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your React app, this starts it in dev mode. It's run
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
   * Path to the directory where your React app is located.  This path is relative to your `sst.config.ts`.
   *
   * By default it assumes your React app is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your React app is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * [Link resources](/docs/linking/) to your React app. This will:
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
   * Set [environment variables](https://vitejs.dev/guide/env-and-mode) in your React app. These are made available:
   *
   * 1. In `react-router build`, they are loaded into `process.env`.
   * 2. Locally while running `react-router dev` through `sst dev`.
   *
   * Commands started by the build command inherit these variables. A standalone
   * `vite preview` command runs outside SST; use
   * `sst shell --target MyWeb -- vite preview` to expose them to the preview
   * process. Client values in `import.meta.env` remain the values embedded by
   * the build.
   *
   * :::tip
   * You can also `link` resources to your React app and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
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
   * Permissions and the resources that the [server function](#nodes-server) in your React app needs to access. These permissions are used to create the function's IAM role.
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
   * The command used internally to build your React app.
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
   * Set a custom domain for your React app.
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
   * Serve your React app through a `Router` instead of a standalone CloudFront
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
   * To serve your React app **from a path**, you'll need to configure the root domain
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
   * You also need to set the `base` property in your `vite.config.ts`.
   *
   * :::caution
   * If routing to a path, you need to set that as the base path in your
   * `vite.config.ts` and `react-router.config.ts` as well.
   * :::
   *
   * ```js title="vite.config.ts" {3}
   * export default defineConfig({
   *   plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
   *   base: "/docs/"
   * });
   * ```
   *
   * And the `basename` in your React Router configuration.
   *
   * ```jsx title="react-router.config.ts" {2}
   * export const routerConfig = {
   *   basename: "/docs"
   * };
   * ```
   *
   * To serve your React app **from a subdomain**, you'll need to configure the
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
   * Finally, to serve your React app **from a combined pattern** like
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
   * Also, make sure to set the base path in your `vite.config.ts` and `basename`
   * in your `react-router.config.ts`, like above.
   */
  router?: SiteRouteArgs;
}

/**
 * The `React` component lets you deploy a React app built with [React Router](https://reactrouter.com/) to AWS.
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy a React app that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.React("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the React app in the `my-react-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.React("MyWeb", {
 *   path: "my-react-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your React app.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.React("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.v5.React("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your React app. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {4} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.React("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your React app.
 *
 * ```ts title="app/root.tsx"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Switch from `sst.aws.React`
 *
 * Change `sst.aws.React` to `sst.aws.v5.React` and keep the name. The site's bucket, its
 * server functions, and its CloudFront distribution or its entry in the router are kept.
 * Its files and its entries in the key-value store are written again by resources of a new
 * type, which the `sst` binary serves, and `sst migrate` takes the old ones out of the
 * state without deleting what they wrote. A few things are written differently:
 *
 * - `nodes.server` holds the server of each region, by region, each an output:
 *   `nodes.server["us-east-1"]`. Without `regions`, that's the app's region. In SPA mode
 *   there's none, so a server is listed once the build says there is one.
 * - With `warm`, the server is warmed again when its code changes. `sst.aws.React` warmed
 *   it on every deploy. The switch warms it once.
 * - The base path is read from `vite.config` and `react-router.config` in any of their
 *   extensions, like `.js`. `sst.aws.React` read only the `.ts` files.
 */
export class React extends component("sst:aws:React", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: ReactArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = createSsrSite(this.builder(), name, args, react).url;
  }

  /**
   * The URL of the React app.
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

// How a React Router app is built, with its package manager, and its server:
// the React Router server build wrapped in a Lambda handler. In SPA mode
// there's no server.
const react: SsrFramework = {
  label: "React",
  alwaysServes: false,
  load: loadBuild,
};

// Reads what React Router built
function loadBuild(builtPath: string, owner: string): SiteBuild {
  const outputPath = path.resolve(context().paths.root, builtPath);
  const serves = fs.existsSync(path.join(outputPath, "build", "server"));

  // The base path, which Vite's `base` and React Router's `basename` both
  // set: `/docs/` and `/docs`. The asset paths are made from `base`, and the
  // root URL works without a slash at its end with `basename`.
  const viteBase = configValue(outputPath, "vite.config", "base") || undefined;
  const basename =
    configValue(outputPath, "react-router.config", "basename") || undefined;
  if (viteBase) {
    if (!viteBase.endsWith("/"))
      throw new VisibleError(
        `The "base" in the Vite config of ${owner} is "${viteBase}". End it with a "/": "${viteBase}/".`,
      );
    if (!basename)
      throw new VisibleError(
        `${capitalized(
          owner,
        )} sets "base" in its Vite config and no "basename" in its react-router.config. Set "basename" to "${viteBase.replace(
          /\/$/,
          "",
        )}" too.`,
      );
  }
  if (basename) {
    if (basename.endsWith("/"))
      throw new VisibleError(
        `The "basename" in the react-router.config of ${owner} is "${basename}". Leave out the "/" at its end: "${basename.replace(
          /\/$/,
          "",
        )}".`,
      );
    if (!viteBase)
      throw new VisibleError(
        `${capitalized(
          owner,
        )} sets "basename" in its react-router.config and no "base" in its Vite config. Set "base" to "${basename}/" too.`,
      );
  }

  // Wrap the server build in the Lambda handler
  if (serves)
    fs.copyFileSync(
      path.join(
        context().paths.platform,
        "functions",
        "react-server",
        "server.mjs",
      ),
      path.join(outputPath, "build", "server.mjs"),
    );

  return {
    sitePath: builtPath,
    outputPath,
    serves,
    plan: {
      base: basename,
      assets: [
        {
          from: path.join("build", "client"),
          to: "",
          cached: true,
          versionedSubDir: "assets",
        },
      ],
      // In SPA mode, every path the router doesn't find in S3 is the app's
      custom404: serves ? undefined : "/index.html",
    },
    server: serves
      ? {
          handler: path.join(builtPath, "build", "server.handler"),
          streaming: true,
        }
      : undefined,
  };
}
