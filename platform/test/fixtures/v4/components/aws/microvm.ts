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
} from "@pulumi/pulumi";
import {
  cloudwatch,
  getCallerIdentityOutput,
  getPartitionOutput,
  getRegionOutput,
  iam,
  lambda,
  lambdamicrovms,
  s3,
} from "@pulumi/aws";
import {
  Component,
  Transform,
  transform,
} from "../../../../../src/components/component";
import { Link } from "../../../../../src/components/link";
import { Input } from "../../../../../src/components/input";
import { VisibleError } from "../../../../../src/components/error";
import { physicalName } from "../../../../../src/components/naming";
import {
  DurationHours,
  toSeconds,
} from "../../../../../src/components/duration";
import { DevCommand } from "../experimental/dev-command";
import { bootstrap } from "../../../../../src/components/aws/helpers/bootstrap";
import { RETENTION } from "../../../../../src/components/aws/logging";
import { FunctionArgs } from "./function";
import {
  Permission,
  permission,
} from "../../../../../src/components/aws/permission";
import { Vpc } from "./vpc";
import { warnOnce } from "../../../../../src/util/warn";
import { MicrovmImagePrune } from "./providers/microvm-image-prune";

export interface MicroVmArgs {
  /**
   * The image to run. Lambda builds it from your `Dockerfile`, on top of its Amazon Linux
   * 2023 base image.
   *
   * SST zips the `context` directory, puts the `dockerfile` at the root of the zip, and
   * uploads it. Lambda builds the image from the zip, starts your app, and takes a snapshot
   * that every MicroVM starts from. So your app starts once, at build time: anything it
   * does on startup, like reading the time or generating an ID, is the same in every
   * MicroVM.
   *
   * A build takes a few minutes, and runs again whenever the code, the `environment` or a
   * link's values change. If it fails, the deploy fails, and the build's logs are in the
   * log group. MicroVMs keep starting from the last version that built.
   *
   * Each build adds a version to the image, and Lambda allows 50. After a build, SST
   * deletes the old ones. It keeps the newest 5 that built, and any that MicroVMs still
   * run from.
   *
   * Lambda runs the `Dockerfile` itself, so Docker build args, targets, secrets and caches
   * don't apply. Files matched by a `.dockerignore` in the `context` aren't uploaded, and
   * neither are the `sst-env.d.ts` files SST generates, so writing them doesn't rebuild
   * the image.
   *
   * @default `{ context: ".", dockerfile: "Dockerfile" }`
   * @example
   * ```js
   * {
   *   image: {
   *     context: "./sandbox",
   *     dockerfile: "Dockerfile"
   *   }
   * }
   * ```
   */
  image?: Input<{
    /**
     * The path to the directory that's zipped and uploaded, relative to your project root.
     * @default `"."`
     */
    context?: Input<string>;
    /**
     * The path to the `Dockerfile`, relative to the `context`.
     * @default `"Dockerfile"`
     */
    dockerfile?: Input<string>;
  }>;
  /**
   * The port your app listens on. The SDK sends requests to this port.
   * @default `8080`
   */
  port?: Input<number>;
  /**
   * Key-value pairs set as environment variables in the image.
   *
   * They're part of the image, so changing them rebuilds it. Lambda allows up to 50.
   */
  environment?: FunctionArgs["environment"];
  /**
   * [Link resources](/docs/linking/) to your MicroVMs. This grants the execution role the
   * permissions of the linked resources, and sets them as environment variables in the
   * image, so your app can read them through the SDK.
   *
   * Changing a linked resource's values rebuilds the image.
   *
   * To read them with `Resource`, add `sst` to your app's dependencies. It comes with the
   * SST CLI, about 75 MB, as an optional dependency that your app doesn't need. To leave it
   * out of the image, install with `npm install --omit=optional`.
   *
   * :::caution
   * The links' values, `Secret` values included, are stored in the image. Anyone allowed
   * to call `lambda:GetMicrovmImageVersion` on it can read them.
   * :::
   *
   * @example
   * ```js
   * {
   *   link: [bucket]
   * }
   * ```
   */
  link?: FunctionArgs["link"];
  /**
   * Permissions and the resources that your MicroVMs need to access. They're added to the
   * execution role.
   *
   * @example
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["bedrock:InvokeModel"],
   *       resources: ["*"]
   *     }
   *   ]
   * }
   * ```
   */
  permissions?: FunctionArgs["permissions"];
  /**
   * The longest a MicroVM can exist, running and suspended. Lambda terminates it after
   * this, up to 8 hours.
   *
   * This is the default for `microvm.run()` in the SDK, which can override it.
   *
   * @default `"1 hour"`
   */
  duration?: Input<DurationHours>;
  /**
   * When a MicroVM gets no requests for a while, Lambda suspends it, and you stop paying
   * for compute. Its memory and disk are kept. Then, if it stays suspended for too long,
   * Lambda terminates it.
   *
   * Pass `false` to keep MicroVMs running until `duration` is up.
   *
   * This is the default for `microvm.run()` in the SDK, which can override it.
   *
   * @default `{ suspendAfter: "15 minutes", terminateAfter: "15 minutes", autoResume: true }`
   */
  idle?: Input<
    | false
    | {
        /**
         * How long a MicroVM can go without a request before it's suspended. At least
         * 1 minute.
         * @default `"15 minutes"`
         */
        suspendAfter?: Input<DurationHours>;
        /**
         * How long a MicroVM can stay suspended before it's terminated.
         * @default `"15 minutes"`
         */
        terminateAfter?: Input<DurationHours>;
        /**
         * Resume a suspended MicroVM when a request arrives for it.
         * @default `true`
         */
        autoResume?: Input<boolean>;
      }
  >;
  /**
   * Configure the log group for your MicroVMs' logs.
   * @default `{ retention: "1 month" }`
   */
  logging?: Input<{
    /**
     * How long to keep the logs.
     * @default `"1 month"`
     */
    retention?: Input<keyof typeof RETENTION>;
  }>;
  /**
   * Send your MicroVMs' outbound traffic through the private subnets of a VPC, so they can
   * reach private resources, like a database.
   *
   * Requests to a MicroVM still come in through its HTTPS endpoint. Only its outbound
   * traffic goes through the VPC, and it reaches the internet only through the VPC's NAT.
   *
   * This creates a Lambda network connector that every MicroVM is run with. Creating it
   * takes about 5 minutes. Lambda's docs say to terminate the MicroVMs that use it before
   * it's changed or removed.
   *
   * @example
   * Create a `Vpc` component, with a NAT if your MicroVMs need the internet.
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
   * Configure how this component works in `sst dev`.
   *
   * By default, the image isn't built in `sst dev`. Instead, `dev.command` runs your app on
   * your machine, in a tab of the `sst dev` multiplexer, with the links and the execution
   * role's permissions.
   *
   * In `sst dev`, the SDK sends the requests of every MicroVM you run to `dev.url`. So the
   * MicroVMs aren't isolated from each other the way they are once deployed.
   *
   * So that the CLI can assume it, the execution role trusts your AWS account in `sst dev`,
   * as `Service`'s and `Task`'s roles do. Any IAM user or role in the account whose
   * policies allow `sts:AssumeRole` on it can then assume it too.
   *
   * To build the image and run real MicroVMs in `sst dev`, pass in `false`.
   */
  dev?:
    | false
    | {
        /**
         * The command that `sst dev` runs to start your app.
         */
        command?: Input<string>;
        /**
         * The directory the `command` runs in.
         * @default The `image.context`
         */
        directory?: Input<string>;
        /**
         * The URL your app listens on in `sst dev`.
         * @default `"http://localhost:8080"`, with your `port`
         */
        url?: Input<string>;
      };
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the MicroVM image resource.
     */
    image?: Transform<lambdamicrovms.ImageArgs>;
    /**
     * Transform the IAM role Lambda uses to build the image.
     */
    buildRole?: Transform<iam.RoleArgs>;
    /**
     * Transform the IAM role your MicroVMs run with.
     */
    executionRole?: Transform<iam.RoleArgs>;
    /**
     * Transform the CloudWatch log group.
     */
    logGroup?: Transform<cloudwatch.LogGroupArgs>;
    /**
     * Transform the Lambda network connector, created when `vpc` is set.
     */
    networkConnector?: Transform<lambda.CoreNetworkConnectorArgs>;
    /**
     * Transform the IAM role Lambda uses to create the network connector's network
     * interfaces in the VPC.
     */
    operatorRole?: Transform<iam.RoleArgs>;
  };
}

/**
 * The `MicroVm` component lets you run your code in
 * [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html):
 * isolated, stateful sandboxes, each with its own HTTPS endpoint, that live for up to
 * 8 hours. For example, to run code that an AI agent wrote.
 *
 * The component creates the image. Your app then starts MicroVMs from it, and sends them
 * requests, with the [SDK](/docs/component/aws/microvm#sdk).
 *
 * :::note
 * Lambda MicroVMs run on ARM64 only, and are available in `us-east-1`, `us-east-2`,
 * `us-west-2`, `eu-west-1` and `ap-northeast-1`.
 * :::
 *
 * @example
 *
 * #### Create a MicroVM image
 *
 * ```ts title="sst.config.ts"
 * const sandbox = new sst.aws.MicroVm("Sandbox", {
 *   image: { context: "./sandbox" },
 *   dev: { command: "node app.js" }
 * });
 * ```
 *
 * Here `./sandbox` has a `Dockerfile` that starts an app listening on port 8080.
 *
 * #### Link it and run MicroVMs
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   link: [sandbox]
 * });
 * ```
 *
 * ```ts title="src/lambda.ts"
 * import { Resource } from "sst";
 * import { microvm } from "sst/aws/microvm";
 *
 * const vm = await microvm.run(Resource.Sandbox);
 * const res = await vm.fetch("/exec", {
 *   method: "POST",
 *   body: JSON.stringify({ code: "print(1 + 1)" })
 * });
 * await vm.terminate();
 * ```
 *
 * #### Reach private resources in a VPC
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc", { nat: "ec2" });
 *
 * new sst.aws.MicroVm("Sandbox", {
 *   image: { context: "./sandbox" },
 *   vpc
 * });
 * ```
 *
 * #### Limit how long MicroVMs live
 *
 * A MicroVM you don't terminate keeps running until it's idle, or until its `duration` is
 * up. These defaults keep that short; change them for long sessions.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.MicroVm("Sandbox", {
 *   image: { context: "./sandbox" },
 *   duration: "4 hours",
 *   idle: { suspendAfter: "10 minutes", terminateAfter: "1 hour" }
 * });
 * ```
 *
 * Your account has a quota for the memory of all its MicroVMs in a region, running and
 * suspended, and each MicroVM has 2 GB. Once it's reached, `microvm.run()` fails until
 * some are terminated. You can ask for more in the Service Quotas console.
 *
 * :::caution
 * Lambda can't delete an image while MicroVMs from it are running. So `sst remove`, and
 * starting `sst dev` on a deployed stage, fail until they're terminated, idle, or their
 * `duration` is up.
 * :::
 */
export class MicroVm extends Component implements Link.Linkable {
  private readonly image?: lambdamicrovms.Image;
  private readonly buildRole?: iam.Role;
  private readonly executionRole: iam.Role;
  private readonly logGroup: cloudwatch.LogGroup;
  private readonly networkConnector?: lambda.CoreNetworkConnector;
  private readonly region: Output<string>;
  private readonly partition: Output<string>;
  private readonly runDefaults: Output<{
    port: number;
    duration: number;
    idle?: {
      autoResumeEnabled: boolean;
      maxIdleDurationSeconds: number;
      suspendedDurationSeconds: number;
    };
  }>;
  private readonly devUrl?: Output<string>;

  constructor(
    name: string,
    args: MicroVmArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(__pulumiType, name, args, opts);

    const self = this;
    const dev = normalizeDev();
    const partition = getPartitionOutput({}, opts).partition;
    const region = getRegionOutput({}, opts).region;
    const image = normalizeImage();
    const runDefaults = normalizeRunDefaults();

    const logGroup = createLogGroup();
    const imageName = logGroup.name.apply((v) => v.split("/").at(-1)!);
    const executionRole = createExecutionRole();

    this.executionRole = executionRole;
    this.logGroup = logGroup;
    this.region = region;
    this.partition = partition;
    this.runDefaults = runDefaults;

    if (dev) {
      this.devUrl = all([args.dev ? args.dev.url : undefined, args.port]).apply(
        ([url, port]) => url ?? `http://localhost:${port ?? 8080}`,
      );
      registerDevCommand();
      return;
    }

    const vpc = normalizeVpc();
    const code = createCode();
    const buildRole = createBuildRole();
    this.buildRole = buildRole;
    this.image = createImage();
    this.networkConnector = createNetworkConnector();
    pruneImageVersions();

    function normalizeDev() {
      if (!$dev) return false;
      if (args.dev === false) return false;
      return true;
    }

    function normalizeImage() {
      return output(args.image ?? {}).apply((image) => {
        const context = path.resolve($cli.paths.root, image.context ?? ".");
        const dockerfile = image.dockerfile ?? "Dockerfile";
        if (!fs.existsSync(path.join(context, dockerfile)))
          throw new VisibleError(
            `The "${name}" MicroVm can't find its Dockerfile at "${path.join(
              context,
              dockerfile,
            )}". Set "image.context" and "image.dockerfile".`,
          );
        return {
          context,
          dockerfile,
          // `sst dev` runs `dev.command` in a directory relative to the project root.
          directory: path.relative($cli.paths.root, context) || ".",
        };
      });
    }

    function normalizeRunDefaults() {
      return all([args.port, args.duration, args.idle]).apply(
        ([port, duration, idle]) => {
          const maxDuration = toSeconds(duration ?? "1 hour");
          if (maxDuration < 1 || maxDuration > 28800)
            throw new VisibleError(
              `The "${name}" MicroVm's "duration" is ${duration}. It has to be between 1 second and 8 hours.`,
            );
          if (idle === false)
            return { port: port ?? 8080, duration: maxDuration };

          const suspendAfter = toSeconds(idle?.suspendAfter ?? "15 minutes");
          if (suspendAfter < 60 || suspendAfter > 28800)
            throw new VisibleError(
              `The "${name}" MicroVm's "idle.suspendAfter" is ${idle?.suspendAfter}. It has to be between 1 minute and 8 hours.`,
            );
          return {
            port: port ?? 8080,
            duration: maxDuration,
            idle: {
              autoResumeEnabled: idle?.autoResume ?? true,
              maxIdleDurationSeconds: suspendAfter,
              suspendedDurationSeconds: toSeconds(
                idle?.terminateAfter ?? "15 minutes",
              ),
            },
          };
        },
      );
    }

    function createLogGroup() {
      return new cloudwatch.LogGroup(
        ...transform(
          args.transform?.logGroup,
          `${name}LogGroup`,
          {
            // Lambda writes the build logs to this log group, and the SDK sends the
            // MicroVMs' logs to it.
            name: `/aws/lambda-microvms/${physicalName(64, name)}`,
            retentionInDays: output(args.logging).apply(
              (logging) => RETENTION[logging?.retention ?? "1 month"],
            ),
          },
          { parent: self, ignoreChanges: ["name"] },
        ),
      );
    }

    function createExecutionRole() {
      const policy = all([
        args.permissions ?? [],
        Link.getInclude<Permission>("aws.permission", args.link),
      ]).apply(([argsPermissions, linkPermissions]) =>
        iam.getPolicyDocumentOutput({
          statements: [
            ...argsPermissions,
            ...linkPermissions,
            {
              effect: "allow" as const,
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [interpolate`${logGroup.arn}:*`],
            },
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

      return new iam.Role(
        ...transform(
          args.transform?.executionRole,
          `${name}ExecutionRole`,
          {
            assumeRolePolicy: iam.getPolicyDocumentOutput({
              statements: [
                {
                  actions: ["sts:AssumeRole", "sts:TagSession"],
                  principals: [
                    { type: "Service", identifiers: ["lambda.amazonaws.com"] },
                  ],
                },
                // In `sst dev`, the CLI assumes this role to run `dev.command`.
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
            inlinePolicies: policy.apply(({ statements }) =>
              statements ? [{ name: "inline", policy: policy.json }] : [],
            ),
          },
          { parent: self },
        ),
      );
    }

    function registerDevCommand() {
      new DevCommand(
        `${name}Dev`,
        {
          link: args.link,
          dev: {
            title: name,
            autostart: true,
            directory: image.directory,
            ...(args.dev || {}),
          },
          environment: all([args.environment, region]).apply(
            ([environment, region]) => ({
              ...environment,
              AWS_REGION: region,
            }),
          ),
          aws: {
            role: executionRole.arn,
          },
        },
        { parent: self },
      );
    }

    function createCode() {
      const zip = image.apply(async ({ context, dockerfile }) => {
        const zipPath = path.resolve(
          $cli.paths.work,
          "artifacts",
          `${name}-microvm`,
          "code.zip",
        );
        await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });

        const files = (
          await glob("**", {
            cwd: context,
            dot: true,
            nodir: true,
            ignore: [
              ".sst/**",
              ".git/**",
              // SST writes these after a deploy, and the root one changes with every
              // resource in the app, so they'd rebuild the image for nothing.
              "**/sst-env.d.ts",
              ...(await readDockerignore(context)),
              // Lambda reads the Dockerfile from the root of the zip.
              ...(dockerfile === "Dockerfile" ? [] : ["Dockerfile"]),
            ],
          })
        )
          .map((file) => ({ from: path.join(context, file), to: file }))
          .concat(
            dockerfile === "Dockerfile"
              ? []
              : [{ from: path.join(context, dockerfile), to: "Dockerfile" }],
          )
          .sort((a, b) => a.to.localeCompare(b.to));

        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(zipPath);
          // statConcurrency and the fixed dates keep the zip, and its hash, the same
          // when nothing changed, so the image isn't rebuilt.
          const archive = archiver("zip", { statConcurrency: 1 });
          archive.on("warning", reject);
          archive.on("error", reject);
          ws.once("close", () => resolve());
          archive.pipe(ws);
          for (const file of files)
            archive.file(file.from, { name: file.to, date: new Date(0) });
          archive.finalize();
        });

        const hash = crypto
          .createHash("sha256")
          .update(await fs.promises.readFile(zipPath))
          .digest("hex");
        return { path: zipPath, hash };
      });

      const bucket = region.apply((region) =>
        bootstrap.forRegion(region).then((d) => d.asset),
      );
      // One key per image, updated in place. With the hash in the key, a deploy that
      // fails and is then reverted replaces the object with one of the same key and
      // deletes it, and a later rebuild of unchanged code can't find it.
      const object = new s3.BucketObjectv2(
        `${name}Code`,
        {
          key: interpolate`assets/microvm/${imageName}.zip`,
          bucket,
          source: zip.path.apply((p) => new asset.FileArchive(p)),
        },
        { parent: self },
      );
      return { object, hash: zip.hash };
    }

    function createBuildRole() {
      return new iam.Role(
        ...transform(
          args.transform?.buildRole,
          `${name}BuildRole`,
          {
            assumeRolePolicy: iam.getPolicyDocumentOutput({
              statements: [
                {
                  actions: ["sts:AssumeRole", "sts:TagSession"],
                  principals: [
                    { type: "Service", identifiers: ["lambda.amazonaws.com"] },
                  ],
                },
              ],
            }).json,
            inlinePolicies: [
              {
                name: "inline",
                policy: iam.getPolicyDocumentOutput({
                  statements: [
                    {
                      actions: ["s3:GetObject"],
                      resources: [
                        interpolate`arn:${partition}:s3:::${code.object.bucket}/${code.object.key}`,
                      ],
                    },
                    {
                      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                      resources: [interpolate`${logGroup.arn}:*`],
                    },
                  ],
                }).json,
              },
            ],
          },
          { parent: self },
        ),
      );
    }

    function createImage() {
      return new lambdamicrovms.Image(
        ...transform(
          args.transform?.image,
          `${name}Image`,
          {
            name: imageName,
            baseImageArn: interpolate`arn:${partition}:lambda:${region}:aws:microvm-image:al2023-1`,
            buildRoleArn: buildRole.arn,
            codeArtifact: {
              uri: interpolate`s3://${code.object.bucket}/${code.object.key}`,
            },
            // The code's key doesn't change, so its hash is what rebuilds the image
            // when the code changes.
            description: interpolate`Code ${code.hash.apply((h) =>
              h.slice(0, 16),
            )}`,
            environmentVariables: all([
              args.environment ?? {},
              Link.propertiesToEnv(Link.getProperties(args.link)),
            ]).apply(([environment, linkEnvironment]) => {
              const variables = { ...environment, ...linkEnvironment };
              if (Object.keys(variables).length > 50)
                throw new VisibleError(
                  `The "${name}" MicroVm has ${
                    Object.keys(variables).length
                  } environment variables, from "environment" and one for each link. Lambda allows up to 50.`,
                );
              return variables;
            }),
          },
          { parent: self, ignoreChanges: ["name"] },
        ),
      );
    }

    // Every build adds a version to the image, and Lambda allows 50.
    function pruneImageVersions() {
      new MicrovmImagePrune(
        `${name}ImagePrune`,
        {
          imageArn: self.image!.arn,
          imageVersion: self.image!.imageVersion,
          region,
          keep: 5,
        },
        { parent: self },
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
          if (natGateways.length === 0 && natInstances.length === 0)
            warnOnce(
              `\nWarning: The "${name}" MicroVm is in the "${id}" VPC, which does not have a NAT gateway. Its MicroVMs can't reach the internet. To let them, set the "nat" prop on the "Vpc" component.\n`,
            );
          return result;
        });
      }

      return output(args.vpc);
    }

    function createNetworkConnector() {
      if (!vpc) return;

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

      return new lambda.CoreNetworkConnector(
        ...transform(
          args.transform?.networkConnector,
          `${name}NetworkConnector`,
          {
            configuration: {
              vpcEgressConfiguration: {
                associatedComputeResourceTypes: ["MicroVm"],
                networkProtocol: "IPv4",
                subnetIds: vpc!.privateSubnets,
                securityGroupIds: vpc!.securityGroups,
              },
            },
            // Lambda checks the operator role as soon as the connector is created. A
            // role IAM hasn't finished propagating fails that check, and leaves a
            // FAILED connector behind, so wait until the role is 20 seconds old.
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
    }

    async function readDockerignore(context: string) {
      const content = await fs.promises
        .readFile(path.join(context, ".dockerignore"), "utf8")
        .catch(() => "");
      const patterns = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (patterns.some((p) => p.startsWith("!")))
        throw new VisibleError(
          `The "${name}" MicroVm's .dockerignore has an exception ("!"), which isn't supported yet.`,
        );
      return patterns
        .map((p) => p.replace(/^\.?\//, "").replace(/\/$/, ""))
        .flatMap((p) => [p, `${p}/**`]);
    }
  }

  /**
   * The ARN of the MicroVM image. Not created in `sst dev`, unless `dev` is `false`.
   */
  public get arn() {
    return this.image?.arn;
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /**
       * The MicroVM image. Not created in `sst dev`, unless `dev` is `false`.
       */
      image: this.image,
      /**
       * The IAM role Lambda uses to build the image.
       */
      buildRole: this.buildRole,
      /**
       * The IAM role your MicroVMs run with.
       */
      executionRole: this.executionRole,
      /**
       * The CloudWatch log group.
       */
      logGroup: this.logGroup,
      /**
       * The Lambda network connector. Only created when `vpc` is set, and not in
       * `sst dev`.
       */
      networkConnector: this.networkConnector,
    };
  }

  /** @internal */
  public getSSTLink() {
    if (this.devUrl)
      return {
        properties: {
          dev: { url: this.devUrl },
          port: this.runDefaults.port,
        },
      };

    const connector = (type: string) =>
      interpolate`arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:${type}`;

    return {
      properties: {
        imageArn: this.image!.arn,
        // Pin the version, so a MicroVM runs the image deployed with the code that started it.
        imageVersion: this.image!.imageVersion,
        executionRoleArn: this.executionRole.arn,
        logGroup: this.logGroup.name,
        ingressNetworkConnectors: [connector("ALL_INGRESS")],
        egressNetworkConnectors: [
          this.networkConnector?.arn ?? connector("INTERNET_EGRESS"),
        ],
        port: this.runDefaults.port,
        duration: this.runDefaults.duration,
        idle: this.runDefaults.idle,
      },
      include: [
        permission({
          actions: [
            "lambda:RunMicrovm",
            "lambda:GetMicrovm",
            "lambda:SuspendMicrovm",
            "lambda:ResumeMicrovm",
            "lambda:TerminateMicrovm",
            "lambda:CreateMicrovmAuthToken",
          ],
          // A MicroVM has no ARN of its own: these are authorized on its image.
          resources: [this.image!.arn],
        }),
        permission({
          actions: ["lambda:ListMicrovms", "lambda:PassNetworkConnector"],
          resources: ["*"],
        }),
        permission({
          actions: ["iam:PassRole"],
          resources: [this.executionRole.arn],
        }),
      ],
    };
  }
}

const __pulumiType = "sst:aws:MicroVm";
// @ts-expect-error
MicroVm.__pulumiType = __pulumiType;
