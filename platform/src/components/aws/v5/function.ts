import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  all,
  asset,
  ComponentResourceOptions,
  interpolate,
  Output,
  output,
  rootStackResource,
  runtime as pulumiRuntime,
  secret,
  unsecret,
} from "@pulumi/pulumi";
import {
  cloudwatch,
  ecr,
  getCallerIdentityOutput,
  getPartitionOutput,
  getRegionOutput,
  iam,
  lambda,
  s3,
  types,
} from "@pulumi/aws";
import { Image } from "@pulumi/docker-build";
import {
  type ComponentArgs,
  component,
  many,
  optional,
} from "../../parts-component";
import {
  ifSet,
  plain,
  plainDeep,
  withDefault,
  withoutDependencies,
} from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { Link } from "../../link";
import { logicalName, physicalName } from "../../naming";
import {
  Duration,
  DurationDays,
  DurationMinutes,
  toDays,
  toSeconds,
} from "../../duration";
import { Size, toMBs } from "../../size";
import type { Loader } from "esbuild";
import type { EsbuildOptions } from "../../esbuild";
import { rpc } from "../../rpc/rpc";
import { devStub } from "../../contract";
import { type Runtime, commandsOf, isRuntime } from "../../runtime";
import { warnOnce } from "../../../util/warn";
import { type AnyVpc, hasNat, isVpc } from "../helpers/vpc";
import { type AnyEfs, isEfs } from "../helpers/efs";
import { type AnyRouter, type RouteArgs, routeOf } from "../helpers/router";
import { RETENTION } from "../logging";
import { Permission, permission } from "../permission";
import { bootstrap } from "../helpers/bootstrap";
import { parseRoleArn, splitQualifiedFunctionArn } from "../helpers/arn";
import {
  FunctionBundle,
  FunctionFile,
  buildBundle,
  devBridgeBundle,
  injectHandler,
  zipCode,
} from "../helpers/function-code";
import { devStubCode, linkEncryptionKey } from "../helpers/function-shared";
import { FunctionEnvironmentUpdate } from "../providers/function-environment-update";
import { KvKeys } from "../resources/kv-keys";
import { KvRoutesUpdate } from "../providers/kv-routes-update";

const parts = {
  /**
   * The IAM Role the function uses. A role you passed by its ARN is looked up when you
   * read this, and the deploy fails if it doesn't exist.
   */
  role: iam.Role,
  /**
   * The CloudWatch Log Group the function's logs are stored in. It isn't created when
   * `logging` is `false`.
   */
  logGroup: optional(cloudwatch.LogGroup),
  /**
   * The function's code: a zip file in the asset bucket of your account. A Python
   * function deployed as a container has an `image` instead.
   */
  code: optional(s3.BucketObjectv2),
  /**
   * The source maps of the function's code, one for each file the build writes. They
   * are numbered from `0`, and they're only known once the function is built.
   */
  sourcemap: many(s3.BucketObjectv2),
  /**
   * The container image of a Python function that's deployed as a container.
   */
  image: optional(Image),
  /**
   * The AWS Lambda function.
   */
  function: lambda.Function,
  /**
   * The Lambda function URL, when `url` is enabled.
   */
  url: optional(lambda.FunctionUrl),
  /**
   * The alias the URL of a durable function points to.
   */
  urlAlias: optional(lambda.Alias),
  /**
   * The permission to call the function's URL: for everyone, or for the router's
   * distribution when the URL is behind a router that signs its requests.
   */
  urlAccess: optional(lambda.Permission),
  /**
   * The permission to invoke the function through its URL. It's given to whoever
   * `urlAccess` is.
   */
  urlInvoke: optional(lambda.Permission),
  /**
   * What the router needs to know to reach the function's URL, stored in the router's
   * key value store.
   */
  routeKey: optional(KvKeys),
  /**
   * The entry for the function's URL in the router's list of routes.
   */
  routesUpdate: optional(KvRoutesUpdate),
  /**
   * The provisioned concurrency of the function, when `concurrency.provisioned` is set.
   */
  provisioned: optional(lambda.ProvisionedConcurrencyConfig),
  /**
   * The settings for asynchronous invocations, when `retries` is set.
   */
  eventInvokeConfig: optional(lambda.FunctionEventInvokeConfig),
  /**
   * The environment variables added with `addEnvironment`.
   */
  environmentUpdate: optional(FunctionEnvironmentUpdate),
};

/**
 * The ARN of a Lambda function.
 */
export type FunctionArn = `arn:${string}` & {};

export interface FunctionPermissionArgs {
  /**
   * Configures whether the permission is allowed or denied.
   * @default `"allow"`
   * @example
   * ```ts
   * {
   *   effect: "deny"
   * }
   * ```
   */
  effect?: "allow" | "deny";
  /**
   * The [IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/reference_policies_actions-resources-contextkeys.html#actions_table) that can be performed.
   * @example
   * ```js
   * {
   *   actions: ["s3:*"]
   * }
   * ```
   */
  actions: string[];
  /**
   * The resourcess specified using the [IAM ARN format](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html).
   * @example
   * ```js
   * {
   *   resources: ["arn:aws:s3:::my-bucket/*"]
   * }
   * ```
   */
  resources: Input<Input<string>[]>;
  /**
   * Configure specific conditions for when the policy is in effect.
   *
   * @example
   * ```js
   * {
   *   conditions: [
   *     {
   *       test: "StringEquals",
   *       variable: "s3:x-amz-server-side-encryption",
   *       values: ["AES256"]
   *     },
   *     {
   *       test: "IpAddress",
   *       variable: "aws:SourceIp",
   *       values: ["10.0.0.0/16"]
   *     }
   *   ]
   * }
   * ```
   */
  conditions?: Input<
    Input<{
      /**
       * Name of the [IAM condition operator](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html) to evaluate.
       */
      test: Input<string>;
      /**
       * Name of a [Context Variable](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html#AvailableKeys) to apply the condition to. Context variables may either be standard AWS variables starting with `aws:` or service-specific variables prefixed with the service name.
       */
      variable: Input<string>;
      /**
       * The values to evaluate the condition against. If multiple values are provided, the condition matches if at least one of them applies. That is, AWS evaluates multiple values as though using an "OR" boolean operation.
       */
      values: Input<Input<string>[]>;
    }>[]
  >;
}

export interface FunctionUrlCorsArgs {
  /**
   * Allow cookies or other credentials in requests to the function URL.
   * @default `false`
   * @example
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowCredentials: true
   *     }
   *   }
   * }
   * ```
   */
  allowCredentials?: Input<boolean>;
  /**
   * The HTTP headers that origins can include in requests to the function URL.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowHeaders: ["date", "keep-alive", "x-custom-header"]
   *     }
   *   }
   * }
   * ```
   */
  allowHeaders?: Input<Input<string>[]>;
  /**
   * The origins that can access the function URL.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowOrigins: ["https://www.example.com", "http://localhost:60905"]
   *     }
   *   }
   * }
   * ```
   * Or the wildcard for all origins.
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowOrigins: ["*"]
   *     }
   *   }
   * }
   * ```
   */
  allowOrigins?: Input<Input<string>[]>;
  /**
   * The HTTP methods that are allowed when calling the function URL.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowMethods: ["GET", "POST", "DELETE"]
   *     }
   *   }
   * }
   * ```
   * Or the wildcard for all methods.
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowMethods: ["*"]
   *     }
   *   }
   * }
   * ```
   */
  allowMethods?: Input<
    Input<
      "*" | "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT"
    >[]
  >;
  /**
   * The HTTP headers you want to expose in your function to an origin that calls the function URL.
   * @default `[]`
   * @example
   * ```js
   * {
   *   url: {
   *     cors: {
   *       exposeHeaders: ["date", "keep-alive", "x-custom-header"]
   *     }
   *   }
   * }
   * ```
   */
  exposeHeaders?: Input<Input<string>[]>;
  /**
   * The maximum amount of time the browser can cache results of a preflight request. By
   * default the browser doesn't cache the results. The maximum value is `86400 seconds` or `1 day`.
   * @default `"0 seconds"`
   * @example
   * ```js
   * {
   *   url: {
   *     cors: {
   *       maxAge: "1 day"
   *     }
   *   }
   * }
   * ```
   */
  maxAge?: Input<Duration>;
}

export interface FunctionLoggingArgs {
  /**
   * The duration the function logs are kept in CloudWatch.
   *
   * It can't be set with a log group passed in `existing.logGroup`, which has its own
   * retention.
   *
   * @default `1 month`
   * @example
   * ```js
   * {
   *   logging: {
   *     retention: "forever"
   *   }
   * }
   * ```
   */
  retention?: Input<keyof typeof RETENTION>;
  /**
   * The [log format](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-advanced.html)
   * of the Lambda function.
   * @default `"text"`
   * @example
   * ```js
   * {
   *   logging: {
   *     format: "json"
   *   }
   * }
   * ```
   */
  format?: Input<"text" | "json">;
}

export interface FunctionUrlArgs {
  /**
   * Serve your function URL through a `Router` instead of a standalone Function URL.
   *
   * By default, this component creates a direct function URL endpoint. But you might
   * want to serve it through the distribution of your `Router` as a:
   *
   * - A path like `/api/users`
   * - A subdomain like `api.example.com`
   * - Or a combined pattern like `dev.example.com/api`
   *
   * Whether the URL is served through a router decides what's created, so it has to
   * be a plain value, and so does the router.
   *
   * @example
   *
   * To serve your function **from a path**, you'll need to configure the root domain
   * in your `Router` component.
   *
   * ```ts title="sst.config.ts" {2}
   * const router = new sst.aws.Router("Router", {
   *   domain: "example.com"
   * });
   * ```
   *
   * Now set the `router` and the `path` in the `url` prop.
   *
   * ```ts {4,5}
   * {
   *   url: {
   *     router: {
   *       instance: router,
   *       path: "/api/users"
   *     }
   *   }
   * }
   * ```
   *
   * To serve your function **from a subdomain**, you'll need to configure the
   * domain in your `Router` component to match both the root and the subdomain.
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
   * ```ts {5}
   * {
   *   url: {
   *     router: {
   *       instance: router,
   *       domain: "api.example.com"
   *     }
   *   }
   * }
   * ```
   *
   * Finally, to serve your function **from a combined pattern** like
   * `dev.example.com/api`, you'll need to configure the domain in your `Router` to
   * match the subdomain.
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
   * And set the `domain` and the `path`.
   *
   * ```ts {5,6}
   * {
   *   url: {
   *     router: {
   *       instance: router,
   *       domain: "dev.example.com",
   *       path: "/api/users"
   *     }
   *   }
   * }
   * ```
   */
  router?: RouteArgs;
  /**
   * The authorization used for the function URL. Supports [IAM authorization](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).
   *
   * It decides which permissions are created, so it has to be a plain value.
   *
   * @default `"none"`
   * @example
   * ```js
   * {
   *   url: {
   *     authorization: "iam"
   *   }
   * }
   * ```
   */
  authorization?: "none" | "iam";
  /**
   * Customize the CORS (Cross-origin resource sharing) settings for the function URL.
   * @default `true`
   * @example
   * Disable CORS.
   * ```js
   * {
   *   url: {
   *     cors: false
   *   }
   * }
   * ```
   * Only enable the `GET` and `POST` methods for `https://example.com`.
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowMethods: ["GET", "POST"],
   *       allowOrigins: ["https://example.com"]
   *     }
   *   }
   * }
   * ```
   */
  cors?: Input<boolean | FunctionUrlCorsArgs>;
}

export interface FunctionPythonArgs {
  /**
   * Set this to `true` if you want to deploy this function as a container image.
   * There are a couple of reasons why you might want to do this.
   *
   * 1. The Lambda package size has an unzipped limit of 250MB. Whereas the
   *    container image size has a limit of 10GB.
   * 2. Even if you are below the 250MB limit, larger Lambda function packages
   *    have longer cold starts when compared to container image.
   * 3. You might want to use a custom Dockerfile to handle complex builds.
   *
   * It decides whether an image is built, so it has to be a plain value.
   *
   * @default `false`
   * @example
   * ```ts
   * {
   *   python: {
   *     container: true
   *   }
   * }
   * ```
   *
   * When you run `sst deploy`, it uses a built-in Dockerfile. It also needs
   * the Docker daemon to be running.
   *
   * :::note
   * This needs the Docker daemon to be running.
   * :::
   *
   * To use a custom Dockerfile, add one to the root of the uv workspace
   * of the function.
   *
   * ```txt {5}
   * ├── sst.config.ts
   * ├── pyproject.toml
   * └── function
   *     ├── pyproject.toml
   *     ├── Dockerfile
   *     └── src
   *         └── function
   *             └── api.py
   * ```
   *
   * You can refer to [this example of using a container image](/docs/examples/#aws-lambda-python-container).
   */
  container?:
    | boolean
    | {
        /**
         * Controls whether Docker build cache is enabled.
         * @default `true`
         * @example
         * Disable Docker build caching, useful for environments like Localstack where
         * ECR cache export is not supported.
         * ```js
         * {
         *   python: {
         *     container: {
         *       cache: false
         *     }
         *   }
         * }
         * ```
         */
        cache?: Input<boolean>;
      };
}

export interface FunctionConcurrencyArgs {
  /**
   * Provisioned concurrency keeps a number of Lambda instances ready to handle
   * requests, which reduces cold starts. It incurs extra charges, and it needs
   * `versioning` to be enabled.
   *
   * It decides whether the provisioned concurrency is created, so it has to be a
   * plain number.
   *
   * @default No provisioned concurrency
   * @example
   * ```js
   * {
   *   concurrency: {
   *     provisioned: 10
   *   }
   * }
   * ```
   */
  provisioned?: number;
  /**
   * Reserved concurrency limits the maximum number of concurrent executions for a
   * function, ensuring critical functions always have capacity. It does not incur
   * extra charges.
   *
   * :::note
   * Setting this to `0` will disable the function from being triggered.
   * :::
   *
   * @default No reserved concurrency
   * @example
   * ```js
   * {
   *   concurrency: {
   *     reserved: 50
   *   }
   * }
   * ```
   */
  reserved?: Input<number>;
}

export interface FunctionArgs extends ComponentArgs<typeof parts> {
  /**
   * Disable running this function [_Live_](/docs/live/) in `sst dev`.
   *
   * By default, the functions in your app are run locally in `sst dev`. To do this, a
   * _stub_ version of your function is deployed, instead of the real function.
   *
   * :::note
   * In `sst dev` a _stub_ version of your function is deployed.
   * :::
   *
   * In `sst dev` the role that SST creates for the function also trusts the root of your AWS
   * account, so you can assume it from your machine. A deployed role trusts only Lambda. If
   * you run `sst dev` on a stage that is also deployed, the account root is added back to
   * the role until the next `sst deploy`, so each switch updates the role.
   *
   * This shows under the **Functions** tab in the multiplexer sidebar where your invocations
   * are logged.
   *
   * A function that's _Live_ makes a round trip to your machine for each invocation, so
   * turning it off makes its invocations faster. It's worth doing for a function you
   * aren't working on, such as an authorizer, which runs before each request to its
   * routes that it doesn't have a cached result for. The function then runs in AWS as
   * it's deployed, so it can't reach anything that only runs on your machine.
   *
   * Read more about [Live](/docs/live/) and [`sst dev`](/docs/reference/cli/#dev).
   *
   * It decides which function is deployed, so it has to be a plain value.
   *
   * @default `true`
   * @example
   * ```js
   * {
   *   dev: false
   * }
   * ```
   */
  dev?: false;
  /**
   * Configure the maximum number of retry attempts for this function when invoked
   * asynchronously.
   *
   * This only affects asynchronous invocations of the function, ie. when subscribed to
   * Topics, EventBuses, or Buckets. And not when directly invoking the function.
   *
   * Valid values are between 0 and 2.
   *
   * @default `2`
   * @example
   * ```js
   * {
   *   retries: 0
   * }
   * ```
   */
  retries?: Input<number>;
  /**
   * The name for the function.
   *
   * By default, the name is generated from the app name, stage name, and component name. This
   * is displayed in the AWS Console for this function.
   *
   * :::caution
   * To avoid the name from thrashing, you want to make sure that it includes the app and stage
   * name.
   * :::
   *
   * If you are going to set the name, you need to make sure:
   * 1. It's unique across your app.
   * 2. Uses the app and stage name, so it doesn't thrash when you deploy to different stages.
   *
   * Also, changing the name after your've deployed it once will create a new function and delete
   * the old one.
   *
   * @example
   * ```js
   * {
   *   name: `${$app.name}-${$app.stage}-my-function`
   * }
   * ```
   */
  name?: Input<string>;
  /**
   * A description for the function. This is displayed in the AWS Console.
   * @example
   * ```js
   * {
   *   description: "Handler function for my nightly cron job."
   * }
   * ```
   */
  description?: Input<string>;
  /**
   * The language runtime for the function: one SST builds in, or a runtime made of
   * commands, from `sst.runtime`, for one it doesn't.
   *
   * Node.js and Golang are officially supported. While, Python and Rust are
   * community supported.
   *
   * A later release can move the default to a newer Node.js, and says so in its notes.
   * A function that uses the default is then updated on its next deploy. Set `runtime`
   * to keep it on one version.
   *
   * It decides what's built, so it has to be a plain value.
   *
   * @default `"nodejs24.x"`
   *
   * @example
   * ```js
   * {
   *   runtime: "nodejs24.x"
   * }
   * ```
   *
   * A runtime made of commands builds the function with its `build` command, runs it
   * with its `dev` command in `sst dev`, and is deployed with the Lambda runtime it
   * names.
   *
   * ```js
   * {
   *   runtime: sst.runtime({
   *     lambda: "ruby3.4",
   *     build: { command: "bundle install" },
   *     dev: { command: "bundle exec aws_lambda_ric $_HANDLER" },
   *     watch: ["*.rb", "Gemfile.lock"],
   *   })
   * }
   * ```
   */
  runtime?:
    | "nodejs18.x"
    | "nodejs20.x"
    | "nodejs22.x"
    | "nodejs24.x"
    | "go"
    | "rust"
    | "provided.al2"
    | "provided.al2023"
    | "python3.9"
    | "python3.10"
    | "python3.11"
    | "python3.12"
    | "python3.13"
    | "python3.14"
    | Runtime;
  /**
   * Path to the source code directory for the function. By default, the handler is
   * bundled with [esbuild](https://esbuild.github.io/). Use `bundle` to skip bundling.
   *
   * :::caution
   * Use `bundle` only when you want to bundle the function yourself.
   * :::
   *
   * If the `bundle` option is specified, the `handler` needs to be in the root of the bundle.
   *
   * :::note
   * SST writes the linked resources of each function to `.sst/<function name>/resource.enc`
   * inside the bundle directory, so functions that share a bundle don't overwrite each
   * other. Each function's zip only includes its own folder from `.sst`. Don't keep your
   * own files in a `.sst` folder or a `resource.enc` file at the root of the bundle, they are
   * left out of the zip.
   * :::
   *
   * It decides what's built, so it has to be a plain value.
   *
   * @example
   *
   * Here, the entire `packages/functions/src` directory is zipped, except for the
   * `.sst` folders of other functions and any `resource.enc` at the root. And the handler is
   * in the `src` directory.
   *
   * ```js
   * {
   *   bundle: "packages/functions/src",
   *   handler: "index.handler"
   * }
   * ```
   */
  bundle?: string;
  /**
   * Path to the handler for the function.
   *
   * - For Node.js this is in the format `{path}/{file}.{method}`.
   * - For Python this is also `{path}/{file}.{method}`.
   * - For Golang this is `{path}` to the Go module.
   * - For Rust this is `{path}` to the Rust crate.
   *
   * It decides what's built, so it has to be a plain value.
   *
   * @example
   *
   * ##### Node.js
   *
   * For example with Node.js you might have.
   *
   * ```js
   * {
   *   handler: "packages/functions/src/main.handler"
   * }
   * ```
   *
   * Where `packages/functions/src` is the path. And `main` is the file, where you might have
   * a `main.ts` or `main.js`. And `handler` is the method exported in that file.
   *
   * :::note
   * You don't need to specify the file extension.
   * :::
   *
   * If `bundle` is specified, the handler needs to be in the root of the bundle directory.
   *
   * ```js
   * {
   *   bundle: "packages/functions/src",
   *   handler: "index.handler"
   * }
   * ```
   *
   * ##### Python
   *
   * SST uses [uv](https://docs.astral.sh/uv/) to package the function.
   * You need to have it installed.
   *
   * :::note
   * You need uv installed for Python functions.
   * :::
   *
   * Your handler must live in a [uv workspace](https://docs.astral.sh/uv/concepts/projects/workspaces/)
   * with a `pyproject.toml`. Match the Python version to your Lambda runtime.
   *
   * ```toml title="pyproject.toml"
   * [project]
   * name = "my-project"
   * requires-python = "==3.11.*"
   * ```
   *
   * Install your packages before starting `sst dev`:
   *
   * ```bash
   * uv sync --all-packages
   * ```
   *
   * Use absolute imports within your package.
   *
   * ```python
   * from mypackage.utils import helper
   * ```
   *
   * Avoid relative imports — they can fail in Lambda. Make sure package directories have `__init__.py`.
   *
   * Access static files relative to `__file__`.
   *
   * ```python
   * from pathlib import Path
   * config = Path(__file__).parent / "config.json"
   * ```
   *
   * For large dependencies like numpy or pandas, deploy as a container. See [`python.container`](#functionpythonargs).
   *
   * For common project layouts, check out the [Python examples](https://github.com/sst-community/sst/tree/main/examples/python-layouts).
   *
   * ##### Golang
   *
   * For Golang the handler looks like.
   *
   * ```js
   * {
   *   handler: "packages/functions/go/some_module"
   * }
   * ```
   *
   * Where `packages/functions/go/some_module` is the path to the Go module. This
   * includes the name of the module in your `go.mod`. So in this case your `go.mod`
   * might be in `packages/functions/go` and `some_module` is the name of the
   * module.
   *
   * You can refer to [this example of deploying a Go function](/docs/examples/#aws-lambda-go).
   *
   * ##### Rust
   *
   * For Rust, the handler looks like.
   *
   * ```js
   * {
   *   handler: "crates/api"
   * }
   * ```
   *
   * Where `crates/api` is the path to the Rust crate. This means there is a
   * `Cargo.toml` file in `crates/api`, and the main() function handles the lambda.
   */
  handler: string;
  /**
   * The maximum amount of time the function can run. The minimum timeout is 1 second and the maximum is 900 seconds or 15 minutes.
   *
   * :::note
   * If a function is connected to another service, the request will time out based on the service's limits.
   * :::
   *
   * While the maximum timeout is 15 minutes, if a function is connected to other
   * services, it'll time out based on those limits.
   *
   * - API Gateway has a timeout of 30 seconds. So even if the function has a
   *   timeout of 15 minutes, the API request will time out after 30 seconds.
   * - CloudFront has a default timeout of 60 seconds. You can have this limit
   *   increased by [contacting AWS Support](https://console.aws.amazon.com/support/home#/case/create?issueType=service-limit-increase).
   *
   * @default `"20 seconds"`
   * @example
   * ```js
   * {
   *   timeout: "900 seconds"
   * }
   * ```
   */
  timeout?: Input<DurationMinutes>;
  /**
   * The amount of memory allocated for the function. Takes values between 128 MB
   * and 10240 MB in 1 MB increments.  The amount of memory affects the amount of
   * virtual CPU available to the function.
   *
   * :::tip
   * While functions with less memory are cheaper, larger functions can process faster.
   * And might end up being more [cost effective](https://docs.aws.amazon.com/lambda/latest/operatorguide/computing-power.html).
   * :::
   *
   * @default `"1024 MB"`
   * @example
   * ```js
   * {
   *   memory: "10240 MB"
   * }
   * ```
   */
  memory?: Input<Size>;
  /**
   * The amount of ephemeral storage allocated for the function. This sets the ephemeral
   * storage of the lambda function (/tmp). Must be between "512 MB" and "10240 MB" ("10 GB")
   * in 1 MB increments.
   *
   * @default `"512 MB"`
   * @example
   * ```js
   * {
   *   storage: "5 GB"
   * }
   * ```
   */
  storage?: Input<Size>;
  /**
   * Key-value pairs of values that are set as [Lambda environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html).
   * The keys need to:
   * - Start with a letter
   * - Be at least 2 characters long
   * - Contain only letters, numbers, or underscores
   *
   * They can be accessed in your function using `process.env.<key>`.
   *
   * :::note
   * The total size of the environment variables cannot exceed 4 KB.
   * :::
   *
   * @example
   *
   * ```js
   * {
   *   environment: {
   *     DEBUG: "true"
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Permissions and the resources that the function needs to access. These permissions are
   * used to create the function's IAM role.
   *
   * :::tip
   * If you `link` the function to a resource, the permissions to access it are
   * automatically added.
   * :::
   *
   * @example
   * Allow the function to read and write to an S3 bucket called `my-bucket`.
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:GetObject", "s3:PutObject"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     }
   *   ]
   * }
   * ```
   *
   * Allow the function to perform all actions on an S3 bucket called `my-bucket`.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:*"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     }
   *   ]
   * }
   * ```
   *
   * Granting the function permissions to access all resources.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["*"],
   *       resources: ["*"]
   *     }
   *   ]
   * }
   * ```
   */
  permissions?: Input<FunctionPermissionArgs[]>;
  /**
   * Policies to attach to the function. These policies will be added to the
   * function's IAM role.
   *
   * Attaching policies lets you grant a set of predefined permissions to the
   * function without having to specify the permissions in the `permissions` prop.
   *
   * @example
   * For example, allow the function to have read-only access to all resources.
   * ```js
   * {
   *   policies: ["arn:aws:iam::aws:policy/ReadOnlyAccess"]
   * }
   * ```
   */
  policies?: Input<string[]>;
  /**
   * [Link resources](/docs/linking/) to your function. This will:
   *
   * 1. Grant the permissions needed to access the resources.
   * 2. Allow you to access it in your function using the [SDK](/docs/reference/sdk/).
   *
   * @example
   *
   * Takes a list of components to link to the function.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: Input<any[]>;
  /**
   * Enable streaming for the function.
   *
   * Streaming is supported with both Function URLs and API Gateway REST API (V1). It is
   * not supported with API Gateway HTTP API (V2).
   *
   * You'll also need to [wrap your handler](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html) with `awslambda.streamifyResponse` to enable streaming.
   *
   * Check out the [AWS Lambda streaming example](/docs/examples/#aws-lambda-streaming) for more
   * details.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   streaming: true
   * }
   * ```
   */
  streaming?: Input<boolean>;
  /**
   * @internal
   */
  injections?: string[];
  /**
   * Configure the function logs in CloudWatch. Or pass in `false` to disable writing
   * logs: the function is then not given permissions to write to CloudWatch.
   *
   * Whether the function logs has to be a plain value. The fields can be outputs.
   *
   * To write to a log group you already have, pass it in `existing.logGroup`.
   *
   * @default `{retention: "1 month", format: "text"}`
   * @example
   * ```js
   * {
   *   logging: false
   * }
   * ```
   */
  logging?: false | FunctionLoggingArgs;
  /**
   * The [architecture](https://docs.aws.amazon.com/lambda/latest/dg/foundation-arch.html)
   * of the Lambda function.
   *
   * It decides what's built, so it has to be a plain value.
   *
   * @default `"x86_64"`
   * @example
   * ```js
   * {
   *   architecture: "arm64"
   * }
   * ```
   */
  architecture?: "x86_64" | "arm64";
  /**
   * Enable [Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html).
   * These are dedicated endpoints for your Lambda functions.
   *
   * Whether there is a URL, and whether it's served through a router, have to be plain
   * values. The fields of the CORS settings can be outputs.
   *
   * @default `false`
   * @example
   * Enable it with the default options.
   * ```js
   * {
   *   url: true
   * }
   * ```
   *
   * Configure the authorization and CORS settings for the URL.
   * ```js
   * {
   *   url: {
   *     authorization: "iam",
   *     cors: {
   *       allowOrigins: ["https://example.com"]
   *     }
   *   }
   * }
   * ```
   */
  url?: boolean | FunctionUrlArgs;
  /**
   * Configure how your function is bundled.
   *
   * By default, SST will bundle your function
   * code using [esbuild](https://esbuild.github.io/). This tree shakes your code to
   * only include what's used; reducing the size of your function package and improving
   * cold starts.
   *
   * It decides what's built, so it has to be a plain value.
   */
  nodejs?: {
    /**
     * @internal
     * Point to a file that exports a list of esbuild plugins to use.
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     plugins: "./plugins.mjs"
     *   }
     * }
     * ```
     *
     * The path is relative to the location of the `sst.config.ts`.
     *
     * ```js title="plugins.mjs"
     * import { somePlugin } from "some-plugin";
     *
     * export default [
     *   somePlugin()
     * ];
     * ```
     *
     * You'll also need to install the npm package of the plugin.
     */
    plugins?: string;
    /**
     * Configure additional esbuild loaders for other file extensions. This is useful
     * when your code is importing non-JS files like `.png`, `.css`, etc.
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     loader: {
     *      ".png": "file"
     *     }
     *   }
     * }
     * ```
     */
    loader?: Record<string, Loader>;
    /**
     * Dependencies that need to be excluded from the function package.
     *
     * Certain npm packages cannot be bundled using esbuild. This allows you to exclude them
     * from the bundle. Instead they'll be moved into a `node_modules/` directory in the
     * function package.
     *
     * :::tip
     * If esbuild is giving you an error about a package, try adding it to `install`.
     * :::
     *
     * This will allow your functions to be able to use these dependencies when deployed. They
     * just won't be tree shaken.
     *
     * :::caution
     * If you don't specify a version, the package still needs to be in your `package.json`.
     * :::
     *
     * Esbuild will ignore them while traversing the imports in your code. So these are the
     * **package names as seen in the imports**. It also works on packages that are not directly
     * imported by your code.
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     install: { pg: "8.13.1" }
     *   }
     * }
     * ```
     *
     * Passing `["packageName"]` is the same as passing `{ packageName: "*" }`.
     */
    install?: string[] | Record<string, string>;
    /**
     * Use this to insert a string at the beginning of the generated JS file.
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     banner: "console.log('Function starting')"
     *   }
     * }
     * ```
     */
    banner?: string;
    /**
     * This allows you to customize esbuild config that is used.
     *
     * :::tip
     * Check out the _JS tab_ in the code snippets in the esbuild docs for the
     * [`BuildOptions`](https://esbuild.github.io/api/#build).
     * :::
     *
     * For example, a function builds faster in `sst dev` when the AWS SDK is left out of
     * its bundle there. It's loaded from your `node_modules` instead, so the packages you
     * import have to be installed. A deploy still bundles them.
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     esbuild: {
     *       external: $dev ? ["@aws-sdk/*", "@smithy/*"] : []
     *     }
     *   }
     * }
     * ```
     */
    esbuild?: EsbuildOptions;
    /**
     * Disable if the function code is minified when bundled.
     *
     * @default `true`
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     minify: false
     *   }
     * }
     * ```
     */
    minify?: boolean;
    /**
     * Configure the format of the generated JS code; ESM or CommonJS.
     *
     * @default `"esm"`
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     format: "cjs"
     *   }
     * }
     * ```
     */
    format?: "cjs" | "esm";
    /**
     * Configure if source maps are added to the function bundle when **deployed**. Since they
     * increase payload size and potentially cold starts, they are not added by default.
     * However, they are always generated during `sst dev`.
     *
     * :::tip[SST Console]
     * For the [Console](/docs/console/), source maps are always generated and uploaded
     * to your bootstrap bucket. These are then downloaded and used to display
     * Issues in the console.
     * :::
     *
     * @default `false`
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     sourcemap: true
     *   }
     * }
     * ```
     */
    sourcemap?: boolean;
    /**
     * If enabled, modules that are dynamically imported will be bundled in their own files
     * with common dependencies placed in shared chunks. This can help reduce cold starts
     * as your function grows in size.
     *
     * @default `false`
     *
     * @example
     * ```js
     * {
     *   nodejs: {
     *     splitting: true
     *   }
     * }
     * ```
     */
    splitting?: boolean;
  };
  /**
   * Configure how your Python function is packaged.
   */
  python?: FunctionPythonArgs;
  /**
   * Add additional files to copy into the function package. Takes a list of objects
   * with `from` and `to` paths. These will be copied over before the function package
   * is zipped up.
   *
   * It decides what's built, so it has to be a plain value.
   *
   * @example
   *
   * Copying over a single file from the `src` directory to the `src/` directory of the
   * function package.
   *
   * ```js
   * {
   *   copyFiles: [{ from: "src/index.js" }]
   * }
   * ```
   *
   * Copying over a single file from the `src` directory to the `core/src` directory in
   * the function package.
   *
   * ```js
   * {
   *   copyFiles: [{ from: "src/index.js", to: "core/src/index.js" }]
   * }
   * ```
   *
   * Copying over a couple of files.
   *
   * ```js
   * {
   *   copyFiles: [
   *     { from: "src/this.js", to: "core/src/this.js" },
   *     { from: "src/that.js", to: "core/src/that.js" }
   *   ]
   * }
   * ```
   */
  copyFiles?: {
    /**
     * Source path relative to the `sst.config.ts`.
     */
    from: string;
    /**
     * Destination path relative to function root in the package. By default, it
     * creates the same directory structure as the `from` path and copies the file.
     *
     * @default The `from` path in the function package
     */
    to?: string;
  }[];
  /**
   * Configure the concurrency settings for the function.
   *
   * @default No concurrency settings set
   * @example
   * ```js
   * {
   *   concurrency: {
   *     provisioned: 10,
   *     reserved: 50
   *   }
   * }
   * ```
   */
  concurrency?: FunctionConcurrencyArgs;
  /**
   * Enable versioning for the function.
   *
   * :::note
   * Durable functions enable this by default.
   * :::
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   versioning: true
   * }
   * ```
   */
  versioning?: Input<boolean>;
  /**
   * A list of Lambda layer ARNs to add to the function.
   *
   * :::note
   * Layers are only added when the function is deployed.
   * :::
   *
   * These are only added when the function is deployed. In `sst dev`, your functions are run
   * locally, so the layers are not used. Instead you should use a local version of what's
   * in the layer.
   *
   * @example
   * ```js
   * {
   *   layers: ["arn:aws:lambda:us-east-1:123456789012:layer:my-layer:1"]
   * }
   * ```
   */
  layers?: Input<Input<string>[]>;
  /**
   * Mount an EFS file system to the function.
   *
   * @example
   * Create an EFS file system.
   *
   * ```ts title="sst.config.ts"
   * const vpc = new sst.aws.v5.Vpc("MyVpc");
   * const fileSystem = new sst.aws.v5.Efs("MyFileSystem", { vpc });
   * ```
   *
   * And pass it in.
   *
   * ```js
   * {
   *   volume: {
   *     efs: fileSystem
   *   }
   * }
   * ```
   *
   * By default, the file system will be mounted to `/mnt/efs`. You can change this by
   * passing in the `path` property.
   *
   * ```js
   * {
   *   volume: {
   *     efs: fileSystem,
   *     path: "/mnt/my-files"
   *   }
   * }
   * ```
   *
   * To use an existing EFS, you can pass in an EFS access point ARN.
   *
   * ```js
   * {
   *   volume: {
   *     efs: "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-12345678",
   *   }
   * }
   * ```
   */
  volume?: Input<{
    /**
     * The EFS file system to mount. Or an EFS access point ARN.
     */
    efs: Input<AnyEfs | string>;
    /**
     * The path to mount the volume.
     * @default `"/mnt/efs"`
     */
    path?: Input<string>;
  }>;
  /**
   * A list of tags to add to the function.
   *
   * @example
   * ```js
   * {
   *   tags: {
   *     "my-tag": "my-value"
   *   }
   * }
   * ```
   */
  tags?: Input<Record<string, Input<string>>>;
  /**
   * Configure the function to connect to private subnets in a virtual private cloud or VPC. This allows your function to access private resources.
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
  vpc?:
    | AnyVpc
    | Input<{
        /**
         * A list of VPC security group IDs.
         */
        securityGroups: Input<Input<string>[]>;
        /**
         * A list of VPC subnet IDs.
         */
        privateSubnets: Input<Input<string>[]>;
      }>;
  /**
   * Hook into the Lambda function build process.
   */
  hook?: {
    /**
     * Specify a callback that'll be run after the Lambda function is built.
     *
     * :::note
     * This is not called in `sst dev`.
     * :::
     *
     * Useful for modifying the generated Lambda function code before it's
     * deployed to AWS. It can also be used for uploading the generated sourcemaps
     * to a service like Sentry.
     *
     * @param dir The directory where the function code is generated.
     */
    postbuild(dir: string): Promise<void>;
  };
  /**
   * Configure the lambda function as a [AWS durable function](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html).
   *
   * :::caution
   * This property is meant to be used internally by [Workflow](/docs/component/aws/workflow).
   * Prefer the component if you want to use the [SDK](/docs/component/aws/workflow#sdk) or if you are not very familiar with durable functions limitations.
   * :::
   */
  durable?:
    | boolean
    | {
        /**
         * Maximum execution time for the durable function.
         * @default `14 days`
         */
        timeout?: Input<Duration>;
        /**
         * Number of days to retain the function's execution state.
         * @default `30 days`
         */
        retention?: Input<DurationDays>;
      };
  /**
   * @internal
   */
  _skipMetadata?: boolean;
  /**
   * @internal
   */
  _skipHint?: boolean;
}

/**
 * The `Function` component lets you add serverless functions to your app.
 * It uses [AWS Lambda](https://aws.amazon.com/lambda/).
 *
 * It's built from parts, so every resource it creates can be transformed, is available
 * in `nodes`, and can be swapped for one you already have. How to switch to it is the
 * last example.
 *
 * @example
 *
 * #### Minimal example
 *
 * Pass in the path to your handler function.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler"
 * });
 * ```
 *
 * What `handler` means for each runtime is under [`handler`](#handler).
 *
 * #### Set additional config
 *
 * ```ts {3,4} title="sst.config.ts"
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   timeout: "3 minutes",
 *   memory: "1024 MB"
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to the function. This will grant permissions
 * to the resources and allow you to access it in your handler.
 *
 * ```ts {5} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   link: [bucket]
 * });
 * ```
 *
 * ```ts title="src/lambda.ts"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Enable function URLs
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   url: true
 * });
 * ```
 *
 * #### Change what's created
 *
 * Every resource the function creates is a part you can transform.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   url: true,
 *   transform: {
 *     function: { tracingConfig: { mode: "Active" } },
 *     logGroup: { logGroupClass: "INFREQUENT_ACCESS" },
 *     url: { invokeMode: "RESPONSE_STREAM" }
 *   }
 * });
 * ```
 *
 * #### Use a role or log group you already have
 *
 * Pass the resource, or the name to look it up by. A role can also be passed by its ARN.
 * It's then used as it is, and only looked up if you read `nodes.role`.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   existing: {
 *     role: "my-lambda-role",
 *     logGroup: "/my/shared/logs"
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.Function`
 *
 * Change `sst.aws.Function` to `sst.aws.v5.Function` and keep the name. The function, its
 * role, log group, code and URL are kept. Behind a router, its route's entry in the router's
 * store is written again by a resource of a new type, which the `sst` binary serves, and
 * `sst migrate` takes the old one out of the state without deleting it. A few things are
 * written differently:
 *
 * - `handler`, `bundle`, `runtime`, `architecture`, `nodejs` and `copyFiles` have to be
 *   plain values, not outputs: the function is built from them, and a preview has to
 *   know what's built. So do `dev`, `logging`, `url`, `url.authorization`, `url.router`,
 *   `python`, `python.container`, `concurrency` and `concurrency.provisioned`, which
 *   decide what's created.
 * - `role: roleArn` becomes `existing: { role: roleArn }`. It can also be the role or
 *   its name, which is looked up on every deploy.
 * - `logging: { logGroup: name }` becomes `existing: { logGroup }`, with the log group
 *   or its name.
 * - `live: false` becomes `dev: false`, and `url.route` becomes `url.router`.
 * - The way `sst.aws.Function` takes those four still works.
 * - `nodes.function` and `nodes.logGroup` are the resources themselves, not outputs.
 * - The alias the URL of a durable function points at is created with the function's
 *   `provider`. `sst.aws.Function` created it with your app's provider, whatever the
 *   function was given. If a durable function has a `url` and a `provider`, the alias is
 *   replaced on switch, and the URL with it.
 * - `transform: { function: { environment: { variables: { A: "1" } } } }` adds a
 *   variable where it used to replace them all.
 *
 * The V5 components create their functions, like a queue's subscriber, as
 * `sst.aws.v5.Function` too. There you can keep writing the function the way
 * `sst.aws.Function` takes it, but for what a build reads: `handler`, `bundle`,
 * `runtime`, `architecture`, `nodejs` and `copyFiles` have to be plain values there
 * too.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * new sst.aws.Function("MyFunction", { handler: "src/lambda.handler" });
 * new sst.aws.v5.Function("MyFunction", { handler: "src/lambda.handler" });
 * ```
 */
export class Function extends component("sst:aws:Function", parts) {
  private readonly durable: boolean;
  private readonly fn: lambda.Function;
  private readonly urlEndpoint: Output<string | undefined>;

  constructor(
    name: string,
    args: FunctionArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    const self = this;
    const durable = (this.durable = Boolean(args.durable));

    // A function that's already deployed is only referenced
    const existing = this.existingPart("function");
    if (existing) {
      this.fn = existing;
      this.urlEndpoint = output(undefined);
      return;
    }

    const option = (arg: string) => `The "${arg}" of the "${name}" function`;
    // A few options are written another way for the 4.x `Function`: `live`,
    // `role`, `logging.logGroup` and `url.route`. They're taken here too. A
    // `$transform` written for the 4.x one runs on this one, as they have
    // the same type, and so does the definition of a function part. One
    // written for this one runs on the 4.x one too, which turns down a runtime
    // from `sst.runtime`.
    const given = args as Record<string, any>;
    const original: {
      live?: boolean;
      role?: Input<string>;
      logGroup?: Input<string>;
    } = {
      live: given.live,
      role: given.role,
      logGroup: plain(given.logging, option("logging"))?.logGroup,
    };

    // The args that decide which resources are created are read first
    const dev =
      plain(args.dev, option("dev")) !== false &&
      !(args.dev === undefined && original.live === false) &&
      $dev;
    const logging = normalizeLogging();
    const url = normalizeUrl();
    const python = plain(args.python, option("python"));
    const container = plain(python?.container, option("python.container"));
    const isContainer = !dev && Boolean(container);
    const concurrency = plain(args.concurrency, option("concurrency"));
    const provisioned = plain(
      concurrency?.provisioned,
      option("concurrency.provisioned"),
    );

    const partition = getPartitionOutput({}, opts).partition;
    const region = getRegionOutput({}, opts).region;
    const bootstrapData = region.apply((region) => bootstrap.forRegion(region));
    const assetBucket = bootstrapData.apply((data) => data.asset);
    // The key links are encrypted with is created once for the app, and
    // shared with the 4.x `Function`, so an app with both has one
    const encryptionKey = linkEncryptionKey().base64;
    // What's built is read from these, and a preview has to know what's
    // built: its handler, and the source maps it writes
    const isBuilt =
      "The function is built from it, and a preview has to know what's built.";
    plain(args.handler, option("handler"), isBuilt);
    plain(args.bundle, option("bundle"), isBuilt);
    plainDeep(args.nodejs, option("nodejs"), isBuilt);
    plainDeep(args.copyFiles, option("copyFiles"), isBuilt);
    const architecture =
      plain(args.architecture, option("architecture"), isBuilt) ?? "x86_64";
    const injections =
      plainDeep(args.injections, option("injections"), isBuilt) ?? [];
    // A runtime made of commands is built and run by them, and deployed with
    // the Lambda runtime it names
    const runtimeArg = plain(args.runtime, option("runtime"), isBuilt);
    if (
      runtimeArg !== undefined &&
      typeof runtimeArg !== "string" &&
      !isRuntime(runtimeArg)
    )
      throw new VisibleError(
        `The "runtime" of the "${name}" function is a runtime's name, like "nodejs24.x", or a runtime from sst.runtime.`,
      );
    const commands = isRuntime(runtimeArg) ? commandsOf(runtimeArg) : undefined;
    const runtime =
      runtimeArg === undefined
        ? "nodejs24.x"
        : typeof runtimeArg === "string"
          ? runtimeArg
          : runtimeArg.lambda;
    if (commands && injections.length > 0)
      throw new VisibleError(
        `The "${name}" function has "injections", which are for a Node.js function SST builds, not one built by a runtime from sst.runtime.`,
      );
    const streaming = withDefault(args.streaming, false);
    // `Link.build` gives an output for each link, and `all` reads them. Left
    // as outputs, each one's name would be an output where a string is read.
    const links = output(args.link || []).apply((links) =>
      all(Link.build(links)),
    );
    const copyFiles = normalizeCopyFiles();
    const nodejs = normalizeNodeJs();
    const vpc = normalizeVpc();
    const volume = normalizeVolume();
    const environment = normalizeEnvironment();
    const durableConfig = normalizeDurable();

    // A role passed by its ARN, the way 4.x takes it, is used as it is. It's
    // only looked up when `nodes.role` is read: a lookup is an IAM GetRole on
    // every run, for every function that shares the role. One passed by its
    // name, or as an output, is looked up for its ARN.
    const existingRole = args.existing?.role;
    const givenRoleArn =
      typeof existingRole === "string" && existingRole.startsWith("arn:")
        ? existingRole
        : existingRole === undefined
          ? original.role
          : undefined;
    const lookUpRole = (id: Input<string>) =>
      this.lookupPart(
        "role",
        output(id).apply((id) =>
          id.startsWith("arn:") ? parseRoleArn(id).roleName : id,
        ),
      );
    let role: iam.Role | undefined;
    if (givenRoleArn !== undefined)
      this.partHandle("role").defer(() => (role ??= lookUpRole(givenRoleArn)));
    else if (existingRole !== undefined && !(existingRole instanceof iam.Role))
      role = lookUpRole(existingRole);
    else role = this.existingPart("role") ?? this.part("role", roleArgs());
    const roleArn = givenRoleArn ?? role!.arn;

    const givenLogGroup =
      original.logGroup !== undefined && !args.existing?.logGroup;
    const logGroup = !logging
      ? undefined
      : givenLogGroup
        ? this.lookupPart("logGroup", original.logGroup!)
        : this.part(
            "logGroup",
            {
              name: interpolate`/aws/lambda/${
                args.name ?? physicalName(64, `${name}Function`)
              }`,
              retentionInDays: logging.retention,
            },
            { ignoreChanges: ["name"] },
          );

    // Build the code. In `sst dev` the stub is deployed in its place, and the
    // CLI is told about the function so it can run it locally.
    // What the build is given but the links and the key
    const buildParts = output({
      functionID: name,
      handler: args.handler,
      bundle: args.bundle,
      runtime,
      copyFiles,
      properties: output({ nodejs, python }).apply((val) => ({
        ...(val.nodejs || val.python),
        architecture,
      })),
      dev,
      ...(commands ? { commands } : {}),
    });
    const buildInput = all([
      buildParts,
      encryptionKey,
      links.apply((links) =>
        Object.fromEntries(links.map((item) => [item.name, item.properties])),
      ),
    ]).apply(([parts, encryptionKey, links]) => ({
      ...parts,
      encryptionKey,
      links,
    }));
    if (dev) buildInput.apply((input) => rpc.call("Runtime.AddTarget", input));
    // What's built is files on this machine. It's given the links, and a
    // link's name is read from the component that's linked, so without this
    // the code would depend on every resource of every linked component. A
    // subscriber that links what it subscribes to would wait for itself.
    const built: Output<FunctionBundle> = dev
      ? output(devBridgeBundle(durable))
      : withoutDependencies(
          buildInput.apply((input) =>
            buildBundle(
              { ...input, isContainer },
              args.hook && ((dir) => args.hook!.postbuild(dir)),
            ),
          ),
        );
    // A Node.js handler is wrapped in a file that runs the injections first
    const entryOf = (built: Output<FunctionBundle>) =>
      all([built, streaming]).apply(
        ([built, streaming]): { handler: string; wrapper?: FunctionFile } =>
          dev || commands || !runtime.startsWith("nodejs")
            ? { handler: built.handler }
            : injectHandler(name, { ...built, streaming, injections }),
      );
    const entry = entryOf(built);
    // In a preview of a new stage, what's linked and the key aren't known yet,
    // so the build waits for them. What the build writes doesn't depend on
    // either: the links are encrypted into a file of their own after it. So
    // the preview builds without them, to learn what the function is made of:
    // its handler, which the provider needs to plan a Zip function, and its
    // source maps, so that what the deploy uploads is in the preview.
    const knowsBuild = output((built as any).isKnown as Promise<boolean>).apply(
      (known) =>
        // With `bundle`, the build writes into the app's own folder, which a
        // build with no key would leave wrong
        known || dev || !!args.bundle || !pulumiRuntime.isDryRun(),
    );
    let builtWithoutLinks: Output<FunctionBundle> | undefined;
    const buildWithoutLinks = () =>
      (builtWithoutLinks ??= withoutDependencies(
        buildParts.apply((parts) =>
          buildBundle(
            {
              ...parts,
              // a key of the right length, as none is known yet
              encryptionKey: Buffer.alloc(32).toString("base64"),
              links: {},
              isContainer,
            },
            args.hook && ((dir) => args.hook!.postbuild(dir)),
          ),
        ),
      ));
    // What's built, as far as what the function is made of goes. Every
    // preview knows it.
    const shape: Output<FunctionBundle> = knowsBuild.apply((knows) =>
      knows ? built : buildWithoutLinks(),
    );
    const handler = knowsBuild.apply((knows) =>
      knows
        ? entry.apply((entry) => entry.handler)
        : entryOf(buildWithoutLinks()).apply((entry) => entry.handler),
    );

    const image = isContainer ? createImage() : undefined;
    const code = isContainer
      ? undefined
      : output(dev ? devBridgeCode() : createCode());

    // This is a hack to avoid handler being marked as having propertyDependencies.
    // There is an unresolved bug in pulumi that causes issues when it does:
    // "runtime and handler must be defined when code is zip".
    // @ts-expect-error
    handler.allResources = () => Promise.resolve(new Set());
    const fn = this.part(
      "function",
      {
        name: args.name,
        description: args.description ?? "",
        role: roleArn,
        timeout: withDefault(args.timeout, "20 seconds", toSeconds),
        memorySize: withDefault(args.memory, "1024 MB", toMBs),
        ephemeralStorage: { size: withDefault(args.storage, "512 MB", toMBs) },
        environment: { variables: environment },
        architectures: [architecture],
        loggingConfig: logging &&
          logGroup && { logFormat: logging.format, logGroup: logGroup.name },
        vpcConfig: vpc && {
          securityGroupIds: vpc.securityGroups,
          subnetIds: vpc.privateSubnets,
        },
        fileSystemConfig: volume && {
          arn: volume.efs,
          localMountPath: volume.path,
        },
        layers: args.layers,
        tags: args.tags,
        publish: output(args.versioning).apply((v) => v ?? durable),
        reservedConcurrentExecutions: concurrency?.reserved,
        durableConfig: durableConfig && {
          executionTimeout: durableConfig.timeout,
          retentionPeriod: durableConfig.retention,
        },
        ...(image
          ? {
              packageType: "Image",
              imageUri: image.ref.apply((ref) => ref?.replace(":latest", "")),
              imageConfig: {
                commands: [
                  handler.apply((handler) =>
                    // A Python image is given the handler as a module path:
                    // no leading "./", and "." in place of "/"
                    runtime.includes("python")
                      ? handler.replace(/\.\//g, "").replace(/\//g, ".")
                      : handler,
                  ),
                ],
              },
            }
          : {
              packageType: "Zip",
              s3Bucket: code!.apply((code) => code.bucket),
              s3Key: code!.apply((code) => code.key),
              handler: unsecret(handler),
              runtime:
                runtime === "go" || runtime === "rust"
                  ? "provided.al2023"
                  : runtime,
            }),
      },
      // In `sst dev` the function is the stub, whatever its transform says
      dev
        ? {
            transformations: [
              ({ props, opts }) => ({
                props: {
                  ...props,
                  description: props.description
                    ? output(props.description as Input<string>).apply(
                        (v) => (v ? `${v.substring(0, 240)} (live)` : "live"),
                      )
                    : "live",
                  runtime: durable ? "nodejs24.x" : "provided.al2023",
                  architectures: ["x86_64"],
                },
                opts,
              }),
            ],
          }
        : undefined,
    );

    this.fn = fn;
    this.urlEndpoint = url ? createUrl(url) : output(undefined);

    if (provisioned)
      this.part("provisioned", {
        functionName: fn.name,
        qualifier: fn.publish.apply((publish) => {
          if (publish !== true)
            throw new VisibleError(
              `Provisioned concurrency requires function versioning. Set "versioning: true" to enable function versioning.`,
            );
          return fn.version;
        }),
        provisionedConcurrentExecutions: provisioned,
      });

    if (args.retries !== undefined)
      this.part("eventInvokeConfig", {
        functionName: fn.name,
        maximumRetryAttempts: args.retries,
      });

    this.report({
      function: { handler: args.handler, internal: args._skipMetadata, dev },
      hint: args._skipHint ? undefined : this.urlEndpoint,
    });
    this.registerOutputs({
      // What's run locally in `sst dev`. Its links by name, as 4.x writes
      // them: what they hold can be a secret, like a client's, and this is
      // kept in the state in plain text.
      _live: dev
        ? unsecret(
            all([
              links.apply((links) => links.map((link) => link.name)),
              args.handler,
              args.bundle,
              runtime,
              nodejs,
              copyFiles,
            ]).apply(
              ([links, handler, bundle, runtime, nodejs, copyFiles]) => ({
                functionID: name,
                links,
                handler,
                bundle,
                runtime,
                copyFiles,
                properties: nodejs,
              }),
            ),
          )
        : undefined,
    });

    function normalizeLogging() {
      const logging = plain(args.logging, option("logging"));
      if (logging === false) return undefined;

      if (
        logging?.retention !== undefined &&
        (args.existing?.logGroup || original.logGroup !== undefined)
      )
        throw new VisibleError(
          `Cannot set "logging.retention" for the "${name}" function: it's given a log group, and that log group has its own retention.`,
        );

      return {
        retention: output(logging?.retention).apply(
          (retention) => RETENTION[retention ?? "1 month"],
        ),
        format: output(logging?.format).apply((format) => {
          if (durable && format && format !== "json")
            throw new VisibleError(
              `Durable functions require "logging.format" to be set to "json"`,
            );
          return (format ?? (durable ? "json" : "text")) === "json"
            ? "JSON"
            : "Text";
        }),
      };
    }

    function normalizeUrl() {
      const url = plain(args.url, option("url"));
      if (url === false || url === undefined) return undefined;
      const urlArgs = url === true ? {} : url;
      // 4.x takes the router as `route.router`
      const given = plain(
        (urlArgs as { route?: Omit<RouteArgs, "instance"> & { router: AnyRouter } })
          .route,
        option("url.route"),
      );
      plain(given?.router, option("url.route.router"));
      const router: RouteArgs | undefined =
        urlArgs.router ??
        (given && (({ router, ...route }) => ({ ...route, instance: router }))(given));

      const defaultCors: types.input.lambda.FunctionUrlCors = {
        allowHeaders: ["*"],
        allowMethods: ["*"],
        allowOrigins: ["*"],
      };
      return {
        authorization:
          plain(urlArgs.authorization, option("url.authorization")) ?? "none",
        cors: output(urlArgs.cors).apply((cors) =>
          cors === false
            ? undefined
            : cors === true || cors === undefined
              ? defaultCors
              : {
                  ...defaultCors,
                  ...cors,
                  maxAge: cors.maxAge && toSeconds(cors.maxAge),
                },
        ),
        router: router && routeOfRouter(router),
      };
    }

    function routeOfRouter(router: RouteArgs) {
      plain(router, option("url.router"));
      plain(router.instance, option("url.router.instance"));
      return routeOf(router);
    }

    function normalizeCopyFiles() {
      return output(args.copyFiles ?? []).apply((copyFiles) =>
        Promise.all(
          copyFiles.map(async (entry) => {
            const from = path.join($cli.paths.root, entry.from);
            const to = entry.to || entry.from;
            if (path.isAbsolute(to))
              throw new VisibleError(
                `Copy destination path "${to}" must be relative`,
              );

            const stats = await fs.promises.stat(from);
            return { from, to, isDir: stats.isDirectory() };
          }),
        ),
      );
    }

    function normalizeNodeJs() {
      return output(args.nodejs).apply((nodejs) =>
        nodejs?.install && Array.isArray(nodejs.install)
          ? {
              ...nodejs,
              install: Object.fromEntries(
                nodejs.install.map((dep) => [dep, "*"]),
              ),
            }
          : nodejs,
      );
    }

    function normalizeVpc() {
      if (!args.vpc) return;

      if (isVpc(args.vpc)) {
        const result = {
          privateSubnets: args.vpc.privateSubnets,
          securityGroups: args.vpc.securityGroups,
        };
        return all([args.vpc.id, hasNat(args.vpc)]).apply(([id, nat]) => {
          if (nat === false) {
            warnOnce(
              `\nWarning: One or more functions are deployed in the "${id}" VPC, which does not have a NAT gateway. As a result, these functions cannot access the internet. If your functions need internet access, enable it by setting the "nat" prop on the "Vpc" component.\n`,
            );
          }
          return result;
        });
      }

      return output(args.vpc).apply((vpc) => {
        // 4.x took the subnets as `vpc.subnets`
        if ((vpc as { subnets?: unknown }).subnets) {
          throw new VisibleError(
            `The "vpc.subnets" property has been renamed to "vpc.privateSubnets". Update your code to use "vpc.privateSubnets" instead.`,
          );
        }
        return vpc;
      });
    }

    function normalizeVolume() {
      if (!args.volume) return;

      return output(args.volume).apply((volume) => ({
        efs:
          isEfs(volume.efs)
            ? volume.efs.nodes.accessPoint.arn
            : output(volume.efs),
        path: volume.path ?? "/mnt/efs",
      }));
    }

    function normalizeDurable() {
      if (!args.durable) return;
      const config = args.durable === true ? {} : args.durable;
      return {
        timeout: withDefault(config.timeout, "14 days", toSeconds),
        retention: withDefault(config.retention, "30 days", toDays),
      };
    }

    function normalizeEnvironment() {
      return all([
        args.environment,
        bootstrapData,
        encryptionKey,
        args.link,
        args.streaming,
        args.bundle,
        dev ? devStub() : undefined,
      ]).apply(([environment, bootstrap, key, link, streaming, bundle, stub]) => {
        const result = environment ?? {};
        result.SST_RESOURCE_App = JSON.stringify({
          name: $app.name,
          stage: $app.stage,
        });
        for (const linkable of link || []) {
          if (!Link.isLinkable(linkable)) continue;
          const def = linkable.getSSTLink();
          for (const item of def.include || []) {
            if (item.type === "environment") Object.assign(result, item.env);
          }
        }
        result.SST_KEY = key;
        // Functions that share a `bundle` each have their own file, under
        // `.sst/<name>/`, where the CLI writes it
        result.SST_KEY_FILE = bundle
          ? `.sst/${name}/resource.enc`
          : "resource.enc";
        if (dev) {
          result.SST_REGION = process.env.SST_AWS_REGION!;
          Object.assign(result, stub!.environment);
          result.SST_FUNCTION_ID = name;
          result.SST_APP = $app.name;
          result.SST_STAGE = $app.stage;
          result.SST_ASSET_BUCKET = bootstrap.asset;
          if (process.env.SST_FUNCTION_TIMEOUT) {
            result.SST_FUNCTION_TIMEOUT = process.env.SST_FUNCTION_TIMEOUT;
          }
          if (streaming) {
            result.SST_FUNCTION_STREAMING = "true";
          }
        }
        return result;
      });
    }

    function roleArgs(): iam.RoleArgs {
      const linkPermissions = Link.getInclude<Permission>(
        "aws.permission",
        args.link,
      );
      // In `sst dev` the stub reaches the CLI through the stage's transport,
      // and uses the asset bucket
      const devPermissions = dev
        ? output(devStub()).apply((stub) => [
            ...stub.permissions.map((permission) => ({
              effect: "allow",
              ...permission,
            })),
            {
              effect: "allow",
              actions: ["s3:*"],
              resources: [
                interpolate`arn:${partition}:s3:::${assetBucket}`,
                interpolate`arn:${partition}:s3:::${assetBucket}/*`,
              ],
            },
          ])
        : [];
      const policy = all([
        args.permissions || [],
        linkPermissions,
        devPermissions,
      ]).apply(
        ([argsPermissions, linkPermissions, devPermissions]) =>
          iam.getPolicyDocumentOutput({
            statements: [
              ...argsPermissions,
              ...linkPermissions,
              ...devPermissions,
            ].map((item) => ({
              effect: (() => {
                const effect = item.effect ?? "allow";
                return effect.charAt(0).toUpperCase() + effect.slice(1);
              })(),
              actions: item.actions,
              resources: item.resources,
              conditions: "conditions" in item ? item.conditions : undefined,
            })),
          }),
      );

      const managed = (policy: string) =>
        interpolate`arn:${partition}:iam::aws:policy/service-role/${policy}`;
      return {
        // Only `sst dev` trusts the account too, so the CLI can take the role
        // to run the function locally. This goes by `$dev`, as `Function`
        // does, and not by the function's own `dev`: a site's dev server is
        // created with `dev: false`, and the CLI still takes its role.
        assumeRolePolicy: iam.getPolicyDocumentOutput({
          statements: [
            {
              actions: ["sts:AssumeRole"],
              principals: [
                {
                  type: "Service",
                  identifiers: ["lambda.amazonaws.com"],
                },
                ...($dev
                  ? [
                      {
                        type: "AWS",
                        identifiers: [
                          interpolate`arn:${partition}:iam::${
                            getCallerIdentityOutput({}, opts).accountId
                          }:root`,
                        ],
                      },
                    ]
                  : []),
              ],
            },
          ],
        }).json,
        // if there are no statements, do not add an inline policy.
        // adding an inline policy with no statements will cause an error.
        inlinePolicies: policy.apply(({ statements }) =>
          statements ? [{ name: "inline", policy: policy.json }] : [],
        ),
        managedPolicyArns: output(args.policies ?? []).apply((policies) => [
          ...policies,
          ...(logging ? [managed("AWSLambdaBasicExecutionRole")] : []),
          ...(vpc ? [managed("AWSLambdaVPCAccessExecutionRole")] : []),
          ...(durable
            ? [managed("AWSLambdaBasicDurableExecutionRolePolicy")]
            : []),
        ]),
      };
    }

    // The build has already put the user's code, its config and a Dockerfile
    // in the artifact directory. What's left is to build the image and push
    // it to the container registry.
    function createImage() {
      const authToken = ecr.getAuthorizationTokenOutput({
        registryId: bootstrapData.assetEcrRegistryId,
      });
      // Set unless the cache is switched off
      const cached = output(
        typeof container === "object" ? container.cache : undefined,
      ).apply((cache) => (cache === false ? undefined : true));
      const cacheRef = interpolate`${bootstrapData.assetEcrUrl}:${name}-cache`;

      return self.part("image", {
        tags: [interpolate`${bootstrapData.assetEcrUrl}:latest`],
        context: {
          // Read once the code is built, so the image is built after it
          location: built.apply(() =>
            path.join($cli.paths.work, "artifacts", `${name}-src`),
          ),
        },
        cacheFrom: ifSet(cached, () => [{ registry: { ref: cacheRef } }]),
        cacheTo: ifSet(cached, () => [
          {
            registry: {
              ref: cacheRef,
              imageManifest: true,
              ociMediaTypes: true,
              mode: "max" as const,
            },
          },
        ]),
        platforms: [architecture === "arm64" ? "linux/arm64" : "linux/amd64"],
        push: true,
        registries: [
          authToken.apply((authToken) => ({
            address: authToken.proxyEndpoint,
            username: authToken.userName,
            password: secret(authToken.password),
          })),
        ],
      });
    }

    function createCode() {
      const zip = all([built, entry, copyFiles, args.bundle]).apply(
        ([built, entry, copyFiles, customBundle]) =>
          zipCode({
            to: path.resolve($cli.paths.work, "artifacts", name, "code.zip"),
            bundle: built.bundle,
            sourcemaps: built.sourcemaps,
            copyFiles,
            wrapper: entry.wrapper,
            sharedBundle: customBundle ? name : undefined,
          }),
      );

      // The source maps are stored under the log group the function creates,
      // which is where the errors to map are read from. Which there are comes
      // from the build as every preview knows it.
      const ownLogGroup =
        self.existingPart("logGroup") || givenLogGroup ? undefined : logGroup;
      if (ownLogGroup)
        shape.apply((shape) =>
          (shape.sourcemaps ?? []).forEach((file, index) =>
            self.part(
              "sourcemap",
              `${index}`,
              {
                key: interpolate`sourcemap/${ownLogGroup.arn}/${
                  zip.hash
                }.${path.basename(file)}`,
                bucket: assetBucket,
                // In a deploy, the build is the one the files come from
                source: built.apply(
                  (built) => new asset.FileAsset(built.sourcemaps![index]),
                ),
              },
              { retainOnDelete: true },
            ),
          ),
        );

      return self.part("code", {
        key: interpolate`assets/${name}-code-${zip.hash}.zip`,
        bucket: assetBucket,
        source: zip.apply((zip) => new asset.FileArchive(zip.path)),
      });
    }

    // Every live function in a region is created from the same stub, so its
    // code is uploaded once for the app, outside of any function.
    function devBridgeCode() {
      return all([built, region]).apply(([{ bundle }, region]) => {
        const cache = devStubCode();
        const cacheKey = `${region}:${bundle}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const stub = logicalName(path.basename(bundle));
        const created = zipCode({
          to: path.resolve(
            $cli.paths.work,
            "artifacts",
            `dev-bridge-${region}-${stub}`,
            "code.zip",
          ),
          bundle,
        }).then(
          (zip) =>
            new s3.BucketObjectv2(
              `DevBridgeCode${logicalName(region)}${stub}`,
              {
                key: `assets/dev-bridge-code-${zip.hash}.zip`,
                bucket: assetBucket,
                source: new asset.FileArchive(zip.path),
              },
              {
                parent: rootStackResource,
                provider: opts?.provider,
                // The dev bridge key is shared by every app and stage in this
                // account and region. Retain it so removing a stage, deploying it
                // outside dev, or changing its bridge version doesn't delete the
                // object other stages' Lambdas are still created from.
                retainOnDelete: true,
              },
            ),
        );
        cache.set(cacheKey, created);
        created.catch(() => cache.delete(cacheKey));
        return created;
      });
    }

    function createUrl(url: NonNullable<ReturnType<typeof normalizeUrl>>) {
      const { authorization } = url;
      const route = url.router?.route;
      // A router can sign its requests to the URL. Then only its
      // distribution may call the URL, whatever the authorization is.
      const isOac = url.router?.signs ?? false;

      /**
       * Lambda Function URLs only accept alias names in the explicit `qualifier`
       * field. Durable functions with URLs therefore need an alias target here,
       * even when the underlying function is still on `$LATEST`.
       * See https://github.com/hashicorp/terraform-provider-aws/issues/31459
       */
      const alias = durable
        ? self.part("urlAlias", {
            functionName: fn.arn,
            functionVersion: fn.version,
          })
        : undefined;

      const fnUrl = self.part("url", {
        functionName: durable ? fn.arn : fn.name,
        qualifier: alias?.name,
        authorizationType: output(isOac).apply((oac) =>
          oac || authorization === "iam" ? "AWS_IAM" : "NONE",
        ),
        invokeMode: streaming.apply((streaming) =>
          streaming ? "RESPONSE_STREAM" : "BUFFERED",
        ),
        cors: ifSet(url.cors),
      });

      // Lambda takes one change to a function at a time, so a permission
      // added while the URL is still being created can fail with a conflict.
      // The permissions wait for the URL.
      const afterUrl = { dependsOn: [fnUrl] };

      const allowEveryone = () => {
        self.part(
          "urlAccess",
          {
            action: "lambda:InvokeFunctionUrl",
            function: fn.name,
            principal: "*",
            functionUrlAuthType: "NONE",
          },
          afterUrl,
        );
        self.part(
          "urlInvoke",
          {
            action: "lambda:InvokeFunction",
            function: fn.name,
            principal: "*",
            invokedViaFunctionUrl: true,
          },
          afterUrl,
        );
      };

      if (!route) {
        if (authorization === "none") allowEveryone();
        return fnUrl.functionUrl;
      }

      // Who may call the URL depends on whether the router signs its
      // requests. A V5 router's settings say so plainly. A 4.x one, or one
      // that's referenced, says so in an output a preview knows. Its
      // distribution is only passed in.
      const permit = (oac: boolean) => {
        if (oac) {
          self.part(
            "urlAccess",
            {
              action: "lambda:InvokeFunctionUrl",
              function: fn.name,
              principal: "cloudfront.amazonaws.com",
              sourceArn: route.routerDistributionArn,
            },
            afterUrl,
          );
          self.part(
            "urlInvoke",
            {
              action: "lambda:InvokeFunction",
              function: fn.name,
              principal: "cloudfront.amazonaws.com",
              sourceArn: route.routerDistributionArn,
              invokedViaFunctionUrl: true,
            },
            afterUrl,
          );
        } else if (authorization === "none") allowEveryone();
      };
      if (typeof isOac === "boolean") permit(isOac);
      else isOac.apply(permit);

      const routeNamespace = crypto
        .createHash("md5")
        .update(`${$app.name}-${$app.stage}-${name}`)
        .digest("hex")
        .substring(0, 4);
      self.part("routeKey", {
        store: route.routerKvStoreArn,
        namespace: routeNamespace,
        entries: all([fnUrl.functionUrl, isOac, route]).apply(
          ([fnUrlValue, oac, route]) => {
            const timeouts = [
              "connectionTimeout" as const,
              "readTimeout" as const,
              "keepAliveTimeout" as const,
            ].flatMap((k) => {
              const value = route[k];
              return value ? [[k, toSeconds(value)]] : [];
            });
            return {
              metadata: JSON.stringify({
                host: new URL(fnUrlValue).host,
                rewrite: route.rewrite,
                origin: {
                  ...(oac
                    ? {
                        originAccessControlConfig: {
                          enabled: true,
                          signingBehavior: "always",
                          signingProtocol: "sigv4",
                          originType: "lambda",
                        },
                      }
                    : {}),
                  connectionAttempts: route.connectionAttempts,
                  ...(timeouts.length
                    ? { timeouts: Object.fromEntries(timeouts) }
                    : {}),
                },
              }),
            };
          },
        ),
        purge: false,
      });
      self.part("routesUpdate", {
        store: route.routerKvStoreArn,
        namespace: route.routerKvNamespace,
        key: "routes",
        entry: route.apply((route) =>
          ["url", routeNamespace, route.hostPattern, route.pathPrefix].join(
            ",",
          ),
        ),
      });
      return route.routerUrl;
    }
  }

  /**
   * The Lambda function URL if `url` is enabled.
   */
  public get url() {
    return this.urlEndpoint.apply((url) => {
      if (!url) {
        throw new VisibleError(
          `Function URL is not enabled. Enable it with "url: true".`,
        );
      }
      return url;
    });
  }

  /**
   * The name of the Lambda function.
   */
  public get name() {
    return this.fn.name;
  }

  /**
   * The ARN of the Lambda function.
   */
  public get arn() {
    return this.fn.arn;
  }

  // A function with versions, or a durable one, is invoked through its
  // latest version.
  private get useQualifiedTarget() {
    return this.fn.publish.apply(
      (publish) => (publish ?? false) || this.durable,
    );
  }

  /** @internal */
  public get targetArn() {
    return this.useQualifiedTarget.apply((useQualifiedTarget) =>
      useQualifiedTarget ? this.fn.qualifiedArn : this.arn,
    );
  }

  /** @internal */
  public get qualifier() {
    return this.targetArn.apply(
      (arn) => splitQualifiedFunctionArn(arn).qualifier,
    );
  }

  /** @internal */
  public get targetInvokeArn() {
    return this.useQualifiedTarget.apply((useQualifiedTarget) =>
      useQualifiedTarget ? this.fn.qualifiedInvokeArn : this.fn.invokeArn,
    );
  }

  /** @internal */
  public get targetResponseStreamingInvokeArn() {
    return this.useQualifiedTarget.apply((useQualifiedTarget) =>
      useQualifiedTarget
        ? all([
            this.arn,
            this.fn.qualifiedArn,
            this.fn.responseStreamingInvokeArn,
          ]).apply(([arn, qualifiedArn, responseStreamingInvokeArn]) =>
            responseStreamingInvokeArn.replace(arn, qualifiedArn),
          )
        : this.fn.responseStreamingInvokeArn,
    );
  }

  /**
   * Add environment variables lazily to the function after the function is created.
   *
   * This is useful for adding environment variables that are only available after the
   * function is created, like the function URL. It can be called once.
   *
   * @param environment The environment variables to add to the function.
   *
   * @example
   * Add the function URL as an environment variable.
   *
   * ```ts title="sst.config.ts"
   * const fn = new sst.aws.v5.Function("MyFunction", {
   *   handler: "src/handler.handler",
   *   url: true,
   * });
   *
   * fn.addEnvironment({
   *   URL: fn.url,
   * });
   * ```
   */
  public addEnvironment(environment: Input<Record<string, Input<string>>>) {
    if (this.nodes.environmentUpdate)
      throw new VisibleError(
        `"addEnvironment" was already called on the "${this.componentName}" function. Pass all of the environment variables in one call.`,
      );
    return this.part("environmentUpdate", {
      functionName: this.name,
      environment,
      region: getRegionOutput(undefined, { parent: this }).region,
      functionLastModified: this.fn.lastModified,
    });
  }

  /**
   * Linking a function gives the linked resource its name and URL, and lets it invoke
   * the function.
   */
  public link() {
    return {
      properties: {
        name: this.name,
        url: this.urlEndpoint,
        ...(this.durable ? { qualifier: this.qualifier } : {}),
      },
      include: [
        permission({
          actions: [
            "lambda:InvokeFunction",
            ...(this.durable
              ? [
                  "lambda:ListDurableExecutionsByFunction",
                  "lambda:GetDurableExecution",
                  "lambda:GetDurableExecutionHistory",
                  "lambda:StopDurableExecution",
                  "lambda:SendDurableExecutionCallbackSuccess",
                  "lambda:SendDurableExecutionCallbackFailure",
                  "lambda:SendDurableExecutionCallbackHeartbeat",
                ]
              : []),
          ],
          resources: [this.durable ? interpolate`${this.arn}:*` : this.arn],
        }),
      ],
    };
  }

  /**
   * Reference an existing function with the given function name. This is useful when you
   * create a function in one stage and want to share it in another. Linking it gives the
   * linked resource its name and lets it invoke the function.
   *
   * @param name The name of the component.
   * @param functionName The name of the existing Lambda function.
   * @param opts Component resource options.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const fn = $app.stage === "frank"
   *   ? sst.aws.v5.Function.get("MyFunction", "app-dev-MyFunctionFunction-abcdefgh")
   *   : new sst.aws.v5.Function("MyFunction", { handler: "src/lambda.handler" });
   * ```
   */
  public static get(
    name: string,
    functionName: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Function(
      name,
      { existing: { function: functionName } } as FunctionArgs,
      opts,
    );
  }
}
