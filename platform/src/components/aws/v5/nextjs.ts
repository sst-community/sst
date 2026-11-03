import fs from "fs";
import path from "path";
import crypto from "crypto";
import { globSync } from "glob";
import {
  ComponentResourceOptions,
  Input,
  Output,
  interpolate,
} from "@pulumi/pulumi";
import { dynamodb, getRegionOutput, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  type PartsBuilder,
  component,
  deferred,
  named,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { plain, plainDeep } from "../../args";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import type { Size } from "../../size";
import { isALteB, isALtB } from "../../../util/compare-semver";
import type { RouteArgs } from "../helpers/router";
import {
  BUILD_READS_IT,
  type SiteBuild,
  type SsrFramework,
  type SsrSiteArgs,
  createSsrSite,
  ssrSiteParts,
  urlAccessArgs,
} from "../helpers/ssr-site";
import type { SitePlan } from "../site-code";
import type { CdnDomainArgs } from "./cdn";
import { Function, type FunctionArgs } from "./function";
import { Queue } from "./queue";

const DEFAULT_OPEN_NEXT_VERSION = "3.9.14";
const DEFAULT_OPEN_NEXT_VERSION_NEXT14 = "3.6.6";

const parts = () => ({
  ...ssrSiteParts(),
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
});

export interface NextjsArgs extends SsrSiteArgs, ComponentArgs<typeof parts> {
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
 * router are kept. Its files and its entries in the key-value store are written again by
 * resources of a new type, which the `sst` binary serves, and `sst migrate` takes the old
 * ones out of the state without deleting what they wrote. A few things are written
 * differently:
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
 * - `sst refresh` doesn't build the site, where `sst.aws.Nextjs` did. What's made from
 *   the build, like the servers in `nodes.server`, stays as it is, and isn't listed while
 *   it runs.
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
    const builder = this.builder();
    this.siteUrl = createSsrSite(
      builder,
      name,
      args,
      nextjsFramework(builder, name, args),
    ).url;
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

// A Next.js site's build, as OpenNext made it
interface NextBuild extends SiteBuild {
  openNext: OpenNextOutput;
  buildId: string;
  prerenderedRoutes: number;
}

// How a Next.js site is built, with OpenNext, and what it adds to what every
// site creates: ISR's queue, table and seed, and the image optimizer
function nextjsFramework(
  builder: PartsBuilder<ReturnType<typeof parts>>,
  name: string,
  args: NextjsArgs,
): SsrFramework<NextBuild> {
  const self = builder.component;
  let imageOptimization: NextjsArgs["imageOptimization"];

  return {
    label: "Nextjs",
    alwaysServes: true,
    check(option) {
      imageOptimization = plainDeep(
        args.imageOptimization,
        option("imageOptimization"),
      );
    },
    buildCommand(sitePath, option) {
      const version =
        plain(
          args.openNextVersion,
          option("openNextVersion"),
          BUILD_READS_IT,
        ) ?? defaultOpenNextVersion(sitePath);
      const packageName = isALteB(version, "3.1.3")
        ? "open-next"
        : "@opennextjs/aws";
      return `npx --yes ${packageName}@${version} build`;
    },
    load: loadBuild,
    server(build, site) {
      const queue = createRevalidationQueue(build);
      const table = createRevalidationTable(build);
      createRevalidationSeeder(build, table);

      const origin = build.openNext.origins["default"];
      const region = getRegionOutput({}, { parent: self }).region;
      return {
        bundle: path.join(build.sitePath, origin.bundle),
        handler: origin.handler,
        streaming: origin.streaming,
        environment: {
          CACHE_BUCKET_NAME: site.bucket.name,
          CACHE_BUCKET_KEY_PREFIX: "_cache",
          CACHE_BUCKET_REGION: region,
          ...(queue && {
            REVALIDATION_QUEUE_URL: queue.url,
            REVALIDATION_QUEUE_REGION: region,
          }),
          ...(table && {
            CACHE_DYNAMO_TABLE: table.name,
          }),
        },
        permissions: [
          // access to the cache data
          {
            actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            resources: [interpolate`${site.bucket.arn}/*`],
          },
          {
            actions: ["s3:ListBucket"],
            resources: [site.bucket.arn],
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
        ],
        injections: [KEY_FILE_INJECTION],
      };
    },
    extras(build, site) {
      const origin = build.openNext.origins["imageOptimizer"];
      const imageOptimizer = builder.part("imageOptimizer", {
        timeout: "25 seconds",
        logging: {
          retention: "3 days",
        },
        permissions: [
          {
            actions: ["s3:GetObject"],
            resources: [interpolate`${site.bucket.arn}/*`],
          },
        ],
        description: `${name} image optimizer`,
        handler: origin.handler,
        bundle: path.join(build.sitePath, origin.bundle),
        runtime: "nodejs24.x",
        architecture: "arm64",
        environment: {
          BUCKET_NAME: site.bucket.name,
          BUCKET_KEY_PREFIX: "_assets",
          ...(imageOptimization?.staticEtag
            ? { OPENNEXT_STATIC_ETAG: "true" }
            : {}),
        },
        memory: imageOptimization?.memory ?? "1536 MB",
        url: { authorization: site.signs ? "iam" : "none" },
        dev: false,
        _skipMetadata: true,
        _skipHint: true,
      });

      // Who may call its URL
      const access = urlAccessArgs(imageOptimizer, site.distributionArn);
      const afterUrl = {
        dependsOn: imageOptimizer.nodes.url ? [imageOptimizer.nodes.url] : [],
      };
      if (!site.signs)
        builder.part("imageOptimizerUrlAccess", access.public, afterUrl);
      else {
        builder.part(
          "imageOptimizerCloudFrontUrlAccess",
          access.cloudFrontUrl,
          afterUrl,
        );
        builder.part(
          "imageOptimizerCloudFrontInvoke",
          access.cloudFrontInvoke,
          afterUrl,
        );
      }
      return { imageOptimizer };
    },
  };

  // OpenNext dropped Next.js 14 after 3.6.6
  function defaultOpenNextVersion(sitePath: string) {
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

  // Reads what OpenNext built
  function loadBuild(builtPath: string): NextBuild {
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
          .readFileSync(path.join(outputPath, ".next/prerender-manifest.json"))
          .toString(),
      ) as { routes?: Record<string, unknown> };
      prerenderedRoutes = Object.keys(manifest.routes ?? {}).length;
    } catch (e) {}

    return {
      sitePath: builtPath,
      outputPath,
      openNext,
      buildId,
      prerenderedRoutes,
      serves: true,
      plan: {
        ...ASSETS,
        imageOptimizer: { prefix: "/_next/image" },
        buildId,
        ...(base !== undefined && { base }),
      },
    };
  }

  function createRevalidationQueue(build: NextBuild) {
    const props = build.openNext.additionalProps;
    if (props?.disableIncrementalCache) return;
    const revalidationFunction = props?.revalidationFunction;
    if (!revalidationFunction) return;

    const queue = builder.part("revalidationQueue", {
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

  function createRevalidationTable(build: NextBuild) {
    if (build.openNext.additionalProps?.disableTagCache) return;
    return builder.part(
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
    build: NextBuild,
    table: dynamodb.Table | undefined,
  ) {
    const initializationFunction =
      build.openNext.additionalProps?.initializationFunction;
    if (!table || !initializationFunction) return;

    // Provision 128MB of memory for every 4,000 prerendered routes,
    // 1GB per 40,000, up to 10GB. This tends to use ~70% of the memory
    // provisioned when testing.
    const seeder = builder.part("revalidationSeeder", {
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
    builder.part("revalidationSeed", {
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
