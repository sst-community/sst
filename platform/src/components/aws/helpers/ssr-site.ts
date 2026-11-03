import fs from "fs";
import path from "path";
import type { Loader } from "esbuild";
import {
  Config,
  type Input,
  type Output,
  all,
  asset,
  interpolate,
  output,
} from "@pulumi/pulumi";
import {
  Region,
  cloudfront,
  cloudwatch,
  getRegionOutput,
  iam,
  lambda,
} from "@pulumi/aws";
import {
  type PartsBuilder,
  deferred,
  many,
  named,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { notAnOption, plain, plainDeep } from "../../args";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import { markUnknowns, unknown } from "../../check";
import { physicalName } from "../../naming";
import { type Size, toMBs } from "../../size";
import { type DurationSeconds, toSeconds } from "../../duration";
import type { BaseSiteFileOptions } from "../../base/base-site";
import { parseLambdaEdgeArn } from "./arn";
import { useProvider } from "./provider";
import { type RouteArgs, routeOf } from "./router";
import { buildSite, defaultBuildCommand } from "./site-build";
import { BucketFiles } from "../resources/bucket-files";
import { KvKeys } from "../resources/kv-keys";
import { DistributionInvalidation } from "../providers/distribution-invalidation";
import { KvRoutesUpdate } from "../providers/kv-routes-update";
import {
  CF_BLOCK_CLOUDFRONT_URL_INJECTION,
  CF_ROUTER_INJECTION,
  type ProtectionConfig,
  isSigning,
  kvNamespace,
} from "../router-code";
import {
  type SitePlan,
  regionsWithoutFunctionUrls,
  serverWarmingInjection,
  siteFiles,
  siteInvalidation,
  siteKvEntries,
} from "../site-code";
import { Bucket } from "../v5/bucket";
import { Cdn, type CdnDomainArgs, cdnDomain } from "../v5/cdn";
import {
  Function,
  type FunctionArgs,
  type FunctionArn,
  type FunctionPermissionArgs,
} from "../v5/function";

// The placeholder URL of a site in `sst dev`, which isn't deployed
export const URL_UNAVAILABLE = "http://url-unavailable-in-dev.mode";

/** Why an arg the site's build reads has to be a plain value. */
export const BUILD_READS_IT =
  "The site is built with it, and a preview has to know what's built.";

/**
 * What every site with a server is built from: its assets and their files,
 * its server in each region with what keeps it warm and what lets CloudFront
 * reach it, and what serves it. A site adds what's its own, like a Next.js
 * site's revalidation.
 *
 * ```ts
 * const parts = () => ({ ...ssrSiteParts(), revalidationQueue: ... });
 * ```
 */
export const ssrSiteParts = () => ({
  /**
   * The Amazon S3 bucket that holds the site's assets, and anything its server caches
   * there.
   */
  assets: Bucket,
  /**
   * The files uploaded to the bucket.
   */
  assetFiles: BucketFiles,
  /**
   * The AWS Lambda function that renders the site, one in each of the `regions`,
   * by region: `nodes.server["us-east-1"]`. Each is an output, as it's created
   * once the site is built.
   *
   * Without `regions`, the server is in the app's region. When the site is given
   * an AWS provider of its own, its region isn't known until the deploy reads it,
   * so the server is listed once it's created. Set `regions` to have it from the
   * start.
   */
  server: many(deferred(Function)),
  /**
   * With `warm`, the AWS Lambda function that keeps the server warm, by region.
   */
  warmer: many(deferred(Function)),
  /**
   * The EventBridge rule that runs the warmer every 5 minutes, by region.
   */
  warmerRule: named(many(deferred(cloudwatch.EventRule)), "WarmerRule"),
  /**
   * The rule's target, the warmer, by region.
   */
  warmerTarget: named(many(deferred(cloudwatch.EventTarget)), "WarmerTarget"),
  /**
   * The permission for the rule to run the warmer, by region.
   */
  warmerPermission: named(
    many(deferred(lambda.Permission)),
    "WarmerPermission",
  ),
  /**
   * The call to the warmer that warms the server when it's built, by region.
   */
  prewarm: many(deferred(lambda.Invocation)),
  /**
   * The permission for anyone to call the server's URL, when CloudFront
   * doesn't sign its requests, by region.
   */
  urlAccess: named(
    many(deferred(lambda.Permission)),
    "PublicFunctionUrlAccess",
  ),
  /**
   * The permission for CloudFront to call the server's URL, when it signs
   * its requests, by region.
   */
  cloudFrontUrlAccess: named(
    many(deferred(lambda.Permission)),
    "CloudFrontFunctionUrlAccess",
  ),
  /**
   * The permission for CloudFront to invoke the server through its URL, when
   * it signs its requests, by region.
   */
  cloudFrontInvoke: named(
    many(deferred(lambda.Permission)),
    "CloudFrontInvokeFunction",
  ),
  /**
   * What the site keeps in the CloudFront key-value store that routes its
   * requests: the paths that go to S3, and where its servers are.
   */
  kvKeys: KvKeys,
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
   * through a `Router`.
   */
  cdn: optional(Cdn),
  /**
   * The CloudFront key-value store the site's requests are routed with, when
   * it isn't served through a `Router` and isn't given one.
   */
  kvStore: optional(cloudfront.KeyValueStore),
  /**
   * The CloudFront cache policy for the server's responses, unless one is
   * given in `cachePolicy`.
   */
  cachePolicy: named(optional(cloudfront.CachePolicy), "ServerCachePolicy"),
  /**
   * The CloudFront function that routes viewer requests.
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
   * The IAM role of the Lambda@Edge function that signs requests to the
   * server, with `protection: "oac-with-edge-signing"`.
   */
  edgeRole: named(optional(iam.Role), "EdgeFunctionRole"),
  /**
   * The Lambda@Edge function that signs requests to the server, with
   * `protection: "oac-with-edge-signing"`.
   */
  edgeFunction: optional(lambda.Function),
  /**
   * In `sst dev`, the function whose role the site runs as on your machine.
   */
  devServer: optional(Function),
});

/**
 * What every site with a server takes, whatever its framework. A site's own
 * args, like its `path` and `dev`, are written for it.
 */
export interface SsrSiteArgs {
  /**
   * Configure Lambda function protection through CloudFront.
   *
   * @default `"none"`
   *
   * The available options are:
   * - `"none"`: Lambda URLs are publicly accessible.
   * - `"oac"`: Lambda URLs protected by CloudFront Origin Access Control. Requires manual `x-amz-content-sha256` header for POST, PUT and PATCH requests. Use when you control all of those requests.
   * - `"oac-with-edge-signing"`: Full protection with automatic header signing via Lambda@Edge. Works with external webhooks and callbacks. Higher cost and latency but works out of the box.
   *
   * :::note
   * When using `"oac-with-edge-signing"`, request bodies are limited to 1MB due to Lambda@Edge payload limits. For file uploads larger than 1MB, consider using presigned S3 URLs or the `"oac"` mode with manual header signing.
   * :::
   *
   * :::note
   * When removing a stage that uses `"oac-with-edge-signing"`, deletion may take 5-10 minutes while AWS removes the Lambda@Edge replicated functions from all edge locations.
   * :::
   *
   * @example
   * ```js
   * // No protection (default)
   * {
   *   protection: "none"
   * }
   * ```
   *
   * @example
   * ```js
   * // OAC protection, manual header signing required
   * {
   *   protection: "oac"
   * }
   * ```
   *
   * @example
   * ```js
   * // Full protection with automatic Lambda@Edge
   * {
   *   protection: "oac-with-edge-signing"
   * }
   * ```
   *
   * @example
   * ```js
   * // Custom Lambda@Edge configuration
   * {
   *   protection: {
   *     mode: "oac-with-edge-signing",
   *     edgeFunction: {
   *       memory: "256 MB",
   *       timeout: "10 seconds"
   *     }
   *   }
   * }
   * ```
   *
   * @example
   * ```js
   * // Use existing Lambda@Edge function
   * {
   *   protection: {
   *     mode: "oac-with-edge-signing",
   *     edgeFunction: {
   *       arn: "arn:aws:lambda:us-east-1:123456789012:function:my-signing-function:1"
   *     }
   *   }
   * }
   * ```
   */
  protection?:
    | "none"
    | "oac"
    | "oac-with-edge-signing"
    | {
        mode: "oac-with-edge-signing";
        edgeFunction?: {
          /**
           * Custom Lambda@Edge function ARN to use for request signing.
           * If provided, this function will be used instead of creating a new one.
           * Must be a qualified ARN (with version) and deployed in us-east-1.
           */
          arn?: Input<FunctionArn>;
          /**
           * Memory size for the auto-created Lambda@Edge function.
           * Only used when arn is not provided.
           * @default `"128 MB"`
           */
          memory?: Input<Size>;
          /**
           * Timeout for the auto-created Lambda@Edge function.
           * Only used when arn is not provided.
           * @default `"5 seconds"`
           */
          timeout?: Input<DurationSeconds>;
        };
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
     */
    viewerRequest?: {
      /**
       * The code to inject into the viewer request function.
       *
       * By default, a viewer request function is created to:
       * - Disable CloudFront default URL if custom domain is set
       * - Add the `x-forwarded-host` header
       * - Route assets requests to S3 (static files stored in the bucket)
       * - Route server requests to server functions (dynamic rendering)
       *
       * The function manages routing by:
       * 1. First checking if the requested path exists in S3 (with variations like adding index.html)
       * 2. Serving a custom 404 page from S3 if configured and the path isn't found
       * 3. Routing image optimization requests to the image optimizer function
       * 4. Routing all other requests to the nearest server function
       *
       * The given code will be injected at the beginning of this function.
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
       *
       * You can use this to add basic auth, [check out an example](/docs/examples/#aws-nextjs-basic-auth).
       */
      injection: Input<string>;
      /**
       * The KV store to associate with the viewer request function.
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
     * The viewer response function can be used to modify outgoing responses before they are
     * sent to the client. For example, you can add security headers or change the response
     * status code.
     *
     * By default, no viewer response function is set. A new function will be created
     * with the provided code.
     */
    viewerResponse?: {
      /**
       * The code to inject into the viewer response function.
       *
       * ```js
       * async function handler(event) {
       *   // User injected code
       *
       *   return event.response;
       * }
       * ```
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
   * Regions that the server function will be deployed to.
   *
   * By default, the server function is deployed to a single region, this is the
   * default region of your SST app.
   *
   * :::note
   * This does not use Lambda@Edge, it deploys multiple Lambda functions instead.
   * :::
   *
   * To deploy it to multiple regions, you can pass in a list of regions. And
   * any requests made will be routed to the nearest region based on the user's
   * location.
   *
   * @default The default region of the SST app
   *
   * @example
   * ```js
   * {
   *   regions: ["us-east-1", "eu-west-1"]
   * }
   * ```
   *
   * :::note
   * A site with a server function can't be deployed to the regions where Lambda function
   * URLs aren't available: `ap-east-2`, `ap-south-2`, `ap-southeast-4`, `ap-southeast-5`,
   * `ap-southeast-6`, `ap-southeast-7`, `ca-west-1`, `eu-central-2`, `il-central-1`,
   * `me-central-1` and `mx-central-1`.
   * :::
   */
  regions?: string[];
  /**
   * The number of instances of the [server function](#nodes-server) to keep warm. This is useful for cases where you are experiencing long cold starts. The default is to not keep any instances warm.
   *
   * This works by starting a serverless cron job to make _n_ concurrent requests to the server function every few minutes. Where _n_ is the number of instances to keep warm.
   *
   * @default `0`
   */
  warm?: number;
  /**
   * Configure the Lambda function used for server.
   * @default `{architecture: "x86_64", memory: "1024 MB"}`
   */
  server?: {
    /**
     * The amount of memory allocated to the server function.
     * Takes values between 128 MB and 10240 MB in 1 MB increments.
     *
     * @default `"1024 MB"`
     * @example
     * ```js
     * {
     *   server: {
     *     memory: "2048 MB"
     *   }
     * }
     * ```
     */
    memory?: FunctionArgs["memory"];
    /**
     * The runtime environment for the server function.
     *
     * @default `"nodejs24.x"`
     * @example
     * ```js
     * {
     *   server: {
     *     runtime: "nodejs24.x"
     *   }
     * }
     * ```
     */
    runtime?: "nodejs18.x" | "nodejs20.x" | "nodejs22.x" | "nodejs24.x";
    /**
     * The maximum amount of time the server function can run.
     *
     * While Lambda supports timeouts up to 900 seconds, your requests are served
     * through AWS CloudFront. And it has a default limit of 60 seconds.
     *
     * :::tip
     * If you need a timeout longer than 60 seconds, you'll need to request a
     * limit increase.
     * :::
     *
     * You can increase this to 180 seconds for your account by contacting AWS
     * Support and [requesting a limit increase](https://console.aws.amazon.com/support/home#/case/create?issueType=service-limit-increase).
     *
     * @default `"20 seconds"`
     * @example
     * ```js
     * {
     *   server: {
     *     timeout: "50 seconds"
     *   }
     * }
     * ```
     *
     * If you need a timeout longer than what CloudFront supports, we recommend
     * using a separate Lambda `Function` with the `url` enabled instead.
     */
    timeout?: FunctionArgs["timeout"];
    /**
     * The [architecture](https://docs.aws.amazon.com/lambda/latest/dg/foundation-arch.html)
     * of the server function.
     *
     * @default `"x86_64"`
     * @example
     * ```js
     * {
     *   server: {
     *     architecture: "arm64"
     *   }
     * }
     * ```
     */
    architecture?: FunctionArgs["architecture"];
    /**
     * Dependencies that need to be excluded from the server function package.
     *
     * Certain npm packages cannot be bundled using esbuild. This allows you to exclude them
     * from the bundle. Instead they'll be moved into a `node_modules/` directory in the
     * function package.
     *
     * :::tip
     * If esbuild is giving you an error about a package, try adding it to the `install` list.
     * :::
     *
     * This will allow your functions to be able to use these dependencies when deployed. They
     * just won't be tree shaken. You however still need to have them in your `package.json`.
     *
     * :::caution
     * Packages listed here still need to be in your `package.json`.
     * :::
     *
     * Esbuild will ignore them while traversing the imports in your code. So these are the
     * **package names as seen in the imports**. It also works on packages that are not directly
     * imported by your code.
     *
     * @example
     * ```js
     * {
     *   server: {
     *     install: ["sharp"]
     *   }
     * }
     * ```
     */
    install?: string[];
    /**
     * Configure additional esbuild loaders for other file extensions. This is useful
     * when your code is importing non-JS files like `.png`, `.css`, etc.
     *
     * @example
     * ```js
     * {
     *   server: {
     *     loader: {
     *      ".png": "file"
     *     }
     *   }
     * }
     * ```
     */
    loader?: Record<string, Loader>;
    /**
     * A list of Lambda layer ARNs to add to the server function.
     *
     * @example
     * ```js
     * {
     *   server: {
     *     layers: ["arn:aws:lambda:us-east-1:123456789012:layer:my-layer:1"]
     *   }
     * }
     * ```
     */
    layers?: Input<Input<string>[]>;
  };
  /**
   * Configure the site to use an existing CloudFront cache policy.
   *
   * :::note
   * CloudFront has a limit of 20 cache policies per account, though you can request a limit
   * increase.
   * :::
   *
   * By default, a new cache policy is created for it. This allows you to reuse an existing
   * policy instead of creating a new one.
   *
   * @default A new cache policy is created
   *
   * @example
   * ```js
   * {
   *   cachePolicy: "658327ea-f89d-4fab-a63d-7e88639e58f6"
   * }
   * ```
   */
  cachePolicy?: Input<string>;
  /**
   * Configure how the CloudFront cache invalidations are handled. This is run after your site has been deployed.
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
         * Waiting for this process to finish ensures that new content will be available after the deploy finishes. However, this process can sometimes take more than 5 mins.
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
         * You can either pass in an array of glob patterns to invalidate specific files. Or you can use one of these built-in options:
         * - `all`: All files will be invalidated when any file changes
         * - `versioned`: Only versioned files will be invalidated when versioned files change
         *
         * :::note
         * Each glob pattern counts as a single invalidation. Whereas, invalidating
         * `/*` counts as a single invalidation.
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
         * This counts as two invalidations.
         */
        paths?: "all" | "versioned" | string[];
      };
  /**
   * Configure the server function to connect to private subnets in a virtual private cloud or VPC. This allows it to access private resources.
   *
   * @example
   * Create a `Vpc` component.
   *
   * ```js title="sst.config.ts"
   * const myVpc = new sst.aws.v5.Vpc("MyVpc");
   * ```
   *
   * Or reference an existing VPC.
   *
   * ```js title="sst.config.ts"
   * const myVpc = sst.aws.v5.Vpc.get("MyVpc", "vpc-12345678901234567");
   * ```
   *
   * And pass it in.
   *
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   */
  vpc?: FunctionArgs["vpc"];
  /**
   * Configure how the assets are uploaded to S3.
   *
   * By default, this is set to the following. Read more about these options below.
   * ```js
   * {
   *   assets: {
   *     textEncoding: "utf-8",
   *     versionedFilesCacheHeader: "public,max-age=31536000,immutable",
   *     nonVersionedFilesCacheHeader: "public,max-age=0,s-maxage=86400,stale-while-revalidate=8640"
   *   }
   * }
   * ```
   *
   * #### Limits
   *
   * CloudFront distributions have a **limit of 25 cache behaviors** per distribution.
   * Each top-level file or directory in your app's public asset directory creates a cache
   * behavior. If you have too many, you'll hit the `TooManyCacheBehaviors` error. This is
   * most common with `SvelteKit`, `SolidStart`, `Nuxt`, and `Analog` apps.
   *
   * For example, in the case of SvelteKit, the static assets are in the `static/`
   * directory. If you have a file and a directory in it, it'll create 2 cache behaviors.
   *
   * ```bash frame="none"
   * static/
   * ├── icons/       # Cache behavior for /icons/*
   * └── logo.png     # Cache behavior for /logo.png
   * ```
   *
   * So if you have many of these at the top-level, you'll hit the limit. You can request a
   * limit increase through AWS Support.
   *
   * Alternatively, you can move some of these into subdirectories. For example, moving them
   * to an `images/` directory, will only create 1 cache behavior.
   *
   * ```bash frame="none"
   * static/
   * └── images/      # Cache behavior for /images/*
   *     ├── icons/
   *     └── logo.png
   * ```
   *
   * Learn more about these [CloudFront limits](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions).
   */
  assets?: Input<{
    /**
     * Character encoding for text based assets, like HTML, CSS, JS. This is
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
     * The `Cache-Control` header used for versioned files, like `main-1234.css`. This is
     * used by both CloudFront and the browser cache.
     *
     * The default `max-age` is set to 1 year.
     * @default `"public,max-age=31536000,immutable"`
     * @example
     * ```js
     * {
     *   assets: {
     *     versionedFilesCacheHeader: "public,max-age=31536000,immutable"
     *   }
     * }
     * ```
     */
    versionedFilesCacheHeader?: Input<string>;
    /**
     * The `Cache-Control` header used for non-versioned files, like `index.html`. This is used by both CloudFront and the browser cache.
     *
     * The default is set to not cache on browsers, and cache for 1 day on CloudFront.
     * @default `"public,max-age=0,s-maxage=86400,stale-while-revalidate=8640"`
     * @example
     * ```js
     * {
     *   assets: {
     *     nonVersionedFilesCacheHeader: "public,max-age=0,no-cache"
     *   }
     * }
     * ```
     */
    nonVersionedFilesCacheHeader?: Input<string>;
    /**
     * Specify the `Content-Type` and `Cache-Control` headers for specific files. This allows
     * you to override the default behavior for specific files using glob patterns.
     *
     * @example
     * Apply `Cache-Control` and `Content-Type` to all zip files.
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
     * Configure if files from previous deployments should be purged from the bucket.
     * @default `false`
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
  }>;
}

export type SsrSiteParts = ReturnType<typeof ssrSiteParts>;

/**
 * What each site takes in its own words: its docs name its framework. The
 * base reads them as they're written there.
 */
export interface SiteOwnArgs {
  dev?:
    | false
    | {
        url?: Input<string>;
        command?: Input<string>;
        autostart?: Input<boolean>;
        directory?: Input<string>;
        title?: Input<string>;
      };
  path?: string;
  link?: FunctionArgs["link"];
  environment?: FunctionArgs["environment"];
  permissions?: FunctionArgs["permissions"];
  buildCommand?: string;
  domain?: string | Prettify<CdnDomainArgs>;
  router?: RouteArgs;
}

/** A site's build, as its framework reads it. */
export interface SiteBuild {
  /** The site's folder, from the app's folder. */
  sitePath: string;
  /** The same, on this machine. */
  outputPath: string;
  /** What the site serves from S3 and from its server. */
  plan: SitePlan;
  /** Whether the build has a server. A static Astro site doesn't. */
  serves: boolean;
}

/** What a framework is told about the site, to create what it adds. */
export interface SsrSiteContext {
  /** The bucket the assets are in. */
  bucket: Bucket;
  /** Whether CloudFront signs its requests to the site's functions. */
  signs: boolean;
  /** The CloudFront distribution the site is served through. */
  distributionArn: Output<string>;
}

/**
 * The server's args a framework's build decides. The base adds the rest, and
 * merges the site's own environment, permissions, links and layers in.
 */
export type ServerPlan = Pick<
  FunctionArgs,
  | "handler"
  | "bundle"
  | "description"
  | "runtime"
  | "architecture"
  | "nodejs"
  | "copyFiles"
  | "injections"
> & {
  memory?: Size;
  streaming?: boolean;
  environment?: Record<string, Input<string>>;
  permissions?: FunctionPermissionArgs[];
  layers?: Input<string>[];
  link?: any[];
};

/**
 * What a framework gives the base: how its site is built and read, and what
 * it creates beside the server.
 */
export interface SsrFramework<B extends SiteBuild> {
  /** The component, in messages: `the "Web" Nextjs site`. */
  label: string;
  /**
   * The command that builds the site, when the site isn't given one. Without
   * it, the site's `build` script, run by its package manager.
   */
  buildCommand?(sitePath: string, option: (arg: string) => string): string;
  /**
   * Checks the app before every build, with a command given or not, like that
   * its adapter can build it. `sst dev` doesn't build, and skips it.
   */
  beforeBuild?(sitePath: string): void;
  /** Reads the build, from the site's folder as it's built. */
  load(builtPath: string): B;
  /**
   * Whether every build has a server, so `nodes.server` lists one in each
   * region from the start.
   */
  alwaysServes: boolean;
  /**
   * Checks the framework's own args that decide what's created. It runs where
   * the base checks its own, which `sst dev` skips.
   */
  check?(option: (arg: string) => string): void;
  /** Creates what the server needs, and says how it's built. */
  server(build: B, site: SsrSiteContext): ServerPlan;
  /** Creates what's made after the servers, like an image optimizer. */
  extras?(build: B, site: SsrSiteContext): { imageOptimizer?: Function };
}

// What a site created from its build
interface Built {
  plan: SitePlan;
  outputPath: string;
  servers: { region: string; server: Function }[];
  imageOptimizer?: Function;
}

/**
 * Build a site with a server: what every framework's site creates, from the
 * plan its framework reads from the build. In `sst dev` the site runs on your
 * machine instead.
 *
 * ```ts
 * const parts = () => ({ ...ssrSiteParts(), revalidationQueue: ... });
 * ...
 * this.siteUrl = createSsrSite(this.builder(), name, args, framework).url;
 * ```
 */
export function createSsrSite<B extends SiteBuild>(
  builder: PartsBuilder<SsrSiteParts>,
  name: string,
  args: SsrSiteArgs & SiteOwnArgs,
  framework: SsrFramework<B>,
): { url: Output<string> } {
  const self = builder.component;
  const owner = `the "${name}" ${framework.label} site`;
  const option = (arg: string) => `The "${arg}" of ${owner}`;
  const isBuilt = BUILD_READS_IT;

  rejectOld();
  const sitePath = sitePathOf();

  // In `sst dev` the site runs on your machine, in a pane of its own
  if (context().dev && args.dev !== false) {
    const dev = args.dev ?? {};
    const devServer = builder.part("devServer", {
      description: `${name} dev server`,
      runtime: "nodejs24.x",
      timeout: "20 seconds",
      memory: "128 MB",
      bundle: path.join(
        context().paths.platform,
        "functions",
        "empty-function",
      ),
      handler: "index.handler",
      environment: args.environment,
      permissions: args.permissions,
      link: args.link,
      dev: false,
    });
    builder.runsLocally();
    const url = output(dev.url ?? URL_UNAVAILABLE);
    builder.report({
      dev: {
        title: dev.title,
        command: output(dev.command).apply((c) => c ?? "npm run dev"),
        autostart: dev.autostart,
        directory: output(dev.directory).apply((d) => d ?? sitePath),
        environment: args.environment,
        link: args.link,
        aws: { role: devServer.nodes.role.arn },
      },
    });
    return { url };
  }

  // The args that decide which resources are created are read first
  const regionsArg = regionsOf();
  // The server's regions, when they're known before the build
  const serverRegions = regionsArg ?? appRegion();
  const warm = plain(args.warm, option("warm"));
  const invalidation = plainDeep(args.invalidation, option("invalidation"));
  framework.check?.(option);
  const serverArgs = plain(args.server, option("server")) ?? {};
  const runtime = plain(serverArgs.runtime, option("server.runtime"), isBuilt);
  const architecture = plain(
    serverArgs.architecture,
    option("server.architecture"),
    isBuilt,
  );
  const install = plainDeep(
    serverArgs.install,
    option("server.install"),
    isBuilt,
  );
  const loader = plainDeep(serverArgs.loader, option("server.loader"), isBuilt);
  const namespace = kvNamespace(name);
  const routing = router();
  const timeout = output(serverArgs.timeout).apply((t) => t ?? "20 seconds");
  const purge = output(args.assets).apply((a) => a?.purge ?? false);

  const bucket = builder.part(
    "assets",
    { access: "cloudfront" },
    { retainOnDelete: false },
  );

  // `sst refresh` runs the program to read what's deployed, and creates
  // nothing, so the site isn't built for it, as SST 4's wasn't. What's made
  // from the build isn't registered, and stays as it is.
  if (context().command === "refresh") {
    builder.report({ hint: routing.url });
    return { url: routing.url };
  }

  framework.beforeBuild?.(sitePath);
  const build = buildSite({
    name,
    sitePath,
    command:
      plain(args.buildCommand, option("buildCommand"), isBuilt) ??
      framework.buildCommand?.(sitePath, option) ??
      defaultBuildCommand(sitePath),
    environment: args.environment,
    link: args.link,
  }).then((builtPath) => {
    const build = framework.load(builtPath);
    return { ...build, plan: normalizedPlan(build.plan) };
  });
  const built = builder.after(build, createFromBuild);
  const builtOutput = output(built);
  if (framework.alwaysServes) promiseRegionalParts();

  const assetFiles = builder.part("assetFiles", {
    bucketName: bucket.name,
    files: all([build, args.assets, routing.pathPrefix]).apply(
      ([build, assets, pathPrefix]) =>
        siteFiles({
          plan: build.plan,
          outputPath: build.outputPath,
          assets: assets as Parameters<typeof siteFiles>[0]["assets"],
          pathPrefix,
          textEncoding: assets?.textEncoding ?? "UTF-8",
        }),
    ),
    purge,
    region: getRegionOutput({}, { parent: self }).region,
  });

  const kvKeys = builder.part("kvKeys", {
    store: routing.kvStoreArn,
    namespace,
    entries: all([
      builtOutput,
      bucket.nodes.bucket.bucketRegionalDomainName,
      timeout,
      routing.protection,
      routing.pathPrefix,
    ]).apply(([built, bucketDomain, timeout, protection, pathPrefix]) =>
      all([
        built.servers.map(({ region, server }) => ({
          region,
          url: server.url,
        })),
        built.imageOptimizer?.url,
      ]).apply(([servers, imageOptimizerUrl]) =>
        siteKvEntries({
          name,
          plan: built.plan,
          outputPath: built.outputPath,
          bucketDomain,
          timeout,
          protection,
          pathPrefix,
          servers,
          imageOptimizerUrl,
        }),
      ),
    ),
    purge,
  });

  const routesUpdate = routing.route
    ? builder.part("routesUpdate", {
        store: routing.route.routerKvStoreArn,
        namespace: routing.route.routerKvNamespace,
        key: "routes",
        entry: routing.route.apply((route) =>
          ["site", namespace, route.hostPattern, route.pathPrefix].join(","),
        ),
      })
    : undefined;

  createInvalidation();

  builder.report({ hint: routing.url });

  function rejectOld() {
    notAnOption(
      args,
      "route",
      `Serve the site through a Router with "router": { instance: router, path, domain }.`,
    );
    notAnOption(args, "cdn", `Serve the site through a Router with "router".`);
    notAnOption(
      args.server ?? {},
      "edge",
      `Set "edge" on the site itself, not on its "server".`,
    );
  }

  function sitePathOf() {
    const sitePath = plain(args.path, option("path"), isBuilt) ?? ".";
    if (!fs.existsSync(path.resolve(context().paths.root, sitePath)))
      throw new VisibleError(
        `Site directory not found at "${path.resolve(
          context().paths.root,
          sitePath,
        )}". Please check the path setting in your configuration.`,
      );
    return sitePath;
  }

  function regionsOf() {
    const regions = plain(args.regions, option("regions"));
    if (regions === undefined) return;
    if (regions.length === 0)
      throw new VisibleError(
        "No deployment regions specified. Please specify at least one region in the 'regions' property.",
      );
    regions.forEach(checkRegion);
    return regions;
  }

  // Without `regions`, the server is in the region of the site's AWS
  // provider. When that's the app's, its region is in the app's config. One
  // given to the site is read in the deploy.
  function appRegion() {
    if (self.getProvider("aws::")) return;
    const region = new Config("aws").get("region");
    if (!region) return;
    checkRegion(region);
    return [region];
  }

  // The parts made for each region are in `nodes` before they're created,
  // when the regions are known
  function promiseRegionalParts() {
    if (!serverRegions) return;
    builder.willCreate("server", serverRegions);
    if (warm)
      for (const key of [
        "warmer",
        "warmerRule",
        "warmerTarget",
        "warmerPermission",
        "prewarm",
      ] as const)
        builder.willCreate(key, serverRegions);
    if (routing.signs === false) builder.willCreate("urlAccess", serverRegions);
    if (routing.signs === true)
      for (const key of ["cloudFrontUrlAccess", "cloudFrontInvoke"] as const)
        builder.willCreate(key, serverRegions);
  }

  function checkRegion(region: string) {
    if (!Object.values(Region).includes(region as Region))
      throw new VisibleError(
        `Invalid AWS region: "${region}". Please specify a valid AWS region.`,
      );
    // `sst refresh` has to work on a stage an earlier deploy left in one of
    // these regions
    if (
      context().command !== "refresh" &&
      regionsWithoutFunctionUrls.includes(region)
    )
      throw new VisibleError(
        `Region ${region} is not supported by this component, because Lambda function URLs aren't available there. Please select a different AWS region.`,
      );
  }

  // How the site is served: through a router, or a distribution of its own
  function router() {
    const routerArgs = plain(args.router, option("router"));
    if (!routerArgs) return standalone();

    if (args.domain)
      throw new VisibleError(
        `Cannot provide both "domain" and "router". Use the "domain" prop on the "Router" component when serving your site through a Router.`,
      );
    if (args.edge)
      throw new VisibleError(
        `Cannot provide both "edge" and "router". Use the "edge" prop on the "Router" component when serving your site through a Router.`,
      );
    if (args.protection)
      throw new VisibleError(
        `Cannot set "protection" when routing through a Router. Set "protection" on the Router component instead.`,
      );

    const { route, signs, pathPrefix } = routeOf(routerArgs);
    return {
      route,
      signs,
      pathPrefix,
      protection: route.routerProtection as Output<ProtectionConfig>,
      kvStoreArn: route.routerKvStoreArn,
      distributionId: route.routerDistributionId,
      distributionArn: route.routerDistributionArn,
      url: route.routerUrl,
    };
  }

  function standalone() {
    cdnDomain(args.domain, owner);
    const protection = protectionOf();
    const edge = edgeOf();

    const kvStoreArn = output(
      edge.viewerRequest?.kvStore ?? builder.part("kvStore", {}).arn,
    );
    const requestFunction = builder.part("requestFunction", {
      runtime: "cloudfront-js-2.0",
      keyValueStoreAssociations: [kvStoreArn],
      code: interpolate`
import cf from "cloudfront";
async function handler(event) {
  ${edge.viewerRequest?.injection ?? ""}
  ${args.domain ? CF_BLOCK_CLOUDFRONT_URL_INJECTION : ""}
  ${CF_ROUTER_INJECTION}

  const kvNamespace = "${namespace}";

  // Load metadata
  let metadata;
  try {
    const v = await cf.kvs().get(kvNamespace + ":metadata");
    metadata = JSON.parse(v);
  } catch (e) {}

  const response = await routeSite(kvNamespace, metadata);
  return response || event.request;
}`,
    });
    const responseFunction = edge.viewerResponse?.injection
      ? builder.part("responseFunction", {
          runtime: "cloudfront-js-2.0",
          keyValueStoreAssociations: edge.viewerResponse.kvStore
            ? [edge.viewerResponse.kvStore]
            : [],
          code: interpolate`
import cf from "cloudfront";
async function handler(event) {
  ${edge.viewerResponse.injection}
  return event.response;
}`,
        })
      : undefined;
    const edgeSigner = signerOf(protection);

    const cdn = builder.part("cdn", {
      comment: `${name} app`,
      domain: args.domain,
      origins: [
        {
          originId: "default",
          domainName: "placeholder.sst.dev",
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "http-only",
            originReadTimeout: 20,
            originSslProtocols: ["TLSv1.2"],
          },
        },
      ],
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
        cachePolicyId: args.cachePolicy ?? cachePolicy().id,
        // CloudFront's Managed-AllViewerExceptHostHeader policy
        originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        functionAssociations: [
          { eventType: "viewer-request", functionArn: requestFunction.arn },
          ...(responseFunction
            ? [
                {
                  eventType: "viewer-response",
                  functionArn: responseFunction.arn,
                },
              ]
            : []),
        ],
        lambdaFunctionAssociations: edgeSigner
          ? [
              {
                eventType: "origin-request",
                lambdaArn: edgeSigner,
                includeBody: true,
              },
            ]
          : [],
      },
    });

    return {
      route: undefined,
      signs: isSigning(protection.mode),
      pathPrefix: output(undefined as string | undefined),
      protection: output(protection as ProtectionConfig),
      kvStoreArn,
      distributionId: cdn.nodes.distribution.id,
      distributionArn: cdn.nodes.distribution.arn,
      url: all([cdn.domainUrl, cdn.url]).apply(
        ([domainUrl, url]) => (domainUrl ?? url) as string,
      ),
    };
  }

  function protectionOf() {
    const protection = plain(args.protection, option("protection"));
    if (!protection) return { mode: "none" as const };
    if (typeof protection === "string") return { mode: protection };
    plain(protection.edgeFunction, option("protection.edgeFunction"));
    const arn = protection.edgeFunction?.arn;
    if (typeof arn === "string") parseLambdaEdgeArn(arn);
    return protection;
  }

  function edgeOf() {
    const edge = plain(args.edge, option("edge")) ?? {};
    plain(edge.viewerRequest, option("edge.viewerRequest"));
    plain(edge.viewerResponse, option("edge.viewerResponse"));
    return edge;
  }

  function cachePolicy() {
    return builder.part("cachePolicy", {
      comment: "SST server response cache policy",
      defaultTtl: 0,
      maxTtl: 31536000, // 1 year
      minTtl: 0,
      parametersInCacheKeyAndForwardedToOrigin: {
        cookiesConfig: {
          cookieBehavior: "none",
        },
        headersConfig: {
          headerBehavior: "whitelist",
          headers: {
            items: ["x-open-next-cache-key", "x-forwarded-host"],
          },
        },
        queryStringsConfig: {
          queryStringBehavior: "all",
        },
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
      },
    });
  }

  // The Lambda@Edge function that signs requests to function URLs: the
  // user's, or one the site creates
  function signerOf(protection: ReturnType<typeof protectionOf>) {
    if (protection.mode !== "oac-with-edge-signing") return;
    const settings =
      "edgeFunction" in protection ? protection.edgeFunction : undefined;
    if (settings?.arn) return settings.arn;

    const role = builder.part(
      "edgeRole",
      {
        name: physicalName(64, `${name}EdgeRole`),
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: {
                Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
              },
            },
          ],
        }),
        managedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
      { ignoreChanges: ["name"] },
    );
    return builder.part(
      "edgeFunction",
      {
        name: physicalName(64, `${name}EdgeFn`),
        runtime: "nodejs24.x",
        handler: "index.handler",
        role: role.arn,
        code: new asset.FileArchive(
          path.join(context().paths.platform, "dist", "oac-edge-signer"),
        ),
        publish: true,
        timeout: output(settings?.timeout).apply((timeout) =>
          timeout ? toSeconds(timeout) : 5,
        ),
        memorySize: output(settings?.memory).apply((memory) =>
          memory ? toMBs(memory) : 128,
        ),
        description: `${name} Lambda@Edge function for OAC request signing`,
      },
      { provider: useProvider("us-east-1"), ignoreChanges: ["name"] },
    ).qualifiedArn;
  }

  // Creates what's made from the build: the servers, what the framework
  // adds, the warmers and the permissions
  async function createFromBuild(build: B): Promise<Built> {
    const plan = build.plan;
    // A site with no server, like a static Astro site, is files alone
    if (!build.serves)
      return {
        plan: await checkedPlan(plan),
        outputPath: build.outputPath,
        servers: [],
      };

    const regions = serverRegions ?? [
      await known(
        getRegionOutput({}, { parent: self }).region,
        "The region of the site's server",
      ),
    ];
    if (!serverRegions) regions.forEach(checkRegion);
    const signs = await signsOf();
    const authorization = signs ? ("iam" as const) : ("none" as const);
    await checkedPlan(plan);
    const serverPlan = framework.server(build, siteOf(signs));

    const servers = regions.map((region) => {
      const provider = useProvider(region as Region);
      const server = builder.part(
        "server",
        region,
        {
          ...serverPlan,
          description: serverPlan.description ?? `${name} server`,
          runtime: runtime ?? serverPlan.runtime ?? "nodejs24.x",
          timeout,
          memory: output(serverArgs.memory).apply(
            (v) => v ?? serverPlan.memory ?? "1024 MB",
          ),
          architecture: architecture ?? serverPlan.architecture ?? "x86_64",
          vpc: args.vpc,
          nodejs: {
            ...serverPlan.nodejs,
            format: "esm" as const,
            install: {
              ...Object.fromEntries((install ?? []).map((pkg) => [pkg, "*"])),
              ...installOf(serverPlan.nodejs?.install),
            },
            loader: loader ?? serverPlan.nodejs?.loader,
          },
          environment: output(args.environment).apply((environment) => ({
            ...environment,
            ...serverPlan.environment,
          })),
          permissions: output(args.permissions).apply((permissions) => [
            {
              actions: ["cloudfront:CreateInvalidation"],
              resources: ["*"],
            },
            ...(permissions ?? []),
            ...(serverPlan.permissions ?? []),
          ]),
          injections: [
            ...(warm ? [serverWarmingInjection(serverPlan.streaming)] : []),
            ...(serverPlan.injections ?? []),
          ],
          link: serverPlan.link
            ? output(args.link).apply((link) => [
                ...(serverPlan.link as any[]),
                ...(link ?? []),
              ])
            : args.link,
          layers: output(serverArgs.layers).apply((layers) => [
            ...(serverPlan.layers ?? []),
            ...(layers ?? []),
          ]),
          url: { authorization },
          dev: false,
          _skipHint: true,
        },
        { provider },
      );
      if (warm) createWarmer(region, server, plan);
      return { region, server };
    });

    // Who may call the servers' URLs
    for (const { region, server } of servers) {
      const access = urlAccessArgs(server, routing.distributionArn);
      const opts = {
        provider: useProvider(region as Region),
        dependsOn: server.nodes.url ? [server.nodes.url] : [],
      };
      if (!signs) {
        builder.part("urlAccess", region, access.public, opts);
        continue;
      }
      builder.part("cloudFrontUrlAccess", region, access.cloudFrontUrl, opts);
      builder.part("cloudFrontInvoke", region, access.cloudFrontInvoke, opts);
    }

    const { imageOptimizer } = framework.extras?.(build, siteOf(signs)) ?? {};
    return { plan, outputPath: build.outputPath, servers, imageOptimizer };
  }

  // What the framework is told about the site, to create what it adds
  function siteOf(signs?: boolean): SsrSiteContext {
    return {
      bucket,
      signs: signs ?? false,
      distributionArn: routing.distributionArn,
    };
  }

  async function signsOf() {
    return typeof routing.signs === "boolean"
      ? routing.signs
      : await known(
          routing.signs,
          "Whether the router signs its requests to the site",
        );
  }

  // The plan's base path, checked against the path the site is routed on
  async function checkedPlan(plan: SitePlan) {
    const pathPrefix = markUnknowns(
      await (routing.pathPrefix as any).promise(true),
    );
    if (typeof pathPrefix === "string" && pathPrefix !== "/") {
      if (!plan.base)
        throw new VisibleError(
          `No base path found for site. You must configure the base path to match the route path prefix "${pathPrefix}".`,
        );
      if (!plan.base.startsWith(pathPrefix))
        throw new VisibleError(
          `The site base path "${plan.base}" must start with the route path prefix "${pathPrefix}".`,
        );
    }
    return plan;
  }

  function createWarmer(region: string, server: Function, plan: SitePlan) {
    const provider = { provider: useProvider(region as Region) };
    const warmer = builder.part(
      "warmer",
      region,
      {
        description: `${name} warmer`,
        bundle: path.join(context().paths.platform, "dist", "ssr-warmer"),
        runtime: "nodejs24.x",
        handler: "index.handler",
        timeout: "900 seconds",
        memory: "128 MB",
        dev: false,
        environment: {
          FUNCTION_NAME: server.nodes.function.name,
          CONCURRENCY: String(warm),
        },
        link: [server],
        _skipMetadata: true,
      },
      provider,
    );
    const rule = builder.part(
      "warmerRule",
      region,
      {
        scheduleExpression: "rate(5 minutes)",
        state: "ENABLED",
      },
      provider,
    );
    builder.part(
      "warmerPermission",
      region,
      {
        action: "lambda:InvokeFunction",
        function: warmer.arn,
        qualifier: warmer.qualifier.apply((qualifier) => qualifier!),
        principal: "events.amazonaws.com",
        sourceArn: rule.arn,
      },
      provider,
    );
    builder.part(
      "warmerTarget",
      region,
      {
        arn: warmer.targetArn,
        rule: rule.name,
        input: JSON.stringify({}),
        retryPolicy: {
          maximumRetryAttempts: 0,
          maximumEventAgeInSeconds: 60,
        },
      },
      provider,
    );
    // Warms the server when it's built
    builder.part(
      "prewarm",
      region,
      {
        functionName: warmer.nodes.function.name,
        triggers: {
          version: plan.buildId ?? server.nodes.function.codeSha256,
        },
        input: JSON.stringify({}),
      },
      provider,
    );
  }

  function createInvalidation() {
    if (invalidation === false) return;
    if (Array.isArray(invalidation?.paths) && invalidation.paths.length === 0)
      return;

    const plan = builtOutput.apply((built) => {
      const of = (
        serverCodeHashes: string[],
        imageOptimizerCodeHash?: string,
      ) => {
        const result = siteInvalidation({
          invalidation,
          plan: built.plan,
          outputPath: built.outputPath,
          serverCodeHashes,
          imageOptimizerCodeHash,
        });
        if (!result)
          throw new VisibleError(
            `The "${name}" site has no cached files to invalidate.`,
          );
        return result;
      };
      // The build id is the version when there is one. Without one, the
      // functions' code is part of it.
      if (built.plan.buildId) return output(of([]));
      return all([
        all(
          built.servers.map(({ server }) => server.nodes.function.codeSha256),
        ),
        built.imageOptimizer?.nodes.function.codeSha256,
      ]).apply(([hashes, imageOptimizerHash]) =>
        of(hashes, imageOptimizerHash),
      );
    });
    builder.part(
      "invalidation",
      {
        distributionId: routing.distributionId,
        paths: plan.paths,
        version: plan.version,
        wait: plan.wait,
      },
      {
        dependsOn: [
          assetFiles,
          kvKeys,
          ...(routesUpdate ? [routesUpdate] : []),
        ],
      },
    );
  }

  return { url: routing.url };
}

// The plan as the site reads it: its base path starting with a slash and not
// ending with one, and where its files go in the bucket without a slash
// around it, which would put them in a folder named "/"
function normalizedPlan(plan: SitePlan): SitePlan {
  const trim = (to: string) => to.replace(/^\/|\/$/g, "");
  return {
    ...plan,
    ...(plan.base && {
      base: (plan.base.startsWith("/") ? plan.base : `/${plan.base}`).replace(
        /\/$/,
        "",
      ),
    }),
    assets: plan.assets.map((copy) => ({ ...copy, to: trim(copy.to) })),
    ...(plan.isrCache && {
      isrCache: { ...plan.isrCache, to: trim(plan.isrCache.to) },
    }),
  };
}

/**
 * The args of the permissions that let callers reach a function's URL: anyone,
 * or CloudFront when it signs its requests.
 */
export function urlAccessArgs(fn: Function, distributionArn: Input<string>) {
  return {
    public: {
      action: "lambda:InvokeFunctionUrl",
      function: fn.nodes.function.name,
      principal: "*",
      functionUrlAuthType: "NONE",
    },
    cloudFrontUrl: {
      action: "lambda:InvokeFunctionUrl",
      function: fn.nodes.function.name,
      principal: "cloudfront.amazonaws.com",
      sourceArn: distributionArn,
    },
    cloudFrontInvoke: {
      action: "lambda:InvokeFunction",
      function: fn.nodes.function.name,
      principal: "cloudfront.amazonaws.com",
      sourceArn: distributionArn,
      invokedViaFunctionUrl: true,
    },
  };
}

// The packages a plan installs, as a record
function installOf(install: unknown): Record<string, string> {
  if (Array.isArray(install))
    return Object.fromEntries(install.map((pkg: string) => [pkg, "*"]));
  return (install as Record<string, string> | undefined) ?? {};
}

// A value, once it's known. What a preview knows is known.
async function known<T>(value: Input<T>, what: string): Promise<T> {
  const resolved = markUnknowns(await (output(value) as any).promise(true));
  if (resolved === unknown)
    throw new VisibleError(`${what} isn't known before the deploy.`);
  return resolved as T;
}
