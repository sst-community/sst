import {
  ComponentResourceOptions,
  Output,
  Resource,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import {
  cloudwatch,
  getCallerIdentityOutput,
  getPartitionOutput,
  iam,
  lambda,
  s3,
  sns,
  sqs,
  types,
} from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { notAnOption, plain, usedAsItIs, withDefault, getArgs } from "../../args";
import type { Plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { type Duration, type DurationDays, toSeconds } from "../../duration";
import { Function } from "./function";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import { invokePermissionArgs } from "../helpers/function-permission";
import { enabledState, ruleFunctionTarget } from "../helpers/eventbridge";
import { sendPolicy } from "../helpers/queue-policy";
import { type AnyQueue, queueArnOf } from "../helpers/queue";
import { type AnySnsTopic, topicArnOf } from "../helpers/sns-topic";
import { permission } from "../permission";

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
  /**
   * The functions subscribed to the bucket's events on the default
   * EventBridge bus, by subscriber name.
   */
  eventBridgeSubscriber: many(deferred(Function)),
  /**
   * The permissions that let EventBridge invoke each of those functions, by
   * subscriber name.
   */
  eventBridgePermission: many(lambda.Permission),
  /**
   * The rules that match the bucket's events for each subscriber, by
   * subscriber name.
   */
  eventBridgeRule: many(cloudwatch.EventRule),
  /**
   * The targets that send what each rule matches to its function, by
   * subscriber name.
   */
  eventBridgeTarget: many(cloudwatch.EventTarget),
});

interface BucketCorsArgs {
  /**
   * The HTTP headers that origins can include in requests to the bucket.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   cors: {
   *     allowHeaders: ["date", "keep-alive", "x-custom-header"]
   *   }
   * }
   * ```
   */
  allowHeaders?: Input<Input<string>[]>;
  /**
   * The origins that can access the bucket.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   cors: {
   *     allowOrigins: ["https://www.example.com", "http://localhost:60905"]
   *   }
   * }
   * ```
   * Or the wildcard for all origins.
   * ```js
   * {
   *   cors: {
   *     allowOrigins: ["*"]
   *   }
   * }
   * ```
   */
  allowOrigins?: Input<Input<string>[]>;
  /**
   * The HTTP methods that are allowed when calling the bucket.
   * @default `["DELETE" | "GET" | "HEAD" | "POST" | "PUT"]`
   * @example
   * ```js
   * {
   *   cors: {
   *     allowMethods: ["GET", "POST", "DELETE"]
   *   }
   * }
   * ```
   */
  allowMethods?: Input<Input<"DELETE" | "GET" | "HEAD" | "POST" | "PUT">[]>;
  /**
   * The HTTP headers you want to expose to an origin that calls the bucket.
   * @default `["ETag"]`
   * @example
   * ```js
   * {
   *   cors: {
   *     exposeHeaders: ["date", "keep-alive", "x-custom-header"]
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
   *   cors: {
   *     maxAge: "1 day"
   *   }
   * }
   * ```
   */
  maxAge?: Input<Duration>;
}

interface BucketLifecycleArgs {
  /**
   * The unique identifier for the lifecycle rule.
   *
   * This ID must be unique across all lifecycle rules in the bucket and cannot exceed 255 characters.
   * Whitespace-only values are not allowed.
   *
   * If not provided, SST will generate a unique ID based on the bucket component name and rule index.
   *
   * @example
   * Use stable IDs to ensure rule identity is preserved when reordering rules.
   * ```js
   * {
   *   id: "expire-tmp-files",
   *   prefix: "tmp/",
   *   expiresIn: "7 days"
   * }
   * ```
   */
  id?: Input<string>;
  /**
   * An S3 object key prefix that the lifecycle rule applies to.
   * @example
   * Applies to all the objects in the `images/` folder.
   * ```js
   * {
   *   prefix: "images/"
   * }
   * ```
   */
  prefix?: Input<string>;
  /**
   * Whether the lifecycle rule is enabled.
   * @example
   * ```js
   * {
   *  enabled: true
   * }
   * ```
   * @default `true`
   */
  enabled?: Input<boolean>;
  /**
   * Days after which the objects in the bucket should expire.
   * @example
   * ```js
   * {
   *  expiresIn: "30 days"
   * }
   * ```
   */
  expiresIn?: Input<DurationDays>;
  /**
   * Date after which the objects in the bucket should expire. Defaults to midnight UTC time.
   * @example
   * ```js
   * {
   *  expiresAt: "2023-08-22"
   * }
   * ```
   */
  expiresAt?: Input<string>;
}

export interface BucketArgs extends ComponentArgs<typeof parts> {
  /**
   * Enable public read access for all the files in the bucket. By default, no access is
   * granted.
   *
   * :::tip
   * If you are using the [`Router`](/docs/component/aws/v5/router) to serve files from this
   * bucket, you need to allow `cloudfront` access the bucket.
   * :::
   *
   * This adds a statement to the bucket policy that either allows `public` access or just
   * `cloudfront` access. With `cloudfront`, only CloudFront distributions in the same AWS
   * account can read the bucket.
   *
   * @example
   * ```js
   * {
   *   access: "public"
   * }
   * ```
   *
   * To let the distributions of another AWS account read a `cloudfront` bucket, add a
   * statement with the `policy` option. In the GovCloud and China partitions, start the ARN
   * with `arn:aws-us-gov:` or `arn:aws-cn:` instead of `arn:aws:`.
   *
   * ```js
   * {
   *   access: "cloudfront",
   *   policy: [
   *     {
   *       effect: "allow",
   *       principals: [{ type: "service", identifiers: ["cloudfront.amazonaws.com"] }],
   *       actions: ["s3:GetObject"],
   *       paths: ["*"],
   *       conditions: [
   *         {
   *           test: "StringLike",
   *           variable: "aws:SourceArn",
   *           values: ["arn:aws:cloudfront::OTHER_ACCOUNT_ID:distribution/*"]
   *         }
   *       ]
   *     }
   *   ]
   * }
   * ```
   */
  access?: Input<"public" | "cloudfront">;
  /**
   * Configure the policy for the bucket.
   *
   * @example
   * Restrict Access to Specific IP Addresses
   *
   * ```js
   * {
   *   policy: [{
   *     actions: ["s3:*"],
   *     principals: "*",
   *     conditions: [
   *       {
   *         test: "IpAddress",
   *         variable: "aws:SourceIp",
   *         values: ["10.0.0.0/16"]
   *       }
   *     ]
   *   }]
   * }
   * ```
   *
   * Allow Specific IAM User Access
   *
   * ```js
   * {
   *   policy: [{
   *     actions: ["s3:*"],
   *     principals: [{
   *       type: "aws",
   *       identifiers: ["arn:aws:iam::123456789012:user/specific-user"]
   *     }],
   *   }]
   * }
   * ```
   *
   * Cross-Account Access
   *
   * ```js
   * {
   *   policy: [{
   *     actions: ["s3:GetObject", "s3:ListBucket"],
   *     principals: [{
   *       type: "aws",
   *       identifiers: ["123456789012"]
   *     }],
   *   }]
   * }
   * ```
   */
  policy?: Input<
    Input<{
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
      effect?: Input<"allow" | "deny">;
      /**
       * The [IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/reference_policies_actions-resources-contextkeys.html#actions_table) that can be performed.
       * @example
       * ```js
       * {
       *   actions: ["s3:*"]
       * }
       * ```
       */
      actions: Input<Input<string>[]>;
      /**
       * The principals that can perform the actions.
       * @example
       * Allow anyone to perform the actions.
       *
       * ```js
       * {
       *   principals: "*"
       * }
       * ```
       *
       * Allow anyone within an AWS account.
       *
       * ```js
       * {
       *   principals: [{ type: "aws", identifiers: ["123456789012"] }]
       * }
       * ```
       *
       * Allow specific IAM roles.
       * ```js
       * {
       *   principals: [{
       *     type: "aws",
       *     identifiers: [
       *       "arn:aws:iam::123456789012:role/MyRole",
       *       "arn:aws:iam::123456789012:role/MyOtherRole"
       *     ]
       *   }]
       * }
       * ```
       *
       * Allow AWS CloudFront.
       * ```js
       * {
       *   principals: [{ type: "service", identifiers: ["cloudfront.amazonaws.com"] }]
       * }
       * ```
       *
       * Allow OIDC federated users.
       * ```js
       * {
       *   principals: [{
       *     type: "federated",
       *     identifiers: ["accounts.google.com"]
       *   }]
       * }
       * ```
       *
       * Allow SAML federated users.
       * ```js
       * {
       *   principals: [{
       *     type: "federated",
       *     identifiers: ["arn:aws:iam::123456789012:saml-provider/provider-name"]
       *   }]
       * }
       * ```
       *
       * Allow Canonical User IDs.
       * ```js
       * {
       *   principals: [{
       *     type: "canonical",
       *     identifiers: ["79a59df900b949e55d96a1e698fbacedfd6e09d98eacf8f8d5218e7cd47ef2be"]
       *   }]
       * }
       * ```
       */
      principals: Input<
        | "*"
        | Input<{
            type: Input<"aws" | "service" | "federated" | "canonical">;
            identifiers: Input<Input<string>[]>;
          }>[]
      >;
      /**
       * Configure specific conditions for when the policy is in effect.
       * @example
       * ```js
       * {
       *   conditions: [
       *     {
       *       test: "StringEquals",
       *       variable: "s3:x-amz-server-side-encryption",
       *       values: ["AES256"]
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
      /**
       * The S3 file paths that the policy is applied to. The paths are specified using
       * the [S3 path format](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-prefixes.html).
       * The bucket arn will be prepended to the paths when constructing the policy.
       * @default `["", "*"]`
       * @example
       * Apply the policy to the bucket itself.
       * ```js
       * {
       *   paths: [""]
       * }
       * ```
       *
       * Apply to all files in the bucket.
       * ```js
       * {
       *   paths: ["*"]
       * }
       * ```
       *
       * Apply to all files in the `images/` folder.
       * ```js
       * {
       *   paths: ["images/*"]
       * }
       * ```
       */
      paths?: Input<Input<string>[]>;
    }>[]
  >;
  /**
   * Enforce HTTPS for all requests to the bucket.
   *
   * By default, the bucket policy will automatically block any HTTP requests.
   * This is done using the `aws:SecureTransport` condition key.
   *
   * @default true
   * @example
   * ```js
   * {
   *   enforceHttps: false
   * }
   * ```
   */
  enforceHttps?: Input<boolean>;
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
   * Whether there is a CORS configuration decides what's created, so it's a plain value.
   * Its fields can be outputs.
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
  cors?: boolean | Prettify<BucketCorsArgs>;
  /**
   * The lifecycle configuration for the bucket. Whether there is one decides what's
   * created, so the list is a plain value. Each rule in it can be an output.
   *
   * @example
   * Delete objects in the `tmp/` folder after 30 days.
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
   *
   * Use stable IDs to preserve rule identity when reordering.
   * ```js
   * {
   *   lifecycle: [
   *     {
   *       id: "expire-tmp-files",
   *       prefix: "tmp/",
   *       expiresIn: "7 days"
   *     },
   *     {
   *       id: "archive-old-logs",
   *       prefix: "logs/",
   *       expiresIn: "90 days"
   *     }
   *   ]
   * }
   * ```
   */
  lifecycle?: Input<Prettify<BucketLifecycleArgs>>[];
  /**
   * Enable versioning for the bucket.
   *
   * Bucket versioning enables you to store multiple versions of an object, protecting
   * against accidental deletion or overwriting. It decides what's created, so it's a
   * plain value.
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

export interface BucketNotificationArgs {
  /**
   * The name of the notification. It's the notification's id in the bucket's
   * `nodes` and `transform`, and it's used in the names of the resources
   * created for it, so it's a plain value.
   *
   * Must be unique across the bucket's notifications.
   */
  name: string;
  /**
   * The function that'll be notified: the handler of one to create, its args, a function
   * component, or the ARN of a function you have. Only a function you have, or its ARN,
   * can be an output.
   *
   * @example
   * ```js
   * {
   *   name: "MySubscriber",
   *   function: "src/subscriber.handler"
   * }
   * ```
   *
   * Customize the subscriber function. The `link` ensures the subscriber can access the
   * bucket through the [SDK](/docs/reference/sdk/).
   *
   * ```js
   * {
   *   name: "MySubscriber",
   *   function: {
   *     handler: "src/subscriber.handler",
   *     timeout: "60 seconds",
   *     link: [bucket]
   *   }
   * }
   * ```
   *
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```js
   * {
   *   name: "MySubscriber",
   *   function: "arn:aws:lambda:us-east-1:123456789012:function:my-function"
   * }
   * ```
   */
  function?: FunctionInput;
  /**
   * The queue that'll be notified: a queue component, or the ARN of a queue.
   *
   * @example
   * For example, let's say you have a queue.
   *
   * ```js title="sst.config.ts"
   * const myQueue = new sst.aws.v5.Queue("MyQueue");
   * ```
   *
   * You can subscribe to this bucket with it.
   *
   * ```js
   * {
   *   name: "MySubscriber",
   *   queue: myQueue
   * }
   * ```
   *
   * Or pass in the ARN of an existing SQS queue.
   *
   * ```js
   * {
   *   name: "MySubscriber",
   *   queue: "arn:aws:sqs:us-east-1:123456789012:my-queue"
   * }
   * ```
   */
  queue?: Input<string | AnyQueue>;
  /**
   * The topic that'll be notified: a topic component, or the ARN of a topic.
   *
   * @example
   * For example, let's say you have a topic.
   *
   * ```js title="sst.config.ts"
   * const myTopic = new sst.aws.v5.SnsTopic("MyTopic");
   * ```
   *
   * You can subscribe to this bucket with it.
   *
   * ```js
   * {
   *   name: "MySubscriber",
   *   topic: myTopic
   * }
   * ```
   *
   * Or pass in the ARN of an existing SNS topic.
   *
   * ```js
   * {
   *   name: "MySubscriber",
   *   topic: "arn:aws:sns:us-east-1:123456789012:my-topic"
   * }
   * ```
   */
  topic?: Input<string | AnySnsTopic>;
  /**
   * A list of S3 event types that'll trigger a notification.
   * @default All S3 events
   * @example
   * ```js
   * {
   *   events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"]
   * }
   * ```
   */
  events?: Input<
    Input<
      | "s3:ObjectCreated:*"
      | "s3:ObjectCreated:Put"
      | "s3:ObjectCreated:Post"
      | "s3:ObjectCreated:Copy"
      | "s3:ObjectCreated:CompleteMultipartUpload"
      | "s3:ObjectRemoved:*"
      | "s3:ObjectRemoved:Delete"
      | "s3:ObjectRemoved:DeleteMarkerCreated"
      | "s3:ObjectRestore:*"
      | "s3:ObjectRestore:Post"
      | "s3:ObjectRestore:Completed"
      | "s3:ObjectRestore:Delete"
      | "s3:ReducedRedundancyLostObject"
      | "s3:Replication:*"
      | "s3:Replication:OperationFailedReplication"
      | "s3:Replication:OperationMissedThreshold"
      | "s3:Replication:OperationReplicatedAfterThreshold"
      | "s3:Replication:OperationNotTracked"
      | "s3:LifecycleExpiration:*"
      | "s3:LifecycleExpiration:Delete"
      | "s3:LifecycleExpiration:DeleteMarkerCreated"
      | "s3:LifecycleTransition"
      | "s3:IntelligentTiering"
      | "s3:ObjectTagging:*"
      | "s3:ObjectTagging:Put"
      | "s3:ObjectTagging:Delete"
      | "s3:ObjectAcl:Put"
    >[]
  >;
  /**
   * An S3 object key prefix that will trigger a notification.
   * @example
   * To be notified for all the objects in the `images/` folder.
   * ```js
   * {
   *   filterPrefix: "images/"
   * }
   * ```
   */
  filterPrefix?: Input<string>;
  /**
   * An S3 object key suffix that will trigger the notification.
   * @example
   * To be notified for all the objects with the `.jpg` suffix.
   * ```js
   * {
   *  filterSuffix: ".jpg"
   * }
   * ```
   */
  filterSuffix?: Input<string>;
}

export interface BucketNotifyArgs {
  /**
   * Publish every S3 event of the bucket to the account's default EventBridge bus. It
   * doesn't send them anywhere by itself: subscribe to them with
   * [`subscribeEventBridge`](#subscribeeventbridge), or add your own rules on the default bus.
   *
   * S3 keeps one notification configuration for each bucket, so set it in the same call
   * as the `notifications`.
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   eventBridge: true,
   *   notifications: [{ name: "MySubscriber", queue: myQueue }]
   * }
   * ```
   */
  eventBridge?: Input<boolean>;
  /**
   * The notifications of the bucket. Each one has a `name` and one of
   * `function`, `queue` or `topic`. Leave it out if the bucket only uses
   * `eventBridge`.
   *
   * What's created for each notification is decided from the list, so it's a plain value.
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
  notifications?: BucketNotificationArgs[];
}

export interface BucketEventBridgeSubscriberArgs {
  /**
   * Configures whether the subscriber is enabled. When disabled, the EventBridge
   * rule is still created, but it won't receive events.
   *
   * @default true
   * @example
   * ```ts
   * {
   *   enabled: false
   * }
   * ```
   */
  enabled?: Input<boolean>;
  /**
   * Filter the S3 events that'll be processed by the subscriber. The `source` and
   * bucket name are automatically added to the EventBridge pattern.
   *
   * :::tip
   * Learn more about [event patterns](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html).
   * :::
   */
  pattern?: Input<{
    /**
     * A list of `detail-type` values to match against. These are the names of the S3
     * events: `Object Created`, `Object Deleted`, `Object Restore Initiated`,
     * `Object Restore Completed`, `Object Restore Expired`, `Object Tags Added`,
     * `Object Tags Deleted`, `Object ACL Updated`, `Object Storage Class Changed`,
     * `Object Access Tier Changed` and `Async Copy Completion`. Leave it out to match
     * all of them.
     *
     * @example
     * ```js
     * {
     *   detailType: ["Object Created"]
     * }
     * ```
     */
    detailType?: Input<
      Input<
        | "Object Created"
        | "Object Deleted"
        | "Object Restore Initiated"
        | "Object Restore Completed"
        | "Object Restore Expired"
        | "Object Tags Added"
        | "Object Tags Deleted"
        | "Object ACL Updated"
        | "Object Storage Class Changed"
        | "Object Access Tier Changed"
        | "Async Copy Completion"
        | string
      >[]
    >;
    /**
     * An object of `detail` values to match.
     *
     * @example
     * ```js
     * {
     *   detail: {
     *     object: {
     *       key: [{ prefix: "images/" }]
     *     }
     *   }
     * }
     * ```
     */
    detail?: Record<string, any>;
  }>;
}

/**
 * The `Bucket` component lets you add an [AWS S3 Bucket](https://aws.amazon.com/s3/) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have. That includes the resources of
 * each notification.
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
 * #### Subscribe to its events in EventBridge
 *
 * Publish the bucket's events to the default EventBridge bus, then subscribe to them.
 *
 * ```ts title="sst.config.ts"
 * bucket
 *   .notify({ eventBridge: true })
 *   .subscribeEventBridge("Resizer", "src/resize.handler", {
 *     pattern: { detailType: ["Object Created"] }
 *   });
 * ```
 *
 * #### Link the bucket to a resource
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
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
 * #### Use a bucket you already have
 *
 * Pass the bucket, or its name. The bucket is used the way it is: the component doesn't
 * configure it, and refuses `access`, `cors`, `versioning` and the other settings of a
 * bucket next to it.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Bucket("MyBucket", {
 *   existing: {
 *     bucket: "app-dev-mybucket-12345678"
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.Bucket`
 *
 * Change `sst.aws.Bucket` to `sst.aws.v5.Bucket` and keep the name. The bucket, what
 * configures it, and the resources `notify` created are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const bucket = new sst.aws.Bucket("MyBucket");
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 * ```
 *
 * A few things are written differently:
 *
 * - `versioning`, `cors` and the list of `lifecycle` rules are plain values, not outputs,
 *   since they decide what's created. The fields of `cors` and each rule can still be
 *   outputs.
 * - So are the list of `notifications` that `notify` takes, each notification in it, and
 *   its `name`. A notification's `function`, and the function `subscribeEventBridge`
 *   takes, can't be a handler or a function's args in an output: they decide what's
 *   created. A function you already have, or its ARN, can still be an output.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - A `transform` function for `cors` or `lifecycle` is given outputs where
 *   `sst.aws.Bucket` gave it plain values, like `corsRules[0].allowedOrigins` and
 *   `rules`. Change them with `apply`, or set them with an object.
 * - A notification's function is described after the component, `Notified by MyBucket on
 *   ...`, where `sst.aws.Bucket` named the component it kept the notifications in: an
 *   update in place.
 * - `transform: { publicAccessBlock: false }` becomes `publicAccessBlock: false`.
 * - `public: true` becomes `access: "public"`.
 * - The `transform` of `notify` becomes the bucket's `transform.notification`.
 * - `subscribe`, `subscribeQueue` and `subscribeTopic` are gone, and are refused with what
 *   to write. Use `notify`, which keeps the subscriber you had.
 * - The static `sst.aws.Bucket.subscribe`, `subscribeQueue` and `subscribeTopic`, which
 *   took a bucket's ARN, are gone too: call `notify` on `get`. They're refused with what
 *   to write. What they created isn't kept: remove it and deploy before you switch, then
 *   add it back with `notify`.
 * - `sst.aws.Bucket.subscribeEventBridge(name, bucketName, ...)` is `subscribeEventBridge`
 *   on the bucket, or on `get` for a bucket that isn't in your app, and the static one is
 *   refused with what to write. What it created is kept. It's created with the bucket's
 *   `provider`, where `sst.aws.Bucket` used your app's: if your bucket has a `provider`,
 *   its rule, target and permission are replaced on switch.
 * - `get` gives its options to the component, so a `provider` or `parent` you pass it
 *   applies to the bucket's notifications too. `sst.aws.Bucket.get` gave them to the bucket it
 *   looked up and to nothing else. If you pass `get` a `provider` and call `notify` on that
 *   bucket, its notifications are replaced on switch, to be created with that provider:
 *   remove them and deploy before you switch, then add them back.
 */
export class Bucket extends component("sst:aws:Bucket", parts) {
  constructor(
    name: string,
    args: BucketArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    notAnOption(
      args,
      "public",
      `Use "access" instead: access: "public".`,
      `the "${name}" bucket`,
    );
    const noBlock: unknown = args.transform?.publicAccessBlock;
    if (noBlock === false)
      throw new VisibleError(
        `In the "${name}" bucket, "transform.publicAccessBlock" changes the public access block, so it can't be false. To not create one, set "publicAccessBlock" to false.`,
      );

    const bucket = this.part("bucket", { forceDestroy: true });

    // A bucket that's already there is used the way it is
    if (this.existingPart("bucket")) {
      usedAsItIs(args, CONFIGURES, "bucket", `the "${name}" bucket`);
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
      { bucket: bucket.bucket, policy: policyDocument(bucket.arn, args, opts) },
      { dependsOn: publicAccessBlock },
    );

    const cors = plain(args.cors, `The "cors" of the "${name}" bucket`);
    if (cors !== false) {
      const rule = cors === true ? undefined : cors;
      this.part("cors", {
        bucket: bucket.bucket,
        corsRules: [
          {
            allowedHeaders: withDefault(rule?.allowHeaders, ["*"]),
            allowedMethods: withDefault(rule?.allowMethods, [
              "DELETE",
              "GET",
              "HEAD",
              "POST",
              "PUT",
            ]),
            allowedOrigins: withDefault(rule?.allowOrigins, ["*"]),
            exposeHeaders: withDefault(rule?.exposeHeaders, ["ETag"]),
            maxAgeSeconds: withDefault(rule?.maxAge, "0 seconds", toSeconds),
          },
        ],
      });
    }

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
        `"notify" was already called on the "${name}" bucket. A bucket has one notification configuration: pass all of its notifications in one call.`,
      );

    if (!args.eventBridge && !args.notifications)
      throw new VisibleError(
        `"notify" on the "${name}" bucket needs "notifications", or "eventBridge" set to true.`,
      );
    const notifications = plain(
      args.notifications ?? [],
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
      if (targets !== 1) {
        const has = targets === 0 ? "has none" : "has more than one";
        throw new VisibleError(
          `The "${n.name}" notification of the "${name}" bucket ${has} of "function", "queue" and "topic". Give it one.`,
        );
      }

      const events = withDefault(n.events, EVENTS);
      const config = {
        id: n.name,
        events,
        filterPrefix: n.filterPrefix,
        filterSuffix: n.filterSuffix,
      };

      if (n.function !== undefined) {
        const fn = functionPart(
          this,
          "subscriber",
          n.name,
          plainFunction(
            n.function,
            `The "function" of the "${n.name}" notification of the "${name}" bucket`,
          ),
          {
            description: events.apply((events) =>
              events.length < 5
                ? `Notified by ${name} on ${events.join(", ")}`
                : `Notified by ${name} on ${events.slice(0, 3).join(", ")}, and ${events.length - 3} more events`,
            ),
          },
        );
        dependsOn.push(
          this.part(
            "permission",
            n.name,
            invokePermissionArgs(fn, "s3.amazonaws.com", this.arn),
          ),
        );
        lambdaFunctions.push({ ...config, lambdaFunctionArn: fn.targetArn });
      } else if (n.queue !== undefined) {
        const queueArn = queueArnOf(n.queue);
        dependsOn.push(
          this.part("queuePolicy", n.name, ...sendPolicy(queueArn)),
        );
        queues.push({ ...config, queueArn });
      } else {
        const topicArn = topicArnOf(n.topic!);
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
      {
        bucket: this.name,
        eventbridge: args.eventBridge,
        lambdaFunctions,
        queues,
        topics,
      },
      { dependsOn },
    );

    return this;
  }

  /**
   * Subscribe to the bucket's events on the account's default EventBridge bus with a
   * function. This creates a rule that matches the events of this bucket, and a target
   * for it. The bucket has to publish to EventBridge: for a bucket in your app, that's
   * `notify({ eventBridge: true })`. For a bucket that isn't, reference it with `get` and
   * turn EventBridge on for it where it's managed.
   *
   * @param name The name of the subscriber.
   * @param subscriber The function that'll be notified: the handler of one to create, its
   * args, a function component, or the ARN of a function you have. Only a function you
   * have, or its ARN, can be an output.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * bucket.subscribeEventBridge("Resizer", "src/resize.handler", {
   *   pattern: {
   *     detailType: ["Object Created"],
   *     detail: {
   *       object: { key: [{ prefix: "uploads/" }] }
   *     }
   *   }
   * });
   * ```
   */
  public subscribeEventBridge(
    name: string,
    subscriber: FunctionInput,
    args: BucketEventBridgeSubscriberArgs = {},
  ) {
    this.assertNew("EventBridge subscriber", "eventBridgeRule", name, args, [
      "eventBridgeRule",
      "eventBridgeTarget",
    ]);
    // The account's default bus, where S3 publishes a bucket's events
    const bus = "default";
    const rule = this.part("eventBridgeRule", name, {
      eventBusName: bus,
      state: enabledState(args.enabled),
      // This bucket's events, and of those the ones the pattern matches
      eventPattern: all([this.name, args.pattern ?? {}]).apply(
        ([bucketName, pattern]) => {
          const detail = pattern.detail ?? {};
          return JSON.stringify({
            "detail-type": pattern.detailType,
            source: ["aws.s3"],
            detail: {
              ...detail,
              bucket: { ...(detail.bucket ?? {}), name: [bucketName] },
            },
          });
        },
      ),
    });
    ruleFunctionTarget(
      this.builder(),
      {
        subscriber: "eventBridgeSubscriber",
        permission: "eventBridgePermission",
        target: "eventBridgeTarget",
      },
      name,
      rule,
      {
        bus,
        subscriber: plainFunction(
          subscriber,
          `The EventBridge subscriber "${name}" of the "${this.componentName}" bucket`,
        ),
        description: `Subscribed to ${bus}`,
      },
    );
    return this;
  }

  /** @internal */
  public subscribe(..._args: unknown[]): never {
    throw new VisibleError(
      `"subscribe" isn't a method of the "${this.componentName}" bucket. Notify the function with "notify": bucket.notify({ notifications: [{ name: "MySubscriber", function: "src/subscriber.handler" }] }).`,
    );
  }

  /** @internal */
  public subscribeQueue(..._args: unknown[]): never {
    throw new VisibleError(
      `"subscribeQueue" isn't a method of the "${this.componentName}" bucket. Notify the queue with "notify": bucket.notify({ notifications: [{ name: "MyQueue", queue }] }).`,
    );
  }

  /** @internal */
  public subscribeTopic(..._args: unknown[]): never {
    throw new VisibleError(
      `"subscribeTopic" isn't a method of the "${this.componentName}" bucket. Notify the topic with "notify": bucket.notify({ notifications: [{ name: "MyTopic", topic }] }).`,
    );
  }

  /**
   * `sst.aws.Bucket.subscribe` subscribed to a bucket by its ARN. Reference the bucket
   * with `get` and call `notify` on that.
   *
   * @internal
   */
  public static subscribe(..._args: unknown[]): never {
    throw new VisibleError(
      `To be notified of the events of a bucket that isn't in your app, reference it with "get" and call "notify" on that: sst.aws.v5.Bucket.get("MyBucket", bucketName).notify({ notifications: [{ name: "MySubscriber", function: "src/subscriber.handler" }] }).`,
    );
  }

  /**
   * `sst.aws.Bucket.subscribeQueue` subscribed a queue to a bucket by its ARN. Reference
   * the bucket with `get` and call `notify` on that.
   *
   * @internal
   */
  public static subscribeQueue(..._args: unknown[]): never {
    throw new VisibleError(
      `To notify a queue of the events of a bucket that isn't in your app, reference the bucket with "get" and call "notify" on that: sst.aws.v5.Bucket.get("MyBucket", bucketName).notify({ notifications: [{ name: "MyQueue", queue }] }).`,
    );
  }

  /**
   * `sst.aws.Bucket.subscribeTopic` subscribed a topic to a bucket by its ARN. Reference
   * the bucket with `get` and call `notify` on that.
   *
   * @internal
   */
  public static subscribeTopic(..._args: unknown[]): never {
    throw new VisibleError(
      `To notify a topic of the events of a bucket that isn't in your app, reference the bucket with "get" and call "notify" on that: sst.aws.v5.Bucket.get("MyBucket", bucketName).notify({ notifications: [{ name: "MyTopic", topic }] }).`,
    );
  }

  /**
   * `sst.aws.Bucket.subscribeEventBridge` subscribed to a bucket's events by its name.
   * It's a method of the bucket now.
   *
   * @internal
   */
  public static subscribeEventBridge(..._args: unknown[]): never {
    throw new VisibleError(
      `"subscribeEventBridge" is a method of the bucket: call it on the bucket, or on "get" for a bucket that isn't in your app: sst.aws.v5.Bucket.get("MyBucket", bucketName).subscribeEventBridge("MySubscriber", "src/subscriber.handler").`,
    );
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
    return new Bucket(
      name,
      getArgs({ existing: { bucket: bucketName } }),
      opts,
    );
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
const EVENTS: NonNullable<Plain<BucketNotificationArgs["events"]>> = [
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

/**
 * The bucket policy: read access for the public or for CloudFront, the
 * statement that denies requests that aren't over HTTPS, and the user's own
 * statements. The account and partition are looked up with the component's
 * provider.
 */
function policyDocument(
  arn: Output<string>,
  args: Pick<BucketArgs, "access" | "enforceHttps" | "policy">,
  opts?: ComponentResourceOptions,
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
        // Without it, a distribution in any AWS account could read the bucket
        // through its own origin access control
        conditions:
          access === "public"
            ? undefined
            : [
                {
                  test: "StringLike",
                  variable: "aws:SourceArn",
                  values: [
                    interpolate`arn:${getPartitionOutput({}, opts).partition}:cloudfront::${getCallerIdentityOutput({}, opts).accountId}:distribution/*`,
                  ],
                },
              ],
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
    const what = `Lifecycle rule ${index} of the "${name}" bucket`;
    if (id.length === 0)
      throw new VisibleError(
        `${what} has an empty "id". Give it one, or leave "id" out for one made from the bucket's name.`,
      );
    if (id.length > 255)
      throw new VisibleError(
        `${what} has an "id" that's ${id.length} characters long. S3 takes at most 255.`,
      );
    const other = seen.get(id);
    if (other !== undefined)
      throw new VisibleError(
        `Lifecycle rules ${other} and ${index} of the "${name}" bucket have the same "id", "${id}". Give each its own.`,
      );
    seen.set(id, index);
    return id;
  });
}
