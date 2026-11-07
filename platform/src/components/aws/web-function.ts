import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import { glob } from "glob";
import {
  ComponentResourceOptions,
  type Output,
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
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../parts-component";
import { context } from "../contract";
import { Link } from "../link";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { physicalName } from "../naming";
import { DurationMinutes, toSeconds } from "../duration";
import {
  notAnExistingPart,
  plain,
  plainDeep,
  withoutDependencies,
} from "../args";
import { rpc } from "../rpc/rpc";
import { inlinePolicies, noPermissionsFor } from "./helpers/iam";
import { linkEncryptionKey } from "./helpers/function-shared";
import { RETENTION } from "./logging";
import { Permission, permission } from "./permission";
import type { FunctionArgs } from "./function";
import type { Vpc } from "./vpc";
import { privateNetworkOf } from "./helpers/vpc";

const parts = {
  /**
   * The CloudWatch log group the web function writes to.
   */
  logGroup: cloudwatch.LogGroup,
  /**
   * The log group Lambda writes to in the endpoint's HomeRegion, named after `logGroup`
   * with `.local` added. Its name and retention follow `logGroup`'s. Not created in `sst
   * dev`, unless `dev` is `false`.
   */
  localLogGroup: cloudwatch.LogGroup,
  /**
   * The IAM role the web function runs with. In `sst dev`, the CLI assumes it to run
   * `dev.command`.
   *
   * A role you pass in `existing` is used as it is: your links' permissions aren't added
   * to it. It has to let the web function write to the log groups, and in `sst dev` trust
   * your AWS account for `dev.command` to run as it.
   */
  role: iam.Role,
  /**
   * The S3 bucket the code is uploaded to. Lambda reads a revision's code by its version,
   * so the bucket is versioned, and only the web function's revisions can read it.
   */
  codeBucket: s3.Bucket,
  /**
   * The code bucket's versioning.
   */
  versioning: named(s3.BucketVersioning, "CodeVersioning"),
  /**
   * What blocks public access to the code bucket.
   */
  codePublicAccessBlock: s3.BucketPublicAccessBlock,
  /**
   * The zip of the code, under a key made from its hash, so a change uploads a new one.
   */
  codeObject: named(s3.BucketObjectv2, "Code"),
  /**
   * The web function. Its revision runs the code.
   */
  function: lambdaweb.Function,
  /**
   * The code bucket's policy, which lets the web function's revisions read the code.
   */
  codeBucketPolicy: s3.BucketPolicy,
  /**
   * The revision that runs the code, with its settings. A revision can't be changed, so
   * new code or settings replace it: the new one is created, the endpoint moves to it,
   * and the old one is deleted.
   */
  revision: lambdaweb.FunctionRevision,
  /**
   * The HTTPS endpoint, which sends every request to the revision.
   */
  endpoint: lambdaweb.FunctionEndpoint,
  /**
   * The IAM role Lambda uses to create the network connector's network interfaces in the
   * VPC. Only created when `vpc` is set, with the connector.
   */
  operatorRole: optional(iam.Role),
  /**
   * The Lambda network connector the revision sends its outbound traffic through.
   * Created when `vpc` is set, and not in `sst dev` while the server runs locally.
   */
  networkConnector: optional(lambda.CoreNetworkConnector),
};

export interface WebFunctionArgs extends ComponentArgs<typeof parts> {
  /**
   * The file that starts an HTTP server, relative to the project root. It doesn't need
   * to export a Lambda handler. Listen on the host and port in
   * `process.env.AWS_LAMBDA_HTTP_ENDPOINT`.
   *
   * SST bundles this file with esbuild. When `bundle` is set, this is instead a JavaScript
   * file relative to that directory, and SST doesn't bundle it.
   * Source files with different supported JavaScript or TypeScript extensions must use
   * distinct basenames in the same directory to avoid ambiguous file resolution.
   *
   * It's what the code is built from, so it has to be a plain value.
   * @example
   * ```js
   * {
   *   entrypoint: "src/server.ts"
   * }
   * ```
   */
  entrypoint: string;
  /**
   * An existing directory containing your deployment package. The `entrypoint` must be
   * inside it. Native dependencies must be built for Linux Arm64. SST writes the web
   * function's encrypted links to `.sst/<name>/resource.enc` inside the bundle and
   * includes only that managed file, excluding other functions' `.sst` directories.
   *
   * It's what the code is built from, so it has to be a plain value.
   * @default The entrypoint is bundled with esbuild.
   * @example
   * ```js
   * {
   *   bundle: "packages/api/dist",
   *   entrypoint: "server.mjs"
   * }
   * ```
   */
  bundle?: string;
  /**
   * Environment variables available to your server. Lambda's `AWS_LAMBDA_*` variables
   * and SST's `SST_RESOURCE_*` link variables can't be overridden.
   * Values are stored as Pulumi secrets. Empty values are rejected.
   * All keys and values, including SST's managed values, must fit in 32 KiB. Linked
   * resource properties are encrypted in the deployment package and don't use this limit.
   * @default `{}`
   * @example
   * ```js
   * {
   *   environment: {
   *     NODE_ENV: "production"
   *   }
   * }
   * ```
   */
  environment?: FunctionArgs["environment"];
  /**
   * [Link resources](/docs/linking/) to your server. Their properties are available
   * through `Resource` from the [SDK](/docs/reference/sdk/), and their permissions are
   * added to the role it creates. Deployed links use the same encrypted `resource.enc` format and
   * stage key as `Function`.
   * @default `[]`
   * @example
   * ```js
   * {
   *   link: [bucket, secret]
   * }
   * ```
   */
  link?: FunctionArgs["link"];
  /**
   * Permissions added to the role, in addition to linked resources'.
   * @default `[]`
   * @example
   * ```js
   * {
   *   permissions: [
   *     { actions: ["ses:SendEmail"], resources: [identity.arn] }
   *   ]
   * }
   * ```
   */
  permissions?: FunctionArgs["permissions"];
  /**
   * Configure esbuild and dependencies, as with `Function`. When `sourcemap` is `true`,
   * source maps are included in the deployment package; they aren't uploaded separately
   * for the logs of SST's functions.
   *
   * It's what the code is built from, so it has to be a plain value.
   * @default `{ minify: true, format: "esm" }`
   * @example
   * ```js
   * {
   *   nodejs: {
   *     install: ["pg"],
   *     sourcemap: true
   *   }
   * }
   * ```
   */
  nodejs?: FunctionArgs["nodejs"];
  /**
   * Copy additional files into the deployment package, as with `Function`. SST's
   * managed resource file can't be replaced by a copied file.
   *
   * It's what the code is built from, so it has to be a plain value.
   * @default `[]`
   * @example
   * ```js
   * {
   *   copyFiles: [{ from: "assets", to: "public" }]
   * }
   * ```
   */
  copyFiles?: FunctionArgs["copyFiles"];
  /**
   * The time allowed for each request, between 3 and 900 seconds.
   * @default `"30 seconds"`
   * @example
   * ```js
   * {
   *   timeout: "2 minutes"
   * }
   * ```
   */
  timeout?: Input<DurationMinutes>;
  /**
   * Concurrent requests handled by each execution environment, between 1 and 128.
   * Your server must safely handle overlapping requests.
   * @default `64`
   * @example
   * ```js
   * {
   *   maxConcurrencyPerEnvironment: 32
   * }
   * ```
   */
  maxConcurrencyPerEnvironment?: Input<number>;
  /**
   * Optional endpoint limits. Omitting a limit removes a previously configured limit.
   * Account quotas still apply.
   * @default No limits of the web function's own.
   * @example
   * ```js
   * {
   *   scaling: {
   *     maxEnvironments: 20,
   *     rateLimit: 1000
   *   }
   * }
   * ```
   */
  scaling?: Input<{
    /**
     * The maximum execution environments, between 2 and 10000.
     * @default The account's service limit.
     * @example
     * ```js
     * {
     *   scaling: {
     *     maxEnvironments: 20
     *   }
     * }
     * ```
     */
    maxEnvironments?: Input<number>;
    /**
     * Requests per second: 0, 100 through 1000 in increments of 100, or 2000 through
     * 10000 in increments of 1000. 0 rejects new requests. Regional limits may differ.
     * @default The account's service limit.
     * @example
     * ```js
     * {
     *   scaling: {
     *     rateLimit: 1000
     *   }
     * }
     * ```
     */
    rateLimit?: Input<number>;
  }>;
  /**
   * Configure authorization for the HTTPS endpoint.
   * @default `{ authorization: "none" }`
   * @example
   * ```js
   * {
   *   url: {
   *     authorization: "iam"
   *   }
   * }
   * ```
   */
  url?: Input<{
    /**
     * `none` lets your application handle authorization. `iam` requires SigV4-signed
     * requests and the `lambda:InvokeWebFunctionEndpoint` permission. IAM requests must
     * include `X-Amz-Content-SHA256`, including the empty-payload hash for bodyless
     * requests.
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
    authorization?: Input<"none" | "iam">;
  }>;
  /**
   * Configure the log groups.
   * @default `{ retention: "1 month", applicationLogLevel: "INFO", systemLogLevel: "INFO" }`
   * @example
   * ```js
   * {
   *   logging: {
   *     retention: "1 week",
   *     applicationLogLevel: "WARN"
   *   }
   * }
   * ```
   */
  logging?: Input<{
    /**
     * How long both log groups keep the logs.
     * @default `"1 month"`
     * @example
     * ```js
     * {
     *   logging: {
     *     retention: "1 week"
     *   }
     * }
     * ```
     */
    retention?: Input<keyof typeof RETENTION>;
    /**
     * The minimum application log level Lambda collects.
     * @default `"INFO"`
     * @example
     * ```js
     * {
     *   logging: {
     *     applicationLogLevel: "WARN"
     *   }
     * }
     * ```
     */
    applicationLogLevel?: Input<
      "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL"
    >;
    /**
     * The minimum level of Lambda's own logs.
     * @default `"INFO"`
     * @example
     * ```js
     * {
     *   logging: {
     *     systemLogLevel: "WARN"
     *   }
     * }
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
   * This creates a Lambda network connector, which each revision is created with. Creating
   * it takes about 5 minutes. Adding, changing or removing `vpc` makes a new revision. In
   * `sst dev`, unless `dev` is `false`, your server runs locally and no connector is
   * created, so it reaches the VPC only through `sst tunnel`.
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
   * Run your server locally in `sst dev`, in a pane of its own, in place of a deployed
   * web function. The command is given the links, the environment variables, AWS
   * credentials for the role, and `AWS_LAMBDA_HTTP_ENDPOINT` from `dev.url`.
   *
   * Set `false` to deploy the web function in `sst dev` too. The role trusts your AWS
   * account only while the server runs locally.
   *
   * It decides which resources are created, so it has to be a plain value.
   * @default Runs locally in `sst dev`.
   * @example
   * ```js
   * {
   *   dev: {
   *     command: "tsx watch src/server.ts",
   *     url: "http://localhost:3000"
   *   }
   * }
   * ```
   */
  dev?:
    | false
    | {
        /**
         * A command that starts your server. Node.js 24 can run erasable TypeScript
         * syntax; for other TypeScript features, set a command such as
         * `"tsx watch src/server.ts"`.
         * @default `"node --watch ENTRYPOINT"`
         * @example
         * ```js
         * {
         *   dev: {
         *     command: "tsx watch src/server.ts"
         *   }
         * }
         * ```
         */
        command?: Input<string>;
        /**
         * The directory to run the command in, relative to the project root.
         * @default The bundle directory, or the project root.
         * @example
         * ```js
         * {
         *   dev: {
         *     directory: "packages/api"
         *   }
         * }
         * ```
         */
        directory?: Input<string>;
        /**
         * The local server's URL, which `url` gives in `sst dev`. Its path and query are
         * kept in it. `AWS_LAMBDA_HTTP_ENDPOINT` uses only the hostname and port, since an
         * HTTP listener can't bind to a URL path.
         * @default `"http://localhost:8080"`
         * @example
         * ```js
         * {
         *   dev: {
         *     url: "http://localhost:3000"
         *   }
         * }
         * ```
         */
        url?: Input<string>;
        /**
         * Whether to start the command when `sst dev` starts.
         * @default `true`
         * @example
         * ```js
         * {
         *   dev: {
         *     autostart: false
         *   }
         * }
         * ```
         */
        autostart?: Input<boolean>;
      };
}

/**
 * The `WebFunction` component deploys an HTTP server to
 * [AWS Lambda web functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html).
 * It uses Node.js 24 on Arm64 and a HomeRegion HTTPS endpoint. With `vpc`, its outbound
 * traffic goes through a VPC. MultiRegion endpoints, custom runtimes, domains and
 * event-source subscriptions aren't supported.
 *
 * Unlike `Function`, your entrypoint starts an HTTP listener; Lambda doesn't call an
 * exported handler. Each environment can serve concurrent requests and stay active
 * across requests, so keep request state separate and don't assume one invocation at a
 * time.
 *
 * SST uploads the code under a key made from its hash, to a bucket of its own, and
 * creates a revision from it. The endpoint sends all traffic to that revision; a deploy
 * moves it to the new revision before deleting the old one. This isn't a health-checked
 * rollout, and there's no automatic rollback of your application.
 *
 * The role you deploy with needs permission to manage Lambda web functions, revisions
 * and endpoints, and the IAM, S3 and CloudWatch Logs resources. The provider creates the
 * web function through Cloud Control, so it also needs `cloudformation:CreateResource`
 * and `cloudformation:GetResourceRequestStatus`. With `vpc`, it also needs permission to
 * create, update and delete Lambda network connectors, `lambda:PassNetworkConnector` to
 * give a revision its connector, and `iam:PassRole` on the operator role. These are for
 * the role you deploy with, not the role the web function runs with.
 *
 * The web function and its code bucket keep their names across deploys. SST manages
 * both log groups with the retention you give, and the role it creates may write only to
 * them.
 * The web function gets the provider's default tags, SST's app and stage tags
 * included, and its revisions and endpoint inherit them.
 *
 * :::caution
 * A deploy doesn't check that your server starts listening. Lambda can report the
 * revision and endpoint as active even when your application fails to start. Send a
 * test request and check the logs after a deploy.
 * :::
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const server = new sst.aws.WebFunction("Server", {
 *   entrypoint: "src/server.ts",
 *   dev: { command: "tsx watch src/server.ts" }
 * });
 *
 * return { url: server.url };
 * ```
 *
 * ```ts title="src/server.ts"
 * import { createServer } from "node:http";
 *
 * const endpoint = new URL(`http://${process.env.AWS_LAMBDA_HTTP_ENDPOINT}`);
 * createServer((_request, response) => response.end("Hello world"))
 *   .listen(Number(endpoint.port), endpoint.hostname);
 * ```
 *
 * #### Switch from SST 4's `sst.aws.WebFunction`
 *
 * Keep the name, and `sst migrate` moves it. The web function, its revision, its
 * endpoint and URL, its code and code bucket, its role, its log groups and its network
 * connector are kept, and nothing is updated.
 *
 * A few things work differently:
 *
 * - In `sst dev`, SST 4's `WebFunction` created a component for the pane `sst dev`
 *   shows. SST 5's tells `sst dev` itself, so a deploy in `sst dev` drops that
 *   component. It has nothing in AWS behind it. The pane is named after the web
 *   function, `Server` where it was `ServerDev`, and that's the name `SST_CHILD` takes.
 * - `entrypoint`, `bundle`, `nodejs`, `copyFiles` and `dev` are plain values, not
 *   outputs.
 * - `transform` takes every part: the `.local` log group, the code bucket, its
 *   versioning, its public access block, its policy and the code's zip too.
 * - `nodes` also has the code bucket's public access block. In `sst dev`, reading a
 *   part that isn't created there throws an error that says the server runs locally,
 *   where SST 4's `WebFunction` gave `undefined`. `arn`, `endpointArn` and
 *   `revisionArn` are still `undefined` there.
 * - A role can be given in `existing`.
 */
export class WebFunction extends component("sst:aws:WebFunction", parts) {
  private readonly run: {
    /** The endpoint's URL, or the local server's in `sst dev`. */
    url: Output<string>;
    /** Whether it's deployed, rather than run locally in `sst dev`. */
    deployed: boolean;
  };

  constructor(
    name: string,
    args: WebFunctionArgs,
    opts: ComponentResourceOptions = {},
  ) {
    if (args?.entrypoint === undefined || args.entrypoint === null)
      throw new VisibleError(`The "${name}" web function needs an entrypoint.`);
    super(name, args, opts);

    const self = this;
    const owner = `the "${name}" web function`;
    const option = (arg: string) =>
      `The "${arg}" of the "${name}" web function`;
    const existing = args.existing ?? {};
    for (const [keys, instead] of [
      [
        ["logGroup", "localLogGroup"],
        `It creates the log group it writes to, and the ".local" one named after it. Change them in "transform".`,
      ],
      [
        [
          "codeBucket",
          "versioning",
          "codePublicAccessBlock",
          "codeObject",
          "codeBucketPolicy",
        ],
        `It keeps its code in a versioned bucket of its own, which only its revisions can read. Change it in "transform".`,
      ],
      [
        ["function", "revision", "endpoint"],
        `It creates the web function, its revision and its endpoint from its code. Change them in "transform".`,
      ],
      [
        ["operatorRole", "networkConnector"],
        `It creates its network connector, and the role Lambda creates the connector's network interfaces with, from "vpc". Change them in "transform".`,
      ],
    ] as const)
      for (const key of keys) notAnExistingPart(existing, key, owner, instead);
    noPermissionsFor(existing.role, args.permissions, "role", owner);

    const isBuilt = "It's what the code is built from.";
    const entrypoint = plain(args.entrypoint, option("entrypoint"), isBuilt);
    const bundle = plain(args.bundle, option("bundle"), isBuilt);
    const nodejs = plainDeep(args.nodejs, option("nodejs"), isBuilt);
    const copyFiles =
      plainDeep(args.copyFiles, option("copyFiles"), isBuilt) ?? [];
    const dev = plain(args.dev, option("dev")) !== false && context().dev;
    const root = context().paths.root;

    validateEntrypoint(entrypoint);
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
    if (!dev) {
      if (bundle === undefined) validateSource(path.resolve(root, entrypoint));
      else validateBundle(bundle);
      for (const item of copyFiles) validateCopyFile(item.from, item.to);
    }

    const region = getRegionOutput({}, { parent: this }).region;
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
              name: context().app.name,
              stage: context().app.stage,
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
          `The "url.authorization" of the "${name}" web function must be "none" or "iam".`,
        );
      if (logging?.retention !== undefined && !(logging.retention in RETENTION))
        throw new VisibleError(
          `The "logging.retention" of the "${name}" web function isn't one CloudWatch takes.`,
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

    const logGroup = this.part(
      "logGroup",
      {
        name: `/aws/lambda/web/${physicalName(64, name)}`,
        retentionInDays: settings.apply(
          ({ logging }) => RETENTION[logging.retention ?? "1 month"],
        ),
      },
      { ignoreChanges: ["name"] },
    );
    const localLogGroup = dev
      ? undefined
      : this.part(
          "localLogGroup",
          {
            name: interpolate`${logGroup.name}.local`,
            retentionInDays: logGroup.retentionInDays,
          },
          { ignoreChanges: ["name"] },
        );
    const role = this.part("role", {
      assumeRolePolicy: iam.getPolicyDocumentOutput({
        statements: [
          {
            actions: ["sts:AssumeRole", "sts:TagSession"],
            principals: [
              { type: "Service", identifiers: ["lambda.amazonaws.com"] },
            ],
          },
          // Only while the server runs locally, so the CLI can run it as
          // the role
          ...(dev
            ? [
                {
                  actions: ["sts:AssumeRole"],
                  principals: [
                    {
                      type: "AWS",
                      identifiers: [
                        getCallerIdentityOutput({}, { parent: this }).accountId,
                      ],
                    },
                  ],
                },
              ]
            : []),
        ],
      }).json,
      inlinePolicies: inlinePolicies([
        args.permissions,
        Link.getInclude<Permission>("aws.permission", args.link),
        [
          {
            actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
            resources: [
              interpolate`${logGroup.arn}:*`,
              ...(localLogGroup ? [interpolate`${localLogGroup.arn}:*`] : []),
            ],
          },
        ],
      ]),
    });

    // In `sst dev`, the server runs on the user's machine, as the role, in
    // place of the web function
    if (dev) {
      const config = args.dev || {};
      const url = output(config.url ?? "http://localhost:8080").apply(
        (value) => {
          const url = new URL(value);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new VisibleError(
              `The "dev.url" of the "${name}" web function must be an HTTP URL without credentials.`,
            );
          return value;
        },
      );
      this.run = { url, deployed: false };
      this.report({
        dev: {
          title: name,
          autostart: config.autostart,
          directory: config.directory ?? bundle,
          command:
            config.command ??
            output(config.directory).apply((directory) => {
              const source = path.resolve(root, bundle ?? ".", entrypoint);
              const working = path.resolve(root, directory ?? bundle ?? ".");
              const relative = path.relative(working, source);
              return `node --watch '${relative.replaceAll("'", "'\"'\"'")}'`;
            }),
          // The command is given the links' properties by `sst dev`
          link: args.link,
          environment: all([environment, region, url]).apply(
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
        hint: url,
      });
      this.runsLocally();
      return;
    }

    const codeBucket = this.part("codeBucket", { forceDestroy: true });
    const versioning = this.part("versioning", {
      bucket: codeBucket.bucket,
      versioningConfiguration: { status: "Enabled" },
    });
    const publicAccessBlock = this.part("codePublicAccessBlock", {
      bucket: codeBucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });

    const encryptionKey = linkEncryptionKey().base64;
    // What's built is files on this machine. It's given the links, and a
    // link's name is read from the component that's linked, so without this
    // the code would depend on every resource of every linked component: a
    // router that routes to the web function, or a subscriber of a linked
    // queue that links it back, would have it wait for itself.
    const build = withoutDependencies(
      all([encryptionKey, Link.getProperties(args.link)]).apply(
        async ([encryptionKey, links]) => {
          const files = copyFiles.map((item) =>
            validateCopyFile(item.from, item.to),
          );
          let bundleDir: string | undefined;
          let handler: string;
          if (bundle !== undefined) {
            ({ bundleDir, handler } = validateBundle(bundle));
          } else {
            const entry = path.resolve(root, entrypoint);
            validateSource(entry);
            handler =
              entry.slice(0, entry.length - path.extname(entry).length) +
              ".main";
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
            bundle: bundleDir,
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
            entrypoint: bundleDir
              ? handler
              : result.handler.slice(0, -path.extname(result.handler).length) +
                (nodejs?.format === "cjs" ? ".cjs" : ".mjs"),
            resourceFile: bundleDir
              ? `.sst/${name}/resource.enc`
              : "resource.enc",
            sourcemaps: nodejs?.sourcemap ? [] : result.sourcemaps,
            copyFiles: files,
          };
        },
      ),
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
              `The environment variable "${key}" of the "${name}" web function must be a non-empty string.`,
            );
          environmentSize +=
            Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
        }
        if (environmentSize > 32 * 1024)
          throw new VisibleError(
            `The environment variables of the "${name}" web function, with SST's own, are over 32 KiB.`,
          );
        if (!fs.existsSync(path.join(directory, entrypoint)))
          throw new VisibleError(
            `The build of the "${name}" web function didn't write "${entrypoint}".`,
          );
        const zipPath = path.join(
          context().paths.work,
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
          // Only this web function's resource file, not another function's
          // that wrote into the same bundle
          if (
            file !== resourceFile &&
            (file === "resource.enc" || file.startsWith(".sst/"))
          )
            continue;
          if (!(await fs.promises.lstat(source)).isDirectory())
            files.set(file, source);
        }
        // A build to deploy doesn't copy the files, so they're added here, to
        // what was built or the bundle given; a later one replaces an earlier
        // one, as with `Function`
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
            `The build of the "${name}" web function didn't write its encrypted resource file.`,
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
              `The symlink "${destination}" of the "${name}" web function must point to a relative path inside its code.`,
            );
        }
        if (!files.has(entrypoint))
          throw new VisibleError(
            `The "entrypoint" of the "${name}" web function is left out of its code.`,
          );
        // statConcurrency and the fixed dates keep the zip, and its hash, the
        // same when nothing changed, so no new revision is made
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
            archive.file(source, { name: file, date: new Date(0) });
          archive.finalize().catch(reject);
        });
        return {
          path: zipPath,
          hash: crypto
            .createHash("sha256")
            .update(await fs.promises.readFile(zipPath))
            .digest("hex"),
        };
      },
    );
    // A key for each zip: a revision reads its code by the object's version,
    // and the old one is deleted after the endpoint has moved
    const codeObject = this.part(
      "codeObject",
      {
        bucket: codeBucket.bucket,
        key: interpolate`code/${zip.hash}.zip`,
        source: zip.path.apply((file) => new asset.FileArchive(file)),
        sourceHash: zip.hash,
      },
      {
        dependsOn: [versioning, publicAccessBlock],
        deleteBeforeReplace: false,
      },
    );
    // The name is filled in from the component's, as for any part
    const fn = this.part("function", { functionName: "" });
    const networkConnector = createNetworkConnector();
    const codeBucketPolicy = this.part(
      "codeBucketPolicy",
      {
        bucket: codeBucket.bucket,
        policy: all([
          codeBucket.arn,
          fn.arn,
          getCallerIdentityOutput({}, { parent: this }).accountId,
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
      { dependsOn: [publicAccessBlock] },
    );
    const revision = this.part(
      "revision",
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
          egressNetworkConnectorArn: networkConnector?.latestVersionArn,
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
      // The new revision is created before the endpoint moves to it
      { dependsOn: [codeBucketPolicy], deleteBeforeReplace: false },
    );
    const endpoint = this.part("endpoint", {
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
    });
    this.run = {
      url: interpolate`https://${endpoint.domainName}`,
      deployed: true,
    };
    this.report({ hint: this.run.url });

    function createNetworkConnector() {
      if (!args.vpc) return;
      // The subnets and security groups the connector puts the server's
      // outbound traffic through
      const vpc = privateNetworkOf(
        args.vpc,
        owner,
        (id) =>
          `\nWarning: The "${name}" web function is in the "${id}" VPC, which does not have a NAT gateway. Its server can't reach the internet. To let it, set the "nat" prop on the "Vpc" component.\n`,
      );
      const partition = getPartitionOutput({}, { parent: self }).partition;

      const operatorRole = self.part("operatorRole", {
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
      });

      return self.part("networkConnector", {
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
        // and leaves a FAILED connector behind, so wait until the role is 20
        // seconds old.
        operatorRole: all([operatorRole.arn, operatorRole.createDate]).apply(
          async ([arn, created]) => {
            const wait = Date.parse(created) + 20_000 - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            return arn;
          },
        ),
      });
    }

    function integer(
      property: string,
      value: number,
      min: number,
      max: number,
    ) {
      if (!Number.isInteger(value) || value < min || value > max)
        throw new VisibleError(
          `The "${property}" of the "${name}" web function must be a whole number from ${min} to ${max}.`,
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
          `The "scaling.rateLimit" of the "${name}" web function isn't a rate Lambda takes: 0, 100 to 1000 in steps of 100, or 2000 to 10000 in steps of 1000.`,
        );
    }
    function validateBundle(bundle: string) {
      const bundleDir = path.resolve(root, bundle);
      const entry = path.resolve(bundleDir, entrypoint);
      if (
        !isWithin(bundleDir, entry) ||
        !fs.existsSync(entry) ||
        !fs.statSync(entry).isFile()
      )
        throw new VisibleError(
          `The "entrypoint" of the "${name}" web function must be a file inside its bundle, "${bundle}".`,
        );
      if (!/[.](mjs|cjs|js)$/.test(entrypoint))
        throw new VisibleError(
          `The "entrypoint" of the "${name}" web function must be a JavaScript file, as it has a "bundle".`,
        );
      return {
        bundleDir,
        handler: path.relative(bundleDir, entry).split(path.sep).join("/"),
      };
    }
    function validateSource(entry: string) {
      if (!fs.existsSync(entry) || !fs.statSync(entry).isFile())
        throw new VisibleError(
          `The "${name}" web function can't find its entrypoint at "${entry}".`,
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
          `The "entrypoint" of the "${name}" web function must be a JavaScript or TypeScript file.`,
        );
      if (siblings.length > 1)
        throw new VisibleError(
          `The "entrypoint" of the "${name}" web function is ambiguous: files with its basename (${siblings.join(
            ", ",
          )}) exist. Give them different basenames.`,
        );
    }
    function validateCopyFile(fromValue: string, toValue?: string) {
      const from = path.resolve(root, fromValue);
      const to = toValue ?? fromValue;
      if (
        path.isAbsolute(to) ||
        !isWithin("/bundle", path.resolve("/bundle", to))
      )
        throw new VisibleError(
          `A "copyFiles" destination of the "${name}" web function must be inside its code.`,
        );
      if (!fs.existsSync(from))
        throw new VisibleError(
          `The "${name}" web function can't find the "copyFiles" source "${fromValue}".`,
        );
      const stats = fs.statSync(from);
      if (!stats.isFile() && !stats.isDirectory())
        throw new VisibleError(
          `A "copyFiles" source of the "${name}" web function must be a file or a directory.`,
        );
      return { from, to, isDir: stats.isDirectory() };
    }
    function validateTimeout(value: DurationMinutes) {
      if (!/^\d+ (seconds?|minutes?)$/.test(value))
        throw new VisibleError(
          `The "timeout" of the "${name}" web function must be a whole number of seconds or minutes.`,
        );
      const seconds = toSeconds(value);
      if (!Number.isInteger(seconds) || seconds < 3 || seconds > 900)
        throw new VisibleError(
          `The "timeout" of the "${name}" web function is ${value}: it has to be from 3 seconds to 15 minutes.`,
        );
      return seconds;
    }
    function validateEntrypoint(value: string) {
      if (typeof value !== "string" || !value.trim())
        throw new VisibleError(
          `The "entrypoint" of the "${name}" web function can't be empty.`,
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
            `The environment variable "${key}" of the "${name}" web function is one Lambda or SST sets.`,
          );
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))
          throw new VisibleError(
            `The environment variable "${key}" of the "${name}" web function isn't a valid name: a letter, then letters, digits and underscores.`,
          );
      }
    }
  }

  /**
   * The URL of the endpoint, with `https://`. In `sst dev`, the local server's, `dev.url`.
   */
  public get url(): Output<string> {
    return this.run.url;
  }

  /**
   * The ARN of the web function. `undefined` in `sst dev`, unless `dev` is `false`.
   */
  public get arn(): Output<string> | undefined {
    return this.run.deployed ? this.nodes.function.arn : undefined;
  }

  /**
   * The ARN of the endpoint. `undefined` in `sst dev`, unless `dev` is `false`.
   */
  public get endpointArn(): Output<string> | undefined {
    return this.run.deployed ? this.nodes.endpoint.arn : undefined;
  }

  /**
   * The ARN of the revision. `undefined` in `sst dev`, unless `dev` is `false`.
   */
  public get revisionArn(): Output<string> | undefined {
    return this.run.deployed ? this.nodes.revision.arn : undefined;
  }

  /**
   * Linking a `WebFunction` gives the linked resource its `url`, and once it's deployed,
   * its `arn` and `endpointArn`, and lets it call an endpoint that takes `iam`
   * authorization.
   */
  public link() {
    if (!this.run.deployed) return { properties: { url: this.run.url } };
    const endpointArn = this.nodes.endpoint.arn;
    return {
      properties: {
        url: this.run.url,
        arn: this.nodes.function.arn,
        endpointArn,
      },
      include: [
        permission({
          actions: ["lambda:InvokeWebFunctionEndpoint"],
          resources: [endpointArn],
        }),
      ],
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
