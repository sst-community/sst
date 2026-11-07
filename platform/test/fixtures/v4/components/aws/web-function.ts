import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import { glob } from "glob";
import {
  ComponentResourceOptions,
  Output,
  all,
  asset,
  interpolate,
  output,
  secret,
} from "@pulumi/pulumi";
import {
  cloudwatch,
  getCallerIdentityOutput,
  getPartitionOutput,
  getRegionOutput,
  iam,
  lambda,
  lambdaweb,
  s3,
} from "@pulumi/aws";
import { Component, Transform, transform } from "../../../../../src/components/component";
import { DurationMinutes, toSeconds } from "../../../../../src/components/duration";
import { VisibleError } from "../../../../../src/components/error";
import { DevCommand } from "../experimental/dev-command";
import { Input } from "../../../../../src/components/input";
import { Link } from "../../../../../src/components/link";
import { physicalName } from "../../../../../src/components/naming";
import { rpc } from "../../../../../src/components/rpc/rpc";
import { FunctionArgs } from "./function";
import { linkEncryptionKey } from "../../../../../src/components/aws/helpers/function-shared";
import { RETENTION } from "../../../../../src/components/aws/logging";
import { Permission, permission } from "../../../../../src/components/aws/permission";
import { Vpc } from "./vpc";
import { warnOnce } from "../../../../../src/util/warn";

export interface WebFunctionArgs {
  /**
   * The file that starts an HTTP server, relative to the project root. It does not need
   * to export a Lambda handler. Listen on the host and port in
   * `process.env.AWS_LAMBDA_HTTP_ENDPOINT`.
   *
   * SST bundles this file with esbuild. When `bundle` is set, this is instead a JavaScript
   * file relative to that directory and SST does not bundle it.
   * Source files with different supported JavaScript or TypeScript extensions must use
   * distinct basenames in the same directory to avoid ambiguous file resolution.
   * @default Required; no default.
   * @example
   * ```js
   * { entrypoint: "src/server.ts" }
   * ```
   */
  entrypoint: Input<string>;
  /**
   * An existing directory containing your deployment package. The `entrypoint` must be
   * inside it. Native dependencies must be built for Linux Arm64. SST writes this
   * function's encrypted links to `.sst/<name>/resource.enc` inside the bundle and
   * includes only that managed file, excluding other functions' `.sst` directories.
   * @default The entrypoint is bundled with esbuild.
   * @example
   * ```js
   * { bundle: "packages/api/dist", entrypoint: "server.mjs" }
   * ```
   */
  bundle?: Input<string>;
  /**
   * Environment variables available to your server. Lambda's `AWS_LAMBDA_*` variables
   * and SST's `SST_RESOURCE_*` link variables cannot be overridden.
   * Values are stored as Pulumi secrets. Empty values are rejected.
   * All keys and values, including SST's managed values, must fit in 32 KiB. Linked
   * resource properties are encrypted in the deployment package and do not use this limit.
   * @default `{}`
   * @example
   * ```js
   * { environment: { NODE_ENV: "production" } }
   * ```
   */
  environment?: FunctionArgs["environment"];
  /**
   * Link resources to your server. Their properties are available through `Resource`
   * from the `sst` SDK and their permissions are added to the execution role. Deployed
   * links use the same encrypted `resource.enc` format and stage key as `Function`.
   * @default `[]`
   * @example
   * ```js
   * { link: [bucket, secret] }
   * ```
   */
  link?: FunctionArgs["link"];
  /**
   * Permissions added to the execution role, in addition to linked resources.
   * @default `[]`
   * @example
   * ```js
   * { permissions: [{ actions: ["ses:SendEmail"], resources: [identity.arn] }] }
   * ```
   */
  permissions?: FunctionArgs["permissions"];
  /**
   * Configure esbuild and dependencies, as with `Function`. When `sourcemap` is `true`,
   * source maps are included in the deployment package; they are not uploaded separately
   * for SST's event-function log integration.
   * @default `{ minify: true, format: "esm" }`
   * @example
   * ```js
   * { nodejs: { install: ["pg"], sourcemap: true } }
   * ```
   */
  nodejs?: FunctionArgs["nodejs"];
  /**
   * Copy additional files into the deployment package, as with `Function`. SST's
   * managed resource file cannot be replaced by a copied file.
   * @default `[]`
   * @example
   * ```js
   * { copyFiles: [{ from: "assets", to: "public" }] }
   * ```
   */
  copyFiles?: FunctionArgs["copyFiles"];
  /**
   * The time allowed for each request, between 3 and 900 seconds.
   * @default `"30 seconds"`
   * @example
   * ```js
   * { timeout: "2 minutes" }
   * ```
   */
  timeout?: Input<DurationMinutes>;
  /**
   * Concurrent requests handled by each execution environment, between 1 and 128.
   * Your server must safely handle overlapping requests.
   * @default `64`
   * @example
   * ```js
   * { maxConcurrencyPerEnvironment: 32 }
   * ```
   */
  maxConcurrencyPerEnvironment?: Input<number>;
  /**
   * Optional endpoint limits. Omitting a limit removes a previously configured limit.
   * Account quotas still apply.
   * @default No component-specific limits.
   * @example
   * ```js
   * { scaling: { maxEnvironments: 20, rateLimit: 1000 } }
   * ```
   */
  scaling?: Input<{
    /**
     * The maximum execution environments, between 2 and 10000.
     * @default The account's service limit.
     * @example
     * ```js
     * { scaling: { maxEnvironments: 20 } }
     * ```
     */
    maxEnvironments?: Input<number>;
    /**
     * Requests per second: 0, 100 through 1000 in increments of 100, or 2000 through
     * 10000 in increments of 1000. 0 rejects new requests. Regional limits may differ.
     * @default The account's service limit.
     * @example
     * ```js
     * { scaling: { rateLimit: 1000 } }
     * ```
     */
    rateLimit?: Input<number>;
  }>;
  /**
   * Configure authorization for the HTTPS endpoint.
   * @default `{ authorization: "none" }`
   * @example
   * ```js
   * { url: { authorization: "iam" } }
   * ```
   */
  url?: Input<{
    /**
     * `none` lets your application handle authorization. `iam` requires SigV4-signed
     * requests and `lambda:InvokeWebFunctionEndpoint` permission. IAM requests must
     * include `X-Amz-Content-SHA256`, including the empty-payload hash for bodyless requests.
     * @default `"none"`
     * @example
     * ```js
     * { url: { authorization: "iam" } }
     * ```
     */
    authorization?: Input<"none" | "iam">;
  }>;
  /**
   * Configure the central and HomeRegion-local CloudWatch log groups.
   * @default `{ retention: "1 month", applicationLogLevel: "INFO", systemLogLevel: "INFO" }`
   * @example
   * ```js
   * { logging: { retention: "1 week", applicationLogLevel: "WARN" } }
   * ```
   */
  logging?: Input<{
    /**
     * Retention for both managed log groups.
     * @default `"1 month"`
     * @example
     * ```js
     * { logging: { retention: "1 week" } }
     * ```
     */
    retention?: Input<keyof typeof RETENTION>;
    /**
     * The minimum application log level collected by Lambda.
     * @default `"INFO"`
     * @example
     * ```js
     * { logging: { applicationLogLevel: "WARN" } }
     * ```
     */
    applicationLogLevel?: Input<
      "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL"
    >;
    /**
     * The minimum Lambda system log level.
     * @default `"INFO"`
     * @example
     * ```js
     * { logging: { systemLogLevel: "WARN" } }
     * ```
     */
    systemLogLevel?: Input<"DEBUG" | "INFO" | "WARN">;
  }>;
  /**
   * Send your server's outbound traffic through the private subnets of a VPC, so it can
   * reach private resources, like a database.
   *
   * Requests still come in through the HTTPS endpoint. Only outbound traffic goes through
   * the VPC, and it reaches the internet only through the VPC's NAT. Let the resources
   * your server calls take traffic from the security groups you give.
   *
   * This creates a Lambda network connector, which each revision is created with.
   * Adding, changing or removing `vpc` makes a new revision. In `sst dev`, your server
   * runs locally and no connector is created, so it reaches the VPC only through
   * `sst tunnel`.
   *
   * @example
   * Create a `Vpc` component, with a NAT if your server needs the internet.
   *
   * ```js title="sst.config.ts"
   * const myVpc = new sst.aws.Vpc("MyVpc", { nat: "ec2" });
   * ```
   *
   * And pass it in.
   *
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   *
   * Or pass in the subnets and security groups of an existing VPC.
   *
   * ```js
   * {
   *   vpc: {
   *     privateSubnets: ["subnet-0b6a2b73896dc8c4c", "subnet-021389ebee680c2f0"],
   *     securityGroups: ["sg-0399348378a4c256c"]
   *   }
   * }
   * ```
   */
  vpc?:
    | Vpc
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
   * Run your server locally in `sst dev`, without deploying a web function. The command
   * receives links, environment variables, AWS credentials for the execution role, and
   * `AWS_LAMBDA_HTTP_ENDPOINT` derived from `url`.
   *
   * Set `false` to deploy the real web function in `sst dev`. The local execution role
   * trusts your AWS account only when local development is enabled.
   * @default Runs locally in `sst dev`.
   * @example
   * ```js
   * { dev: { command: "tsx watch src/server.ts", url: "http://localhost:3000" } }
   * ```
   */
  dev?:
    | false
    | {
        /**
         * A command that starts your server. Node.js 24 can run erasable TypeScript syntax;
         * for other TypeScript features, set a command such as `"tsx watch src/server.ts"`.
         * @default `"node --watch ENTRYPOINT"`
         * @example
         * ```js
         * { dev: { command: "tsx watch src/server.ts" } }
         * ```
         */
        command?: Input<string>;
        /**
         * The directory to run the command in, relative to the project root.
         * @default The bundle directory, or the project root.
         * @example
         * ```js
         * { dev: { directory: "packages/api" } }
         * ```
         */
        directory?: Input<string>;
        /**
         * The local server URL returned by this component. Its path and query are
         * preserved in the returned URL. `AWS_LAMBDA_HTTP_ENDPOINT` uses only the
         * hostname and port, since an HTTP listener cannot bind to a URL path.
         * @default `"http://localhost:8080"`
         * @example
         * ```js
         * { dev: { url: "http://localhost:3000" } }
         * ```
         */
        url?: Input<string>;
        /**
         * Whether to start the command automatically in the multiplexer.
         * @default `true`
         * @example
         * ```js
         * { dev: { autostart: false } }
         * ```
         */
        autostart?: Input<boolean>;
      };
  /**
   * Transform the underlying resources.
   * @default No transforms.
   * @example
   * ```js
   * { transform: { endpoint: { description: "HTTP API" } } }
   * ```
   */
  transform?: {
    /**
     * Transform the execution role.
     * @default No transform.
     * @example
     * ```js
     * { transform: { role: { description: "HTTP server role" } } }
     * ```
     */
    role?: Transform<iam.RoleArgs>;
    /**
     * Transform the central group. The local group's name and retention follow it.
     * @default No transform.
     * @example
     * ```js
     * { transform: { logGroup: { retentionInDays: 7 } } }
     * ```
     */
    logGroup?: Transform<cloudwatch.LogGroupArgs>;
    /**
     * Transform the web function.
     * @default No transform.
     * @example
     * ```js
     * { transform: { function: { tags: { team: "api" } } } }
     * ```
     */
    function?: Transform<lambdaweb.FunctionArgs>;
    /**
     * Transform the immutable revision. Changing its build or service configuration replaces it.
     * @default No transform.
     * @example
     * ```js
     * { transform: { revision: { description: "HTTP server revision" } } }
     * ```
     */
    revision?: Transform<lambdaweb.FunctionRevisionArgs>;
    /**
     * Transform the HTTPS endpoint.
     * @default No transform.
     * @example
     * ```js
     * { transform: { endpoint: { description: "HTTP API" } } }
     * ```
     */
    endpoint?: Transform<lambdaweb.FunctionEndpointArgs>;
    /**
     * Transform the Lambda network connector, created when `vpc` is set.
     * @default No transform.
     * @example
     * ```js
     * { transform: { networkConnector: { timeouts: { create: "20m" } } } }
     * ```
     */
    networkConnector?: Transform<lambda.CoreNetworkConnectorArgs>;
    /**
     * Transform the IAM role Lambda uses to create the network connector's network
     * interfaces in the VPC, created when `vpc` is set.
     * @default No transform.
     * @example
     * ```js
     * { transform: { operatorRole: { description: "Connects the HTTP server" } } }
     * ```
     */
    operatorRole?: Transform<iam.RoleArgs>;
  };
}

/**
 * The `WebFunction` component deploys an HTTP server to AWS Lambda web functions. It
 * uses Node.js 24 on Arm64 and a HomeRegion HTTPS endpoint. With `vpc`, its outbound
 * traffic goes through a VPC. MultiRegion endpoints, custom runtimes, domains, and
 * event-source subscriptions are not supported by this component.
 *
 * Unlike `Function`, your entrypoint starts an HTTP listener; Lambda does not call an
 * exported handler. Each environment can serve concurrent requests and remain active
 * across requests, so keep request state separate and do not assume one invocation at
 * a time.
 *
 * SST uploads code under a content-hashed S3 key and uses the native `@pulumi/aws`
 * resources to create a revision. The endpoint explicitly routes all traffic to that
 * revision; Pulumi updates it before deleting the replaced revision. This is not a
 * health-checked rollout and does not provide automatic application rollback.
 * The deployment role needs permission to manage Lambda web functions, revisions, and
 * endpoints, plus IAM, S3, and Logs resources. The provider internally creates the bare
 * function through Cloud Control, so the deployment role also needs
 * `cloudformation:CreateResource` and `cloudformation:GetResourceRequestStatus`.
 * With `vpc`, it also needs to manage Lambda network connectors, with
 * `lambda:PassNetworkConnector`, and `iam:PassRole` on the operator role.
 * These permissions belong to the deployment role, not the application execution role.
 * The function and code bucket names are retained across ordinary deployments.
 * SST manages both the central CloudWatch group and its HomeRegion `.local` group with
 * the configured retention, and grants the execution role access only to those groups.
 * The function receives the provider's default tags, including SST's app and stage tags.
 * AWS revisions and endpoints inherit these tags from their function.
 *
 * :::caution
 * Resource readiness does not check that your server starts listening. Lambda can
 * report the revision and endpoint as Active even when application initialization fails.
 * Send a test request and check the application logs after deployment.
 * :::
 *
 * @example
 * ```ts title="sst.config.ts"
 * const server = new sst.aws.WebFunction("Server", {
 *   entrypoint: "src/server.ts",
 *   dev: { command: "tsx watch src/server.ts" }
 * });
 * return { url: server.url };
 * ```
 *
 * ```ts title="src/server.ts"
 * import { createServer } from "node:http";
 * const endpoint = new URL(`http://${process.env.AWS_LAMBDA_HTTP_ENDPOINT}`);
 * createServer((_request, response) => response.end("Hello world"))
 *   .listen(Number(endpoint.port), endpoint.hostname);
 * ```
 */
export class WebFunction extends Component implements Link.Linkable {
  private readonly function?: lambdaweb.Function;
  private readonly revision?: lambdaweb.FunctionRevision;
  private readonly endpoint?: lambdaweb.FunctionEndpoint;
  private readonly codeBucket?: s3.Bucket;
  private readonly codeObject?: s3.BucketObjectv2;
  private readonly versioning?: s3.BucketVersioning;
  private readonly codeBucketPolicy?: s3.BucketPolicy;
  private readonly role: iam.Role;
  private readonly logGroup: cloudwatch.LogGroup;
  private readonly localLogGroup?: cloudwatch.LogGroup;
  private readonly devUrl?: Output<string>;
  private readonly networkConnector?: lambda.CoreNetworkConnector;
  private readonly operatorRole?: iam.Role;

  constructor(
    name: string,
    args: WebFunctionArgs,
    opts: ComponentResourceOptions = {},
  ) {
    if (!args)
      throw new VisibleError(`The "${name}" WebFunction needs an entrypoint.`);
    if (args.entrypoint === undefined || args.entrypoint === null)
      throw new VisibleError(`The "${name}" WebFunction needs an entrypoint.`);
    if (typeof args.entrypoint === "string")
      validateEntrypoint(args.entrypoint);
    if (typeof args.timeout === "string") validateTimeout(args.timeout);
    if (typeof args.maxConcurrencyPerEnvironment === "number")
      integer(
        "maxConcurrencyPerEnvironment",
        args.maxConcurrencyPerEnvironment,
        1,
        128,
      );
    if (isPlainRecord(args.environment)) validateEnvironment(args.environment);
    if (isPlainRecord(args.scaling)) {
      if (typeof args.scaling.maxEnvironments === "number")
        integer(
          "scaling.maxEnvironments",
          args.scaling.maxEnvironments,
          2,
          10000,
        );
      if (typeof args.scaling.rateLimit === "number")
        validateRateLimit(args.scaling.rateLimit);
    }
    if (!($dev && args.dev !== false)) {
      if (args.bundle === undefined && typeof args.entrypoint === "string")
        validateSource(path.resolve($cli.paths.root, args.entrypoint));
      if (Array.isArray(args.copyFiles))
        for (const item of args.copyFiles) {
          if (!isPlainRecord(item)) continue;
          if (
            typeof item.from === "string" &&
            (item.to === undefined || typeof item.to === "string")
          )
            validateCopyFile(item.from, item.to);
        }
    }
    super(__pulumiType, name, args, opts);

    const self = this;
    const dev = $dev && args.dev !== false;
    const region = getRegionOutput({}, opts).region;
    const links = Link.getProperties(args.link);
    const environment = all([
      args.environment ?? {},
      Link.getInclude<{
        type: "environment";
        env: Input<Record<string, Input<string>>>;
      }>("environment", args.link),
    ]).apply(([environment, includes]) => {
      validateEnvironment(environment);
      return all(includes.map((include) => output(include.env))).apply(
        (included) => {
          for (const value of included) validateEnvironment(value);
          return {
            ...environment,
            ...Object.assign({}, ...included),
            SST_RESOURCE_App: JSON.stringify({
              name: $app.name,
              stage: $app.stage,
            }),
          };
        },
      );
    });
    const settings = all([
      args.timeout,
      args.maxConcurrencyPerEnvironment,
      args.scaling,
      args.url,
      args.logging,
    ]).apply(([timeout, concurrency, scaling, url, logging]) => {
      const seconds = validateTimeout(timeout ?? "30 seconds");
      const maximum = integer(
        "maxConcurrencyPerEnvironment",
        concurrency ?? 64,
        1,
        128,
      );
      const maxEnvironments = scaling?.maxEnvironments;
      if (maxEnvironments !== undefined)
        integer("scaling.maxEnvironments", maxEnvironments, 2, 10000);
      const rateLimit = scaling?.rateLimit;
      if (rateLimit !== undefined) validateRateLimit(rateLimit);
      if (
        url?.authorization !== undefined &&
        !["none", "iam"].includes(url.authorization)
      )
        throw new VisibleError(
          `The "${name}" WebFunction's "url.authorization" must be "none" or "iam".`,
        );
      if (logging?.retention !== undefined && !(logging.retention in RETENTION))
        throw new VisibleError(
          `The "${name}" WebFunction's "logging.retention" is invalid.`,
        );
      return {
        seconds,
        maximum,
        maxEnvironments,
        rateLimit,
        authType:
          url?.authorization === "iam" ? "IamAuth" : "ApplicationManaged",
        logging: logging ?? {},
      };
    });
    const logGroup = new cloudwatch.LogGroup(
      ...transform(
        args.transform?.logGroup,
        `${name}LogGroup`,
        {
          name: `/aws/lambda/web/${physicalName(64, name)}`,
          retentionInDays: settings.apply(
            ({ logging }) => RETENTION[logging.retention ?? "1 month"],
          ),
        },
        { parent: self, ignoreChanges: ["name"] },
      ),
    );
    this.logGroup = logGroup;
    const localLogGroup = dev
      ? undefined
      : new cloudwatch.LogGroup(
          `${name}LocalLogGroup`,
          {
            name: interpolate`${logGroup.name}.local`,
            retentionInDays: logGroup.retentionInDays,
          },
          { parent: self, ignoreChanges: ["name"] },
        );
    this.localLogGroup = localLogGroup;

    const codeBucket = dev
      ? undefined
      : new s3.Bucket(
          `${name}CodeBucket`,
          {
            forceDestroy: true,
          },
          { parent: self },
        );
    this.codeBucket = codeBucket;
    const versioning =
      codeBucket &&
      new s3.BucketVersioning(
        `${name}CodeVersioning`,
        {
          bucket: codeBucket.bucket,
          versioningConfiguration: { status: "Enabled" },
        },
        { parent: self },
      );
    this.versioning = versioning;
    const publicAccessBlock =
      codeBucket &&
      new s3.BucketPublicAccessBlock(
        `${name}CodePublicAccessBlock`,
        {
          bucket: codeBucket.bucket,
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        },
        { parent: self },
      );
    const role = new iam.Role(
      ...transform(
        args.transform?.role,
        `${name}Role`,
        {
          assumeRolePolicy: iam.getPolicyDocumentOutput({
            statements: [
              {
                actions: ["sts:AssumeRole", "sts:TagSession"],
                principals: [
                  { type: "Service", identifiers: ["lambda.amazonaws.com"] },
                ],
              },
              ...(dev
                ? [
                    {
                      actions: ["sts:AssumeRole"],
                      principals: [
                        {
                          type: "AWS",
                          identifiers: [
                            getCallerIdentityOutput({}, opts).accountId,
                          ],
                        },
                      ],
                    },
                  ]
                : []),
            ],
          }).json,
          inlinePolicies: [
            {
              name: "inline",
              policy: all([
                args.permissions ?? [],
                Link.getInclude<Permission>("aws.permission", args.link),
              ]).apply(
                ([permissions, links]) =>
                  iam.getPolicyDocumentOutput({
                    statements: [
                      ...permissions,
                      ...links,
                      {
                        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                        resources: [
                          interpolate`${logGroup.arn}:*`,
                          ...(localLogGroup
                            ? [interpolate`${localLogGroup.arn}:*`]
                            : []),
                        ],
                      },
                    ].map((item) => ({
                      effect:
                        ("effect" in item ? item.effect : "allow") === "deny"
                          ? "Deny"
                          : "Allow",
                      actions: item.actions,
                      resources: item.resources,
                      conditions:
                        "conditions" in item ? item.conditions : undefined,
                    })),
                  }).json,
              ),
            },
          ],
        },
        { parent: self },
      ),
    );
    this.role = role;

    if (dev) {
      const config = args.dev || {};
      this.devUrl = output(config.url ?? "http://localhost:8080").apply(
        (value) => {
          const url = new URL(value);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new VisibleError(
              `The "${name}" WebFunction's "dev.url" must be an HTTP URL without credentials.`,
            );
          return value;
        },
      );
      new DevCommand(
        `${name}Dev`,
        {
          link: args.link,
          dev: {
            title: name,
            autostart: config.autostart ?? true,
            directory: config.directory ?? args.bundle,
            command:
              config.command ??
              all([args.entrypoint, args.bundle, config.directory]).apply(
                ([entrypoint, bundle, directory]) => {
                  const source = path.resolve(
                    $cli.paths.root,
                    bundle ?? ".",
                    entrypoint,
                  );
                  const working = path.resolve(
                    $cli.paths.root,
                    directory ?? bundle ?? ".",
                  );
                  const relative = path.relative(working, source);
                  return `node --watch '${relative.replaceAll(
                    "'",
                    "'\"'\"'",
                  )}'`;
                },
              ),
          },
          environment: all([
            environment,
            Link.propertiesToEnv(links),
            region,
            this.devUrl,
          ]).apply(([environment, linkedEnvironment, region, value]) => {
            const url = new URL(value);
            return {
              ...environment,
              ...linkedEnvironment,
              AWS_REGION: region,
              AWS_LAMBDA_HTTP_ENDPOINT: `${url.hostname}:${
                url.port || (url.protocol === "https:" ? "443" : "80")
              }`,
            };
          }),
          aws: { role: role.arn },
        },
        { parent: self },
      );
      this.registerOutputs({ _hint: this.url });
      return;
    }

    const encryptionKey = linkEncryptionKey().base64;
    const build = all([
      args.entrypoint,
      args.bundle,
      args.nodejs,
      args.copyFiles ?? [],
      encryptionKey,
      links,
    ]).apply(
      async ([
        entrypoint,
        customBundle,
        nodejs,
        copyFiles,
        encryptionKey,
        links,
      ]) => {
        validateEntrypoint(entrypoint);
        const files = copyFiles.map((item) =>
          validateCopyFile(item.from, item.to),
        );
        let bundle: string | undefined;
        let handler: string;
        if (customBundle !== undefined) {
          bundle = path.resolve($cli.paths.root, customBundle);
          const entry = path.resolve(bundle, entrypoint);
          if (
            !isWithin(bundle, entry) ||
            !fs.existsSync(entry) ||
            !fs.statSync(entry).isFile()
          )
            throw new VisibleError(
              `The "${name}" WebFunction's entrypoint must be a file inside its bundle.`,
            );
          if (!/[.](mjs|cjs|js)$/.test(entrypoint))
            throw new VisibleError(
              `The "${name}" WebFunction's bundled entrypoint must be a JavaScript file.`,
            );
          handler = path.relative(bundle, entry).split(path.sep).join("/");
        } else {
          const entry = path.resolve($cli.paths.root, entrypoint);
          validateSource(entry);
          handler =
            entry.slice(0, entry.length - path.extname(entry).length) + ".main";
        }
        const install = Array.isArray(nodejs?.install)
          ? Object.fromEntries(nodejs.install.map((value) => [value, "*"]))
          : nodejs?.install;
        const result = await rpc.call<{
          out: string;
          handler: string;
          errors: string[];
          sourcemaps: string[];
        }>("Runtime.Build", {
          functionID: name,
          handler,
          bundle,
          runtime: "nodejs24.x",
          encryptionKey,
          links,
          copyFiles: files,
          dev: false,
          properties: {
            ...nodejs,
            install,
            minify: nodejs?.minify ?? true,
            format: nodejs?.format ?? "esm",
            architecture: "arm64",
          },
        });
        if (result.errors.length)
          throw new VisibleError(result.errors.join("\n"));
        return {
          directory: result.out,
          entrypoint: bundle
            ? handler
            : result.handler.slice(0, -path.extname(result.handler).length) +
              (nodejs?.format === "cjs" ? ".cjs" : ".mjs"),
          resourceFile: bundle ? `.sst/${name}/resource.enc` : "resource.enc",
          sourcemaps: nodejs?.sourcemap ? [] : result.sourcemaps,
          copyFiles: files,
        };
      },
    );
    const cloudEnvironment = all([environment, encryptionKey, build]).apply(
      ([environment, key, build]) => ({
        ...environment,
        SST_KEY: key,
        SST_KEY_FILE: build.resourceFile,
        AWS_LAMBDA_NODEJS_ENTRYPOINT: build.entrypoint,
      }),
    );
    const zip = all([build, cloudEnvironment]).apply(
      async ([
        { directory, entrypoint, resourceFile, sourcemaps, copyFiles },
        variables,
      ]) => {
        let environmentSize = 0;
        for (const [key, value] of Object.entries(variables)) {
          if (typeof value !== "string" || value.length === 0)
            throw new VisibleError(
              `The "${name}" WebFunction's environment variable "${key}" must be a non-empty string.`,
            );
          environmentSize +=
            Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
        }
        if (environmentSize > 32 * 1024)
          throw new VisibleError(
            `The "${name}" WebFunction's environment variables exceed 32 KiB, including SST's managed values.`,
          );
        if (!fs.existsSync(path.join(directory, entrypoint)))
          throw new VisibleError(
            `The "${name}" WebFunction's build did not produce "${entrypoint}".`,
          );
        const zipPath = path.join(
          $cli.paths.work,
          "artifacts",
          `${name}-web-function`,
          "code.zip",
        );
        await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
        const files = new Map<string, string>();
        const bundled = await glob("**", {
          cwd: directory,
          dot: true,
          follow: false,
          ignore: [
            ".git/**",
            "**/sst-env.d.ts",
            ...sourcemaps.map((file) =>
              path.relative(directory, file).split(path.sep).join("/"),
            ),
          ],
        });
        for (const file of bundled) {
          const source = path.join(directory, file);
          if (
            file !== resourceFile &&
            (file === "resource.enc" || file.startsWith(".sst/"))
          )
            continue;
          if (!(await fs.promises.lstat(source)).isDirectory())
            files.set(file, source);
        }
        // Deployment-mode Runtime.Build does not copy files. Overlay both built and
        // prebuilt packages here; later entries override earlier ones, as in Function.
        for (const copy of copyFiles) {
          const entries = copy.isDir
            ? await glob("**", { cwd: copy.from, dot: true, follow: false })
            : [""];
          for (const relative of entries) {
            const source = path.join(copy.from, relative);
            if ((await fs.promises.lstat(source)).isDirectory()) continue;
            const destination = path
              .join(copy.to, relative)
              .split(path.sep)
              .join("/");
            if (
              destination === "resource.enc" ||
              destination === "sst-env.d.ts" ||
              destination.endsWith("/sst-env.d.ts") ||
              destination.startsWith(".git/") ||
              destination.startsWith(".sst/")
            )
              continue;
            files.set(destination, source);
          }
        }
        const resourcePath = path.join(directory, resourceFile);
        if (!fs.existsSync(resourcePath) || !fs.statSync(resourcePath).isFile())
          throw new VisibleError(
            `The "${name}" WebFunction's build did not produce its encrypted resource file.`,
          );
        files.set(resourceFile, resourcePath);
        for (const [destination, source] of files) {
          if (!(await fs.promises.lstat(source)).isSymbolicLink()) continue;
          const target = await fs.promises.readlink(source);
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(destination), target),
          );
          if (
            path.isAbsolute(target) ||
            resolved === ".." ||
            resolved.startsWith("../") ||
            (!files.has(resolved) &&
              ![...files.keys()].some((entry) =>
                entry.startsWith(`${resolved}/`),
              ))
          )
            throw new VisibleError(
              `The "${name}" WebFunction's symlink "${destination}" must point to an existing relative target inside the deployment package.`,
            );
        }
        if (!files.has(entrypoint))
          throw new VisibleError(
            `The "${name}" WebFunction's entrypoint is excluded from its deployment package.`,
          );
        await new Promise<void>((resolve, reject) => {
          const stream = fs.createWriteStream(zipPath);
          const archive = archiver("zip", { statConcurrency: 1 });
          archive.on("warning", reject);
          archive.on("error", reject);
          stream.on("error", reject);
          stream.once("close", resolve);
          archive.pipe(stream);
          for (const [file, source] of [...files].sort(([a], [b]) =>
            a.localeCompare(b),
          ))
            archive.file(source, {
              name: file,
              date: new Date(0),
            });
          archive.finalize().catch(reject);
        });
        return {
          path: zipPath,
          hash: crypto
            .createHash("sha256")
            .update(await fs.promises.readFile(zipPath))
            .digest("hex"),
          entrypoint,
        };
      },
    );
    const codeObject = new s3.BucketObjectv2(
      `${name}Code`,
      {
        bucket: codeBucket!.bucket,
        key: interpolate`code/${zip.hash}.zip`,
        source: zip.path.apply((file) => new asset.FileArchive(file)),
        sourceHash: zip.hash,
      },
      {
        parent: self,
        dependsOn: [versioning!, publicAccessBlock!],
        deleteBeforeReplace: false,
      },
    );
    this.codeObject = codeObject;
    const fn = new lambdaweb.Function(
      ...transform(
        args.transform?.function,
        `${name}Function`,
        {
          // Component supplies the app/stage-prefixed name before provider registration.
          functionName: "",
        },
        { parent: self },
      ),
    );
    this.function = fn;
    const codeBucketPolicy = new s3.BucketPolicy(
      `${name}CodeBucketPolicy`,
      {
        bucket: codeBucket!.bucket,
        policy: all([
          codeBucket!.arn,
          fn.arn,
          getCallerIdentityOutput({}, opts).accountId,
        ]).apply(([bucketArn, functionArn, account]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowLambdaWebFunctionCodeAccess",
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: `${bucketArn}/code/*`,
                Condition: {
                  StringEquals: { "aws:SourceAccount": account },
                  ArnLike: {
                    "aws:SourceArn": `${functionArn}/revision/*`,
                  },
                },
              },
            ],
          }),
        ),
      },
      { parent: self, dependsOn: [publicAccessBlock!] },
    );
    this.codeBucketPolicy = codeBucketPolicy;
    const network = createNetworkConnector();
    this.networkConnector = network?.connector;
    this.operatorRole = network?.operatorRole;
    const revision = new lambdaweb.FunctionRevision(
      ...transform(
        args.transform?.revision,
        `${name}Revision`,
        {
          functionName: fn.functionName,
          buildConfig: {
            codeConfig: {
              s3Object: {
                bucket: codeObject.bucket,
                key: codeObject.key,
                versionId: codeObject.versionId,
              },
            },
            runtimeConfig: { runtime: "nodejs24.x" },
          },
          serviceConfig: {
            executionRoleArn: role.arn,
            // A revision takes a version of the connector: a change to the
            // connector publishes a new one, and makes a new revision
            egressNetworkConnectorArn: network?.connector.latestVersionArn,
            environmentVariables: secret(cloudEnvironment),
            timeoutSeconds: settings.seconds,
            maxConcurrencyPerEnvironment: settings.maximum,
            telemetryConfig: {
              loggingConfig: {
                logGroup: logGroup.name,
                applicationLogLevel: settings.logging.apply(
                  (logging) => logging.applicationLogLevel ?? "INFO",
                ),
                systemLogLevel: settings.logging.apply(
                  (logging) => logging.systemLogLevel ?? "INFO",
                ),
              },
            },
          },
        },
        {
          parent: self,
          dependsOn: [codeBucketPolicy],
          deleteBeforeReplace: false,
        },
      ),
    );
    this.revision = revision;
    const endpoint = new lambdaweb.FunctionEndpoint(
      ...transform(
        args.transform?.endpoint,
        `${name}Endpoint`,
        {
          functionName: fn.functionName,
          endpointName: "default",
          endpointType: "HomeRegion",
          authType: settings.authType,
          autoDeploymentMode: "Disabled",
          revisionWeights: [{ revisionId: revision.revisionId, weight: 100 }],
          scalingConfig: settings.apply(({ maxEnvironments }) =>
            maxEnvironments === undefined ? undefined : { maxEnvironments },
          ),
          throttleConfig: settings.apply(({ rateLimit }) =>
            rateLimit === undefined ? undefined : { rateLimit },
          ),
        },
        { parent: self },
      ),
    );
    this.endpoint = endpoint;

    this.registerOutputs({ _hint: this.url });

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
          if (natGateways.length === 0 && natInstances.length === 0)
            warnOnce(
              `\nWarning: The "${name}" WebFunction is in the "${id}" VPC, which does not have a NAT gateway. Its server can't reach the internet. To let it, set the "nat" prop on the "Vpc" component.\n`,
            );
          return result;
        });
      }
      return output(args.vpc);
    }

    function createNetworkConnector() {
      const vpc = normalizeVpc();
      if (!vpc) return;
      const partition = getPartitionOutput({}, opts).partition;

      const operatorRole = new iam.Role(
        ...transform(
          args.transform?.operatorRole,
          `${name}OperatorRole`,
          {
            assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
              Service: "network-connectors.lambda.amazonaws.com",
            }),
            inlinePolicies: [
              {
                name: "inline",
                policy: iam.getPolicyDocumentOutput({
                  statements: [
                    {
                      actions: ["ec2:CreateNetworkInterface"],
                      resources: [
                        interpolate`arn:${partition}:ec2:*:*:network-interface/*`,
                        interpolate`arn:${partition}:ec2:*:*:subnet/*`,
                        interpolate`arn:${partition}:ec2:*:*:security-group/*`,
                      ],
                    },
                    {
                      actions: ["ec2:CreateTags"],
                      resources: [
                        interpolate`arn:${partition}:ec2:*:*:network-interface/*`,
                      ],
                      conditions: [
                        {
                          test: "StringEquals",
                          variable: "ec2:ManagedResourceOperator",
                          values: ["network-connectors.lambda.amazonaws.com"],
                        },
                      ],
                    },
                  ],
                }).json,
              },
            ],
          },
          { parent: self },
        ),
      );

      const connector = new lambda.CoreNetworkConnector(
        ...transform(
          args.transform?.networkConnector,
          `${name}NetworkConnector`,
          {
            configuration: {
              vpcEgressConfiguration: {
                associatedComputeResourceTypes: ["WebFunction"],
                networkProtocol: "IPv4",
                subnetIds: vpc.privateSubnets,
                securityGroupIds: vpc.securityGroups,
              },
            },
            // Lambda checks the operator role as soon as the connector is
            // created. A role IAM hasn't finished propagating fails that check,
            // and leaves a FAILED connector behind, so wait until the role is
            // 20 seconds old.
            operatorRole: all([
              operatorRole.arn,
              operatorRole.createDate,
            ]).apply(async ([arn, created]) => {
              const wait = Date.parse(created) + 20_000 - Date.now();
              if (wait > 0) await new Promise((r) => setTimeout(r, wait));
              return arn;
            }),
          },
          { parent: self },
        ),
      );
      return { connector, operatorRole };
    }

    function integer(
      property: string,
      value: number,
      min: number,
      max: number,
    ) {
      if (!Number.isInteger(value) || value < min || value > max)
        throw new VisibleError(
          `The "${name}" WebFunction's "${property}" must be an integer between ${min} and ${max}.`,
        );
      return value;
    }
    function validateRateLimit(value: number) {
      if (
        !(
          Number.isInteger(value) &&
          (value === 0 ||
            (value >= 100 && value <= 1000 && value % 100 === 0) ||
            (value >= 2000 && value <= 10000 && value % 1000 === 0))
        )
      )
        throw new VisibleError(
          `The "${name}" WebFunction's "scaling.rateLimit" is not a supported request rate.`,
        );
    }
    function validateSource(entry: string) {
      if (!fs.existsSync(entry) || !fs.statSync(entry).isFile())
        throw new VisibleError(
          `The "${name}" WebFunction can't find its entrypoint at "${entry}".`,
        );
      const stem = entry.slice(0, entry.length - path.extname(entry).length);
      const siblings = [
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
      ].filter((extension) => fs.existsSync(stem + extension));
      if (!siblings.includes(path.extname(entry)))
        throw new VisibleError(
          `The "${name}" WebFunction's entrypoint must be a JavaScript or TypeScript source file.`,
        );
      if (siblings.length > 1)
        throw new VisibleError(
          `The "${name}" WebFunction's entrypoint is ambiguous: files with the same basename (${siblings.join(
            ", ",
          )}) exist. Rename them to distinct basenames.`,
        );
    }
    function validateCopyFile(fromValue: string, toValue?: string) {
      const from = path.resolve($cli.paths.root, fromValue);
      const to = toValue ?? fromValue;
      if (
        path.isAbsolute(to) ||
        !isWithin("/bundle", path.resolve("/bundle", to))
      )
        throw new VisibleError(
          `The "${name}" WebFunction's copyFiles destination must stay inside the bundle.`,
        );
      if (!fs.existsSync(from))
        throw new VisibleError(
          `The "${name}" WebFunction can't find copyFiles source "${fromValue}".`,
        );
      const stats = fs.statSync(from);
      if (!stats.isFile() && !stats.isDirectory())
        throw new VisibleError(
          `The "${name}" WebFunction's copyFiles source must be a file or directory.`,
        );
      return { from, to, isDir: stats.isDirectory() };
    }
    function validateTimeout(value: DurationMinutes) {
      if (!/^\d+ (seconds?|minutes?)$/.test(value))
        throw new VisibleError(
          `The "${name}" WebFunction's "timeout" must be a whole number of seconds or minutes.`,
        );
      return integer("timeout", toSeconds(value), 3, 900);
    }
    function validateEntrypoint(value: string) {
      if (typeof value !== "string" || !value.trim())
        throw new VisibleError(
          `The "${name}" WebFunction needs a non-empty entrypoint.`,
        );
    }
    function validateEnvironment(value: Record<string, unknown>) {
      for (const key of Object.keys(value)) {
        if (
          key.startsWith("AWS_LAMBDA_") ||
          key.startsWith("SST_RESOURCE_") ||
          [
            "AWS_ACCESS_KEY",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SECRET_KEY",
            "AWS_SECURITY_TOKEN",
            "AWS_SESSION_TOKEN",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "AWS_EXECUTION_ENV",
            "LAMBDA_TASK_ROOT",
            "LAMBDA_RUNTIME_DIR",
            "SST_KEY",
            "SST_KEY_FILE",
          ].includes(key)
        )
          throw new VisibleError(
            `The "${name}" WebFunction's environment variable "${key}" is reserved.`,
          );
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))
          throw new VisibleError(
            `The "${name}" WebFunction's environment variable "${key}" has an invalid name.`,
          );
      }
    }
  }

  /** The full HTTPS URL (including `https://`), or the local URL in `sst dev`. */
  public get url(): Output<string> {
    return this.devUrl ?? interpolate`https://${this.endpoint!.domainName}`;
  }
  /** The web function ARN. Not available in local `sst dev`. */
  public get arn() {
    return this.function?.arn;
  }
  /** The endpoint ARN. Not available in local `sst dev`. */
  public get endpointArn() {
    return this.endpoint?.arn;
  }
  /** The immutable revision ARN. Not available in local `sst dev`. */
  public get revisionArn() {
    return this.revision?.arn;
  }
  /** The underlying resources. Deployment resources are absent in local `sst dev`. */
  public get nodes() {
    return {
      function: this.function,
      revision: this.revision,
      endpoint: this.endpoint,
      codeBucket: this.codeBucket,
      codeObject: this.codeObject,
      versioning: this.versioning,
      codeBucketPolicy: this.codeBucketPolicy,
      role: this.role,
      logGroup: this.logGroup,
      localLogGroup: this.localLogGroup,
      /**
       * The Lambda network connector. Only created when `vpc` is set, and not in
       * `sst dev` while the server runs locally.
       */
      networkConnector: this.networkConnector,
      /**
       * The IAM role Lambda uses to create the network connector's network interfaces.
       * Only created with the network connector.
       */
      operatorRole: this.operatorRole,
    };
  }
  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        url: this.url,
        ...(this.endpoint
          ? {
              arn: this.arn,
              endpointArn: this.endpointArn,
            }
          : {}),
      },
      ...(this.endpoint
        ? {
            include: [
              permission({
                actions: ["lambda:InvokeWebFunctionEndpoint"],
                resources: [this.endpointArn!],
              }),
            ],
          }
        : {}),
    };
  }
}

function isWithin(directory: string, file: string) {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && Object.getPrototypeOf(value) === Object.prototype;
}

const __pulumiType = "sst:aws:WebFunction";
// @ts-expect-error
WebFunction.__pulumiType = __pulumiType;
