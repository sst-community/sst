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
  cloudformation,
  cloudwatch,
  getCallerIdentityOutput,
  getPartitionOutput,
  getRegionOutput,
  iam,
  s3,
} from "@pulumi/aws";
import { Component, Transform, transform } from "../component";
import { DurationMinutes, toSeconds } from "../duration";
import { VisibleError } from "../error";
import { DevCommand } from "../experimental/dev-command";
import { Input } from "../input";
import { Link } from "../link";
import { physicalName } from "../naming";
import { rpc } from "../rpc/rpc";
import { FunctionArgs } from "./function";
import { RETENTION } from "./logging";
import { Permission, permission } from "./permission";

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
   * @example
   * ```js
   * { entrypoint: "src/server.ts" }
   * ```
   */
  entrypoint: Input<string>;
  /**
   * An existing directory containing your deployment package. The `entrypoint` must be
   * inside it. Native dependencies must be built for Linux Arm64.
   */
  bundle?: Input<string>;
  /**
   * Environment variables available to your server. Lambda's `AWS_LAMBDA_*` variables
   * and SST's `SST_RESOURCE_*` link variables cannot be overridden.
   * Values are passed as CloudFormation `NoEcho` parameters. Including links, at most
   * 200 variables can be configured. Empty values are rejected and each value must fit
   * in 4096 UTF-8 bytes.
   * All keys and values, including links and the managed entrypoint, must fit in 32 KiB.
   */
  environment?: FunctionArgs["environment"];
  /**
   * Link resources to your server. Their properties are available through `Resource`
   * from the `sst` SDK and their permissions are added to the execution role.
   */
  link?: FunctionArgs["link"];
  /** Permissions added to the execution role, in addition to linked resources. */
  permissions?: FunctionArgs["permissions"];
  /**
   * Configure esbuild and dependencies, as with `Function`. When `sourcemap` is `true`,
   * source maps are included in the deployment package; they are not uploaded separately
   * for SST's event-function log integration.
   */
  nodejs?: FunctionArgs["nodejs"];
  /** Copy additional files into the deployment package, as with `Function`. */
  copyFiles?: FunctionArgs["copyFiles"];
  /**
   * The time allowed for each request, between 3 and 900 seconds.
   * @default `"30 seconds"`
   */
  timeout?: Input<DurationMinutes>;
  /**
   * Concurrent requests handled by each execution environment, between 1 and 128.
   * Your server must safely handle overlapping requests.
   * @default `64`
   */
  maxConcurrencyPerEnvironment?: Input<number>;
  /**
   * Optional endpoint limits. Omitting a limit removes a previously configured limit.
   * Account quotas still apply.
   */
  scaling?: Input<{
    /** The maximum execution environments, between 2 and 10000. */
    maxEnvironments?: Input<number>;
    /**
     * Requests per second: 0, 100 through 1000 in increments of 100, or 2000 through
     * 10000 in increments of 1000. 0 rejects new requests. Regional limits may differ.
     */
    rateLimit?: Input<number>;
  }>;
  /** Configure authorization for the HTTPS endpoint. */
  url?: Input<{
    /**
     * `none` lets your application handle authorization. `iam` requires SigV4-signed
     * requests and `lambda:InvokeWebFunctionEndpoint` permission.
     * @default `"none"`
     */
    authorization?: Input<"none" | "iam">;
  }>;
  /** Configure CloudWatch logs. */
  logging?: Input<{
    /** @default `"1 month"` */
    retention?: Input<keyof typeof RETENTION>;
    /** @default `"INFO"` */
    applicationLogLevel?: Input<
      "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL"
    >;
    /** @default `"INFO"` */
    systemLogLevel?: Input<"DEBUG" | "INFO" | "WARN">;
  }>;
  /**
   * Run your server locally in `sst dev`, without deploying a web function. The command
   * receives links, environment variables, AWS credentials for the execution role, and
   * `AWS_LAMBDA_HTTP_ENDPOINT` derived from `url`.
   *
   * Set `false` to deploy the real web function in `sst dev`. The local execution role
   * trusts your AWS account only when local development is enabled.
   */
  dev?:
    | false
    | {
        /**
         * A command that starts your server. Node.js 24 can run erasable TypeScript syntax;
         * for other TypeScript features, set a command such as `"tsx watch src/server.ts"`.
         * @default `"node --watch ENTRYPOINT"`
         */
        command?: Input<string>;
        /** The directory to run the command in, relative to the project root. */
        directory?: Input<string>;
        /** @default `"http://localhost:8080"` */
        url?: Input<string>;
        /** @default `true` */
        autostart?: Input<boolean>;
      };
  /** Transform the underlying resources. */
  transform?: {
    role?: Transform<iam.RoleArgs>;
    /** Transform the central group. The local group's name and retention follow it. */
    logGroup?: Transform<cloudwatch.LogGroupArgs>;
    stack?: Transform<cloudformation.StackArgs>;
  };
}

/**
 * The `WebFunction` component deploys an HTTP server to AWS Lambda web functions. It
 * uses Node.js 24 on Arm64 and a HomeRegion HTTPS endpoint. MultiRegion endpoints,
 * custom runtimes, VPC connectors, domains, and event-source subscriptions are not
 * supported by this component.
 *
 * Unlike `Function`, your entrypoint starts an HTTP listener; Lambda does not call an
 * exported handler. Each environment can serve concurrent requests and remain active
 * across requests, so keep request state separate and do not assume one invocation at
 * a time.
 *
 * SST uploads an immutable S3 object version and creates a revision through
 * CloudFormation. The endpoint's target is updated before the old revision is deleted,
 * and CloudFormation attempts to roll back a failed stack update.
 * The deployment role needs CloudFormation permissions and permissions to manage Lambda
 * web functions, revisions, and endpoints, as well as the IAM, S3, and Logs resources.
 * The assigned stack and code bucket names are retained across ordinary deployments.
 * SST manages both the central CloudWatch group and its HomeRegion `.local` group with
 * the configured retention, and grants the execution role access only to those groups.
 * The function includes `sst:app` and `sst:stage` tags. AWS revisions and endpoints
 * inherit these tags from their function.
 *
 * :::caution
 * CloudFormation readiness does not check that your server starts listening. Lambda can
 * report the revision and endpoint as Active even when application initialization fails.
 * Send a test request and check the application logs after deployment. This component
 * does not provide a health-checked rollout.
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
  private readonly stack?: cloudformation.Stack;
  private readonly codeBucket?: s3.Bucket;
  private readonly codeObject?: s3.BucketObjectv2;
  private readonly versioning?: s3.BucketVersioning;
  private readonly codeBucketPolicy?: s3.BucketPolicy;
  private readonly role: iam.Role;
  private readonly logGroup: cloudwatch.LogGroup;
  private readonly localLogGroup?: cloudwatch.LogGroup;
  private readonly devUrl?: Output<string>;

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
    const environment = all([
      args.environment ?? {},
      Link.propertiesToEnv(Link.getProperties(args.link)),
      Link.getInclude<{
        type: "environment";
        env: Input<Record<string, Input<string>>>;
      }>("environment", args.link),
    ]).apply(([environment, links, includes]) => {
      validateEnvironment(environment);
      return all(includes.map((include) => output(include.env))).apply(
        (included) => {
          for (const value of included) validateEnvironment(value);
          return {
            ...environment,
            ...Object.assign({}, ...included),
            ...links,
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
          environment: all([environment, region, this.devUrl]).apply(
            ([environment, region, value]) => {
              const url = new URL(value);
              return {
                ...environment,
                AWS_REGION: region,
                AWS_LAMBDA_HTTP_ENDPOINT: `${url.hostname}:${
                  url.port || (url.protocol === "https:" ? "443" : "80")
                }`,
              };
            },
          ),
          aws: { role: role.arn },
        },
        { parent: self },
      );
      this.registerOutputs({ _hint: this.url });
      return;
    }

    const build = all([
      args.entrypoint,
      args.bundle,
      args.nodejs,
      args.copyFiles ?? [],
    ]).apply(async ([entrypoint, customBundle, nodejs, copyFiles]) => {
      validateEntrypoint(entrypoint);
      const files = copyFiles.map((item) =>
        validateCopyFile(item.from, item.to),
      );
      if (customBundle !== undefined) {
        const directory = path.resolve($cli.paths.root, customBundle);
        const entry = path.resolve(directory, entrypoint);
        if (
          !isWithin(directory, entry) ||
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
        return {
          directory,
          entrypoint: path.relative(directory, entry).split(path.sep).join("/"),
          sourcemaps: [] as string[],
          copyFiles: files,
        };
      }
      const entry = path.resolve($cli.paths.root, entrypoint);
      validateSource(entry);
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
        handler:
          entry.slice(0, entry.length - path.extname(entry).length) + ".main",
        runtime: "nodejs24.x",
        encryptionKey: "",
        links: {},
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
        entrypoint:
          result.handler.slice(0, -path.extname(result.handler).length) +
          (nodejs?.format === "cjs" ? ".cjs" : ".mjs"),
        sourcemaps: nodejs?.sourcemap ? [] : result.sourcemaps,
        copyFiles: files,
      };
    });
    const zip = all([build, environment]).apply(
      async ([{ directory, entrypoint, sourcemaps, copyFiles }, variables]) => {
        let environmentSize =
          Buffer.byteLength("AWS_LAMBDA_NODEJS_ENTRYPOINT", "utf8") +
          Buffer.byteLength(entrypoint, "utf8");
        for (const [key, value] of Object.entries(variables)) {
          if (
            typeof value !== "string" ||
            value.length === 0 ||
            Buffer.byteLength(value, "utf8") > 4096
          )
            throw new VisibleError(
              `The "${name}" WebFunction's environment variable "${key}" must be a non-empty string of at most 4096 UTF-8 bytes.`,
            );
          environmentSize +=
            Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
        }
        if (environmentSize > 32 * 1024)
          throw new VisibleError(
            `The "${name}" WebFunction's environment variables exceed 32 KiB, including links and the managed entrypoint.`,
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
            ".sst/**",
            "**/sst-env.d.ts",
            "resource.enc",
            ...sourcemaps.map((file) =>
              path.relative(directory, file).split(path.sep).join("/"),
            ),
          ],
        });
        for (const file of bundled) {
          const source = path.join(directory, file);
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
        key: "code.zip",
        source: zip.path.apply((file) => new asset.FileArchive(file)),
        sourceHash: zip.hash,
      },
      { parent: self, dependsOn: [versioning!, publicAccessBlock!] },
    );
    this.codeObject = codeObject;
    const codeBucketPolicy = new s3.BucketPolicy(
      `${name}CodeBucketPolicy`,
      {
        bucket: codeBucket!.bucket,
        policy: all([
          codeBucket!.arn,
          codeBucket!.bucket,
          region,
          getPartitionOutput({}, opts).partition,
          getCallerIdentityOutput({}, opts).accountId,
        ]).apply(([bucketArn, functionName, region, partition, account]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowLambdaWebFunctionCodeAccess",
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: `${bucketArn}/code.zip`,
                Condition: {
                  StringEquals: { "aws:SourceAccount": account },
                  ArnLike: {
                    "aws:SourceArn": `arn:${partition}:lambda:${region}:${account}:web-function/${functionName}/revision/*`,
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
    const parameterData = environment.apply((variables) => {
      const keys = Object.keys(variables).sort();
      if (keys.length > 200)
        throw new VisibleError(
          `The "${name}" WebFunction supports at most 200 environment variables, including links.`,
        );
      const parameters: Record<string, string> = {};
      const definitions: Record<string, { Type: string; NoEcho: boolean }> = {};
      const references: Record<string, { Ref: string }> = {};
      keys.forEach((key, index) => {
        const value: unknown = variables[key];
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          Buffer.byteLength(value, "utf8") > 4096
        )
          throw new VisibleError(
            `The "${name}" WebFunction's environment variable "${key}" must be a non-empty string of at most 4096 UTF-8 bytes.`,
          );
        const parameter = `Environment${index}`;
        parameters[parameter] = value;
        definitions[parameter] = { Type: "String", NoEcho: true };
        references[key] = { Ref: parameter };
      });
      return { parameters, definitions, references };
    });
    this.stack = new cloudformation.Stack(
      ...transform(
        args.transform?.stack,
        `${name}Stack`,
        {
          name: physicalName(128, `${name}WebFunction`),
          parameters: secret(parameterData.parameters),
          templateBody: all([
            codeObject.bucket,
            codeObject.key,
            codeObject.versionId,
            role.arn,
            logGroup.name,
            parameterData,
            settings,
            zip.entrypoint,
          ]).apply(
            ([
              bucket,
              key,
              versionId,
              executionRoleArn,
              logGroupName,
              parameterData,
              settings,
              entrypoint,
            ]) =>
              JSON.stringify({
                AWSTemplateFormatVersion: "2010-09-09",
                Parameters: parameterData.definitions,
                Resources: {
                  Function: {
                    Type: "AWS::Lambda::WebFunction",
                    Properties: {
                      // The code bucket has a stable, unique physical name. Log group
                      // transforms must not rename or replace the web function.
                      FunctionName: bucket,
                      Tags: [
                        { Key: "sst:app", Value: $app.name },
                        { Key: "sst:stage", Value: $app.stage },
                      ],
                    },
                  },
                  Revision: {
                    Type: "AWS::Lambda::WebFunctionRevision",
                    Properties: {
                      FunctionName: {
                        "Fn::GetAtt": ["Function", "FunctionArn"],
                      },
                      BuildConfig: {
                        CodeConfig: {
                          S3Object: {
                            Bucket: bucket,
                            Key: key,
                            VersionId: versionId,
                          },
                        },
                        RuntimeConfig: { Runtime: "nodejs24.x" },
                      },
                      ServiceConfig: {
                        ExecutionRoleArn: executionRoleArn,
                        EnvironmentVariables: {
                          ...parameterData.references,
                          AWS_LAMBDA_NODEJS_ENTRYPOINT: entrypoint,
                        },
                        TimeoutSeconds: settings.seconds,
                        MaxConcurrencyPerEnvironment: settings.maximum,
                        TelemetryConfig: {
                          LoggingConfig: {
                            LogGroup: logGroupName,
                            ApplicationLogLevel:
                              settings.logging.applicationLogLevel ?? "INFO",
                            SystemLogLevel:
                              settings.logging.systemLogLevel ?? "INFO",
                          },
                        },
                      },
                    },
                  },
                  Endpoint: {
                    Type: "AWS::Lambda::WebFunctionEndpoint",
                    Properties: {
                      FunctionName: {
                        "Fn::GetAtt": ["Function", "FunctionArn"],
                      },
                      EndpointName: "default",
                      EndpointType: "HomeRegion",
                      AuthType: settings.authType,
                      RevisionWeights: [
                        {
                          RevisionId: {
                            "Fn::GetAtt": ["Revision", "RevisionId"],
                          },
                          Weight: 100,
                        },
                      ],
                      ScalingConfig:
                        settings.maxEnvironments === undefined
                          ? {}
                          : { MaxEnvironments: settings.maxEnvironments },
                      ThrottleConfig:
                        settings.rateLimit === undefined
                          ? {}
                          : { RateLimit: settings.rateLimit },
                    },
                  },
                },
                Outputs: {
                  FunctionArn: {
                    Value: { "Fn::GetAtt": ["Function", "FunctionArn"] },
                  },
                  RevisionArn: { Value: { Ref: "Revision" } },
                  EndpointArn: {
                    Value: { "Fn::GetAtt": ["Endpoint", "EndpointArn"] },
                  },
                  DomainName: {
                    Value: { "Fn::GetAtt": ["Endpoint", "DomainName"] },
                  },
                },
              }),
          ),
        },
        {
          parent: self,
          dependsOn: [codeBucketPolicy],
          ignoreChanges: ["name"],
          customTimeouts: { create: "30m", update: "30m", delete: "30m" },
        },
      ),
    );

    this.registerOutputs({ _hint: this.url });

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
    return (
      this.devUrl ??
      this.stack!.outputs.apply((values) => `https://${values.DomainName}`)
    );
  }
  /** The web function ARN. Not available in local `sst dev`. */
  public get arn() {
    return this.stack?.outputs.apply((values) => values.FunctionArn);
  }
  /** The endpoint ARN. Not available in local `sst dev`. */
  public get endpointArn() {
    return this.stack?.outputs.apply((values) => values.EndpointArn);
  }
  /** The immutable revision ARN. Not available in local `sst dev`. */
  public get revisionArn() {
    return this.stack?.outputs.apply((values) => values.RevisionArn);
  }
  /** The underlying resources. Deployment resources are absent in local `sst dev`. */
  public get nodes() {
    return {
      stack: this.stack,
      codeBucket: this.codeBucket,
      codeObject: this.codeObject,
      versioning: this.versioning,
      codeBucketPolicy: this.codeBucketPolicy,
      role: this.role,
      logGroup: this.logGroup,
      localLogGroup: this.localLogGroup,
    };
  }
  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        url: this.url,
        ...(this.stack
          ? {
              arn: this.arn,
              endpointArn: this.endpointArn,
            }
          : {}),
      },
      ...(this.stack
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
