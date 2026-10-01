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
import { V5Args, component, many, optional } from "../parts-component";
import { Plain, ifSet, notAnOption, plain, withDefault } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { Link } from "../link";
import { logicalName, physicalName } from "../naming";
import { toDays, toSeconds } from "../duration";
import { toMBs } from "../size";
import { rpc } from "../rpc/rpc";
import { warnOnce } from "../../util/warn";
import { Function, FunctionArgs } from "./function";
import { Efs } from "./efs";
import { Vpc } from "./vpc";
import { RETENTION } from "./logging";
import { Permission, permission } from "./permission";
import { normalizeRouteArgs } from "./router";
import { bootstrap } from "./helpers/bootstrap";
import { splitQualifiedFunctionArn } from "./helpers/arn";
import {
  FunctionBundle,
  FunctionFile,
  buildBundle,
  devBridgeBundle,
  injectHandler,
  zipCode,
} from "./helpers/function-code";
import { FunctionEnvironmentUpdate } from "./providers/function-environment-update";
import { KvKeys } from "./providers/kv-keys";
import { KvRoutesUpdate } from "./providers/kv-routes-update";

const parts = {
  /**
   * The IAM Role the function uses.
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
   * distribution when the URL is behind a router that signs its requests. When the URL
   * is behind a router, it's only known once the router is.
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

type Logging = Exclude<Plain<FunctionArgs["logging"]>, false | undefined>;
type Url = Exclude<Plain<FunctionArgs["url"]>, boolean | undefined>;
type Python = NonNullable<Plain<FunctionArgs["python"]>>;
type Concurrency = NonNullable<Plain<FunctionArgs["concurrency"]>>;

export interface FunctionV5LoggingArgs extends Omit<Logging, "logGroup"> {}

export interface FunctionV5UrlArgs
  extends Omit<Url, "route" | "authorization"> {
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
}

export interface FunctionV5PythonArgs extends Omit<Python, "container"> {
  /**
   * Set this to `true` to deploy the function as a container image. That lifts the
   * 250MB limit on the unzipped package to 10GB, and lets you use your own Dockerfile.
   * It needs the Docker daemon to be running.
   *
   * It decides whether an image is built, so it has to be a plain value.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   python: {
   *     container: true
   *   }
   * }
   * ```
   *
   * To use a custom Dockerfile, add one to the root of the uv workspace of the function.
   *
   * Disable the Docker build cache, for environments like Localstack where exporting
   * the cache to ECR isn't supported.
   *
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
  container?: boolean | { cache?: Input<boolean> };
}

export interface FunctionV5ConcurrencyArgs
  extends Omit<Concurrency, "provisioned"> {
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
}

export interface FunctionV5Args
  extends V5Args<
    Omit<
      FunctionArgs,
      "live" | "dev" | "role" | "logging" | "url" | "python" | "concurrency"
    >,
    typeof parts
  > {
  /**
   * Disable running this function [_Live_](/docs/live/) in `sst dev`.
   *
   * By default, the functions in your app are run locally in `sst dev`. To do this, a
   * _stub_ version of your function is deployed, instead of the real function. You can
   * turn this off by setting `dev` to `false`. It has to be a plain value.
   *
   * @default `true`
   * @example
   * ```js
   * {
   *   dev: false
   * }
   * ```
   */
  dev?: Plain<FunctionArgs["dev"]>;
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
  logging?: false | FunctionV5LoggingArgs;
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
  url?: boolean | FunctionV5UrlArgs;
  /**
   * Configure how your Python function is packaged.
   */
  python?: FunctionV5PythonArgs;
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
  concurrency?: FunctionV5ConcurrencyArgs;
}

/**
 * The `FunctionV5` component lets you add serverless functions to your app.
 * It uses [AWS Lambda](https://aws.amazon.com/lambda/).
 *
 * It takes the same args as [`Function`](/docs/component/aws/function), apart from the
 * few listed under [Switch from `Function`](#switch-from-function). It's built from parts,
 * so every resource it creates can be transformed, is available in `nodes`, and can be
 * swapped for one you already have.
 *
 * @example
 *
 * #### Minimal example
 *
 * Pass in the path to your handler function.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.FunctionV5("MyFunction", {
 *   handler: "src/lambda.handler"
 * });
 * ```
 *
 * The runtimes, and what `handler` means for each, are the same as for
 * [`Function`](/docs/component/aws/function#handler).
 *
 * #### Set additional config
 *
 * ```ts {3,4} title="sst.config.ts"
 * new sst.aws.FunctionV5("MyFunction", {
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
 * const bucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.FunctionV5("MyFunction", {
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
 * new sst.aws.FunctionV5("MyFunction", {
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
 * new sst.aws.FunctionV5("MyFunction", {
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
 * Pass the resource, or the name to look it up by.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.FunctionV5("MyFunction", {
 *   handler: "src/lambda.handler",
 *   existing: {
 *     role: "my-lambda-role",
 *     logGroup: "/my/shared/logs"
 *   }
 * });
 * ```
 *
 * #### Switch from `Function`
 *
 * Change `Function` to `FunctionV5` and keep the name. The function, its role, log
 * group, code and URL are kept. A few things are written differently:
 *
 * - `dev`, `logging`, `url`, `url.authorization`, `python`, `python.container`,
 *   `concurrency` and `concurrency.provisioned` have to be plain values, not outputs.
 * - `role: roleArn` becomes `existing: { role }`, with the role or its name.
 * - `logging: { logGroup: name }` becomes `existing: { logGroup }`, with the log group
 *   or its name.
 * - `live: false` becomes `dev: false`, and `url.route` becomes `url.router`.
 * - `nodes.function` and `nodes.logGroup` are the resources themselves, not outputs.
 * - The alias the URL of a durable function points at is created with the function's
 *   `provider`. `Function` created it with your app's provider, whatever the function was
 *   given. If a durable function has a `url` and a `provider`, the alias is replaced on
 *   switch, and the URL with it.
 * - An object in `transform` is merged into the defaults, so
 *   `transform: { function: { environment: { variables: { A: "1" } } } }` adds a
 *   variable where it used to replace them all.
 * - `$transform(sst.aws.Function, ...)` doesn't apply to it. Write one for
 *   `sst.aws.FunctionV5`.
 *
 * The V5 components create their functions, like a queue's subscriber, as `FunctionV5`
 * too. There you can keep writing the function the way `Function` takes it.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * new sst.aws.Function("MyFunction", { handler: "src/lambda.handler" });
 * new sst.aws.FunctionV5("MyFunction", { handler: "src/lambda.handler" });
 * ```
 */
export class FunctionV5 extends component("sst:aws:FunctionV5", parts) {
  private readonly durable: boolean;
  private readonly fn: lambda.Function;
  private readonly urlEndpoint: Output<string | undefined>;

  constructor(
    name: string,
    args: FunctionV5Args,
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
    notAnOption(args, "live", `Use "dev: false".`);
    notAnOption(
      args,
      "role",
      `Pass the role, or its name, in "existing": { existing: { role } }.`,
    );

    // The args that decide which resources are created are read first
    const dev = plain(args.dev, option("dev")) !== false && $dev;
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
    // The key links are encrypted with, and the code of the dev stub, are
    // created once for the app. `Function` holds them, so that an app with
    // both kinds of function has one of each.
    const encryptionKey = Function["encryptionKey"]().base64;
    const runtime = output(args.runtime ?? "nodejs24.x");
    const architecture = withDefault(args.architecture, "x86_64");
    const streaming = withDefault(args.streaming, false);
    const injections = withDefault(args.injections, []);
    const links = output(args.link || []).apply((links) => Link.build(links));
    const copyFiles = normalizeCopyFiles();
    const nodejs = normalizeNodeJs();
    const vpc = normalizeVpc();
    const volume = normalizeVolume();
    const environment = normalizeEnvironment();
    const durableConfig = normalizeDurable();

    const role = this.existingPart("role") ?? this.part("role", roleArgs());

    const logGroup = logging
      ? this.part(
          "logGroup",
          {
            name: interpolate`/aws/lambda/${
              args.name ?? physicalName(64, `${name}Function`)
            }`,
            retentionInDays: logging.retention,
          },
          { ignoreChanges: ["name"] },
        )
      : undefined;

    // Build the code. In `sst dev` the stub is deployed in its place, and the
    // CLI is told about the function so it can run it locally.
    const buildInput = output({
      functionID: name,
      handler: args.handler,
      bundle: args.bundle,
      encryptionKey,
      runtime,
      links: links.apply((links) =>
        Object.fromEntries(links.map((item) => [item.name, item.properties])),
      ),
      copyFiles,
      properties: output({ nodejs, python }).apply((val) => ({
        ...(val.nodejs || val.python),
        architecture,
      })),
      dev,
    });
    if (dev) buildInput.apply((input) => rpc.call("Runtime.AddTarget", input));
    const built: Output<FunctionBundle> = dev
      ? output(devBridgeBundle(durable))
      : buildInput.apply((input) =>
          buildBundle(
            { ...input, isContainer },
            args.hook && ((dir) => args.hook!.postbuild(dir)),
          ),
        );
    // A Node.js handler is wrapped in a file that runs the injections first
    const entry = all([built, runtime, streaming, injections]).apply(
      ([built, runtime, streaming, injections]): {
        handler: string;
        wrapper?: FunctionFile;
      } =>
        dev || !runtime.startsWith("nodejs")
          ? { handler: built.handler }
          : injectHandler(name, { ...built, streaming, injections }),
    );
    const handler = entry.apply((entry) => entry.handler);

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
        role: role.arn,
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
                  all([handler, runtime]).apply(([handler, runtime]) =>
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
              runtime: runtime.apply((v) =>
                v === "go" || v === "rust" ? "provided.al2023" : v,
              ),
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
                        (v) => `${v.substring(0, 240)} (live)`,
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

    this.registerOutputs({
      // What's run locally in `sst dev`
      _live: dev
        ? unsecret(
            all([
              links,
              args.handler,
              args.bundle,
              args.runtime,
              nodejs,
              copyFiles,
            ]).apply(
              ([links, handler, bundle, runtime, nodejs, copyFiles]) => ({
                functionID: name,
                links,
                handler,
                bundle,
                runtime: runtime || "nodejs24.x",
                copyFiles,
                properties: nodejs,
              }),
            ),
          )
        : undefined,
      _metadata: {
        handler: args.handler,
        internal: args._skipMetadata,
        dev,
      },
      _hint: args._skipHint ? undefined : this.urlEndpoint,
    });

    function normalizeLogging() {
      const logging = plain(args.logging, option("logging"));
      if (logging === false) return undefined;

      notAnOption(
        logging ?? {},
        "logGroup",
        `Pass the log group, or its name, in "existing": { existing: { logGroup } }.`,
      );
      if (logging?.retention !== undefined && args.existing?.logGroup)
        throw new VisibleError(
          `Cannot set "logging.retention" for the "${name}" function: it's given a log group in "existing", and that log group has its own retention.`,
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
      notAnOption(
        urlArgs,
        "route",
        `Use "url.router": { url: { router: { instance: router } } }.`,
      );

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
        route: normalizeRouteArgs(plain(urlArgs.router, option("url.router"))),
      };
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

      if (args.vpc instanceof Vpc) {
        const result = {
          privateSubnets: args.vpc.privateSubnets,
          securityGroups: args.vpc.securityGroups,
        };
        return all([
          args.vpc.id,
          args.vpc.nodes.natGateways,
          args.vpc.nodes.natInstances,
        ]).apply(([id, natGateways, natInstances]) => {
          if (natGateways.length === 0 && natInstances.length === 0) {
            warnOnce(
              `\nWarning: One or more functions are deployed in the "${id}" VPC, which does not have a NAT gateway. As a result, these functions cannot access the internet. If your functions need internet access, enable it by setting the "nat" prop on the "Vpc" component.\n`,
            );
          }
          return result;
        });
      }

      return output(args.vpc).apply((vpc) => {
        if (vpc.subnets) {
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
          volume.efs instanceof Efs
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
        dev ? Function.appsync() : undefined,
      ]).apply(([environment, bootstrap, key, link, streaming, appsync]) => {
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
        result.SST_KEY_FILE = "resource.enc";
        if (dev) {
          result.SST_REGION = process.env.SST_AWS_REGION!;
          result.SST_APPSYNC_HTTP = appsync.http;
          result.SST_APPSYNC_REALTIME = appsync.realtime;
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
      // In `sst dev` the stub talks to the CLI through AppSync and the asset bucket
      const devPermissions = dev
        ? [
            { effect: "allow", actions: ["appsync:*"], resources: ["*"] },
            {
              effect: "allow",
              actions: ["s3:*"],
              resources: [
                interpolate`arn:${partition}:s3:::${assetBucket}`,
                interpolate`arn:${partition}:s3:::${assetBucket}/*`,
              ],
            },
          ]
        : [];
      const policy = all([args.permissions || [], linkPermissions]).apply(
        ([argsPermissions, linkPermissions]) =>
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
        // The account is trusted too, so the CLI can take the role to run the
        // function locally in `sst dev`. `Function` means to add that only in
        // `sst dev`, but its check never passes, so every role it has
        // deployed trusts the account. This matches what's deployed.
        assumeRolePolicy: iam.getPolicyDocumentOutput({
          statements: [
            {
              actions: ["sts:AssumeRole"],
              principals: [
                {
                  type: "Service",
                  identifiers: ["lambda.amazonaws.com"],
                },
                {
                  type: "AWS",
                  identifiers: [
                    interpolate`arn:${partition}:iam::${
                      getCallerIdentityOutput({}, opts).accountId
                    }:root`,
                  ],
                },
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
        platforms: [
          architecture.apply((v) =>
            v === "arm64" ? "linux/arm64" : "linux/amd64",
          ),
        ],
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
      const zip = all([built, entry, copyFiles]).apply(
        ([built, entry, copyFiles]) =>
          zipCode({
            to: path.resolve($cli.paths.work, "artifacts", name, "code.zip"),
            bundle: built.bundle,
            sourcemaps: built.sourcemaps,
            copyFiles,
            wrapper: entry.wrapper,
          }),
      );

      // The source maps are stored under the log group the function creates,
      // which is where the errors to map are read from. How many there are
      // is only known once the code is built.
      const ownLogGroup = self.existingPart("logGroup") ? undefined : logGroup;
      if (ownLogGroup)
        all([built, zip]).apply(([built, zip]) =>
          (built.sourcemaps ?? []).forEach((file, index) =>
            self.part(
              "sourcemap",
              `${index}`,
              {
                key: interpolate`sourcemap/${ownLogGroup.arn}/${zip.hash}.${path.basename(file)}`,
                bucket: assetBucket,
                source: new asset.FileAsset(file),
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
        const cache = Function["devBridgeCode"]();
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
      const { authorization, route } = url;
      // A router can sign its requests to the URL. Then only its
      // distribution may call the URL, whatever the authorization is.
      const isOac = output(route?.routerProtection).apply(
        (p) => p?.mode === "oac" || p?.mode === "oac-with-edge-signing",
      );

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
        authorizationType: isOac.apply((oac) =>
          oac || authorization === "iam" ? "AWS_IAM" : "NONE",
        ),
        invokeMode: streaming.apply((streaming) =>
          streaming ? "RESPONSE_STREAM" : "BUFFERED",
        ),
        cors: ifSet(url.cors),
      });

      const allowEveryone = () => {
        self.part("urlAccess", {
          action: "lambda:InvokeFunctionUrl",
          function: fn.name,
          principal: "*",
          functionUrlAuthType: "NONE",
        });
        self.part("urlInvoke", {
          action: "lambda:InvokeFunction",
          function: fn.name,
          principal: "*",
          invokedViaFunctionUrl: true,
        });
      };

      if (!route) {
        if (authorization === "none") allowEveryone();
        return fnUrl.functionUrl;
      }

      // Who may call the URL depends on how the router protects its origins,
      // and that's only known once the router is.
      all([isOac, route.routerDistributionArn]).apply(
        ([oac, distributionArn]) => {
          if (oac && distributionArn) {
            self.part("urlAccess", {
              action: "lambda:InvokeFunctionUrl",
              function: fn.name,
              principal: "cloudfront.amazonaws.com",
              sourceArn: distributionArn,
            });
            self.part("urlInvoke", {
              action: "lambda:InvokeFunction",
              function: fn.name,
              principal: "cloudfront.amazonaws.com",
              sourceArn: distributionArn,
              invokedViaFunctionUrl: true,
            });
          } else if (authorization === "none") allowEveryone();
        },
      );

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
          ["url", routeNamespace, route.hostPattern, route.pathPrefix].join(","),
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
   * const fn = new sst.aws.FunctionV5("MyFunction", {
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
   *   ? sst.aws.FunctionV5.get("MyFunction", "app-dev-MyFunctionFunction-abcdefgh")
   *   : new sst.aws.FunctionV5("MyFunction", { handler: "src/lambda.handler" });
   * ```
   */
  public static get(
    name: string,
    functionName: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new FunctionV5(
      name,
      { existing: { function: functionName } } as FunctionV5Args,
      opts,
    );
  }
}
