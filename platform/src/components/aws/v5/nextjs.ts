import fs from "fs";
import path from "path";
import crypto from "crypto";
import { globSync } from "glob";
import type { Loader } from "esbuild";
import {
  ComponentResourceOptions,
  Config,
  Input,
  Output,
  all,
  asset,
  interpolate,
  output,
} from "@pulumi/pulumi";
import {
  Region,
  cloudfront,
  cloudwatch,
  dynamodb,
  getRegionOutput,
  iam,
  lambda,
} from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
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
import { isALteB, isALtB } from "../../../util/compare-semver";
import type { BaseSiteFileOptions } from "../../base/base-site";
import { parseLambdaEdgeArn } from "../helpers/arn";
import { useProvider } from "../helpers/provider";
import { type RouteArgs, routeOf } from "../helpers/router";
import { buildSite } from "../helpers/site-build";
import { BucketFiles } from "../providers/bucket-files";
import { DistributionInvalidation } from "../providers/distribution-invalidation";
import { KvKeys } from "../providers/kv-keys";
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
import { Bucket } from "./bucket";
import { Cdn, type CdnDomainArgs, cdnDomain } from "./cdn";
import { Function, type FunctionArgs, type FunctionArn } from "./function";
import { Queue } from "./queue";

const DEFAULT_OPEN_NEXT_VERSION = "3.9.14";
const DEFAULT_OPEN_NEXT_VERSION_NEXT14 = "3.6.6";

// The placeholder URL of a site in `sst dev`, which isn't deployed
const URL_UNAVAILABLE = "http://url-unavailable-in-dev.mode";

const parts = () => ({
  /**
   * The Amazon S3 bucket that holds the assets and the ISR cache.
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
   * The AWS Lambda function that optimizes images.
   */
  imageOptimizer: deferred(Function),
  /**
   * The Amazon SQS queue that triggers the ISR revalidator, which is its
   * subscriber. `undefined` when the build turns the incremental cache off.
   */
  revalidationQueue: named(deferred(optional(Queue)), "RevalidationEvents"),
  /**
   * The Amazon DynamoDB table that holds the ISR revalidation data. `undefined`
   * when the build turns the tag cache off.
   */
  revalidationTable: deferred(optional(dynamodb.Table)),
  /**
   * The AWS Lambda function that seeds the revalidation table from the build.
   */
  revalidationSeeder: deferred(optional(Function)),
  /**
   * The call to the seeder, made when what it seeds changes.
   */
  revalidationSeed: deferred(optional(lambda.Invocation)),
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
   * The permission for anyone to call the image optimizer's URL, when
   * CloudFront doesn't sign its requests.
   */
  imageOptimizerUrlAccess: named(
    deferred(optional(lambda.Permission)),
    "ImageOptimizerPublicFunctionUrlAccess",
  ),
  /**
   * The permission for CloudFront to call the image optimizer's URL, when it
   * signs its requests.
   */
  imageOptimizerCloudFrontUrlAccess: named(
    deferred(optional(lambda.Permission)),
    "ImageOptimizerCloudFrontFunctionUrlAccess",
  ),
  /**
   * The permission for CloudFront to invoke the image optimizer through its
   * URL, when it signs its requests.
   */
  imageOptimizerCloudFrontInvoke: named(
    deferred(optional(lambda.Permission)),
    "ImageOptimizerCloudFrontInvokeFunction",
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

export interface NextjsArgs extends ComponentArgs<typeof parts> {
  /**
   * Configure how this component works in `sst dev`.
   *
   * :::note
   * In `sst dev` your Next.js app is run in dev mode; it's not deployed.
   * :::
   *
   * Instead of deploying your Next.js app, this starts it in dev mode. It's run
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
   * Path to the directory where your Next.js app is located. This path is relative to your `sst.config.ts`.
   *
   * By default this assumes your Next.js app is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your Next.js app is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: string;
  /**
   * [Link resources](/docs/linking/) to your Next.js app. This will:
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
   * Set [environment variables](https://nextjs.org/docs/pages/building-your-application/configuring/environment-variables) in your Next.js app. These are made available:
   *
   * 1. In `next build`, they are loaded into `process.env`.
   * 2. Locally while running through `sst dev`.
   *
   * :::tip
   * You can also `link` resources to your Next.js app and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
   * :::
   *
   * Recall that in Next.js, you need to prefix your environment variables with `NEXT_PUBLIC_` to access these in the browser. [Read more here](https://nextjs.org/docs/pages/building-your-application/configuring/environment-variables#bundling-environment-variables-for-the-browser).
   *
   * @example
   * ```js
   * {
   *   environment: {
   *     API_URL: api.url,
   *     // Accessible in the browser
   *     NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   */
  environment?: FunctionArgs["environment"];
  /**
   * Permissions and the resources that the [server function](#nodes-server) in your Next.js app needs to access. These permissions are used to create the function's IAM role.
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
   * The command used internally to build your Next.js app. It uses OpenNext with the `openNextVersion`.
   *
   * @default `"npx --yes open-next@OPEN_NEXT_VERSION build"`
   *
   * @example
   *
   * If you want to use a custom `build` script from your `package.json`. This is useful if you have a custom build process or want to use a different version of OpenNext.
   * OpenNext by default uses the `build` script for building next-js app in your `package.json`. You can customize the build command in OpenNext configuration.
   * ```js
   * {
   *   buildCommand: "npm run build:open-next"
   * }
   * ```
   */
  buildCommand?: string;
  /**
   * Configure the [OpenNext](https://opennext.js.org) version used to build the Next.js app.
   *
   * :::note
   * The default OpenNext version is auto-detected based on your Next.js version and pinned to the version of SST you have.
   * :::
   *
   * By default, SST auto-detects the Next.js version from your `package.json` and picks a compatible OpenNext version. For Next.js 15+, it uses `3.9.14`. For Next.js 14, it uses `3.6.6` since newer versions of OpenNext dropped Next.js 14 support. If set, this overrides the auto-detection.
   *
   * You can [find the defaults in the source](https://github.com/sst-community/sst/blob/main/platform/src/components/aws/nextjs.ts#L16) under `DEFAULT_OPEN_NEXT_VERSION`.
   * OpenNext changed its package name from `open-next` to `@opennextjs/aws` in version `3.1.4`. SST will choose the correct one based on the version you provide.
   *
   * @default Auto-detected based on your Next.js version.
   * @example
   * ```js
   * {
   *   openNextVersion: "3.4.1"
   * }
   * ```
   */
  openNextVersion?: string;
  /**
   * Set a custom domain for your Next.js app.
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
   * Serve your Next.js app through a `Router` instead of a standalone CloudFront
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
   * To serve your Next.js app **from a path**, you'll need to configure the root domain
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
   * You also need to set the [`basePath`](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)
   * in your `next.config.js`.
   *
   * :::caution
   * If routing to a path, you need to set that as the base path in your Next.js
   * app as well.
   * :::
   *
   * ```js title="next.config.js" {2}
   * export default defineConfig({
   *   basePath: "/docs"
   * });
   * ```
   *
   * To serve your Next.js app **from a subdomain**, you'll need to configure the
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
   * Finally, to serve your Next.js app **from a combined pattern** like
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
   * Also, make sure to set this as the `basePath` in your `next.config.js`, like
   * above.
   */
  router?: RouteArgs;
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
   * Configure the Lambda function used for image optimization.
   * @default `{memory: "1024 MB"}`
   */
  imageOptimization?: {
    /**
     * The amount of memory allocated to the image optimization function.
     * Takes values between 128 MB and 10240 MB in 1 MB increments.
     *
     * @default `"1536 MB"`
     * @example
     * ```js
     * {
     *   imageOptimization: {
     *     memory: "512 MB"
     *   }
     * }
     * ```
     */
    memory?: Size;
    /**
     * If set to true, a previously computed image will return _304 Not Modified_.
     * This means that image needs to be **immutable**.
     *
     * The etag will be computed based on the image href, format and width and the next
     * BUILD_ID.
     *
     * @default `false`
     * @example
     * ```js
     * {
     *   imageOptimization: {
     *     staticEtag: true,
     *   }
     * }
     * ```
     */
    staticEtag?: boolean;
  };
  /**
   * Configure the Next.js app to use an existing CloudFront cache policy.
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
   * Configure how the CloudFront cache invalidations are handled. This is run after your Next.js app has been deployed.
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

// What OpenNext's build says it made, in `.open-next/open-next.output.json`
type BaseFunction = {
  handler: string;
  bundle: string;
};

type OpenNextFunctionOrigin = {
  type: "function";
  streaming?: boolean;
  wrapper: string;
  converter: string;
} & BaseFunction;

type OpenNextServerFunctionOrigin = OpenNextFunctionOrigin & {
  queue: string;
  incrementalCache: string;
  tagCache: string;
};

type OpenNextImageOptimizationOrigin = OpenNextFunctionOrigin & {
  imageLoader: string;
};

type OpenNextS3Origin = {
  type: "s3";
  originPath: string;
  copy: {
    from: string;
    to: string;
    cached: boolean;
    versionedSubDir?: string;
  }[];
};

interface OpenNextOutput {
  edgeFunctions: {
    [key: string]: BaseFunction;
  } & {
    middleware?: BaseFunction & { pathResolver: string };
  };
  origins: {
    s3: OpenNextS3Origin;
    default: OpenNextServerFunctionOrigin;
    imageOptimizer: OpenNextImageOptimizationOrigin;
  } & {
    [key: string]: OpenNextServerFunctionOrigin | OpenNextS3Origin;
  };
  behaviors: {
    pattern: string;
    origin?: string;
    edgeFunction?: string;
  }[];
  additionalProps?: {
    disableIncrementalCache?: boolean;
    disableTagCache?: boolean;
    initializationFunction?: BaseFunction;
    warmer?: BaseFunction;
    revalidationFunction?: BaseFunction;
  };
}

// What the site serves from S3, wherever OpenNext built it
const ASSETS: Pick<SitePlan, "assets" | "isrCache"> = {
  assets: [
    {
      from: ".open-next/assets",
      to: "_assets",
      cached: true,
      versionedSubDir: "_next",
      deepRoute: "_next",
    },
  ],
  isrCache: {
    from: ".open-next/cache",
    to: "_cache",
  },
};

// The site's build: where it is, and what OpenNext made
interface Build {
  /** The site's folder, from the app's folder */
  sitePath: string;
  /** The same, on this machine */
  outputPath: string;
  openNext: OpenNextOutput;
  buildId: string;
  base?: string;
  prerenderedRoutes: number;
}

// What the site created from its build
interface Built {
  plan: SitePlan;
  outputPath: string;
  servers: { region: string; server: Function }[];
  imageOptimizer: Function;
}

/**
 * The `Nextjs` component lets you deploy [Next.js](https://nextjs.org) apps on AWS. It uses
 * [OpenNext](https://open-next.js.org) to build your Next.js app, and transforms the build
 * output to a format that can be deployed to AWS.
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy the Next.js app that's in the project root.
 *
 * ```js title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys a Next.js app in the `my-next-app/` directory.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   path: "my-next-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Next.js app.
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4} title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   domain: {
 *     name: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your Next.js app. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {4} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your Next.js app.
 *
 * ```ts title="app/page.tsx"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Switch from `sst.aws.Nextjs`
 *
 * Change `sst.aws.Nextjs` to `sst.aws.v5.Nextjs` and keep the name. The site's bucket, its
 * functions, its ISR queue and table, and its CloudFront distribution or its entry in the
 * router are kept. A few things are written differently:
 *
 * - The site is built in the deploy itself, once, with the values of what it's linked to.
 *   `sst.aws.Nextjs` built it with a command it kept in the state, which goes.
 * - `sst diff` builds the site too, to show what the build creates. Values that aren't known
 *   until the deploy, like those of what the same deploy creates on a new stage, are left
 *   out of that build, and a link none of whose properties are known is passed with only
 *   its `type`. A build that checks its environment, or reads a link while it prerenders,
 *   has to allow for that. `sst.aws.Nextjs` skipped its build in `sst diff` then.
 * - A deploy that previews first, on a stage with checks or with a policy pack, builds the
 *   site twice: in the preview, and in the deploy.
 * - `regions`, `warm`, `protection`, `edge`, `router`, `invalidation`, `imageOptimization`
 *   and `server` have to be plain values, not outputs: they decide what's created. So do
 *   `path`, `buildCommand` and `openNextVersion`, which the build reads, and the `name`,
 *   `aliases` and `redirects` of `domain`.
 * - `route` and `cdn` are gone. Serve the site through a Router with `router`.
 * - `nodes.server` holds the server of each region, by region, each an output:
 *   `nodes.server["us-east-1"]`. Without `regions`, that's the app's region. When the site
 *   is given an AWS provider of its own, the server is listed once it's created; set
 *   `regions` to have it from the start.
 * - `nodes.revalidationQueue` and `nodes.revalidationTable` are outputs that are
 *   `undefined` when the build turns ISR off, and the revalidation function is the queue's
 *   `nodes.subscriber`.
 * - `transform.revalidationEventsSubscriber` becomes the `subscriber` in the queue's own
 *   `transform`: `transform: { revalidationQueue: { transform: { subscriber } } }`. In
 *   `sst dev`, the function the site runs as is `transform.devServer`, not
 *   `transform.server`.
 * - `assets.textEncoding` sets the charset of text files. `sst.aws.Nextjs` ignored it and
 *   wrote `UTF-8`.
 * - The ISR data is seeded again when it changes, and with `warm` the server is warmed
 *   again when it's built. `sst.aws.Nextjs` did both on every deploy. The data is keyed by
 *   the build's id, which Next.js makes new on every build unless the app sets
 *   `generateBuildId`, so it's most often seeded on every deploy all the same. The switch
 *   does both once.
 * - With `warm`, the warmer's function, rule, target and permission move into the site.
 */
export class Nextjs extends component("sst:aws:Nextjs", parts) {
  private readonly siteUrl: Output<string>;

  constructor(
    name: string,
    args: NextjsArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    const self = this;
    const owner = `the "${name}" Nextjs site`;
    const option = (arg: string) => `The "${arg}" of ${owner}`;
    // What's built is read from these, and a preview has to know what's built
    const isBuilt =
      "The site is built with it, and a preview has to know what's built.";

    rejectOld();
    const sitePath = sitePathOf();

    // In `sst dev` the site runs on your machine, in a pane of its own
    if (context().dev && args.dev !== false) {
      const dev = args.dev ?? {};
      const devServer = this.part("devServer", {
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
      this.runsLocally();
      this.siteUrl = output(dev.url ?? URL_UNAVAILABLE);
      this.report({
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
      return;
    }

    // The args that decide which resources are created are read first
    const regionsArg = regionsOf();
    // The server's regions, when they're known before the build
    const serverRegions = regionsArg ?? appRegion();
    const warm = plain(args.warm, option("warm"));
    const invalidation = plainDeep(args.invalidation, option("invalidation"));
    const imageOptimization = plainDeep(
      args.imageOptimization,
      option("imageOptimization"),
    );
    const serverArgs = plain(args.server, option("server")) ?? {};
    const runtime = plain(
      serverArgs.runtime,
      option("server.runtime"),
      isBuilt,
    );
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
    const loader = plainDeep(
      serverArgs.loader,
      option("server.loader"),
      isBuilt,
    );
    const namespace = kvNamespace(name);
    const routing = router();
    const timeout = output(serverArgs.timeout).apply((t) => t ?? "20 seconds");
    const purge = output(args.assets).apply((a) => a?.purge ?? false);

    const bucket = this.part(
      "assets",
      { access: "cloudfront" },
      { retainOnDelete: false },
    );

    const build = buildSite({
      name,
      sitePath,
      command: buildCommandOf(),
      environment: args.environment,
      link: args.link,
    }).then(loadBuild);
    const built = this.after(build, createFromBuild);
    const builtOutput = output(built);
    promiseRegionalParts();

    const assetFiles = this.part("assetFiles", {
      bucketName: bucket.name,
      files: all([build, args.assets, routing.pathPrefix]).apply(
        ([build, assets, pathPrefix]) =>
          siteFiles({
            plan: ASSETS,
            outputPath: build.outputPath,
            assets: assets as Parameters<typeof siteFiles>[0]["assets"],
            pathPrefix,
            textEncoding: assets?.textEncoding ?? "UTF-8",
          }),
      ),
      purge,
      region: getRegionOutput({}, { parent: this }).region,
    });

    const kvKeys = this.part("kvKeys", {
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
          built.imageOptimizer.url,
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
      ? this.part("routesUpdate", {
          store: routing.route.routerKvStoreArn,
          namespace: routing.route.routerKvNamespace,
          key: "routes",
          entry: routing.route.apply((route) =>
            ["site", namespace, route.hostPattern, route.pathPrefix].join(","),
          ),
        })
      : undefined;

    createInvalidation();

    this.siteUrl = routing.url;
    this.report({ hint: this.siteUrl });

    function rejectOld() {
      notAnOption(
        args,
        "route",
        `Serve the site through a Router with "router": { instance: router, path, domain }.`,
      );
      notAnOption(
        args,
        "cdn",
        `sst.aws.Nextjs no longer took it either. Serve the site through a Router with "router".`,
      );
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
      self.willCreate("server", serverRegions);
      if (warm)
        for (const key of [
          "warmer",
          "warmerRule",
          "warmerTarget",
          "warmerPermission",
          "prewarm",
        ] as const)
          self.willCreate(key, serverRegions);
      if (routing.signs === false) self.willCreate("urlAccess", serverRegions);
      if (routing.signs === true)
        for (const key of ["cloudFrontUrlAccess", "cloudFrontInvoke"] as const)
          self.willCreate(key, serverRegions);
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

    function buildCommandOf() {
      const command = plain(args.buildCommand, option("buildCommand"), isBuilt);
      if (command) return command;
      const version =
        plain(args.openNextVersion, option("openNextVersion"), isBuilt) ??
        defaultOpenNextVersion();
      const packageName = isALteB(version, "3.1.3")
        ? "open-next"
        : "@opennextjs/aws";
      return `npx --yes ${packageName}@${version} build`;
    }

    // OpenNext dropped Next.js 14 after 3.6.6
    function defaultOpenNextVersion() {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(
            path.resolve(context().paths.root, sitePath, "package.json"),
            "utf-8",
          ),
        );
        const nextVersion = pkg.dependencies?.next ?? pkg.devDependencies?.next;
        if (nextVersion && isALtB(nextVersion, "15.0.0"))
          return DEFAULT_OPEN_NEXT_VERSION_NEXT14;
      } catch {
        console.warn(
          `Failed to detect Next.js version. Using OpenNext v${DEFAULT_OPEN_NEXT_VERSION} as default.`,
        );
      }
      return DEFAULT_OPEN_NEXT_VERSION;
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
        edge.viewerRequest?.kvStore ?? self.part("kvStore", {}).arn,
      );
      const requestFunction = self.part("requestFunction", {
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
        ? self.part("responseFunction", {
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

      const cdn = self.part("cdn", {
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
      return self.part("cachePolicy", {
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

      const role = self.part(
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
      return self.part(
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

    // Reads what OpenNext built
    function loadBuild(builtPath: string): Build {
      const outputPath = path.resolve(context().paths.root, builtPath);
      const openNextOutputPath = path.join(
        outputPath,
        ".open-next",
        "open-next.output.json",
      );
      if (!fs.existsSync(openNextOutputPath))
        throw new VisibleError(
          `Could not load OpenNext output file at "${openNextOutputPath}". Make sure your Next.js app was built correctly with OpenNext.`,
        );
      const openNext = JSON.parse(
        fs.readFileSync(openNextOutputPath).toString(),
      ) as OpenNextOutput;
      // open-next.output.json says the initialization function is at
      // ".open-next/initialization-function", which isn't where it is
      if (openNext.additionalProps?.initializationFunction)
        openNext.additionalProps.initializationFunction = {
          handler: "index.handler",
          bundle: ".open-next/dynamodb-provider",
        };
      if (Object.entries(openNext.edgeFunctions).length)
        throw new VisibleError(
          `Lambda@Edge runtime is deprecated. Update your OpenNext configuration to use the standard Lambda runtime and deploy to multiple regions using the "regions" option in your Nextjs component.`,
        );

      let buildId: string;
      try {
        buildId = fs
          .readFileSync(path.join(outputPath, ".next/BUILD_ID"))
          .toString();
      } catch (e) {
        throw new VisibleError(
          `Build ID not found in ".next/BUILD_ID" for site "${name}". Ensure your Next.js app was built successfully.`,
        );
      }

      let base: string | undefined;
      try {
        const routes = JSON.parse(
          fs.readFileSync(
            path.join(outputPath, ".next", "routes-manifest.json"),
            "utf-8",
          ),
        ) as { basePath: string };
        base = routes.basePath === "" ? undefined : routes.basePath;
      } catch (e) {
        throw new VisibleError(
          `Base path configuration not found in ".next/routes-manifest.json" for site "${name}". Check your Next.js configuration.`,
        );
      }

      let prerenderedRoutes = 0;
      try {
        const manifest = JSON.parse(
          fs
            .readFileSync(
              path.join(outputPath, ".next/prerender-manifest.json"),
            )
            .toString(),
        ) as { routes?: Record<string, unknown> };
        prerenderedRoutes = Object.keys(manifest.routes ?? {}).length;
      } catch (e) {}

      return {
        sitePath: builtPath,
        outputPath,
        openNext,
        buildId,
        base,
        prerenderedRoutes,
      };
    }

    // Creates what's made from the build: the functions, ISR, the warmer and
    // the permissions
    async function createFromBuild(build: Build): Promise<Built> {
      const regions = serverRegions ?? [
        await known(
          getRegionOutput({}, { parent: self }).region,
          "The region of the site's server",
        ),
      ];
      if (!serverRegions) regions.forEach(checkRegion);
      const signs =
        typeof routing.signs === "boolean"
          ? routing.signs
          : await known(
              routing.signs,
              "Whether the router signs its requests to the site",
            );
      const authorization = signs ? ("iam" as const) : ("none" as const);

      const plan: SitePlan = {
        ...ASSETS,
        imageOptimizer: { prefix: "/_next/image" },
        buildId: build.buildId,
      };
      if (build.base) {
        // Starts with a slash, and doesn't end with one
        plan.base = build.base.startsWith("/") ? build.base : `/${build.base}`;
        plan.base = plan.base.replace(/\/$/, "");
      }
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

      const queue = createRevalidationQueue(build);
      const table = createRevalidationTable(build);
      createRevalidationSeeder(build, table);

      const serverOrigin = build.openNext.origins["default"];
      const servers = regions.map((region) => {
        const provider = useProvider(region as Region);
        const server = self.part(
          "server",
          region,
          {
            description: `${name} server`,
            bundle: path.join(build.sitePath, serverOrigin.bundle),
            handler: serverOrigin.handler,
            streaming: serverOrigin.streaming,
            runtime: runtime ?? "nodejs24.x",
            timeout,
            memory: output(serverArgs.memory).apply((v) => v ?? "1024 MB"),
            architecture: architecture ?? "x86_64",
            vpc: args.vpc,
            nodejs: {
              format: "esm" as const,
              install: Object.fromEntries(
                (install ?? []).map((pkg) => [pkg, "*"]),
              ),
              loader,
            },
            environment: output(args.environment).apply((environment) => ({
              ...environment,
              CACHE_BUCKET_NAME: bucket.name,
              CACHE_BUCKET_KEY_PREFIX: "_cache",
              CACHE_BUCKET_REGION: getRegionOutput({}, { parent: self }).region,
              ...(queue && {
                REVALIDATION_QUEUE_URL: queue.url,
                REVALIDATION_QUEUE_REGION: getRegionOutput({}, { parent: self })
                  .region,
              }),
              ...(table && {
                CACHE_DYNAMO_TABLE: table.name,
              }),
            })),
            permissions: output(args.permissions).apply((permissions) => [
              {
                actions: ["cloudfront:CreateInvalidation"],
                resources: ["*"],
              },
              ...(permissions ?? []),
              // access to the cache data
              {
                actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                resources: [interpolate`${bucket.arn}/*`],
              },
              {
                actions: ["s3:ListBucket"],
                resources: [bucket.arn],
              },
              ...(queue
                ? [
                    {
                      actions: [
                        "sqs:SendMessage",
                        "sqs:GetQueueAttributes",
                        "sqs:GetQueueUrl",
                      ],
                      resources: [queue.arn],
                    },
                  ]
                : []),
              ...(table
                ? [
                    {
                      actions: [
                        "dynamodb:BatchGetItem",
                        "dynamodb:GetRecords",
                        "dynamodb:GetShardIterator",
                        "dynamodb:Query",
                        "dynamodb:GetItem",
                        "dynamodb:Scan",
                        "dynamodb:ConditionCheckItem",
                        "dynamodb:BatchWriteItem",
                        "dynamodb:PutItem",
                        "dynamodb:UpdateItem",
                        "dynamodb:DeleteItem",
                        "dynamodb:DescribeTable",
                      ],
                      resources: [table.arn, interpolate`${table.arn}/*`],
                    },
                  ]
                : []),
            ]),
            injections: [
              ...(warm ? [serverWarmingInjection(serverOrigin.streaming)] : []),
              KEY_FILE_INJECTION,
            ],
            link: args.link,
            layers: output(serverArgs.layers).apply((layers) => [
              ...(layers ?? []),
            ]),
            url: { authorization },
            dev: false,
            _skipHint: true,
          },
          { provider },
        );
        if (warm) createWarmer(region, server, build);
        return { region, server };
      });

      const imageOptimizerOrigin = build.openNext.origins["imageOptimizer"];
      const imageOptimizer = self.part("imageOptimizer", {
        timeout: "25 seconds",
        logging: {
          retention: "3 days",
        },
        permissions: [
          {
            actions: ["s3:GetObject"],
            resources: [interpolate`${bucket.arn}/*`],
          },
        ],
        description: `${name} image optimizer`,
        handler: imageOptimizerOrigin.handler,
        bundle: path.join(build.sitePath, imageOptimizerOrigin.bundle),
        runtime: "nodejs24.x",
        architecture: "arm64",
        environment: {
          BUCKET_NAME: bucket.name,
          BUCKET_KEY_PREFIX: "_assets",
          ...(imageOptimization?.staticEtag
            ? { OPENNEXT_STATIC_ETAG: "true" }
            : {}),
        },
        memory: imageOptimization?.memory ?? "1536 MB",
        url: { authorization },
        dev: false,
        _skipMetadata: true,
        _skipHint: true,
      });

      // Who may call the functions' URLs
      for (const { region, server } of servers) {
        const opts = {
          provider: useProvider(region as Region),
          dependsOn: server.nodes.url ? [server.nodes.url] : [],
        };
        if (!signs) {
          self.part(
            "urlAccess",
            region,
            {
              action: "lambda:InvokeFunctionUrl",
              function: server.nodes.function.name,
              principal: "*",
              functionUrlAuthType: "NONE",
            },
            opts,
          );
          continue;
        }
        self.part(
          "cloudFrontUrlAccess",
          region,
          {
            action: "lambda:InvokeFunctionUrl",
            function: server.nodes.function.name,
            principal: "cloudfront.amazonaws.com",
            sourceArn: routing.distributionArn,
          },
          opts,
        );
        self.part(
          "cloudFrontInvoke",
          region,
          {
            action: "lambda:InvokeFunction",
            function: server.nodes.function.name,
            principal: "cloudfront.amazonaws.com",
            sourceArn: routing.distributionArn,
            invokedViaFunctionUrl: true,
          },
          opts,
        );
      }
      const afterUrl = {
        dependsOn: imageOptimizer.nodes.url ? [imageOptimizer.nodes.url] : [],
      };
      if (!signs)
        self.part(
          "imageOptimizerUrlAccess",
          {
            action: "lambda:InvokeFunctionUrl",
            function: imageOptimizer.nodes.function.name,
            principal: "*",
            functionUrlAuthType: "NONE",
          },
          afterUrl,
        );
      else {
        self.part(
          "imageOptimizerCloudFrontUrlAccess",
          {
            action: "lambda:InvokeFunctionUrl",
            function: imageOptimizer.nodes.function.name,
            principal: "cloudfront.amazonaws.com",
            sourceArn: routing.distributionArn,
          },
          afterUrl,
        );
        self.part(
          "imageOptimizerCloudFrontInvoke",
          {
            action: "lambda:InvokeFunction",
            function: imageOptimizer.nodes.function.name,
            principal: "cloudfront.amazonaws.com",
            sourceArn: routing.distributionArn,
            invokedViaFunctionUrl: true,
          },
          afterUrl,
        );
      }

      return { plan, outputPath: build.outputPath, servers, imageOptimizer };
    }

    function createRevalidationQueue(build: Build) {
      const props = build.openNext.additionalProps;
      if (props?.disableIncrementalCache) return;
      const revalidationFunction = props?.revalidationFunction;
      if (!revalidationFunction) return;

      const queue = self.part("revalidationQueue", {
        fifo: true,
        transform: {
          queue: {
            receiveWaitTimeSeconds: 20,
          },
        },
      });
      queue.subscribe(
        {
          description: `${name} ISR revalidator`,
          handler: revalidationFunction.handler,
          bundle: path.join(build.sitePath, revalidationFunction.bundle),
          runtime: "nodejs24.x",
          timeout: "30 seconds",
          permissions: [
            {
              actions: [
                "sqs:ChangeMessageVisibility",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
                "sqs:GetQueueUrl",
                "sqs:ReceiveMessage",
              ],
              resources: [queue.arn],
            },
          ],
          dev: false,
          _skipMetadata: true,
        },
        { batch: { size: 5 } },
      );
      return queue;
    }

    function createRevalidationTable(build: Build) {
      if (build.openNext.additionalProps?.disableTagCache) return;
      return self.part(
        "revalidationTable",
        {
          attributes: [
            { name: "tag", type: "S" },
            { name: "path", type: "S" },
            { name: "revalidatedAt", type: "N" },
          ],
          hashKey: "tag",
          rangeKey: "path",
          pointInTimeRecovery: {
            enabled: true,
          },
          billingMode: "PAY_PER_REQUEST",
          globalSecondaryIndexes: [
            {
              name: "revalidate",
              hashKey: "path",
              rangeKey: "revalidatedAt",
              projectionType: "ALL",
            },
          ],
        },
        { retainOnDelete: false },
      );
    }

    function createRevalidationSeeder(
      build: Build,
      table: dynamodb.Table | undefined,
    ) {
      const initializationFunction =
        build.openNext.additionalProps?.initializationFunction;
      if (!table || !initializationFunction) return;

      // Provision 128MB of memory for every 4,000 prerendered routes,
      // 1GB per 40,000, up to 10GB. This tends to use ~70% of the memory
      // provisioned when testing.
      const seeder = self.part("revalidationSeeder", {
        description: `${name} ISR revalidation data seeder`,
        handler: initializationFunction.handler,
        bundle: path.join(build.sitePath, initializationFunction.bundle),
        runtime: "nodejs24.x",
        timeout: "900 seconds",
        memory: `${Math.min(
          10240,
          Math.max(128, Math.ceil(build.prerenderedRoutes / 4000) * 128),
        )} MB`,
        permissions: [
          {
            actions: [
              "dynamodb:BatchWriteItem",
              "dynamodb:PutItem",
              "dynamodb:DescribeTable",
            ],
            resources: [table.arn],
          },
        ],
        environment: {
          CACHE_DYNAMO_TABLE: table.name,
        },
        dev: false,
        _skipMetadata: true,
        _skipHint: true,
      });
      self.part("revalidationSeed", {
        functionName: seeder.nodes.function.name,
        // Seeded again when what it seeds changes
        triggers: {
          version: hashOf(
            path.join(build.outputPath, initializationFunction.bundle),
          ),
        },
        input: JSON.stringify({
          RequestType: "Create",
        }),
      });
    }

    function createWarmer(region: string, server: Function, build: Build) {
      const provider = { provider: useProvider(region as Region) };
      const warmer = self.part(
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
      const rule = self.part(
        "warmerRule",
        region,
        {
          scheduleExpression: "rate(5 minutes)",
          state: "ENABLED",
        },
        provider,
      );
      self.part(
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
      self.part(
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
      self.part(
        "prewarm",
        region,
        {
          functionName: warmer.nodes.function.name,
          triggers: {
            version: build.buildId,
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
          built.imageOptimizer.nodes.function.codeSha256,
        ]).apply(([hashes, imageOptimizerHash]) =>
          of(hashes, imageOptimizerHash),
        );
      });
      self.part(
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
  }

  /**
   * The URL of the Next.js app.
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

// The server reads the values of its links from an encrypted file, when it
// has one
const KEY_FILE_INJECTION = [
  `outer:if (process.env.SST_KEY_FILE) {`,
  `  const { readFileSync } = await import("fs")`,
  `  const { createDecipheriv } = await import("crypto")`,
  `  const key = Buffer.from(process.env.SST_KEY, "base64");`,
  `  const encryptedData = readFileSync(process.env.SST_KEY_FILE);`,
  `  const nonce = Buffer.alloc(12, 0);`,
  `  const decipher = createDecipheriv("aes-256-gcm", key, nonce);`,
  `  const authTag = encryptedData.slice(-16);`,
  `  const actualCiphertext = encryptedData.slice(0, -16);`,
  `  decipher.setAuthTag(authTag);`,
  `  let decrypted = decipher.update(actualCiphertext);`,
  `  decrypted = Buffer.concat([decrypted, decipher.final()]);`,
  `  const decryptedData = JSON.parse(decrypted.toString());`,
  `  globalThis.SST_KEY_FILE_DATA = decryptedData;`,
  `}`,
].join("\n");

// A value, once it's known. What a preview knows is known.
async function known<T>(value: Input<T>, what: string): Promise<T> {
  const resolved = markUnknowns(await (output(value) as any).promise(true));
  if (resolved === unknown)
    throw new VisibleError(`${what} isn't known before the deploy.`);
  return resolved as T;
}

// A hash of the files in a folder, and their names
function hashOf(dir: string) {
  const hash = crypto.createHash("sha256");
  for (const file of globSync("**", {
    cwd: dir,
    nodir: true,
    dot: true,
  }).sort()) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(dir, file)));
  }
  return hash.digest("hex");
}
