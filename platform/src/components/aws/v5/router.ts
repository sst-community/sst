import path from "path";
import {
  ComponentResourceOptions,
  Input,
  Output,
  all,
  asset,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { cloudfront, cloudwatch, iam, lambda, wafv2 } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  many,
  named,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { notAnOption, plain } from "../../args";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import { DurationSeconds, toSeconds } from "../../duration";
import { Size, toMBs } from "../../size";
import { physicalName } from "../../naming";
import { RETENTION } from "../logging";
import { parseLambdaEdgeArn } from "../helpers/arn";
import { useProvider } from "../helpers/provider";
import type { AnyBucket } from "../helpers/bucket";
import { KvKeys } from "../resources/kv-keys";
import { KvRoutesUpdate } from "../providers/kv-routes-update";
import {
  CF_BLOCK_CLOUDFRONT_URL_INJECTION,
  CF_ROUTER_INJECTION,
  type ProtectionConfig,
  isSigning,
  kvNamespace,
  parsePattern,
  routerLookupCode,
} from "../router-code";
import { Cdn, type CdnDomainArgs, cdnDomain } from "./cdn";
import type { FunctionArn } from "./function";

const parts = {
  /**
   * The CloudFront distribution, with the custom domain.
   */
  cdn: Cdn,
  /**
   * The CloudFront KeyValueStore the routes are kept in. Not created when
   * `edge.viewerRequest.kvStore` is set: the routes are kept in that one.
   */
  kvStore: optional(cloudfront.KeyValueStore),
  /**
   * The cache policy of the distribution's behavior.
   */
  cachePolicy: named(cloudfront.CachePolicy, "ServerCachePolicy"),
  /**
   * The CloudFront function that runs on each request and sends it on to its route.
   */
  requestFunction: named(cloudfront.Function, "CloudfrontFunctionRequest"),
  /**
   * The CloudFront function that runs on each response, created with
   * `edge.viewerResponse`.
   */
  responseFunction: named(
    optional(cloudfront.Function),
    "CloudfrontFunctionResponse",
  ),
  /**
   * The role of the Lambda@Edge function that signs requests. Created with
   * `protection: "oac-with-edge-signing"`, unless `protection.edgeFunction.arn` is set.
   */
  edgeRole: named(optional(iam.Role), "EdgeFunctionRole"),
  /**
   * The Lambda@Edge function that signs requests, in `us-east-1`. Created with
   * `protection: "oac-with-edge-signing"`, unless `protection.edgeFunction.arn` is set.
   */
  edgeFunction: optional(lambda.Function),
  /**
   * The WAF web ACL, in `us-east-1`. Created with `waf`.
   */
  waf: optional(wafv2.WebAcl),
  /**
   * The log group the WAF writes to, in `us-east-1`. Created with `waf.logging`.
   */
  wafLogGroup: optional(cloudwatch.LogGroup),
  /**
   * What sends the WAF's logs to its log group. Created with `waf.logging`.
   */
  wafLogging: optional(wafv2.WebAclLoggingConfiguration),
  /**
   * Where each route of `route()` and `routeBucket()` goes, in the KeyValueStore, by
   * the route's pattern.
   */
  routeKey: many(KvKeys),
  /**
   * What adds each route of `route()` and `routeBucket()` to the router's list of
   * routes, by the route's pattern.
   */
  routesUpdate: many(KvRoutesUpdate),
};

interface RouteArgs {
  /**
   * The number of times that CloudFront attempts to connect to the origin. Must be
   * between 1 and 3.
   * @default 3
   * @example
   * ```js
   * {
   *   connectionAttempts: 1
   * }
   * ```
   */
  connectionAttempts?: Input<number>;
  /**
   * The number of seconds that CloudFront waits before timing out and closing the
   * connection to the origin. Must be between 1 and 10 seconds.
   * @default `"10 seconds"`
   * @example
   * ```js
   * {
   *   connectionTimeout: "3 seconds"
   * }
   * ```
   */
  connectionTimeout?: Input<DurationSeconds>;
}

export interface RouterUrlRouteArgs extends RouteArgs {
  /**
   * Rewrite the request path.
   *
   * @example
   *
   * If the route path is `/api/*` and a request comes in for `/api/users/profile`,
   * the request path the destination sees is `/api/users/profile`.
   *
   * If you want to serve the route from the root, you can rewrite the request
   * path to `/users/profile`.
   *
   * ```js
   * {
   *   rewrite: {
   *     regex: "^/api/(.*)$",
   *     to: "/$1"
   *   }
   * }
   * ```
   */
  rewrite?: Input<{
    /**
     * The regex to match the request path.
     */
    regex: Input<string>;
    /**
     * The replacement for the matched path.
     */
    to: Input<string>;
  }>;
  /**
   * The number of seconds that CloudFront waits for a response after routing a
   * request to the destination. Must be between 1 and 60 seconds.
   *
   * When compared to the `connectionTimeout`, this is the time CloudFront waits
   * for each connection attempt. If the destination doesn't respond, CloudFront
   * tries again, up to `connectionAttempts` times (3 by default), so the request
   * can take that many times this value to fail.
   *
   * The Router applies this timeout dynamically to matching requests through
   * its CloudFront Function. It does not change the distribution's static
   * origin configuration. When you don't set it, the requests use the 20 seconds
   * that the Router sets on the distribution's origin by default.
   *
   * @default `"20 seconds"`
   * @example
   * ```js
   * {
   *   readTimeout: "60 seconds"
   * }
   * ```
   */
  readTimeout?: Input<DurationSeconds>;
  /**
   * The number of seconds that CloudFront should try to maintain the connection
   * to the destination after receiving the last packet of the response. Must be
   * between 1 and 60 seconds
   *
   * The Router passes this value to CloudFront with each matching request, but
   * CloudFront currently does not apply it. It keeps the connection for the
   * keep-alive timeout of the distribution's origin, which is 5 seconds by
   * default, whatever you set here.
   *
   * @default `"5 seconds"`
   * @example
   * ```js
   * {
   *   keepAliveTimeout: "10 seconds"
   * }
   * ```
   */
  keepAliveTimeout?: Input<DurationSeconds>;
  /**
   * Sign the requests to this route with the Router's [`protection`](/docs/component/aws/v5/router/#protection).
   *
   * This only applies when the destination is a Lambda function URL (a host like
   * `<id>.lambda-url.<region>.on.aws`) and the Router has `protection` set. For any
   * other destination, such as a function URL behind a custom domain, the route is
   * not signed and the option has no effect.
   *
   * It is off by default, because a URL can't tell a function URL with IAM
   * authorization from a public one, so the route has to say that it should be signed.
   *
   * The signature replaces the `Authorization` header of the viewer's request.
   * Signing is meant for function URLs with `"iam"` authorization. A public one is
   * signed too, but gains nothing. CloudFront needs permission to invoke the
   * function. [Read more](/docs/component/aws/v5/router/#protection).
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   protection: true
   * }
   * ```
   */
  protection?: Input<boolean>;
}

export interface RouterBucketRouteArgs extends RouteArgs {
  /**
   * Rewrite the request path.
   *
   * @example
   *
   * If the route path is `/files/*` and a request comes in for `/files/logo.png`,
   * the request path the destination sees is `/files/logo.png`.
   *
   * If you want to serve the file from the root of the bucket, you can rewrite
   * the request path to `/logo.png`.
   *
   * ```js
   * {
   *   rewrite: {
   *     regex: "^/files/(.*)$",
   *     to: "/$1"
   *   }
   * }
   * ```
   */
  rewrite?: Input<{
    /**
     * The regex to match the request path.
     */
    regex: Input<string>;
    /**
     * The replacement for the matched path.
     */
    to: Input<string>;
  }>;
}

export interface WafLoggingArgs {
  /**
   * Filter which requests are logged.
   *
   * - `"all"` logs every request evaluated by the WAF.
   * - `"blocked"` only logs requests that were blocked.
   *
   * @default `"all"`
   * @example
   * ```js
   * {
   *   waf: {
   *     logging: {
   *       include: "blocked"
   *     }
   *   }
   * }
   * ```
   */
  include?: Input<"all" | "blocked">;
  /**
   * The duration the WAF logs are kept in CloudWatch.
   *
   * @default `"1 month"`
   * @example
   * ```js
   * {
   *   waf: {
   *     logging: {
   *       retention: "3 months"
   *     }
   *   }
   * }
   * ```
   */
  retention?: Input<keyof typeof RETENTION>;
  /**
   * Configure which parts of the request are redacted from the logs. Redacted
   * fields are replaced with `REDACTED` in the log output.
   *
   * By default, the query string and the `cookie` and `authorization` headers
   * are redacted since they commonly contain PII or credentials.
   *
   * Set to `false` to disable all redaction.
   *
   * @default `{ queryString: true, headers: ["cookie", "authorization"] }`
   * @example
   *
   * Disable all redaction.
   *
   * ```js
   * {
   *   waf: {
   *     logging: {
   *       redact: false
   *     }
   *   }
   * }
   * ```
   *
   * Redact everything.
   *
   * ```js
   * {
   *   waf: {
   *     logging: {
   *       redact: {
   *         queryString: true,
   *         uriPath: true,
   *         method: true,
   *         headers: ["cookie", "authorization"]
   *       }
   *     }
   *   }
   * }
   * ```
   */
  redact?: Input<
    | false
    | {
        /**
         * Redact the query string from the logs. The query string is the
         * part of a URL after the `?` and can contain tokens, user IDs,
         * or other sensitive parameters.
         * @default `true`
         */
        queryString?: Input<boolean>;
        /**
         * Redact the URI path from the logs. The URI path identifies the
         * resource being accessed, like `/users/123/profile`.
         * @default `false`
         */
        uriPath?: Input<boolean>;
        /**
         * Redact the HTTP method from the logs (GET, POST, etc.).
         * @default `false`
         */
        method?: Input<boolean>;
        /**
         * A list of header names to redact from the logs. Must be lowercase.
         * @default `["cookie", "authorization"]`
         * @example
         * ```js
         * {
         *   headers: ["cookie", "authorization", "x-api-key"]
         * }
         * ```
         */
        headers?: Input<string[]>;
      }
  >;
}

export interface WafArgs {
  /**
   * The rate limit per IP address. Requests from an IP that exceed this limit
   * within a 5-minute window will be blocked.
   *
   * @default `2000`
   * @example
   * ```js
   * {
   *   waf: {
   *     rateLimitPerIp: 1000
   *   }
   * }
   * ```
   */
  rateLimitPerIp?: Input<number>;
  /**
   * Configure which AWS managed rule groups to enable.
   *
   * @default All managed rules enabled
   * @example
   * ```js
   * {
   *   waf: {
   *     managedRules: {
   *       coreRuleSet: true,
   *       knownBadInputs: true,
   *       sqlInjection: false
   *     }
   *   }
   * }
   * ```
   */
  managedRules?: Input<{
    /**
     * Enable the AWS Core Rule Set (CRS) which provides protection against common
     * web vulnerabilities.
     * @default `true`
     */
    coreRuleSet?: Input<boolean>;
    /**
     * Enable protection against known bad inputs, including Log4j vulnerabilities.
     * @default `true`
     */
    knownBadInputs?: Input<boolean>;
    /**
     * Enable SQL injection protection.
     * @default `true`
     */
    sqlInjection?: Input<boolean>;
  }>;
  /**
   * Configure WAF logging to CloudWatch. When set to `true`, all WAF-evaluated
   * requests are logged with a 1-month retention. Or pass in an object to
   * customize what is logged, how long logs are retained, and which fields
   * are redacted.
   *
   * :::tip
   * WAF logging is off by default. Enabling it will incur additional
   * [CloudWatch costs](https://aws.amazon.com/cloudwatch/pricing/) depending
   * on log volume.
   * :::
   *
   * @default Logging is disabled
   * @example
   *
   * Enable with defaults.
   *
   * ```js
   * {
   *   waf: {
   *     logging: true
   *   }
   * }
   * ```
   *
   * Only log blocked requests.
   *
   * ```js
   * {
   *   waf: {
   *     logging: {
   *       include: "blocked",
   *       retention: "3 months"
   *     }
   *   }
   * }
   * ```
   *
   * Redact sensitive fields.
   *
   * ```js
   * {
   *   waf: {
   *     logging: {
   *       redact: {
   *         queryString: true,
   *         headers: ["cookie"]
   *       }
   *     }
   *   }
   * }
   * ```
   */
  logging?: boolean | WafLoggingArgs;
}

export interface RouterArgs extends ComponentArgs<typeof parts> {
  /**
   * Set a custom domain for your Router. It has to be a plain value, and so do its
   * `name`, `aliases` and `redirects`.
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
       * - Disable CloudFront default URL if custom domain is set.
       * - Add the `x-forwarded-host` header.
       * - Route requests to the corresponding target based on the domain and request path.
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
       */
      injection: Input<string>;
      /**
       * The KeyValueStore to associate with the viewer request function.
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
     * The viewer response function can be used to modify outgoing responses before
     * they are sent to the client. For example, you can add security headers or change
     * the response status code.
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
       * The KeyValueStore to associate with the viewer response function.
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
   * Configure Lambda function URL protection through CloudFront Origin Access Control.
   *
   * When set, all Functions and SSR sites routing through this Router automatically
   * inherit the protection mode.
   *
   * @default `"none"`
   *
   * The available options are:
   * - `"none"`: Lambda URLs are publicly accessible.
   * - `"oac"`: Lambda URLs protected by CloudFront Origin Access Control. Requires
   *   manual `x-amz-content-sha256` header for POST, PUT and PATCH requests.
   * - `"oac-with-edge-signing"`: Full protection with automatic header signing via
   *   Lambda@Edge. Works with external webhooks and callbacks. Higher cost and latency
   *   but works out of the box.
   *
   * :::note
   * Switching from `"none"` to `"oac"` or `"oac-with-edge-signing"` may cause brief
   * 403 errors (~10-60s) during deployment while CloudFront edge nodes pick up the new
   * signing configuration. For zero-disruption upgrades, set `protection` when first
   * creating the Router.
   * :::
   *
   * :::note
   * When using `"oac-with-edge-signing"`, request bodies are limited to 1MB due to
   * Lambda@Edge payload limits. For file uploads larger than 1MB, consider using
   * presigned S3 URLs or the `"oac"` mode with manual header signing.
   * :::
   *
   * :::note
   * A Lambda function URL added with `router.route()` is signed when the route sets
   * `protection: true`. It is off by default, because only you know whether the URL
   * uses `"iam"` authorization. For example, `router.route("/api", fn.url, { protection: true })`.
   *
   * `router.route()` only receives a URL, so it cannot create the Lambda permissions.
   * Allow the `cloudfront.amazonaws.com` principal to call `lambda:InvokeFunctionUrl`
   * and `lambda:InvokeFunction` on the function, with this Router's distribution as
   * the source ARN. Get the ARN with
   * `router.nodes.cdn.nodes.distribution.arn`. Set
   * `invokedViaFunctionUrl: true` on the `lambda:InvokeFunction` permission.
   *
   * With `"oac"`, `POST`, `PUT` and `PATCH` requests to a function URL with `"iam"`
   * authorization also need the `x-amz-content-sha256` header. The signature replaces
   * the `Authorization` header of the viewer's request, so the function does not
   * receive it. Send tokens in a different header.
   * :::
   *
   * :::note
   * When removing a stage that uses `"oac-with-edge-signing"`, deletion may take
   * 5-10 minutes while AWS removes the Lambda@Edge replicated functions from all
   * edge locations.
   * :::
   *
   * @example
   * ```js
   * {
   *   protection: "oac"
   * }
   * ```
   *
   * @example
   * ```js
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
   * Enable AWS WAF (Web Application Firewall) to protect your Router from common
   * web exploits and bots.
   *
   * :::tip
   * WAF provides protection against SQL injection, cross-site scripting (XSS),
   * and other common attacks.
   * :::
   *
   * @default WAF is disabled
   * @example
   *
   * Enable with sensible defaults.
   *
   * ```js
   * {
   *   waf: true
   * }
   * ```
   *
   * Or customize the configuration.
   *
   * ```js
   * {
   *   waf: {
   *     rateLimitPerIp: 1000,
   *     managedRules: {
   *       coreRuleSet: true,
   *       knownBadInputs: true,
   *       sqlInjection: true
   *     }
   *   }
   * }
   * ```
   */
  waf?: boolean | WafArgs;
  /**
   * @internal
   */
  _skipHint?: boolean;
}

// The router's `protection`, as an object
type Protection = {
  mode: ProtectionConfig["mode"];
  edgeFunction?: {
    arn?: Input<string>;
    memory?: Input<Size>;
    timeout?: Input<DurationSeconds>;
  };
};

// Where the router keeps its routes, and whether it signs its requests: what
// a route, a function or a site served through it reads. A router that's
// referenced with `get` reads them from its distribution's tags.
interface Routing {
  kvStoreArn: Output<string>;
  kvNamespace: Input<string>;
  protection: Input<Protection>;
  signs: boolean | Output<boolean>;
  hasInlineRoutes: Input<boolean>;
}

/**
 * The `Router` component lets you use a CloudFront distribution to direct
 * requests to various parts of your application like:
 *
 * - A URL
 * - A function
 * - A frontend
 * - An S3 bucket
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Router("MyRouter");
 * ```
 *
 * #### Add a custom domain
 *
 * ```ts {2} title="sst.config.ts"
 * new sst.aws.v5.Router("MyRouter", {
 *   domain: "myapp.com"
 * });
 * ```
 *
 * #### Sharing the router across stages
 *
 * ```ts title="sst.config.ts"
 * const router = $app.stage === "production"
 *   ? new sst.aws.v5.Router("MyRouter", {
 *       domain: {
 *         name: "example.com",
 *         aliases: ["*.example.com"]
 *       }
 *     })
 *   : sst.aws.v5.Router.get("MyRouter", "E1XWRGCYGTFB7Z");
 * ```
 *
 * #### Route to a URL
 *
 * ```ts title="sst.config.ts" {3}
 * const router = new sst.aws.v5.Router("MyRouter");
 *
 * router.route("/", "https://some-external-service.com");
 * ```
 *
 * #### Route to an S3 bucket
 *
 * ```ts title="sst.config.ts" {2,6}
 * const myBucket = new sst.aws.v5.Bucket("MyBucket", {
 *   access: "cloudfront"
 * });
 *
 * const router = new sst.aws.v5.Router("MyRouter");
 * router.routeBucket("/files", myBucket);
 * ```
 *
 * You need to allow CloudFront to access the bucket by setting the `access` prop
 * on the bucket.
 *
 * #### Route to a function
 *
 * ```ts title="sst.config.ts" {8-11}
 * const router = new sst.aws.v5.Router("MyRouter", {
 *   domain: "example.com"
 * });
 *
 * const myFunction = new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/api.handler",
 *   url: {
 *     router: {
 *       instance: router,
 *       path: "/api"
 *     }
 *   }
 * });
 * ```
 *
 * Setting the route through the function, instead of `router.route()` makes
 * it so that `myFunction.url` gives you the URL based on the Router domain.
 *
 * #### Route to a frontend
 *
 * ```ts title="sst.config.ts" {4-6}
 * const router = new sst.aws.v5.Router("MyRouter");
 *
 * const mySite = new sst.aws.Nextjs("MyWeb", {
 *   router: {
 *     instance: router
 *   }
 * });
 * ```
 *
 * Setting the route through the site, instead of `router.route()` makes
 * it so that `mySite.url` gives you the URL based on the Router domain.
 *
 * #### Route to a frontend on a path
 *
 * ```ts title="sst.config.ts" {4-7}
 * const router = new sst.aws.v5.Router("MyRouter");
 *
 * new sst.aws.Nextjs("MyWeb", {
 *   router: {
 *     instance: router,
 *     path: "/docs"
 *   }
 * });
 * ```
 *
 * If you are routing to a path, you'll need to configure the base path in your
 * frontend app as well. [Learn more](/docs/component/aws/nextjs/#router).
 *
 * #### Route to a frontend on a subdomain
 *
 * ```ts title="sst.config.ts" {4,9-12}
 * const router = new sst.aws.v5.Router("MyRouter", {
 *   domain: {
 *     name: "example.com",
 *     aliases: ["*.example.com"]
 *   }
 * });
 *
 * new sst.aws.Nextjs("MyWeb", {
 *   router: {
 *     instance: router,
 *     domain: "docs.example.com"
 *   }
 * });
 * ```
 *
 * We configure `*.example.com` as an alias so that we can route to a subdomain.
 *
 * #### How it works
 *
 * This uses a CloudFront KeyValueStore to store the routing data and a CloudFront
 * function to route the request. As routes are added, the store is updated.
 *
 * So when a request comes in, it does a lookup in the store and dynamically sets
 * the origin based on the routing data. For frontends, that have their server
 * functions deployed to multiple `regions`, it routes to the closest region based
 * on the user's location.
 *
 * You might notice a _placeholder.sst.dev_ behavior in CloudFront. This is not
 * used and is only there because CloudFront requires a default behavior.
 *
 * #### Limits
 *
 * There are some limits on this setup but it's managed by SST.
 *
 * - The CloudFront function can be a maximum of 10KB in size. But because all
 *   the route data is stored in the KeyValueStore, the function can be kept small.
 * - Each value in the KeyValueStore needs to be less than 1KB. This component
 *   splits the routes into multiple values to keep it under the limit.
 * - The KeyValueStore can be a maximum of 5MB. This is fairly large. But to
 *   handle sites that have a lot of files, only top-level assets get individual
 *   entries. Folders with prerendered routes are the exception: their files get
 *   entries too, up to 1MB per site, so they don't hide server routes.
 *
 * ---
 *
 * #### Switch from `sst.aws.Router`
 *
 * Change `sst.aws.Router` to `sst.aws.v5.Router` and keep the name. The distribution, its
 * domain, the key-value store, the functions and every route are kept. Each route's entries
 * in the store are written again by a resource of a new type, which the `sst` binary
 * serves, and `sst migrate` takes the old ones out of the state without deleting them. A few
 * things are written differently:
 *
 * - `routes` is gone. Add each route with `route()` or `routeBucket()`. A router that's
 *   deployed with `routes` switches to `route()` on `sst.aws.Router` first, then to this
 *   one: `sst migrate --check` fails on one that hasn't.
 * - `invalidation` is gone. `sst.aws.Router` never used it. A site served through the
 *   router invalidates its own files, with its own `invalidation`.
 * - `domain`, `edge`, `edge.viewerRequest`, `edge.viewerResponse`, `protection`,
 *   `protection.edgeFunction`, `waf` and `waf.logging` have to be plain values, not
 *   outputs. So does the pattern you give `route()` and `routeBucket()`.
 * - `nodes.cdn` is the `Cdn` itself, not an output.
 * - `transform` also takes the key-value store, the functions, the Lambda@Edge function
 *   and its role, and each route's entries in the store.
 * - A route is part of the router: `sst.aws.Router` kept each one in a component of its
 *   own at the top of your app. A switch takes those components out of the state, which
 *   changes nothing in AWS.
 * - An `sst.aws.Function` that links the router and is routed to with `route()` would
 *   wait on its own route, and never be deployed: it waits for everything in what it
 *   links. Switch it to `sst.aws.v5.Function` with the router, or serve it with its own
 *   `url.router`.
 * - If you set `tags` on the CDN with an object in `transform`, it keeps the tags SST
 *   sets next to yours. They're added back when you switch, and a stage that references
 *   this router with `get` reads them.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const router = new sst.aws.Router("MyRouter", { domain: "example.com" });
 * const router = new sst.aws.v5.Router("MyRouter", { domain: "example.com" });
 * ```
 */
export class Router extends component("sst:aws:Router", parts) {
  private readonly routing: Routing;

  constructor(
    name: string,
    args: RouterArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const cdn = this.existingPart("cdn");
    this.routing = cdn ? this.reference(name, cdn) : this.create(name, args);
    if (!args._skipHint) this.report({ hint: this.url });
  }

  private create(name: string, args: RouterArgs): Routing {
    const self = this;
    const owner = `the "${name}" Router`;

    if ((args as { routes?: unknown }).routes !== undefined)
      throw new VisibleError(
        `"routes" isn't an option of ${owner}. Add each route with "route(pattern, url)" or "routeBucket(pattern, bucket)". A Router that's deployed with "routes" switches to those on sst.aws.Router first, then to sst.aws.v5.Router.`,
      );
    notAnOption(
      args,
      "invalidation",
      `sst.aws.Router never used it. A site served through ${owner} invalidates its own files, with its own "invalidation".`,
    );

    cdnDomain(args.domain, owner);
    const protection = protectionOf();
    const edge = edgeOf();
    const namespace = kvNamespace(name);
    const waf = createWaf();

    const kvStoreArn = output(
      edge.viewerRequest?.kvStore ?? this.part("kvStore", {}).arn,
    );
    const requestFunction = this.part("requestFunction", {
      runtime: "cloudfront-js-2.0",
      keyValueStoreAssociations: [kvStoreArn],
      code: interpolate`
import cf from "cloudfront";
async function handler(event) {
  ${edge.viewerRequest?.injection ?? ""}
  ${args.domain ? CF_BLOCK_CLOUDFRONT_URL_INJECTION : ""}
  ${CF_ROUTER_INJECTION}
  ${routerLookupCode(namespace)}
}`,
    });
    const responseFunction = edge.viewerResponse?.injection
      ? this.part("responseFunction", {
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
    const cachePolicy = this.part("cachePolicy", {
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
    const edgeSigner = signerOf();

    this.part("cdn", {
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
        cachePolicyId: cachePolicy.id,
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
      // What a stage that references this router with `get` reads
      tags: {
        "sst:ref:kv": kvStoreArn,
        "sst:ref:kv-namespace": namespace,
        "sst:ref:version": "2",
        "sst:ref:protection": protection.mode,
      },
      webAclArn: waf?.arn,
    });

    return {
      kvStoreArn,
      kvNamespace: namespace,
      protection,
      signs: isSigning(protection.mode),
      hasInlineRoutes: false,
    };

    function protectionOf(): Protection {
      const protection = plain(args.protection, `The "protection" of ${owner}`);
      if (!protection) return { mode: "none" };
      if (typeof protection === "string") return { mode: protection };
      plain(
        protection.edgeFunction,
        `The "protection.edgeFunction" of ${owner}`,
      );
      const arn = protection.edgeFunction?.arn;
      if (typeof arn === "string") parseLambdaEdgeArn(arn);
      return protection;
    }

    function edgeOf() {
      const edge = plain(args.edge, `The "edge" of ${owner}`) ?? {};
      plain(edge.viewerRequest, `The "edge.viewerRequest" of ${owner}`);
      plain(edge.viewerResponse, `The "edge.viewerResponse" of ${owner}`);
      return edge;
    }

    // The Lambda@Edge function that signs requests to function URLs: the
    // user's, or one the router creates
    function signerOf() {
      if (protection.mode !== "oac-with-edge-signing") return;
      const settings = protection.edgeFunction;
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

    function createWaf() {
      const settings = plain(args.waf, `The "waf" of ${owner}`);
      if (!settings) return;
      const config: WafArgs = settings === true ? {} : settings;

      const rules = all([
        config.rateLimitPerIp ?? 2000,
        config.managedRules ?? {},
      ]).apply(([rateLimit, managedRules]) => {
        const r: wafv2.WebAclArgs["rules"] = [];
        let priority = 0;

        r.push({
          name: "RateLimitPerIP",
          priority: priority++,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: rateLimit,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            cloudwatchMetricsEnabled: true,
            metricName: `${name}RateLimitPerIP`,
            sampledRequestsEnabled: true,
          },
        });

        if (managedRules.coreRuleSet !== false) {
          r.push({
            name: "AWSManagedRulesCommonRuleSet",
            priority: priority++,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: "AWS",
                name: "AWSManagedRulesCommonRuleSet",
                // Set SizeRestrictions_BODY to COUNT to avoid blocking large request bodies
                ruleActionOverrides: [
                  {
                    name: "SizeRestrictions_BODY",
                    actionToUse: { count: {} },
                  },
                ],
              },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: `${name}AWSManagedRulesCommonRuleSet`,
              sampledRequestsEnabled: true,
            },
          });
        }

        if (managedRules.knownBadInputs !== false) {
          r.push({
            name: "AWSManagedRulesKnownBadInputsRuleSet",
            priority: priority++,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: "AWS",
                name: "AWSManagedRulesKnownBadInputsRuleSet",
              },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: `${name}AWSManagedRulesKnownBadInputsRuleSet`,
              sampledRequestsEnabled: true,
            },
          });
        }

        if (managedRules.sqlInjection !== false) {
          r.push({
            name: "AWSManagedRulesSQLiRuleSet",
            priority: priority++,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: "AWS",
                name: "AWSManagedRulesSQLiRuleSet",
              },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: `${name}AWSManagedRulesSQLiRuleSet`,
              sampledRequestsEnabled: true,
            },
          });
        }

        return r;
      });

      // WAF must be created in us-east-1 for CloudFront
      const us = { provider: useProvider("us-east-1") };
      const waf = self.part(
        "waf",
        {
          scope: "CLOUDFRONT",
          defaultAction: { allow: {} },
          rules,
          visibilityConfig: {
            cloudwatchMetricsEnabled: true,
            metricName: `${name}Waf`,
            sampledRequestsEnabled: true,
          },
        },
        us,
      );

      const logging = plain(config.logging, `The "waf.logging" of ${owner}`);
      if (!logging) return waf;
      const settingsOf = output(logging === true ? {} : logging);

      // CloudWatch Log Group name MUST start with "aws-waf-logs-"
      const logGroup = self.part(
        "wafLogGroup",
        {
          name: `aws-waf-logs-${physicalName(64, name)}`,
          retentionInDays: settingsOf.apply(
            (l) => RETENTION[l.retention ?? "1 month"],
          ),
        },
        { ...us, ignoreChanges: ["name"] },
      );

      self.part(
        "wafLogging",
        {
          resourceArn: waf.arn,
          logDestinationConfigs: [logGroup.arn],
          redactedFields: settingsOf.apply((l) => {
            const redact =
              l.redact === false
                ? undefined
                : l.redact ?? {
                    queryString: true,
                    headers: ["cookie", "authorization"],
                  };
            if (!redact) return undefined;
            const fields: wafv2.WebAclLoggingConfigurationArgs["redactedFields"] &
              {}[] = [];
            if (redact.method) fields.push({ method: {} });
            if (redact.queryString) fields.push({ queryString: {} });
            if (redact.uriPath) fields.push({ uriPath: {} });
            for (const header of redact.headers ?? [])
              fields.push({ singleHeader: { name: header.toLowerCase() } });
            return fields;
          }),
          loggingFilter: settingsOf.apply((l) =>
            (l.include ?? "all") === "blocked"
              ? {
                  defaultBehavior: "DROP",
                  filters: [
                    {
                      behavior: "KEEP" as const,
                      requirement: "MEETS_ANY" as const,
                      conditions: [{ actionCondition: { action: "BLOCK" } }],
                    },
                  ],
                }
              : undefined,
          ),
        },
        us,
      );
      return waf;
    }
  }

  // A router deployed in another stage, found by its distribution. What it
  // was created with is in the distribution's tags.
  private reference(name: string, cdn: Cdn): Routing {
    const tags = cdn.nodes.distribution.tagsAll.apply((tags) => {
      if (tags?.["sst:ref:version"] !== "2")
        throw new VisibleError(
          [
            `There have been some minor changes to the "Router" component that's being referenced by "${name}".\n`,
            `To update, you'll need to redeploy the stage where the Router was created. And then redeploy this stage.`,
          ].join("\n"),
        );
      return {
        kvStoreArn: tags["sst:ref:kv"],
        kvNamespace: tags["sst:ref:kv-namespace"],
        hasInlineRoutes: tags["sst:ref:kv"] === undefined,
        protection: {
          mode: (tags["sst:ref:protection"] ??
            "none") as ProtectionConfig["mode"],
        },
      };
    });
    return {
      kvStoreArn: tags.kvStoreArn,
      kvNamespace: tags.kvNamespace,
      protection: tags.protection,
      signs: tags.protection.apply((p) => isSigning(p.mode)),
      hasInlineRoutes: tags.hasInlineRoutes,
    };
  }

  /**
   * The ID of the Router distribution.
   */
  public get distributionID() {
    const cdn = this.nodes.cdn;
    return cdn.whenDeployed(cdn.nodes.distribution.id);
  }

  /**
   * The URL of the Router.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated CloudFront URL.
   */
  public get url() {
    const cdn = this.nodes.cdn;
    return all([cdn.domainUrl, cdn.url]).apply(
      ([domainUrl, url]) => domainUrl ?? url,
    );
  }

  /** @internal */
  public get _kvStoreArn() {
    return this.routing.kvStoreArn;
  }

  /** @internal */
  public get _kvNamespace() {
    return output(this.routing.kvNamespace);
  }

  /** @internal */
  public get _hasInlineRoutes() {
    return output(this.routing.hasInlineRoutes);
  }

  /** @internal */
  public get _protection() {
    return output(this.routing.protection) as Output<ProtectionConfig>;
  }

  /**
   * Whether the router signs its requests to function URLs: plain unless the
   * router is referenced with `get`.
   * @internal
   */
  public get _signs() {
    return this.routing.signs;
  }

  /** @internal */
  public get _distributionArn() {
    const cdn = this.nodes.cdn;
    return cdn.whenDeployed(cdn.nodes.distribution.arn);
  }

  /**
   * Add a route to a destination URL.
   *
   * If the Router has [`protection`](#protection) set, set `protection: true` in the
   * route's `args` to sign requests to a Lambda function URL with Origin Access
   * Control. It is off by default. CloudFront also needs permission to invoke the
   * function, as described under `protection`.
   *
   * A request that matches none of the Router's routes gets a 404. To catch it
   * instead, add a route for `/`.
   *
   * @param pattern The path prefix to match for this route. It has to be a plain value:
   * the route is named after it.
   * @param url The destination URL to route matching requests to.
   * @param args Configure the route.
   *
   * @example
   *
   * You can match a route based on:
   *
   * - A path prefix like `/api`
   * - A domain pattern like `api.example.com`
   * - A combined pattern like `dev.example.com/api`
   *
   * For example, to match a path prefix.
   *
   * ```ts title="sst.config.ts"
   * router.route("/api", "https://api.example.com");
   * ```
   *
   * Or match a domain.
   *
   * ```ts title="sst.config.ts"
   * router.route("api.myapp.com/", "https://api.example.com");
   * ```
   *
   * Or a combined pattern.
   *
   * ```ts title="sst.config.ts"
   * router.route("dev.myapp.com/api", "https://api.example.com");
   * ```
   *
   * You can also rewrite the request path.
   *
   * ```ts title="sst.config.ts"
   * router.route("/api", "https://api.example.com", {
   *   rewrite: {
   *     regex: "^/api/(.*)$",
   *     to: "/$1"
   *   }
   * });
   * ```
   *
   * Here something like `/api/users/profile` will be routed to
   * `https://api.example.com/users/profile`.
   */
  public route(
    pattern: string,
    url: Input<string>,
    args?: Input<RouterUrlRouteArgs>,
  ) {
    const namespace = this.newRoute(pattern, args);
    const metadata = all([url, args, this.routing.signs]).apply(
      ([url, args, signs]) => {
        const u = new URL(url);
        const protocol = u.protocol.slice(0, -1);
        // Only a function URL can be signed for
        const useOac =
          args?.protection === true &&
          /^[a-z0-9]{32}\.lambda-url\.[a-z0-9-]+\.on\.aws$/.test(u.hostname) &&
          signs;
        const timeouts = (
          ["connectionTimeout", "readTimeout", "keepAliveTimeout"] as const
        ).flatMap((k) => {
          const value = args?.[k];
          return value ? [[k, toSeconds(value)]] : [];
        });
        return JSON.stringify({
          host: u.host,
          rewrite: args?.rewrite,
          origin: {
            protocol: useOac || protocol === "https" ? undefined : protocol,
            connectionAttempts: args?.connectionAttempts,
            ...(useOac
              ? {
                  originAccessControlConfig: {
                    enabled: true,
                    signingBehavior: "always",
                    signingProtocol: "sigv4",
                    originType: "lambda",
                  },
                }
              : {}),
            timeouts: timeouts.length
              ? Object.fromEntries(timeouts)
              : undefined,
          },
        });
      },
    );
    this.addRoute(pattern, namespace, "url", metadata);
    return this;
  }

  /**
   * Add a route to an S3 bucket.
   *
   * A request that matches none of the Router's routes gets a 404. To catch it
   * instead, add a route for `/`.
   *
   * @param pattern The path prefix to match for this route. It has to be a plain value:
   * the route is named after it.
   * @param bucket The S3 bucket to route matching requests to.
   * @param args Configure the route.
   *
   * @example
   *
   * Let's say you have an S3 bucket that gives CloudFront `access`.
   *
   * ```ts title="sst.config.ts" {2}
   * const bucket = new sst.aws.v5.Bucket("MyBucket", {
   *   access: "cloudfront"
   * });
   * ```
   *
   * You can match a pattern and route to it based on:
   *
   * - A path prefix like `/api`
   * - A domain pattern like `api.example.com`
   * - A combined pattern like `dev.example.com/api`
   *
   * For example, to match a path prefix.
   *
   * ```ts title="sst.config.ts"
   * router.routeBucket("/files", bucket);
   * ```
   *
   * Or match a domain.
   *
   * ```ts title="sst.config.ts"
   * router.routeBucket("files.example.com", bucket);
   * ```
   *
   * Or a combined pattern.
   *
   * ```ts title="sst.config.ts"
   * router.routeBucket("dev.example.com/files", bucket);
   * ```
   *
   * You can also rewrite the request path.
   *
   * ```ts title="sst.config.ts"
   * router.routeBucket("/files", bucket, {
   *   rewrite: {
   *     regex: "^/files/(.*)$",
   *     to: "/$1"
   *   }
   * });
   * ```
   *
   * Here something like `/files/logo.png` will be routed to
   * `/logo.png`.
   */
  public routeBucket(
    pattern: string,
    bucket: Input<AnyBucket>,
    args?: Input<RouterBucketRouteArgs>,
  ) {
    const namespace = this.newRoute(pattern, args);
    const metadata = all([
      output(bucket).apply((b) => b.nodes.bucket.bucketRegionalDomainName),
      args,
    ]).apply(([domain, args]) =>
      JSON.stringify({
        domain,
        rewrite: args?.rewrite,
        origin: {
          connectionAttempts: args?.connectionAttempts,
          timeouts: {
            connectionTimeout:
              args?.connectionTimeout && toSeconds(args.connectionTimeout),
          },
        },
      }),
    );
    this.addRoute(pattern, namespace, "bucket", metadata);
    return this;
  }

  /**
   * Add a route to a frontend or static site.
   *
   * @deprecated The `routeSite` function has been deprecated. Set the `route` on the
   * site components to route the site through this Router.
   * @internal
   */
  public routeSite(_pattern: Input<string>, _site: any): never {
    throw new VisibleError(
      `The "routeSite" function has been deprecated. Configure the new "route" prop on the site component to route the site through this Router.`,
    );
  }

  // Check a route that's about to be added, and give the prefix of what it
  // keeps in the store
  private newRoute(pattern: string, args: unknown) {
    plain(
      pattern,
      `The pattern of a route of the "${this.componentName}" Router`,
      "The route is named after it.",
    );
    this.assertNew(
      "route",
      "routeKey",
      pattern,
      Output.isInstance(args) ? {} : args ?? {},
      ["routeKey", "routesUpdate"],
    );
    // What 4.x named the component it kept the route in
    return kvNamespace(`${this.componentName}Route${pattern}`);
  }

  private addRoute(
    pattern: string,
    namespace: string,
    type: "url" | "bucket",
    metadata: Output<string>,
  ) {
    const { host, path } = parsePattern(pattern);
    this.part("routeKey", pattern, {
      store: this.routing.kvStoreArn,
      namespace,
      entries: { metadata },
      purge: false,
    });
    this.part("routesUpdate", pattern, {
      store: this.routing.kvStoreArn,
      namespace: this.routing.kvNamespace,
      key: "routes",
      entry: [type, namespace, host, path].join(","),
    });
  }

  /** @internal */
  public link() {
    return {
      properties: {
        url: this.url,
      },
    };
  }

  /**
   * Reference an existing Router with the given Router distribution ID.
   *
   * @param name The name of the component.
   * @param distributionID The ID of the existing Router distribution.
   * @param opts Resource options.
   *
   * This is useful when you create a Router in one stage and want to share it in
   * another. It avoids having to create a new Router in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share a Router across stages.
   * :::
   *
   * @example
   * Let's say you create a Router in the `dev` stage. And in your personal stage
   * `frank`, you want to share the same Router.
   *
   * ```ts title="sst.config.ts"
   * const router = $app.stage === "frank"
   *   ? sst.aws.v5.Router.get("MyRouter", "E2IDLMESRN6V62")
   *   : new sst.aws.v5.Router("MyRouter");
   * ```
   *
   * Here `E2IDLMESRN6V62` is the ID of the Router distribution created in the
   * `dev` stage. You can find this by outputting the distribution ID in the `dev`
   * stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   router: router.distributionID
   * };
   * ```
   *
   * Learn more about [how to configure a router for your app](/docs/configure-a-router).
   */
  public static get(
    name: string,
    distributionID: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Router(
      name,
      { existing: { cdn: distributionID } } as RouterArgs,
      opts,
    );
  }
}
