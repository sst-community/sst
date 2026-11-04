import fs from "fs";
import path from "path";
import crypto from "crypto";
import { globSync } from "glob";
import {
  ComponentResourceOptions,
  Input,
  Output,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { cloudfront, getRegionOutput, s3 } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { notAnOption, plain, plainDeep } from "../../args";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import { physicalName } from "../../naming";
import { toPosix } from "../../path";
import { type BaseSiteFileOptions, getContentType } from "../../base/base-site";
import {
  edgeOf,
  routingStore,
  viewerResponseFunction,
} from "../helpers/distribution";
import type { SiteRouteArgs } from "../helpers/router";
import {
  BUILD_READS_IT,
  URL_UNAVAILABLE,
  capitalized,
  refreshing,
  rejectSst4SiteArgs,
  siteDev,
  siteRouteOf,
  siteRoutesUpdateArgs,
  sitePathOf,
} from "../helpers/site";
import { buildSite, writeViteTypes } from "../helpers/site-build";
import { siteRequestCode } from "../helpers/ssr-site";
import { type BucketFile, BucketFiles } from "../resources/bucket-files";
import { hashFiles } from "../helpers/file-hashes";
import { KvKeys } from "../resources/kv-keys";
import { DistributionInvalidation } from "../resources/distribution-invalidation";
import { KvRoutesUpdate } from "../resources/kv-routes-update";
import { OriginAccessControl } from "../resources/origin-access-control";
import {
  CF_BLOCK_CLOUDFRONT_URL_INJECTION,
  type KV_SITE_METADATA,
  kvNamespace,
} from "../router-code";
import { Bucket } from "./bucket";
import { Cdn, type CdnDomainArgs, cdnDomain } from "./cdn";

// CloudFront's managed CachingOptimized policy
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";

const parts = () => ({
  /**
   * The Amazon S3 bucket that holds the site's files, unless `assets.bucket`
   * names one.
   */
  assets: optional(Bucket),
  /**
   * The files uploaded to the bucket.
   */
  assetFiles: BucketFiles,
  /**
   * What the site keeps in the CloudFront key-value store that routes its
   * requests: its files, and where they are. Not with `edgeRouting: false`.
   */
  kvKeys: optional(KvKeys),
  /**
   * The site's entry in the routes of the `Router` it's served through.
   */
  routesUpdate: optional(KvRoutesUpdate),
  /**
   * The CloudFront cache invalidation made on a deploy that changes the site.
   */
  invalidation: optional(DistributionInvalidation),
  /**
   * The Amazon CloudFront CDN that serves the site, when it isn't served
   * through a `Router`. It can't be given in `existing`: to serve the site
   * through a distribution that's deployed, serve it through a `Router`.
   */
  cdn: optional(Cdn),
  /**
   * The CloudFront key-value store the site's requests are routed with, when
   * it isn't served through a `Router` and isn't given one. Not with
   * `edgeRouting: false`.
   */
  kvStore: optional(cloudfront.KeyValueStore),
  /**
   * The CloudFront function that routes viewer requests, when the site isn't
   * served through a `Router`. With `edgeRouting: false`, it's created only for
   * `edge.viewerRequest.injection` or a `domain`.
   */
  requestFunction: named(
    optional(cloudfront.Function),
    "CloudfrontFunctionRequest",
  ),
  /**
   * The CloudFront function that runs on viewer responses, with
   * `edge.viewerResponse`.
   */
  responseFunction: named(
    optional(cloudfront.Function),
    "CloudfrontFunctionResponse",
  ),
  /**
   * The CloudFront origin access control that lets the site's own
   * distribution read the bucket, when it serves files from the bucket itself:
   * with an `errorPage`, or `edgeRouting: false`. Not behind a `Router`.
   */
  accessControl: named(optional(OriginAccessControl), "S3AccessControl"),
});

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
   * This directory will be uploaded to S3. The path is relative to your `sst.config.ts`.
   *
   * :::note
   * If the `build` options are specified, `build.output` will be uploaded to S3 instead.
   * :::
   *
   * If you are using a static site generator, like Vite, you'll need to configure the `build` options. When these are set, the `build.output` directory will be uploaded to S3 instead.
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
   * The name of the index page of the site. This is a path relative to the root of your site, or the `path`.
   *
   * The index page only applies to the root of your site. By default this is set to `index.html`. So if a visitor goes to your site, let's say `example.com`, `example.com/index.html` will be served.
   *
   * @default `"index.html"`
   * @example
   * ```js
   * {
   *   indexPage: "home.html"
   * }
   * ```
   */
  indexPage?: string;
  /**
   * The error page to display on a 403 or 404 error. This is a path relative to the root of your site, or the `path`.
   * @default The `indexPage` of your site.
   * @example
   * ```js
   * {
   *   errorPage: "404.html"
   * }
   * ```
   */
  errorPage?: string;
  /**
   * Set environment variables for your static site. These are made available:
   *
   * 1. Locally while running your site through `sst dev`.
   * 2. In the build process when running `build.command`.
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
   * The types for the Vite environment variables are generated automatically. You can change their location through `vite.types`.
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
   * Configure if your static site needs to be built. This is useful if you are using a static site generator.
   *
   * The `build.output` directory will be uploaded to S3 instead.
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
     * The command that builds the static site. It's run in your static site directory.
     *
     * @example
     * ```js
     * {
     *   build: {
     *     command: "npm run build"
     *   }
     * }
     * ```
     */
    command: string;
    /**
     * The directory where the build output of your static site is generated. This will be uploaded.
     *
     * The path is relative to the root directory of your static site.
     *
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
   * Configure [Vite](https://vitejs.dev) related options.
   *
   * :::tip
   * If a `vite.config.ts` or `vite.config.js` file is detected in the `path`, then these options will be used during the build and deploy process.
   * :::
   */
  vite?: {
    /**
     * The path where the type definition for the `environment` variables are generated. This is relative to the `path`. [Read more](https://vitejs.dev/guide/env-and-mode#intellisense-for-typescript).
     *
     * @default `"src/sst-env.d.ts"`
     * @example
     * ```js
     * {
     *   vite: {
     *     types: "other/path/sst-env.d.ts"
     *   }
     * }
     * ```
     */
    types?: string;
  };
  /**
   * Configure CloudFront Functions to customize the behavior of HTTP requests and responses at the edge.
   */
  edge?: {
    /**
     * Configure the viewer request function.
     *
     * The viewer request function can be used to modify incoming requests before they
     * reach your origin server. For example, you can redirect users, rewrite URLs,
     * or add headers.
     *
     * By default, a viewer request function is created to:
     * - Disable CloudFront default URL if custom domain is set.
     * - Rewrite URLs to append `index.html` to the URL if the URL ends with a `/`.
     * - Rewrite URLs to append `.html` to the URL if the URL does not contain a file extension.
     *
     * With [`edgeRouting`](#edgerouting) set to `false`, URLs aren't rewritten, and the
     * function is only created for your `injection`, or to disable the CloudFront URL.
     *
     * @example
     *
     * You can pass in the code to inject into the function. The provided code will
     * be injected at the start of the function.
     *
     * ```js
     * async function handler(event) {
     *   // User injected code
     *
     *   // Default behavior code
     *
     *   return event.request;
     * }
     * ```
     *
     * To add a custom header to all requests.
     *
     * ```js
     * {
     *   edge: {
     *     viewerRequest: {
     *       injection: `event.request.headers["x-foo"] = { value: "bar" };`
     *     }
     *   }
     * }
     * ```
     *
     * You can use this add basic auth, [check out an example](/docs/examples/#aws-static-site-basic-auth).
     */
    viewerRequest?: {
      /**
       * The code to inject into the viewer request function.
       *
       * @example
       * To add a custom header to all requests.
       *
       * ```js
       * {
       *   edge: {
       *     viewerRequest: {
       *       injection: `event.request.headers["x-foo"] = { value: "bar" };`
       *     }
       *   }
       * }
       * ```
       */
      injection: Input<string>;
      /**
       * The KV store to associate with the viewer request function.
       *
       * The site's routes are written to it, unless `edgeRouting` is `false`. Then it's
       * only associated when a viewer request function is created, for your `injection`
       * to use.
       *
       * @example
       * ```js
       * {
       *   edge: {
       *     viewerRequest: {
       *       kvStore: "arn:aws:cloudfront::123456789012:key-value-store/my-store"
       *     }
       *   }
       * }
       * ```
       */
      kvStore?: Input<string>;
    };
    /**
     * Configure the viewer response function.
     *
     * The viewer response function can be used to modify outgoing responses before they
     * are sent to the client. For example, you can add security headers or change the response
     * status code.
     *
     * By default, no viewer response function is set. A new function will be created with
     * the provided code.
     *
     * @example
     *
     * You can pass in the code to inject into the function. And a CloudFront function will
     * be created with the provided code injected into it.
     *
     * ```js
     * async function handler(event) {
     *   // User injected code
     *
     *   return event.response;
     * }
     * ```
     *
     * To add a custom header to all responses.
     *
     * ```js
     * {
     *   edge: {
     *     viewerResponse: {
     *       injection: `event.response.headers["x-foo"] = { value: "bar" };`
     *     }
     *   }
     * }
     * ```
     */
    viewerResponse?: {
      /**
       * The code to inject into the viewer response function.
       *
       * @example
       * To add a custom header to all responses.
       *
       * ```js
       * {
       *   edge: {
       *     viewerResponse: {
       *       injection: `event.response.headers["x-foo"] = { value: "bar" };`
       *     }
       *   }
       * }
       * ```
       */
      injection: Input<string>;
      /**
       * The KV store to associate with the viewer response function.
       *
       * @example
       * ```js
       * {
       *   edge: {
       *     viewerResponse: {
       *       kvStore: "arn:aws:cloudfront::123456789012:key-value-store/my-store"
       *     }
       *   }
       * }
       * ```
       */
      kvStore?: Input<string>;
    };
  };
  /**
   * Configure how the static site's assets are uploaded to S3.
   *
   * By default, this is set to the following. Read more about these options below.
   * ```js
   * {
   *   assets: {
   *     textEncoding: "utf-8",
   *     fileOptions: [
   *       {
   *         files: "**",
   *         cacheControl: "max-age=31536000,public,immutable"
   *       },
   *       {
   *         files: "**\/*.html",
   *         cacheControl: "max-age=0,no-cache,no-store,must-revalidate"
   *       }
   *     ]
   *   }
   * }
   * ```
   * @default `Object`
   */
  assets?: {
    /**
     * Character encoding for text based assets uploaded to S3, like HTML, CSS, JS. This is
     * used to set the `Content-Type` header when these files are served out.
     *
     * If set to `"none"`, then no charset will be returned in header.
     * @default `"utf-8"`
     * @example
     * ```js
     * {
     *   assets: {
     *     textEncoding: "iso-8859-1"
     *   }
     * }
     * ```
     */
    textEncoding?: Input<
      "utf-8" | "iso-8859-1" | "windows-1252" | "ascii" | "none"
    >;
    /**
     * Specify the `Content-Type` and `Cache-Control` headers for specific files. This allows
     * you to override the default behavior for specific files using glob patterns.
     *
     * By default, this is set to cache CSS/JS files for 1 year and not cache HTML files.
     *
     * ```js
     * {
     *   assets: {
     *     fileOptions: [
     *       {
     *         files: "**",
     *         cacheControl: "max-age=31536000,public,immutable"
     *       },
     *       {
     *         files: "**\/*.html",
     *         cacheControl: "max-age=0,no-cache,no-store,must-revalidate"
     *       }
     *     ]
     *   }
     * }
     * ```
     *
     * @default `Object[]`
     * @example
     * You can change the default options. For example, apply `Cache-Control` and `Content-Type` to all zip files.
     * ```js
     * {
     *   assets: {
     *     fileOptions: [
     *       {
     *         files: "**\/*.zip",
     *         contentType: "application/zip",
     *         cacheControl: "private,no-cache,no-store,must-revalidate"
     *       }
     *     ]
     *   }
     * }
     * ```
     * Apply `Cache-Control` to all CSS and JS files except for CSS files with `index-`
     * prefix in the `main/` directory.
     * ```js
     * {
     *   assets: {
     *     fileOptions: [
     *       {
     *         files: ["**\/*.css", "**\/*.js"],
     *         ignore: "main\/index-*.css",
     *         cacheControl: "private,no-cache,no-store,must-revalidate"
     *       }
     *     ]
     *   }
     * }
     * ```
     */
    fileOptions?: Input<Prettify<BaseSiteFileOptions>[]>;
    /**
     * The name of the S3 bucket to upload the assets to.
     * @default Creates a new bucket
     * @example
     * ```js
     * {
     *   assets: {
     *     bucket: "my-existing-bucket"
     *   }
     * }
     * ```
     *
     * :::note
     * The bucket must allow CloudFront to access the bucket.
     * :::
     *
     * When using an existing bucket, ensure that the bucket has a policy that allows CloudFront to access the bucket.
     * For example, the bucket policy might look like this:
     * ```json
     * {
     *   "Version": "2012-10-17",
     *   "Statement": [
     *     {
     *       "Effect": "Allow",
     *       "Principal": {
     *         "Service": "cloudfront.amazonaws.com"
     *       },
     *       "Action": "s3:GetObject",
     *       "Resource": "arn:aws:s3:::my-existing-bucket/*",
     *       "Condition": {
     *         "StringLike": {
     *           "aws:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/*"
     *         }
     *       }
     *     }
     *   ]
     * }
     * ```
     *
     * The `Condition` limits it to the CloudFront distributions in your own AWS account.
     * Without it, a distribution in any account can read the bucket.
     */
    bucket?: string;
    /**
     * The path into the S3 bucket where the assets should be uploaded.
     * @default Root of the bucket
     * @example
     * ```js
     * {
     *   assets: {
     *     path: "websites/my-website"
     *   }
     * }
     * ```
     */
    path?: Input<string>;
    /**
     * Configure if files from previous deployments should be purged from the bucket.
     * @default `true`
     * @example
     * ```js
     * {
     *   assets: {
     *     purge: false
     *   }
     * }
     * ```
     */
    purge?: Input<boolean>;
    /**
     * Configure additional asset routes for serving files directly from the S3 bucket.
     *
     * These routes allow files stored in specific S3 bucket paths to be served under the
     * same domain as your site. This is particularly useful for handling user-uploaded
     * content.
     *
     * @example
     * If user-uploaded files are stored in the `uploads` directory, and no `routes` are
     * configured, these files will return 404 errors or display the `errorPage` if set.
     * By including `uploads` in `routes`, all files in that folder will be served
     * directly from the S3 bucket.
     *
     * ```js
     * {
     *   assets: {
     *     routes: ["uploads"]
     *   }
     * }
     * ```
     *
     * Has no effect with [`edgeRouting`](#edgerouting) set to `false`, which serves every
     * file under `assets.path` at its exact path.
     */
    routes?: Input<Input<string>[]>;
  };
  /**
   * Set a custom domain for your static site.
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
   * Serve your static site through a `Router` instead of a standalone CloudFront
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
   * To serve your static site **from a path**, you'll need to configure the root domain
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
   * If you are using a static site generator make sure the base path is set in your
   * config.
   *
   * :::caution
   * If routing to a path, you need to configure that as the base path in your static
   * site generator as well.
   * :::
   *
   * For Vite, set the `base` option in your `vite.config.ts`. It should end with
   * a `/` to ensure asset paths like CSS and JS, are constructed correctly.
   *
   * ```js title="vite.config.ts" {2}
   * export default defineConfig({
   *   base: "/docs/"
   * });
   * ```
   *
   * To serve your static site **from a subdomain**, you'll need to configure the
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
   * Finally, to serve your static site **from a combined pattern** like
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
   * Also, make sure to set the base path in your static site generator
   * configuration, like above.
   */
  router?: SiteRouteArgs;
  /**
   * Configure how the CloudFront cache invalidations are handled. This is run after your static site has been deployed.
   * :::tip
   * You get 1000 free invalidations per month. After that you pay $0.005 per invalidation path. [Read more here](https://aws.amazon.com/cloudfront/pricing/).
   * :::
   * @default `{paths: "all", wait: false}`
   * @example
   * Turn off invalidations.
   * ```js
   * {
   *   invalidation: false
   * }
   * ```
   * Wait for all paths to be invalidated.
   * ```js
   * {
   *   invalidation: {
   *     paths: "all",
   *     wait: true
   *   }
   * }
   * ```
   */
  invalidation?:
    | false
    | {
        /**
         * Configure if `sst deploy` should wait for the CloudFront cache invalidation to finish.
         *
         * :::tip
         * For non-prod environments it might make sense to pass in `false`.
         * :::
         *
         * Waiting for the CloudFront cache invalidation process to finish ensures that the new content will be served once the deploy finishes. However, this process can sometimes take more than 5 mins.
         * @default `false`
         * @example
         * ```js
         * {
         *   invalidation: {
         *     wait: true
         *   }
         * }
         * ```
         */
        wait?: boolean;
        /**
         * The paths to invalidate.
         *
         * You can either pass in an array of glob patterns to invalidate specific files. Or you can use the built-in option `all` to invalidation all files when any file changes.
         *
         * :::note
         * Invalidating `all` counts as one invalidation, while each glob pattern counts as a single invalidation path.
         * :::
         * @default `"all"`
         * @example
         * Invalidate the `index.html` and all files under the `products/` route.
         * ```js
         * {
         *   invalidation: {
         *     paths: ["/index.html", "/products/*"]
         *   }
         * }
         * ```
         */
        paths?: "all" | string[];
      };
  /**
   * Route requests with a CloudFront Function and a KeyValueStore that lists the site's
   * files. This is what lets `/about` serve `about.html` or `about/index.html`.
   *
   * Set this to `false` to serve the site straight from the assets bucket, with no
   * function or KeyValueStore:
   *
   * - `/` serves the `indexPage`.
   * - Any other path serves the file at that exact path.
   * - A path with no file serves the `errorPage` with a 404. Without an `errorPage`, it
   *   serves the `indexPage` with a 200, so a single-page app can handle the route.
   *
   * Use it for a single-page app, or when a policy on your account denies the
   * KeyValueStore API. Its requests are signed for all regions (SigV4A), so a policy
   * that limits regions, like a service control policy, blocks them.
   *
   * :::caution
   * Without edge routing, `/about` doesn't serve `about.html` or `about/index.html`.
   * Don't use it for a site with a page for each path.
   * :::
   *
   * A viewer request function is still created for `edge.viewerRequest.injection`, or
   * to block the CloudFront URL when you set a `domain`. `assets.routes` has no effect.
   *
   * Can't be used with the `router` prop. An SST `Router` finds and serves its sites
   * through its KeyValueStore, so a site behind one needs edge routing.
   *
   * @default `true`
   * @example
   * ```js
   * {
   *   edgeRouting: false
   * }
   * ```
   */
  edgeRouting?: boolean;
}

/**
 * The `StaticSite` component lets you deploy a static website to AWS. It uses [Amazon S3](https://aws.amazon.com/s3/) to store your files and [Amazon CloudFront](https://aws.amazon.com/cloudfront/) to serve them.
 *
 * It can also `build` your site by running your static site generator, like [Vite](https://vitejs.dev) and uploading the build output to S3.
 *
 * @example
 *
 * #### Minimal example
 *
 * Simply uploads the current directory as a static site.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Change the `path` that should be uploaded.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   path: "path/to/site"
 * });
 * ```
 *
 * #### Running locally
 *
 * In `sst dev`, we don't deploy your site to AWS because we assume you are running it locally.
 *
 * :::note
 * Your static site will not be deployed when run locally with `sst dev`.
 * :::
 *
 * For example, for a Vite site, you can run it locally with.
 *
 * ```bash
 * sst dev vite dev
 * ```
 *
 * This will start the Vite dev server and pass in any environment variables that you've set in your config. But it will not deploy your site to AWS.
 *
 * #### Deploy a Vite SPA
 *
 * Use [Vite](https://vitejs.dev) to deploy a React/Vue/Svelte/etc. SPA by specifying the `build` config.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   build: {
 *     command: "npm run build",
 *     output: "dist"
 *   }
 * });
 * ```
 *
 * #### Deploy a Jekyll site
 *
 * Use [Jekyll](https://jekyllrb.com) to deploy a static site.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   errorPage: "/404.html",
 *   build: {
 *     command: "bundle exec jekyll build",
 *     output: "_site"
 *   }
 * });
 * ```
 *
 * #### Deploy a Gatsby site
 *
 * Use [Gatsby](https://www.gatsbyjs.com) to deploy a static site.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   errorPage: "/404.html",
 *   build: {
 *     command: "npm run build",
 *     output: "public"
 *   }
 * });
 * ```
 *
 * #### Deploy an Angular SPA
 *
 * Use [Angular](https://angular.dev) to deploy a SPA.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   build: {
 *     command: "ng build --output-path dist",
 *     output: "dist"
 *   }
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your site.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Serve a SPA without edge routing
 *
 * Serve a SPA straight from its bucket, without a CloudFront Function or
 * KeyValueStore. Also useful if a policy on your account denies the KeyValueStore API.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.StaticSite("MyWeb", {
 *   edgeRouting: false
 * });
 * ```
 *
 * #### Set environment variables
 *
 * Set `environment` variables for the build process of your static site. These will be used locally and on deploy.
 *
 * :::tip
 * For Vite, the types for the environment variables are also generated. This can be configured through the `vite` prop.
 * :::
 *
 * For some static site generators like Vite, [environment variables](https://vitejs.dev/guide/env-and-mode) prefixed with `VITE_` can be accessed in the browser.
 *
 * ```ts {5-7} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.StaticSite("MyWeb", {
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
 * #### Switch from `sst.aws.StaticSite`
 *
 * Change `sst.aws.StaticSite` to `sst.aws.v5.StaticSite` and keep the name. The site's
 * bucket, its CloudFront distribution and functions, or its entry in the router are kept.
 * Its files, its entries in the key-value store and its route in the router's list are
 * written again by resources of a new type, which the `sst` binary serves, and `sst migrate`
 * takes the old ones out of the state without deleting what they wrote. Its CloudFront
 * invalidation runs once more, and its origin access control is kept, by its id. A few
 * things are written differently:
 *
 * - With `build`, the site is built in the deploy itself, once. `sst.aws.StaticSite`
 *   built it with a command it kept in the state, which goes.
 * - `sst diff` builds the site too, to see what it uploads. Values that aren't known until
 *   the deploy, like those of what the same deploy creates on a new stage, are left out of
 *   that build's `environment`. `sst.aws.StaticSite` skipped its build in `sst diff` then.
 * - The build gets `SST=1` and `SST_RESOURCE_App` in its environment, as the other sites'
 *   builds do, and not what the CLI is given for its own calls to Cloudflare.
 * - `sst migrate`, and a deploy that previews first, on a stage with checks or with a policy
 *   pack, build the site twice: in the preview, and in the deploy.
 * - `sst refresh` doesn't build the site, where `sst.aws.StaticSite` did. Its files stay as
 *   they are.
 * - `path`, `build`, `vite`, `indexPage`, `errorPage`, `edge`, `edgeRouting`, `router`,
 *   `invalidation` and `assets.bucket` have to be plain values, not outputs: they decide
 *   what's created, or what's built. So do the `name`, `aliases` and `redirects` of
 *   `domain`.
 * - `route`, `base` and `cdn` are gone. Serve the site through a Router with `router`.
 * - `router` takes `instance`, `path` and `domain`. `rewrite`, `readTimeout`,
 *   `keepAliveTimeout`, `connectionTimeout` and `connectionAttempts` in it are refused:
 *   `sst.aws.StaticSite` ignored them.
 * - `edge.viewerRequest.kvStores` and `edge.viewerResponse.kvStores` are gone, and refused.
 *   Use `kvStore`. `sst.aws.StaticSite` gave the viewer response function the first of
 *   `kvStores`.
 * - A viewer request or response function is created when its `injection` is given. An
 *   `injection` given as an output that turns out empty still creates one, where
 *   `sst.aws.StaticSite` created none.
 * - `assets.textEncoding` sets the charset of text files. `sst.aws.StaticSite` ignored it
 *   and wrote `UTF-8`.
 * - Vite's types are written when the keys of `environment` are known, in `sst diff` too.
 *   `sst.aws.StaticSite` waited for every value.
 * - The bucket an `assets.bucket` names is looked up with a function, not a resource of the
 *   state. `sst migrate` takes SST 4's lookup out of the state, which changes nothing in AWS.
 * - `nodes` has a key for each resource the site creates, like `nodes.kvKeys`.
 *   `nodes.assets` is `undefined` when `assets.bucket` names a bucket. In `sst dev`, reading
 *   `nodes` says the site runs on your machine, where `sst.aws.StaticSite` gave `undefined`.
 * - `transform.cdn` is given the distribution's `customErrorResponses`, its
 *   `defaultRootObject` and its `defaultCacheBehavior.functionAssociations` as plain values,
 *   not outputs.
 * - If you set the `defaultCacheBehavior` of `transform.cdn` with an object, it's merged
 *   with the one the site sets: it keeps the functions the site associates with it, where
 *   `sst.aws.StaticSite` replaced it whole.
 */
export class StaticSite extends component("sst:aws:StaticSite", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: StaticSiteArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.siteUrl = this.create(name, args);
  }

  private create(name: string, args: StaticSiteArgs): Output<string> {
    const self = this;
    const owner = `the "${name}" static site`;
    const option = (arg: string) => `The "${arg}" of ${owner}`;
    const root = context().paths.root;

    rejectSst4SiteArgs(args, owner);
    notAnOption(
      args,
      "base",
      `Set the path it's served under with "router": { instance: router, path }.`,
      owner,
    );
    const sitePath = sitePathOf(args.path, owner);
    const vite = plainDeep(args.vite, option("vite"), BUILD_READS_IT);

    // In `sst dev` the site runs on your machine, in a pane of its own
    const dev = plain(args.dev, option("dev"));
    if (context().dev && dev !== false) {
      this.runsLocally();
      // The environment, once Vite's types for it are written
      const environment = output(
        writeViteTypes(sitePath, vite?.types, args.environment).then(
          () => args.environment ?? {},
        ),
      );
      this.report({ dev: { ...siteDev(dev, sitePath), environment } });
      return output(dev?.url ?? URL_UNAVAILABLE);
    }

    // The args that decide which resources are created are read first
    const edgeRouting = plain(args.edgeRouting, option("edgeRouting")) ?? true;
    const indexPage =
      plain(args.indexPage, option("indexPage")) ?? "index.html";
    const errorPageArg = plain(args.errorPage, option("errorPage"));
    // The page a path with no file serves: the error page, or the index page
    const errorPage = "/" + (errorPageArg ?? indexPage).replace(/^\//, "");
    const build = plainDeep(args.build, option("build"), BUILD_READS_IT);
    const invalidation = plainDeep(args.invalidation, option("invalidation"));
    const givenBucket = plain(args.assets?.bucket, option("assets.bucket"));
    const assetsPath = output(args.assets?.path).apply((p) =>
      p ? p.replace(/^\//, "").replace(/\/$/, "") : undefined,
    );
    const purge = output(args.assets?.purge ?? true);
    const namespace = kvNamespace(name);

    const bucket = givenBucket
      ? undefined
      : this.part(
          "assets",
          { access: "cloudfront" },
          { retainOnDelete: false },
        );
    const bucketName = bucket ? bucket.name : output(givenBucket!);
    const bucketDomain = bucket
      ? bucket.nodes.bucket.bucketRegionalDomainName
      : s3.getBucketOutput({ bucket: givenBucket! }, { parent: self })
          .bucketRegionalDomainName;

    const routing = router();

    if (refreshing()) {
      this.report({ hint: routing.url });
      return routing.url;
    }

    // The folder that's uploaded, from the app's folder, once it's built
    const built = build
      ? writeViteTypes(sitePath, vite?.types, args.environment)
          .then(() =>
            buildSite({
              name,
              sitePath,
              command: build.command,
              environment: args.environment,
            }),
          )
          .then(() => {
            const outputPath = path.join(sitePath, build.output);
            if (!fs.existsSync(path.resolve(root, outputPath)))
              throw new VisibleError(
                `${capitalized(owner)} has no build output at "${path.resolve(
                  root,
                  outputPath,
                )}". Set "build.output" to the folder its build writes.`,
              );
            return outputPath;
          })
      : writeViteTypes(sitePath, vite?.types, args.environment).then(
          () => sitePath,
        );
    const outputDir = output(built).apply((p) => path.resolve(root, p));

    const assetFiles = this.part("assetFiles", {
      bucketName,
      files: all([
        outputDir,
        args.assets,
        assetsPath,
        routing.pathPrefix,
      ]).apply(([outputDir, assets, assetsPath, pathPrefix]) =>
        filesOf({
          outputDir,
          fileOptions: assets?.fileOptions as BaseSiteFileOptions[],
          textEncoding: assets?.textEncoding ?? "UTF-8",
          assetsPath,
          pathPrefix,
        }),
      ),
      purge,
      region: getRegionOutput({}, { parent: self }).region,
    });

    const kvKeys = routing.kvStoreArn
      ? this.part("kvKeys", {
          store: routing.kvStoreArn,
          namespace,
          entries: all([
            outputDir,
            args.assets?.routes,
            assetsPath,
            bucketDomain,
            routing.pathPrefix,
          ]).apply(
            ([outputDir, routes, assetsPath, bucketDomain, pathPrefix]) =>
              kvEntriesOf({
                outputDir,
                routes: (routes ?? []).map(
                  (route) => "/" + route.replace(/^\//, "").replace(/\/$/, ""),
                ),
                assetsPath,
                bucketDomain,
                errorPage,
                hasErrorPage: Boolean(errorPageArg),
                pathPrefix,
              }),
          ),
          purge,
        })
      : undefined;

    const routesUpdate = routing.route
      ? this.part(
          "routesUpdate",
          siteRoutesUpdateArgs(routing.route, namespace),
        )
      : undefined;

    createInvalidation();

    this.report({ hint: routing.url });
    return routing.url;

    // How the site is served: through a router, or a distribution of its own
    function router() {
      if (args.router !== undefined && !edgeRouting)
        throw new VisibleError(
          `${capitalized(
            owner,
          )} can't have both "edgeRouting: false" and "router". A Router finds and serves its sites through its key-value store, so a site behind one needs edge routing. Remove "router" to serve the site from its own distribution without edge routing.`,
        );
      const routed = siteRouteOf(
        {
          router: args.router,
          existing: args.existing,
          routerHas: { domain: args.domain, edge: args.edge },
        },
        owner,
        ["kvStore", "requestFunction", "responseFunction", "accessControl"],
      );
      if (!routed) return standalone();

      const { route, pathPrefix } = routed;
      return {
        route,
        pathPrefix,
        kvStoreArn: route.routerKvStoreArn as Output<string> | undefined,
        distributionId: route.routerDistributionId,
        url: route.routerUrl,
      };
    }

    function standalone() {
      cdnDomain(args.domain, owner);
      const edge = edgeOf(args.edge, option, owner);
      const builder = self.builder();
      const kvStoreArn = edgeRouting
        ? routingStore(builder, edge, args.existing, owner)
        : undefined;
      const requestFunction = requestFunctionOf(kvStoreArn, edge.viewerRequest);
      const responseFunction = viewerResponseFunction(
        builder,
        edge.viewerResponse,
      );

      const cdn = self.part("cdn", {
        comment: `${name} site`,
        domain: args.domain,
        origins: originsOf(),
        defaultCacheBehavior: {
          targetOriginId: "default",
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: [
            "DELETE",
            "GET",
            "HEAD",
            "OPTIONS",
            "PATCH",
            "POST",
            "PUT",
          ],
          cachedMethods: ["GET", "HEAD"],
          compress: true,
          cachePolicyId: CACHING_OPTIMIZED,
          functionAssociations: [
            ...(requestFunction
              ? [
                  {
                    eventType: "viewer-request",
                    functionArn: requestFunction.arn,
                  },
                ]
              : []),
            ...(responseFunction
              ? [
                  {
                    eventType: "viewer-response",
                    functionArn: responseFunction.arn,
                  },
                ]
              : []),
          ],
        },
        // With `edgeRouting: false`, CloudFront serves the index page for `/`
        defaultRootObject: edgeRouting
          ? undefined
          : indexPage.replace(/^\//, ""),
        customErrorResponses: errorResponsesOf(),
      });

      return {
        route: undefined,
        pathPrefix: output(undefined as string | undefined),
        kvStoreArn,
        distributionId: cdn.nodes.distribution.id,
        url: all([cdn.domainUrl, cdn.url]).apply(
          ([domainUrl, url]) => (domainUrl ?? url) as string,
        ),
      };
    }

    // The viewer request function: the one that routes each request, or with
    // `edgeRouting: false`, one that only runs the user's code and blocks
    // the CloudFront URL, and only when there's something to run
    function requestFunctionOf(
      kvStoreArn: Output<string> | undefined,
      viewerRequest:
        | { injection: Input<string>; kvStore?: Input<string> }
        | undefined,
    ) {
      if (kvStoreArn)
        return self.part("requestFunction", {
          runtime: "cloudfront-js-2.0",
          keyValueStoreAssociations: [kvStoreArn],
          code: siteRequestCode(
            namespace,
            viewerRequest?.injection,
            Boolean(args.domain),
          ),
        });
      if (!viewerRequest?.injection && !args.domain) return;
      return self.part("requestFunction", {
        runtime: "cloudfront-js-2.0",
        keyValueStoreAssociations: viewerRequest?.kvStore
          ? [viewerRequest.kvStore]
          : [],
        code: interpolate`
import cf from "cloudfront";
async function handler(event) {
  ${viewerRequest?.injection ?? ""}
  ${args.domain ? CF_BLOCK_CLOUDFRONT_URL_INJECTION : ""}
  return event.request;
}`,
      });
    }

    // The default origin. CloudFront fetches custom error pages without
    // running the viewer request function, so a site with an error page, or
    // with `edgeRouting: false` (no function to set the origin), uses the
    // bucket, not a placeholder. Otherwise it's the placeholder, with no
    // access control.
    function originsOf() {
      if (edgeRouting && !errorPageArg)
        return [
          {
            originId: "default",
            domainName: "placeholder.sst.dev",
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: "https-only",
              originReadTimeout: 20,
              originSslProtocols: ["TLSv1.2"],
            },
          },
        ];
      const accessControl = self.part(
        "accessControl",
        { name: physicalName(64, name) },
        { ignoreChanges: ["name"] },
      );
      return [
        {
          originId: "default",
          domainName: bucketDomain,
          originAccessControlId: accessControl.id,
          // Without edge routing, nothing adds the assets' path to a request
          ...(!edgeRouting &&
            args.assets?.path && {
              originPath: assetsPath.apply((p) => (p ? "/" + p : "")),
            }),
        },
      ];
    }

    function errorResponsesOf() {
      // Error page, or index page with a 200 for a SPA. The origin path
      // already has the assets' path.
      if (!edgeRouting)
        return [403, 404].map((errorCode) => ({
          errorCode,
          responseCode: errorPageArg ? 404 : 200,
          responsePagePath: errorPage,
          errorCachingMinTtl: 0,
        }));
      if (!errorPageArg) return [];
      // Error page fetches skip the viewer request function, which is what
      // adds the assets' path to every other request
      return [403, 404].map((errorCode) => ({
        errorCode,
        responseCode: 404,
        responsePagePath: assetsPath.apply((p) =>
          path.posix.join("/", p ?? "", errorPage),
        ),
        errorCachingMinTtl: 0,
      }));
    }

    function createInvalidation() {
      if (invalidation === false) return;
      const paths = invalidation?.paths ?? "all";
      const invalidationPaths = paths === "all" ? ["/*"] : paths;
      if (invalidationPaths.length === 0) return;

      self.part(
        "invalidation",
        {
          distributionId: routing.distributionId,
          paths: invalidationPaths,
          version: all([outputDir, args.assets]).apply(([outputDir, assets]) =>
            versionOf(outputDir, assets),
          ),
          wait: invalidation?.wait ?? false,
        },
        {
          dependsOn: [
            assetFiles,
            ...(routesUpdate ? [routesUpdate] : []),
            ...(kvKeys ? [kvKeys] : []),
          ],
        },
      );
    }
  }

  /**
   * The URL of the website.
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

/**
 * The files a static site uploads, with their headers: the first of the file
 * options that matches a file decides its headers, counting from the last.
 *
 * @param outputDir The folder that's uploaded, on this machine.
 * @param assetsPath Where in the bucket they go.
 * @param pathPrefix The path the site is routed under, when it's served
 * through a router.
 */
async function filesOf(input: {
  outputDir: string;
  fileOptions?: BaseSiteFileOptions[];
  textEncoding: string;
  assetsPath?: string;
  pathPrefix?: string;
}): Promise<BucketFile[]> {
  const { outputDir, assetsPath, pathPrefix } = input;
  const fileOptions = [
    ...(input.fileOptions ?? [
      {
        files: "**",
        cacheControl: "max-age=31536000,public,immutable",
      },
      {
        files: "**/*.html",
        cacheControl: "max-age=0,no-cache,no-store,must-revalidate",
      },
    ]),
  ].reverse();

  const bucketFiles: BucketFile[] = [];
  const filesProcessed = new Set<string>();
  for (const fileOption of fileOptions) {
    const files = globSync(fileOption.files, {
      cwd: outputDir,
      nodir: true,
      dot: true,
      ignore: [
        ".sst/**",
        ...(typeof fileOption.ignore === "string"
          ? [fileOption.ignore]
          : fileOption.ignore ?? []),
      ],
    }).filter((file) => !filesProcessed.has(file));

    const sources = files.map((file) => path.resolve(outputDir, file));
    const hashes = await hashFiles(sources);
    bucketFiles.push(
      ...files.map((file, i) => ({
        source: sources[i],
        key: toPosix(
          path.join(
            assetsPath ?? "",
            pathPrefix?.replace(/^\//, "") ?? "",
            file,
          ),
        ),
        hash: hashes[i],
        cacheControl: fileOption.cacheControl,
        contentType:
          fileOption.contentType ?? getContentType(file, input.textEncoding),
      })),
    );
    for (const file of files) filesProcessed.add(file);
  }
  return bucketFiles;
}

/**
 * What a static site keeps in the key-value store its CloudFront function
 * reads: its top-level files, and its metadata, with the folders that go to
 * S3.
 *
 * @param routes The `assets.routes`, each as `/uploads`.
 * @param errorPage The page a path with no file serves, as `/404.html`.
 * @param hasErrorPage Whether that's an `errorPage` the site was given, which
 * CloudFront serves with a 404. Otherwise the router serves it.
 */
function kvEntriesOf(input: {
  outputDir: string;
  routes: string[];
  assetsPath?: string;
  bucketDomain: string;
  errorPage: string;
  hasErrorPage: boolean;
  pathPrefix?: string;
}) {
  const { outputDir, assetsPath, pathPrefix, hasErrorPage } = input;
  const entries: Record<string, string> = {};
  const dirs: string[] = [];
  // The router adds `.html` and `index.html` to a request that goes to S3, so
  // the files in `.well-known`, which have no suffix, are listed one by one
  const expandDirs = [".well-known"];

  const processDir = (childPath = "", level = 0) => {
    const currentPath = path.join(outputDir, childPath);
    fs.readdirSync(currentPath, { withFileTypes: true }).forEach((item) => {
      if (item.isFile()) {
        entries[toPosix(path.join("/", childPath, item.name))] = "s3";
        return;
      }
      if (level === 0 && expandDirs.includes(item.name)) {
        processDir(path.join(childPath, item.name), level + 1);
        return;
      }
      dirs.push(toPosix(path.join("/", childPath, item.name)));
    });
  };
  processDir();

  entries["metadata"] = JSON.stringify({
    base: pathPrefix === "/" ? undefined : pathPrefix,
    custom404: hasErrorPage ? undefined : input.errorPage,
    errorResponseCode: hasErrorPage ? 404 : undefined,
    s3: {
      domain: input.bucketDomain,
      dir: assetsPath ? "/" + assetsPath : "",
      prefix: pathPrefix && pathPrefix !== "/" ? pathPrefix : "",
      routes: [...input.routes, ...dirs],
    },
  } satisfies KV_SITE_METADATA);
  return entries;
}

// The invalidation's version: it changes when a file, or how the files are
// uploaded, does. Each file is read as bytes, one at a time: a file that isn't
// text read as text can hash the same after a change.
function versionOf(outputDir: string, assets: unknown) {
  const hash = crypto.createHash("md5");
  hash.update(JSON.stringify(assets ?? {}));
  globSync("**", {
    dot: true,
    nodir: true,
    follow: true,
    cwd: outputDir,
  }).forEach((file) =>
    hash.update(fs.readFileSync(path.resolve(outputDir, file))),
  );
  return hash.digest("hex");
}
