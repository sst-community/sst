import {
  ComponentResourceOptions,
  Output,
  OutputInstance,
  Resource,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { iam, lambda, s3, sns, sqs, types } from "@pulumi/aws";
import {
  V5Args,
  component,
  deferred,
  many,
  optional,
} from "../../parts-component";
import { notAnOption, plain, withDefault } from "../../args";
import type { Plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { toSeconds } from "../../duration";
import { Function } from "./function";
import { functionPart } from "../helpers/function-part";
import { invokePermissionArgs } from "../helpers/function-permission";
import { sendPolicyArgs } from "../helpers/queue-policy";
import { permission } from "../permission";
import type {
  BucketArgs as OriginalBucketArgs,
  BucketNotificationsArgs,
} from "../bucket";
import type { Queue as OriginalQueue } from "../queue";
import type { Queue } from "./queue";
import type { SnsTopic as OriginalSnsTopic } from "../sns-topic";
import type { SnsTopic } from "./sns-topic";

const parts = () => ({
  /**
   * The Amazon S3 bucket.
   */
  bucket: s3.Bucket,
  /**
   * The bucket's versioning configuration, created when `versioning` is on.
   */
  versioning: optional(s3.BucketVersioning),
  /**
   * The bucket's public access block. It isn't created when
   * `publicAccessBlock` is `false`.
   */
  publicAccessBlock: optional(s3.BucketPublicAccessBlock),
  /**
   * The bucket's policy.
   */
  policy: optional(s3.BucketPolicy),
  /**
   * The bucket's CORS configuration. It isn't created when `cors` is `false`.
   */
  cors: optional(s3.BucketCorsConfiguration),
  /**
   * The bucket's lifecycle configuration, created when `lifecycle` has rules.
   */
  lifecycle: optional(s3.BucketLifecycleConfiguration),
  /**
   * The bucket's notification configuration, created by `notify`. A bucket has
   * one, which holds all of its notifications.
   */
  notification: optional(s3.BucketNotification),
  /**
   * The functions that are notified, by notification name.
   */
  subscriber: many(deferred(Function)),
  /**
   * The permissions that let the bucket invoke each notified function, by
   * notification name.
   */
  permission: many(lambda.Permission),
  /**
   * The policies that let the bucket send to each notified queue, by
   * notification name.
   */
  queuePolicy: many(sqs.QueuePolicy),
  /**
   * The policies that let the bucket publish to each notified topic, by
   * notification name.
   */
  topicPolicy: many(sns.TopicPolicy),
});

/** An arg as a plain value: what's left when it can't be an output or a promise. */

type Notification = Plain<
  Plain<BucketNotificationsArgs["notifications"]>[number]
>;

export interface BucketArgs
  extends V5Args<
    Omit<OriginalBucketArgs, "public" | "cors" | "lifecycle" | "versioning">,
    typeof parts
  > {
  /**
   * The CORS configuration for the bucket. Defaults to `true`, which is the same as:
   *
   * ```js
   * {
   *   cors: {
   *     allowHeaders: ["*"],
   *     allowOrigins: ["*"],
   *     allowMethods: ["DELETE", "GET", "HEAD", "POST", "PUT"],
   *     exposeHeaders: ["ETag"],
   *     maxAge: "0 seconds"
   *   }
   * }
   * ```
   *
   * Whether there is a CORS configuration has to be a plain value. Its fields
   * can be outputs.
   *
   * @default `true`
   * @example
   * Turn off CORS.
   *
   * ```js
   * {
   *   cors: false
   * }
   * ```
   */
  cors?: Plain<OriginalBucketArgs["cors"]>;
  /**
   * The lifecycle rules for the bucket. The list has to be a plain array; each
   * rule can be an output.
   *
   * @example
   * Delete objects in the `tmp/` folder after 30 days.
   *
   * ```js
   * {
   *   lifecycle: [
   *     {
   *       prefix: "tmp/",
   *       expiresIn: "30 days"
   *     }
   *   ]
   * }
   * ```
   */
  lifecycle?: Plain<OriginalBucketArgs["lifecycle"]>;
  /**
   * Enable versioning for the bucket, which keeps multiple versions of an
   * object. It has to be a plain value.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   versioning: true
   * }
   * ```
   */
  versioning?: boolean;
  /**
   * Whether to create the bucket's public access block. Set it to `false` in
   * an account that doesn't let you manage them.
   *
   * @default `true`
   * @example
   * ```js
   * {
   *   publicAccessBlock: false
   * }
   * ```
   */
  publicAccessBlock?: boolean;
}

export interface BucketNotificationArgs
  extends Omit<Notification, "name" | "queue" | "topic"> {
  /**
   * The name of the notification. It's the notification's id in the bucket's
   * `nodes` and `transform`, and it's used in the names of the resources
   * created for it.
   *
   * Must be unique across the bucket's notifications.
   */
  name: string;
  /**
   * The queue that'll be notified: a queue component, or the ARN of a queue.
   */
  queue?: Input<string | OriginalQueue | Queue>;
  /**
   * The topic that'll be notified: a topic component, or the ARN of a topic.
   */
  topic?: Input<string | OriginalSnsTopic | SnsTopic>;
}

export interface BucketNotifyArgs {
  /**
   * The notifications of the bucket. Each one has a `name` and one of
   * `function`, `queue` or `topic`.
   *
   * @example
   * ```js
   * {
   *   notifications: [
   *     {
   *       name: "MySubscriber",
   *       function: "src/subscriber.handler",
   *       events: ["s3:ObjectCreated:*"],
   *       filterPrefix: "images/"
   *     }
   *   ]
   * }
   * ```
   */
  notifications: BucketNotificationArgs[];
}

/**
 * The `Bucket` component lets you add an [AWS S3 Bucket](https://aws.amazon.com/s3/) to your app.
 *
 * It takes the args of [`sst.aws.Bucket`](/docs/component/aws/bucket), a few of them written
 * differently. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have. That includes the
 * resources of each notification.
 *
 * @example
 *
 * #### Create a bucket
 *
 * ```ts title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 * ```
 *
 * #### Make it public
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Bucket("MyBucket", {
 *   access: "public"
 * });
 * ```
 *
 * #### Add notifications
 *
 * Each notification has a name, and sends events to a function, a queue or a topic.
 *
 * ```ts title="sst.config.ts"
 * bucket.notify({
 *   notifications: [
 *     {
 *       name: "MySubscriber",
 *       function: "src/subscriber.handler"
 *     }
 *   ]
 * });
 * ```
 *
 * #### Link the bucket to a resource
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * Once linked, you can generate a pre-signed URL to upload files in your app.
 *
 * ```ts title="app/page.tsx" {1,7}
 * import { Resource } from "sst";
 * import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
 * import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
 *
 * const command = new PutObjectCommand({
 *   Key: "file.txt",
 *   Bucket: Resource.MyBucket.name
 * });
 * await getSignedUrl(new S3Client({}), command);
 * ```
 *
 * #### Switch from `sst.aws.Bucket`
 *
 * Change `sst.aws.Bucket` to `sst.aws.v5.Bucket` and keep the name. The bucket, what
 * configures it, and the resources `notify` created are kept. A few things are written
 * differently:
 *
 * - `versioning`, `cors` and `lifecycle` have to be plain values, not outputs.
 * - `transform: { publicAccessBlock: false }` becomes `publicAccessBlock: false`.
 * - `public: true` becomes `access: "public"`.
 * - The `transform` of `notify` becomes the bucket's `transform.notification`.
 * - `subscribe`, `subscribeQueue` and `subscribeTopic` are gone. Use `notify`, which keeps
 *   the subscriber you had.
 * - `get` gives its options to the component, so a `provider` or `parent` you pass it
 *   applies to the bucket's notifications too. `sst.aws.Bucket.get` gave them to the bucket it
 *   looked up and to nothing else. If you pass `get` a `provider` and call `notify` on that
 *   bucket, its notifications are replaced on switch, to be created with that provider:
 *   remove them and deploy before you switch, then add them back.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const bucket = new sst.aws.Bucket("MyBucket");
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 * ```
 *
 * #### Use a bucket you already have
 *
 * Pass the bucket, or its name. The bucket is used the way it is: the component doesn't
 * configure it.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Bucket("MyBucket", {
 *   existing: {
 *     bucket: "app-dev-mybucket-12345678"
 *   }
 * });
 * ```
 */
export class Bucket extends component("sst:aws:BucketV5", parts) {
  constructor(
    name: string,
    args: BucketArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    notAnOption(args, "public", `Use "access" instead: access: "public".`);
    const noBlock: unknown = args.transform?.publicAccessBlock;
    if (noBlock === false)
      throw new VisibleError(
        `In the "${name}" bucket, "transform.publicAccessBlock" changes the public access block, so it can't be false. To not create one, set "publicAccessBlock" to false.`,
      );

    const bucket = this.part("bucket", { forceDestroy: true });

    // A bucket that's already there is used the way it is
    if (this.existingPart("bucket")) {
      const set = CONFIGURES.filter((arg) => args[arg] !== undefined);
      if (set.length > 0)
        throw new VisibleError(
          `The "${name}" bucket is given an existing "bucket", which it uses the way it is. Remove ${set.map((arg) => `"${arg}"`).join(", ")} from its args.`,
        );
      return;
    }

    if (plain(args.versioning, `The "versioning" of the "${name}" bucket`))
      this.part("versioning", {
        bucket: bucket.bucket,
        versioningConfiguration: { status: "Enabled" },
      });

    const isPrivate = output(args.access).apply((v) => v !== "public");
    const publicAccessBlock =
      plain(
        args.publicAccessBlock,
        `The "publicAccessBlock" of the "${name}" bucket`,
      ) === false
        ? undefined
        : this.part("publicAccessBlock", {
            bucket: bucket.bucket,
            blockPublicAcls: true,
            blockPublicPolicy: isPrivate,
            ignorePublicAcls: true,
            restrictPublicBuckets: isPrivate,
          });

    this.part(
      "policy",
      { bucket: bucket.bucket, policy: policyDocument(bucket.arn, args) },
      { dependsOn: publicAccessBlock },
    );

    const cors = plain(args.cors, `The "cors" of the "${name}" bucket`);
    if (cors !== false)
      this.part("cors", {
        bucket: bucket.bucket,
        corsRules: [
          {
            allowedHeaders: withDefault(cors?.allowHeaders, ["*"]),
            allowedMethods: withDefault(cors?.allowMethods, [
              "DELETE",
              "GET",
              "HEAD",
              "POST",
              "PUT",
            ]),
            allowedOrigins: withDefault(cors?.allowOrigins, ["*"]),
            exposeHeaders: withDefault(cors?.exposeHeaders, ["ETag"]),
            maxAgeSeconds: withDefault(cors?.maxAge, "0 seconds", toSeconds),
          },
        ],
      });

    const lifecycle = plain(
      args.lifecycle,
      `The "lifecycle" of the "${name}" bucket`,
    );
    if (lifecycle && lifecycle.length > 0)
      this.part("lifecycle", {
        bucket: bucket.bucket,
        rules: output(lifecycle).apply((rules) => {
          const ids = lifecycleIds(name, rules);
          return rules.map((rule, index) => ({
            id: ids[index],
            status: rule.enabled !== false ? "Enabled" : "Disabled",
            expiration:
              rule.expiresIn || rule.expiresAt
                ? {
                    days: rule.expiresIn
                      ? toSeconds(rule.expiresIn) / 86400
                      : undefined,
                    date: rule.expiresAt
                      ? `${rule.expiresAt}T00:00:00Z`
                      : undefined,
                  }
                : undefined,
            filter: rule.prefix ? { prefix: rule.prefix } : undefined,
          }));
        }),
      });
  }

  /**
   * The generated name of the S3 Bucket.
   */
  public get name() {
    return this.afterPolicy(this.nodes.bucket.bucket);
  }

  /**
   * The domain name of the bucket. Has the format `${bucketName}.s3.amazonaws.com`.
   */
  public get domain() {
    return this.afterPolicy(this.nodes.bucket.bucketDomainName);
  }

  /**
   * The ARN of the S3 Bucket.
   */
  public get arn() {
    return this.afterPolicy(this.nodes.bucket.arn);
  }

  // A bucket has one policy. Whatever uses the bucket through its name, ARN
  // or domain waits for this one, so a second policy fails instead of racing
  // it, and nothing reaches the bucket before the policy is in place.
  private afterPolicy(value: Output<string>) {
    const policy = this.nodes.policy;
    return policy ? all([value, policy.id]).apply(([value]) => value) : value;
  }

  /**
   * Subscribe to the events of this bucket with functions, queues and topics. A bucket has
   * one notification configuration, so pass all the notifications in one call.
   *
   * @param args The notifications.
   *
   * @example
   *
   * Notify a function, a queue and a topic.
   *
   * ```js title="sst.config.ts"
   * const queue = new sst.aws.v5.Queue("MyQueue");
   * const topic = new sst.aws.v5.SnsTopic("MyTopic");
   *
   * bucket.notify({
   *   notifications: [
   *     {
   *       name: "MySubscriber",
   *       function: "src/subscriber.handler"
   *     },
   *     {
   *       name: "MyQueue",
   *       queue
   *     },
   *     {
   *       name: "MyTopic",
   *       topic
   *     }
   *   ]
   * });
   * ```
   *
   * Only notify on some events, for some of the objects.
   *
   * ```js title="sst.config.ts"
   * bucket.notify({
   *   notifications: [
   *     {
   *       name: "MySubscriber",
   *       function: "src/subscriber.handler",
   *       events: ["s3:ObjectCreated:*"],
   *       filterPrefix: "images/",
   *       filterSuffix: ".jpg"
   *     }
   *   ]
   * });
   * ```
   *
   * Customize the function, or pass in the ARN of one you already have.
   *
   * ```js title="sst.config.ts"
   * bucket.notify({
   *   notifications: [
   *     {
   *       name: "MySubscriber",
   *       function: {
   *         handler: "src/subscriber.handler",
   *         timeout: "60 seconds"
   *       }
   *     },
   *     {
   *       name: "MyOtherSubscriber",
   *       function: "arn:aws:lambda:us-east-1:123456789012:function:my-function"
   *     }
   *   ]
   * });
   * ```
   *
   * To change how the notification's resources are created, use the bucket's `transform`.
   * A function there is given the notification's name.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.v5.Bucket("MyBucket", {
   *   transform: {
   *     subscriber: (args, opts, name, notification) => {
   *       if (notification === "MySubscriber") args.memory = "2048 MB";
   *     }
   *   }
   * });
   * ```
   *
   * To be notified of the events of a bucket that isn't in your app, reference it with
   * `get` first.
   *
   * ```js title="sst.config.ts"
   * sst.aws.v5.Bucket.get("Uploads", "my-uploads-bucket").notify({
   *   notifications: [{ name: "MySubscriber", function: "src/subscriber.handler" }]
   * });
   * ```
   */
  public notify(args: BucketNotifyArgs) {
    const name = this.componentName;
    notAnOption(
      args,
      "transform",
      `Use the "transform" of the "${name}" bucket: its "notification", and "subscriber", "permission", "queuePolicy" and "topicPolicy" for what each notification creates.`,
    );
    if (this.nodes.notification)
      throw new VisibleError(
        `Cannot call "notify" on the "${name}" bucket multiple times. Calling it again will override previous notifications.`,
      );

    const notifications = plain(
      args.notifications,
      `The "notifications" of the "${name}" bucket`,
    );

    const lambdaFunctions: types.input.s3.BucketNotificationLambdaFunction[] = [];
    const queues: types.input.s3.BucketNotificationQueue[] = [];
    const topics: types.input.s3.BucketNotificationTopic[] = [];
    const dependsOn: Resource[] = [];
    const names = new Set<string>();

    for (const n of notifications) {
      plain(n, `Each notification of the "${name}" bucket`);
      plain(n.name, `The "name" of each notification of the "${name}" bucket`);
      if (names.has(n.name))
        throw new VisibleError(
          `The "${name}" bucket already has a notification named "${n.name}". Give each notification its own name.`,
        );
      names.add(n.name);

      const targets = [n.function, n.queue, n.topic].filter(
        (target) => target !== undefined,
      ).length;
      if (targets === 0)
        throw new VisibleError(
          `At least one of function, queue, or topic is required for the "${n.name}" bucket notification.`,
        );
      if (targets > 1)
        throw new VisibleError(
          `Only one of function, queue, or topic is allowed for the "${n.name}" bucket notification.`,
        );

      const events = withDefault(n.events, EVENTS);
      const config = {
        id: n.name,
        events,
        filterPrefix: n.filterPrefix,
        filterSuffix: n.filterSuffix,
      };

      if (n.function !== undefined) {
        const fn = functionPart(this, "subscriber", n.name, n.function, {
          description: events.apply((events) =>
            events.length < 5
              ? `Notified by ${name} on ${events.join(", ")}`
              : `Notified by ${name} on ${events.slice(0, 3).join(", ")}, and ${events.length - 3} more events`,
          ),
        });
        dependsOn.push(
          this.part(
            "permission",
            n.name,
            invokePermissionArgs(fn, "s3.amazonaws.com", this.arn),
          ),
        );
        lambdaFunctions.push({ ...config, lambdaFunctionArn: fn.targetArn });
      } else if (n.queue !== undefined) {
        const queueArn = arnOf(n.queue);
        dependsOn.push(
          // A queue has one policy. Whatever replaces this one sets its own,
          // so deleting this one would remove the replacement.
          this.part("queuePolicy", n.name, sendPolicyArgs(queueArn), {
            retainOnDelete: true,
          }),
        );
        queues.push({ ...config, queueArn });
      } else {
        const topicArn = arnOf(n.topic!);
        dependsOn.push(
          this.part("topicPolicy", n.name, {
            arn: topicArn,
            policy: iam.getPolicyDocumentOutput({
              statements: [
                {
                  actions: ["sns:Publish"],
                  resources: [topicArn],
                  principals: [
                    { type: "Service", identifiers: ["s3.amazonaws.com"] },
                  ],
                  conditions: [
                    {
                      test: "ArnEquals",
                      variable: "aws:SourceArn",
                      values: [this.arn],
                    },
                  ],
                },
              ],
            }).json,
          }),
        );
        topics.push({ ...config, topicArn });
      }
    }

    this.part(
      "notification",
      { bucket: this.name, lambdaFunctions, queues, topics },
      { dependsOn },
    );

    return this;
  }

  /**
   * Reference an existing bucket with its name. This is useful when you create a bucket in
   * one stage and want to share it in another, or to be notified of the events of a bucket
   * that isn't in your app. The bucket is used the way it is: it isn't configured here.
   *
   * @param name The name of the component.
   * @param bucketName The name of the existing S3 Bucket.
   * @param opts Component resource options.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const bucket = $app.stage === "frank"
   *   ? sst.aws.v5.Bucket.get("MyBucket", "app-dev-mybucket-12345678")
   *   : new sst.aws.v5.Bucket("MyBucket");
   * ```
   */
  public static get(
    name: string,
    bucketName: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Bucket(name, { existing: { bucket: bucketName } }, opts);
  }

  /**
   * Linking a bucket gives the linked resource the bucket's name and
   * permission to use the bucket and its objects.
   */
  public link() {
    return {
      properties: { name: this.name },
      include: [
        permission({
          actions: ["s3:*"],
          resources: [this.arn, interpolate`${this.arn}/*`],
        }),
      ],
    };
  }
}

// The args that configure the bucket, which an existing bucket isn't given
const CONFIGURES = [
  "access",
  "policy",
  "enforceHttps",
  "cors",
  "lifecycle",
  "versioning",
  "publicAccessBlock",
] as const;

// What a notification is sent on when it doesn't say
const EVENTS: NonNullable<Plain<Notification["events"]>> = [
  "s3:ObjectCreated:*",
  "s3:ObjectRemoved:*",
  "s3:ObjectRestore:*",
  "s3:ReducedRedundancyLostObject",
  "s3:Replication:*",
  "s3:LifecycleExpiration:*",
  "s3:LifecycleTransition",
  "s3:IntelligentTiering",
  "s3:ObjectTagging:*",
  "s3:ObjectAcl:Put",
];

const EVERYONE = { type: "*", identifiers: ["*"] };

const PRINCIPALS = {
  aws: "AWS",
  service: "Service",
  federated: "Federated",
  canonical: "Canonical",
};

/** The ARN of a queue or topic that's given as a component or as its ARN. */
function arnOf(
  target: Input<string | OriginalQueue | Queue | OriginalSnsTopic | SnsTopic>,
) {
  return output(target).apply((target) =>
    typeof target === "string" ? output(target) : target.arn,
  );
}

/**
 * The bucket policy: read access for the public or for CloudFront, the
 * statement that denies requests that aren't over HTTPS, and the user's own
 * statements.
 */
function policyDocument(
  arn: Output<string>,
  args: Pick<BucketArgs, "access" | "enforceHttps" | "policy">,
) {
  return all([
    args.access,
    withDefault(args.enforceHttps, true),
    args.policy ?? [],
  ]).apply(([access, enforceHttps, policy]) => {
    const statements: types.input.iam.GetPolicyDocumentStatementArgs[] = [];
    if (access)
      statements.push({
        principals: [
          access === "public"
            ? EVERYONE
            : { type: "Service", identifiers: ["cloudfront.amazonaws.com"] },
        ],
        actions: ["s3:GetObject"],
        resources: [interpolate`${arn}/*`],
      });
    if (enforceHttps)
      statements.push({
        effect: "Deny",
        principals: [EVERYONE],
        actions: ["s3:*"],
        resources: [arn, interpolate`${arn}/*`],
        conditions: [
          {
            test: "Bool",
            variable: "aws:SecureTransport",
            values: ["false"],
          },
        ],
      });
    for (const statement of policy) {
      // A path is relative to the bucket. Without paths, a statement covers
      // the bucket and everything in it.
      const paths = statement.paths?.map((path) => path.replace(/^\//, ""));
      statements.push({
        effect:
          statement.effect &&
          statement.effect.charAt(0).toUpperCase() + statement.effect.slice(1),
        principals:
          statement.principals === "*"
            ? [EVERYONE]
            : statement.principals.map((principal) => ({
                ...principal,
                type: PRINCIPALS[principal.type],
              })),
        actions: statement.actions,
        conditions: statement.conditions,
        resources: (paths ?? ["", "*"]).map((path) =>
          path === "" ? arn : interpolate`${arn}/${path}`,
        ),
      });
    }
    return iam.getPolicyDocumentOutput({ statements }).json;
  });
}

/**
 * The id of each lifecycle rule: its own, or one made from the bucket's name
 * and the rule's position. S3 needs each to be unique and at most 255
 * characters.
 */
function lifecycleIds(name: string, rules: { id?: string }[]) {
  const seen = new Map<string, number>();
  return rules.map((rule, index) => {
    const id = (rule.id ?? `${name}LifecycleRule${index}`).trim();
    if (id.length === 0)
      throw new VisibleError(
        `Lifecycle rule at index ${index} has an empty or whitespace-only "id". Please provide a valid id or omit it to use the auto-generated id.`,
      );
    if (id.length > 255)
      throw new VisibleError(
        `Lifecycle rule at index ${index} has an "id" that is ${id.length} characters long. AWS S3 lifecycle rule IDs cannot exceed 255 characters.`,
      );
    const other = seen.get(id);
    if (other !== undefined)
      throw new VisibleError(
        `Lifecycle rule "id" values must be unique. The id "${id}" is used by rules at indexes ${other} and ${index}.`,
      );
    seen.set(id, index);
    return id;
  });
}
