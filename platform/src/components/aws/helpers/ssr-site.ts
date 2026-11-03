import type { Loader } from "esbuild";
import type { Input } from "@pulumi/pulumi";
import { cloudfront, cloudwatch, iam, lambda } from "@pulumi/aws";
import { deferred, many, named, optional } from "../../parts-component";
import type { Prettify } from "../../component";
import type { DurationSeconds } from "../../duration";
import type { Size } from "../../size";
import type { BaseSiteFileOptions } from "../../base/base-site";
import { BucketFiles } from "../resources/bucket-files";
import { KvKeys } from "../resources/kv-keys";
import { DistributionInvalidation } from "../providers/distribution-invalidation";
import { KvRoutesUpdate } from "../providers/kv-routes-update";
import { Bucket } from "../v5/bucket";
import { Cdn } from "../v5/cdn";
import { Function, type FunctionArgs, type FunctionArn } from "../v5/function";

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
   * The Amazon S3 bucket that holds the site's assets, and what its server caches there,
   * like the ISR cache of a Next.js site.
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
