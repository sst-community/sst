import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { mockPulumi, type TakeoverWay, sidedClass } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

// A policy document is worked out by AWS. Here it's the statements it's given,
// so two policies compare equal when their statements are the same. A bucket
// that's looked up is named what it was looked up by, and so is a bus. A
// function that publishes versions, like a workflow's, is invoked by its
// version.
const pulumi = mockPulumi({
  state: (args) =>
    args.type === "aws:s3/bucket:Bucket" && args.id
      ? { bucket: args.id }
      : args.type === "aws:cloudwatch/eventBus:EventBus" && args.id
        ? { name: args.id }
        : args.type === "aws:lambda/function:Function"
          ? versioned(`arn:aws:mock:us-east-1:123456789012:${args.name}`)
          : {},
  call: (args) =>
    args.token === "aws:iam/getPolicyDocument:getPolicyDocument"
      ? { json: JSON.stringify(sorted(args.inputs)) }
      : undefined,
});

function versioned(arn: string) {
  const invoke = (api: string, path: string) =>
    `arn:aws:apigateway:us-east-1:lambda:path/${api}/functions/${arn}/${path}`;
  return {
    qualifiedArn: `${arn}:3`,
    invokeArn: invoke("2015-03-31", "invocations"),
    qualifiedInvokeArn: invoke("2015-03-31", "invocations").replace(
      arn,
      `${arn}:3`,
    ),
    responseStreamingInvokeArn: invoke(
      "2021-11-15",
      "response-streaming-invocations",
    ),
  };
}

function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const QUEUE_ARN = "arn:aws:sqs:us-east-1:123456789012:orders";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:uploads";
const threeTargets = [
  { name: "A", function: FUNCTION_ARN },
  { name: "B", queue: QUEUE_ARN },
  { name: "C", topic: TOPIC_ARN },
];

type BucketClass =
  | typeof import("../../fixtures/v4/components/aws/bucket").Bucket
  | typeof import("../../../src/components/aws/bucket").Bucket;
type OriginalBucketArgs = import("../../fixtures/v4/components/aws/bucket").BucketArgs;
type NotifyArgs = Parameters<
  import("../../fixtures/v4/components/aws/bucket").Bucket["notify"]
>[0] &
  Parameters<import("../../../src/components/aws/bucket").Bucket["notify"]>[0];
type BucketArgs = import("../../../src/components/aws/bucket").BucketArgs;

describe("Bucket", () => {
  let OriginalBucket: typeof import("../../fixtures/v4/components/aws/bucket").Bucket;
  let Bucket: typeof import("../../../src/components/aws/bucket").Bucket;
  let SidedQueue: any;
  let SidedSnsTopic: any;

  beforeAll(async () => {
    OriginalBucket = (await import("../../fixtures/v4/components/aws/bucket")).Bucket;
    // SST 4's for SST 4's Bucket, SST 5's for SST 5's
    SidedQueue = await sidedClass(
      "Queue",
      import("../../fixtures/v4/components/aws/queue"),
      import("../../../src/components/aws/queue"),
      import("../../../src/components/aws/takeover/queue"),
    );
    SidedSnsTopic = await sidedClass(
      "SnsTopic",
      import("../../fixtures/v4/components/aws/sns-topic"),
      import("../../../src/components/aws/sns-topic"),
      import("../../../src/components/aws/takeover/sns-topic"),
    );
    Bucket = (await import("../../../src/components/aws/bucket")).Bucket;
    await import("../../../src/components/aws/takeover/bucket");
    await import("../../../src/components/aws/takeover/function");
  });

  beforeEach(() => pulumi.reset());

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name).sort();

  // Each case deploys the 4.x Bucket, then the same thing as the V5 one.
  // Everything the 4.x Bucket created has to be kept, with the same inputs.
  describe("takes over a deployed Bucket", () => {
    const cases: Record<string, OriginalBucketArgs & BucketArgs> = {
      "default bucket": {},
      "public access": { access: "public" },
      "cloudfront access": { access: "cloudfront" },
      "no cors": { cors: false },
      "custom cors": {
        cors: {
          allowOrigins: ["https://example.com"],
          allowMethods: ["GET"],
          maxAge: "1 day",
        },
      },
      versioning: { versioning: true },
      "http allowed": { enforceHttps: false },
      "policy statements": {
        policy: [
          {
            actions: ["s3:GetObject"],
            principals: "*",
            paths: ["/public/*"],
          },
          {
            effect: "deny",
            actions: ["s3:DeleteObject"],
            principals: [
              { type: "aws", identifiers: ["arn:aws:iam::123456789012:root"] },
            ],
            conditions: [
              {
                test: "StringEquals",
                variable: "aws:PrincipalTag/team",
                values: ["guests"],
              },
            ],
          },
        ],
      },
      "lifecycle rules": {
        lifecycle: [
          { prefix: "tmp/", expiresIn: "30 days" },
          { id: "Old", expiresAt: "2030-01-01", enabled: false },
        ],
      },
      transforms: {
        versioning: true,
        transform: {
          bucket: { bucket: "my-bucket", forceDestroy: false },
          cors: (args) => {
            args.expectedBucketOwner = "123456789012";
          },
          policy: { bucket: "my-bucket" },
          versioning: { mfa: "serial code" },
          publicAccessBlock: { blockPublicAcls: false },
        },
      },
    };

    const BUCKET = "aws:s3/bucket:Bucket::MyBucketBucket";
    // What goes is the component the 4.x Bucket wraps its notifications in,
    // which has nothing in AWS behind it. It's created with the bucket's own
    // options, so inside whatever the bucket is inside.
    const WRAPPER = "sst:aws:BucketNotification::MyBucketNotifications";
    const notify =
      (args: NotifyArgs) =>
      (Bucket: BucketClass, opts?: ComponentResourceOptions) =>
        new Bucket("MyBucket", {}, opts).notify(args);
    // The 4.x `Bucket.get` gives its options to the bucket it looks up and not
    // to the component, which is at the top of the app wherever it's asked to
    // be. V5's `get` puts the component where it's asked to, so the old one,
    // which has nothing in AWS behind it, goes.
    const leftAtTheTop = (way: TakeoverWay) =>
      way === "inside another component" ? ["sst:aws:Bucket::MyBucket"] : [];

    pulumi.takeoverCases({
      original: () => OriginalBucket,
      v5: () => Bucket,
      // A function that links the 4.x bucket waits for everything in it, its
      // CORS rules too, and so do the permission and the notification made
      // from the function. Nothing in AWS needs that: the CORS rules and the
      // notification configuration are each a setting of the bucket of their
      // own, removed with no regard to the other.
      needlessOrder:
        /^MyBucket(PermissionResizer|Notification) before MyBucketCors$/,
      cases: {
        ...Object.fromEntries(
          Object.entries(cases).map(([name, args]) => [
            name,
            (Bucket: BucketClass, opts?: ComponentResourceOptions) =>
              new Bucket("MyBucket", args, opts),
          ]),
        ),
        "every part of the bucket": {
          create: (Bucket, opts) =>
            new Bucket("MyBucket", { versioning: true, lifecycle: [{}] }, opts),
          check: () =>
            expect(
              names().filter((name) => name.startsWith("MyBucket")),
            ).toEqual([
              "MyBucket",
              "MyBucketBucket",
              "MyBucketCors",
              "MyBucketLifecycle",
              "MyBucketPolicy",
              "MyBucketPublicAccessBlock",
              "MyBucketVersioning",
            ]),
        },
        "no public access block": {
          original: (opts) =>
            new OriginalBucket(
              "MyBucket",
              { transform: { publicAccessBlock: false } },
              opts,
            ),
          v5: (opts) =>
            new Bucket("MyBucket", { publicAccessBlock: false }, opts),
          check: () =>
            expect(names()).not.toContain("MyBucketPublicAccessBlock"),
        },
        // 4.x's `get` looks the bucket up outside of the component. V5 looks
        // the same bucket up inside it, which this can't match: a lookup
        // has no aliases. Nothing is deployed for a lookup, so nothing is
        // deleted.
        "a bucket referenced with get": {
          create: (Bucket, opts) =>
            Bucket.get("MyBucket", "existing-bucket", opts),
          unclaimed: (way) => [BUCKET, ...leftAtTheTop(way)],
          check: () => {
            expect(resource("MyBucketBucket")).toMatchObject({
              kind: "read",
              options: { id: "existing-bucket" },
            });
            expect(
              names().filter((name) => name.startsWith("MyBucket")),
            ).toEqual(["MyBucket", "MyBucketBucket"]);
          },
        },
        "notifications to functions given as arns": {
          create: notify({
            notifications: [
              {
                name: "Resizer",
                function: FUNCTION_ARN,
                events: ["s3:ObjectCreated:*" as const],
                filterPrefix: "images/",
                filterSuffix: ".jpg",
              },
              { name: "Auditor", function: FUNCTION_ARN },
            ],
          }),
          unclaimed: [WRAPPER],
        },
        "a notification to a function created from a handler": {
          create: notify({
            notifications: [
              { name: "Resizer", function: "src/resize.handler" },
            ],
          }),
          unclaimed: [WRAPPER],
          // The function is kept. Its description is updated: it names the
          // bucket now, where it named the notification component.
          changed: [
            [
              "MyBucketNotificationsNotificationResizerFunction",
              ["description"],
            ],
          ],
          // The function and what it's made of are now inside the bucket
          check: () =>
            expect(
              names().filter((name) => name.startsWith("MyBucketSubscriber")),
            ).toEqual([
              "MyBucketSubscriberResizer",
              "MyBucketSubscriberResizerCode",
              "MyBucketSubscriberResizerFunction",
              "MyBucketSubscriberResizerLogGroup",
              "MyBucketSubscriberResizerRole",
            ]),
        },
        // A function's links go into its code, which the check compares, and
        // a subscriber that links its own bucket has to be created at all
        "a notification to a function that links the bucket": {
          create: (Bucket, opts) => {
            const bucket = new Bucket("MyBucket", {}, opts);
            return bucket.notify({
              notifications: [
                {
                  name: "Resizer",
                  function: { handler: "src/resize.handler", link: [bucket] },
                },
              ],
            } as NotifyArgs);
          },
          unclaimed: [WRAPPER],
          changed: [
            [
              "MyBucketNotificationsNotificationResizerFunction",
              ["description"],
            ],
          ],
          check: () =>
            expect(names()).toContain("MyBucketSubscriberResizerFunction"),
        },
        "eventBridge with a notification to a queue": {
          create: notify({
            eventBridge: true,
            notifications: [{ name: "Orders", queue: QUEUE_ARN }],
          }),
          unclaimed: [WRAPPER],
        },
        "eventBridge alone": {
          create: notify({ eventBridge: true }),
          unclaimed: [WRAPPER],
          check: () =>
            expect(resource("MyBucketNotification").inputs.eventbridge).toBe(
              true,
            ),
        },
        "notifications to a queue and a topic given as arns": {
          create: notify({
            notifications: [
              { name: "Orders", queue: QUEUE_ARN },
              {
                name: "Uploads",
                topic: TOPIC_ARN,
                events: ["s3:ObjectRemoved:*" as const],
              },
            ],
          }),
          unclaimed: [WRAPPER],
          check: () =>
            expect(
              resource("MyBucketQueuePolicyOrders").options.retainOnDelete,
            ).toBe(true),
        },
        "a function, a queue and a topic with the same name apart": {
          original: (opts) =>
            new OriginalBucket("MyBucket", {}, opts).notify({
              notifications: threeTargets,
              transform: { notification: { eventbridge: true } },
            }),
          v5: (opts) =>
            new Bucket(
              "MyBucket",
              { transform: { notification: { eventbridge: true } } },
              opts,
            ).notify({ notifications: threeTargets }),
          unclaimed: [WRAPPER],
        },
        "notifications to a queue and a topic given as components": {
          create: (Bucket, opts) =>
            new Bucket("MyBucket", {}, opts).notify({
              notifications: [
                { name: "Orders", queue: new SidedQueue("Orders") },
                { name: "Uploads", topic: new SidedSnsTopic("Uploads") },
              ],
            }),
          unclaimed: [WRAPPER],
        },
        "notifications of a bucket referenced with get": {
          create: (Bucket, opts) =>
            Bucket.get("MyBucket", "existing-bucket", opts).notify({
              notifications: [{ name: "Resizer", function: FUNCTION_ARN }],
            }),
          // The lookup, as above
          unclaimed: (way) => [BUCKET, WRAPPER, ...leftAtTheTop(way)],
          // The 4.x Bucket creates the notifications of a bucket referenced
          // with `get` with the app's provider. V5 creates them with the one
          // the bucket is looked up with, which replaces them.
          changed: (way) =>
            way === "with another provider"
              ? [
                  [
                    "MyBucketNotificationsNotificationResizerPermission",
                    ["options.provider"],
                  ],
                  ["MyBucketNotificationsNotification", ["options.provider"]],
                ]
              : [],
        },
      },
    });

    // `subscribe`, `subscribeQueue` and `subscribeTopic` are deprecated in
    // 4.x and gone from V5, where the subscriber becomes a
    // notification. These don't come over unchanged.
    describe("with a deprecated subscriber", () => {
      // The subscriber's name is made from the bucket's ARN
      const SUBSCRIBER = "MyBucketSubscriberZcfvxk";
      const notification = `${SUBSCRIBER}Notification`;
      // The notification configuration is kept and updated in place: a
      // notification is known by its name now, not by `Notification<hash>`.
      // The function and its permission are kept.
      it("a function: kept, and its notification is renamed", async () => {
        const { unclaimed, changed } = await pulumi.takesOver(
          () => new OriginalBucket("MyBucket").subscribe(FUNCTION_ARN),
          () =>
            new Bucket("MyBucket").notify({
              notifications: [{ name: "Resizer", function: FUNCTION_ARN }],
            }),
        );
        expect(unclaimed).toEqual([
          `sst:aws:BucketLambdaSubscriber::${SUBSCRIBER}`,
        ]);
        expect(changed.map((c) => c.name)).toEqual([notification]);
        // Nothing else about it changes
        const { original, now } = changed[0];
        expect(original.lambdaFunctions[0].id).toBe("NotificationZcfvxk");
        expect(now).toEqual({
          ...original,
          lambdaFunctions: [{ ...original.lambdaFunctions[0], id: "Resizer" }],
          queues: [],
          topics: [],
        });
      });

      it("a function created from a handler is kept", async () => {
        const result = await pulumi.takesOver(
          () => new OriginalBucket("MyBucket").subscribe("src/resize.handler"),
          () =>
            new Bucket("MyBucket").notify({
              notifications: [
                { name: "Resizer", function: "src/resize.handler" },
              ],
            }),
        );
        expect(result.unclaimed).toEqual([
          `sst:aws:BucketLambdaSubscriber::${SUBSCRIBER}`,
        ]);
        // The function's description is updated, and the notification's id
        expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
          [`${SUBSCRIBER}Function`, ["description"]],
          [notification, ["lambdaFunctions", "queues", "topics"]],
        ]);
        expect(names()).toContain("MyBucketSubscriberResizerRole");
      });

      // Two resources claiming the one subscriber would fail the deploy
      // (and `takesOver` here). With an ARN this is about the permission,
      // and with a handler about the function.
      it.each([FUNCTION_ARN, "src/resize.handler"])(
        "only the first function notification is the old subscriber: %s",
        async (fn) => {
          const { unclaimed } = await pulumi.takesOver(
            () => new OriginalBucket("MyBucket").subscribe(fn),
            () =>
              new Bucket("MyBucket").notify({
                notifications: [
                  { name: "Resizer", function: fn },
                  { name: "Auditor", function: fn },
                ],
              }),
          );
          expect(unclaimed).toEqual([
            `sst:aws:BucketLambdaSubscriber::${SUBSCRIBER}`,
          ]);
        },
      );

      // The queue's or topic's policy was created outside of the subscriber,
      // with no parent. It's kept too.
      it.each([
        ["queue", "sst:aws:BucketQueueSubscriber", { queue: QUEUE_ARN }],
        ["topic", "sst:aws:BucketTopicSubscriber", { topic: TOPIC_ARN }],
      ] as const)("a %s and its policy are kept", async (kind, wrapper, target) => {
        const { unclaimed, changed } = await pulumi.takesOver(
          () =>
            kind === "queue"
              ? new OriginalBucket("MyBucket").subscribeQueue(QUEUE_ARN)
              : new OriginalBucket("MyBucket").subscribeTopic(TOPIC_ARN),
          () =>
            new Bucket("MyBucket").notify({
              notifications: [{ name: "Orders", ...target }],
            }),
        );
        expect(unclaimed).toEqual([`${wrapper}::${SUBSCRIBER}`]);
        expect(changed.map((c) => c.name)).toEqual([notification]);
      });
    });

  });

  describe("policy", () => {
    const statements = () =>
      JSON.parse(resource("MyBucketPolicy").inputs.policy).statements;
    const ARN = "arn:aws:mock:us-east-1:123456789012:MyBucketBucket";

    it("denies requests that aren't over https by default", async () => {
      new Bucket("MyBucket");
      await pulumi.settle();

      expect(statements()).toEqual([
        {
          effect: "Deny",
          principals: [{ type: "*", identifiers: ["*"] }],
          actions: ["s3:*"],
          resources: [ARN, `${ARN}/*`],
          conditions: [
            { test: "Bool", variable: "aws:SecureTransport", values: ["false"] },
          ],
        },
      ]);
    });

    it("lets the public read a public bucket", async () => {
      new Bucket("MyBucket", { access: "public", enforceHttps: false });
      await pulumi.settle();

      expect(statements()).toEqual([
        {
          principals: [{ type: "*", identifiers: ["*"] }],
          actions: ["s3:GetObject"],
          resources: [`${ARN}/*`],
        },
      ]);
      expect(resource("MyBucketPublicAccessBlock").inputs).toMatchObject({
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      });
    });

    it("is created after the public access block", async () => {
      new Bucket("MyBucket");
      await pulumi.settle();

      expect(resource("MyBucketPolicy").options.dependencies).toContainEqual(
        expect.stringContaining("::MyBucketPublicAccessBlock"),
      );
    });
  });

  describe("public access block", () => {
    // Deleted with the bucket, the block isn't taken off first, so a bucket
    // being removed, or kept by `removal: "retain"`, keeps it.
    it("is deleted with its bucket", async () => {
      new Bucket("MyBucket");
      await pulumi.settle();

      const block = resource("MyBucketPublicAccessBlock").options;
      expect(block.deletedWith).toMatch(/::MyBucketBucket$/);
      expect(block.retainOnDelete).toBeUndefined();
    });

    it("lets a transform delete it on its own again", async () => {
      new Bucket("MyBucket", {
        transform: {
          publicAccessBlock: (_args, opts) => {
            opts.deletedWith = undefined;
          },
        },
      });
      await pulumi.settle();

      expect(
        resource("MyBucketPublicAccessBlock").options.deletedWith,
      ).toBeUndefined();
    });
  });

  it("makes what uses the bucket wait for its policy", async () => {
    const aws = await import("@pulumi/aws");
    const bucket = new Bucket("MyBucket");
    new aws.ssm.Parameter("BucketName", { type: "String", value: bucket.name });
    await pulumi.settle();

    const dependencies: string[] = resource("BucketName").options.dependencies;
    expect(dependencies.some((urn) => urn.endsWith("::MyBucketPolicy"))).toBe(
      true,
    );
  });

  describe("notify", () => {
    it("holds each notification's resources by its name", async () => {
      const bucket = new Bucket("MyBucket").notify({
        notifications: [
          { name: "Resizer", function: "src/resize.handler" },
          { name: "Auditor", function: FUNCTION_ARN },
          { name: "Orders", queue: QUEUE_ARN },
          { name: "Uploads", topic: TOPIC_ARN },
        ],
      });
      await pulumi.settle();

      expect(Object.keys(bucket.nodes.subscriber).sort()).toEqual([
        "Auditor",
        "Resizer",
      ]);
      expect(Object.keys(bucket.nodes.permission).sort()).toEqual([
        "Auditor",
        "Resizer",
      ]);
      expect(Object.keys(bucket.nodes.queuePolicy)).toEqual(["Orders"]);
      expect(Object.keys(bucket.nodes.topicPolicy)).toEqual(["Uploads"]);

      const fn = await new Promise<any>((done) =>
        bucket.nodes.subscriber.Resizer.apply(done),
      );
      expect(fn).toBeInstanceOf(
        (await import("../../../src/components/aws/function")).Function,
      );
    });

    it("puts every notification in one notification configuration", async () => {
      new Bucket("MyBucket").notify({
        notifications: [
          { name: "Resizer", function: FUNCTION_ARN },
          { name: "Auditor", function: FUNCTION_ARN },
          { name: "Orders", queue: QUEUE_ARN },
          { name: "Uploads", topic: TOPIC_ARN },
        ],
      });
      await pulumi.settle();

      const { inputs, options } = resource("MyBucketNotification");
      expect(inputs.lambdaFunctions.map((c: any) => c.id)).toEqual([
        "Resizer",
        "Auditor",
      ]);
      expect(inputs.queues).toMatchObject([{ id: "Orders", queueArn: QUEUE_ARN }]);
      expect(inputs.topics).toMatchObject([{ id: "Uploads", topicArn: TOPIC_ARN }]);
      expect(inputs.queues[0].events).toHaveLength(10);
      // It waits for what lets the bucket reach each target
      for (const name of [
        "MyBucketPermissionResizer",
        "MyBucketPermissionAuditor",
        "MyBucketQueuePolicyOrders",
        "MyBucketTopicPolicyUploads",
      ])
        expect(options.dependencies).toContainEqual(
          expect.stringContaining(`::${name}`),
        );
    });

    it("accepts V5 queue and topic components", async () => {
      const { Queue } = await import("../../../src/components/aws/queue");
      const { SnsTopic } = await import(
        "../../../src/components/aws/sns-topic"
      );
      new Bucket("MyBucket").notify({
        notifications: [
          { name: "Orders", queue: new Queue("Orders") },
          { name: "Uploads", topic: new SnsTopic("Uploads") },
        ],
      });
      await pulumi.settle();

      const { inputs } = resource("MyBucketNotification");
      expect(inputs.queues[0].queueArn).toBe(
        "arn:aws:mock:us-east-1:123456789012:OrdersQueue",
      );
      expect(inputs.topics[0].topicArn).toBe(
        "arn:aws:mock:us-east-1:123456789012:UploadsTopic",
      );
    });

    it("tells the bucket's transform which notification it is given", async () => {
      new Bucket("MyBucket", {
        transform: {
          notification: { eventbridge: true },
          permission: (args, _opts, _name, notification) => {
            if (notification === "Auditor") args.statementId = "audit";
          },
        },
      }).notify({
        notifications: [
          { name: "Resizer", function: FUNCTION_ARN },
          { name: "Auditor", function: FUNCTION_ARN },
        ],
      });
      await pulumi.settle();

      expect(resource("MyBucketNotification").inputs.eventbridge).toBe(true);
      expect(resource("MyBucketPermissionAuditor").inputs.statementId).toBe(
        "audit",
      );
      expect(
        resource("MyBucketPermissionResizer").inputs.statementId,
      ).toBeUndefined();
    });

    it("says where its transform goes", async () => {
      const bucket = new Bucket("MyBucket");
      await pulumi.settle();
      expect(() =>
        bucket.notify({ notifications: [], transform: {} } as any),
      ).toThrow(
        /"transform" isn't an option here. Use the "transform" of the "MyBucket" bucket/,
      );
    });

    it("can only be called once", async () => {
      const bucket = new Bucket("MyBucket").notify({
        notifications: [{ name: "Resizer", function: FUNCTION_ARN }],
      });
      await pulumi.settle();
      expect(() =>
        bucket.notify({
          notifications: [{ name: "Auditor", function: FUNCTION_ARN }],
        }),
      ).toThrow(
        /"notify" was already called on the "MyBucket" bucket. A bucket has one notification configuration/,
      );
    });

    it("needs notifications or EventBridge", () => {
      expect(() => new Bucket("MyBucket").notify({})).toThrow(
        /"notify" on the "MyBucket" bucket needs "notifications", or "eventBridge" set to true/,
      );
    });

    it("rejects a notification without one target, or a name used twice", async () => {
      const notify = (...notifications: any[]) => {
        const bucket = new Bucket("MyBucket");
        return () => bucket.notify({ notifications });
      };
      expect(notify({ name: "A" })).toThrow(
        'The "A" notification of the "MyBucket" bucket has none of "function", "queue" and "topic". Give it one.',
      );
      expect(
        notify({ name: "A", function: FUNCTION_ARN, queue: QUEUE_ARN }),
      ).toThrow(
        'The "A" notification of the "MyBucket" bucket has more than one of "function", "queue" and "topic".',
      );
      expect(
        notify(
          { name: "A", function: FUNCTION_ARN },
          { name: "A", queue: QUEUE_ARN },
        ),
      ).toThrow(/already has a notification named "A"/);
      await pulumi.settle();
    });

    it("needs its notifications as plain values", async () => {
      const { output } = await import("@pulumi/pulumi");
      const bucket = new Bucket("MyBucket");
      expect(() =>
        bucket.notify({ notifications: output([]) as any }),
      ).toThrow(/The "notifications" of the "MyBucket" bucket has to be a plain value/);
      expect(() =>
        bucket.notify({
          notifications: [{ name: output("A") as any, function: FUNCTION_ARN }],
        }),
      ).toThrow(/The "name" of each notification of the "MyBucket" bucket has to be a plain value/);
      await pulumi.settle();
    });

    // Whether a function is created is decided from what's given, which a
    // preview has to know. An ARN creates nothing, so it can be an output.
    it("takes a function in an output only as an ARN", async () => {
      const { output } = await import("@pulumi/pulumi");
      const bucket = new Bucket("MyBucket")
        .notify({
          eventBridge: true,
          notifications: [{ name: "Auditor", function: output(FUNCTION_ARN) }],
        })
        .subscribeEventBridge("Resizer", output(FUNCTION_ARN));
      await pulumi.settle();

      expect(
        pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
      ).toEqual([]);
      expect(Object.keys(bucket.nodes.permission)).toEqual(["Auditor"]);
      expect(Object.keys(bucket.nodes.eventBridgePermission)).toEqual([
        "Resizer",
      ]);
      expect(
        resource("MyBucketNotification").inputs.lambdaFunctions[0]
          .lambdaFunctionArn,
      ).toBe(FUNCTION_ARN);
      expect(resource("MyBucketEventBridgeTargetResizer").inputs.arn).toBe(
        FUNCTION_ARN,
      );
    });

    it("turns down a handler or args in an output", async () => {
      const { output } = await import("@pulumi/pulumi");
      const { plainFunction } = await import(
        "../../../src/components/aws/helpers/function-part"
      );
      const what = `The "function" of the "A" notification`;
      for (const given of [
        output("src/subscriber.handler"),
        output({ handler: "src/subscriber.handler" }) as any,
      ]) {
        // The error is thrown inside an apply. Handle the promises Pulumi
        // derives from the output too, or they're reported as unhandled.
        const out = plainFunction(given, what) as any;
        out.isKnown.catch(() => {});
        out.isSecret.catch(() => {});
        out.allResources?.().catch(() => {});
        await expect(out.promise()).rejects.toThrow(
          `${what} is an output that isn't a function or the ARN of one.`,
        );
      }
      // What's plain is passed on as it is
      const args = { handler: "src/subscriber.handler" };
      expect(plainFunction(args, what)).toBe(args);
      expect(plainFunction("src/subscriber.handler", what)).toBe(
        "src/subscriber.handler",
      );
    });

    it("refuses a handler or args in an output, and creates no function", async () => {
      const { output } = await import("@pulumi/pulumi");
      const errors = await applyErrors(
        () =>
          new Bucket("MyBucket")
            .notify({
              eventBridge: true,
              notifications: [
                { name: "Later", function: output("src/resize.handler") },
              ],
            })
            .subscribeEventBridge(
              "LaterArgs",
              output({ handler: "src/resize.handler" }) as any,
            ),
        pulumi.settle,
      );
      expect(
        pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
      ).toEqual([]);
      expect(errors).toContainEqual(
        expect.stringContaining(
          `The "function" of the "Later" notification of the "MyBucket" bucket is an output that isn't a function or the ARN of one.`,
        ),
      );
      expect(errors).toContainEqual(
        expect.stringContaining(
          `The EventBridge subscriber "LaterArgs" of the "MyBucket" bucket is an output that isn't a function or the ARN of one.`,
        ),
      );
    });

    it("takes a function you have, or an output of one", async () => {
      const { output } = await import("@pulumi/pulumi");
      const { Function } = await import(
        "../../../src/components/aws/function"
      );
      const { Workflow } = await import("../../../src/components/aws/workflow");
      const mine = new Function("Mine", { handler: "src/mine.handler" });
      const flow = new Workflow("Flow", { handler: "src/flow.handler" });
      new Bucket("MyBucket")
        .notify({
          eventBridge: true,
          notifications: [
            { name: "Mine", function: mine },
            { name: "Flow", function: flow },
            { name: "Later", function: output(mine) },
          ],
        })
        .subscribeEventBridge("Resizer", output(flow));
      await pulumi.settle();

      // No function of the bucket's own
      expect(
        names().filter((name) => /^MyBucket(EventBridge)?Subscriber/.test(name)),
      ).toEqual([]);
      const invoked = (permission: string) =>
        resource(permission).inputs.function;
      expect(invoked("MyBucketPermissionMine")).toMatch(/Mine/);
      expect(invoked("MyBucketPermissionLater")).toBe(
        invoked("MyBucketPermissionMine"),
      );
      expect(invoked("MyBucketPermissionFlow")).toMatch(/Flow/);
      expect(invoked("MyBucketEventBridgePermissionResizer")).toBe(
        invoked("MyBucketPermissionFlow"),
      );
    });

    it("takes a queue or a topic in an output", async () => {
      const { output } = await import("@pulumi/pulumi");
      const { Queue } = await import("../../../src/components/aws/queue");
      const { SnsTopic } = await import("../../../src/components/aws/sns-topic");
      const queue = new Queue("Orders");
      const topic = new SnsTopic("Uploads");
      new Bucket("MyBucket").notify({
        notifications: [
          { name: "Orders", queue: output(queue) as any },
          { name: "Uploads", topic: output(topic) as any },
        ],
      });
      await pulumi.settle();

      const { inputs } = resource("MyBucketNotification");
      expect(inputs.queues[0].queueArn).toMatch(/Orders/);
      expect(inputs.topics[0].topicArn).toMatch(/Uploads/);
    });

    // A subscriber that links its own bucket, a function given by its ARN in
    // an output, and the rest: `bucket-preview.test.ts` runs the same as a
    // new stage's preview, which has to plan all of it
    it("creates what a new stage's preview plans", async () => {
      const { EVERY_PART, everyPart } = await import("./bucket-every-part");
      await everyPart();
      await pulumi.settle();
      expect(names()).toEqual(EVERY_PART);
    });
  });

  describe("args", () => {
    it("needs the ones that decide what's created as plain values", async () => {
      const { output } = await import("@pulumi/pulumi");
      for (const arg of ["versioning", "cors", "lifecycle", "publicAccessBlock"])
        expect(
          () => new Bucket("MyBucket", { [arg]: output(false) as any }),
        ).toThrow(
          new RegExp(`The "${arg}" of the "MyBucket" bucket has to be a plain value`),
        );
      await pulumi.settle();
    });

    it("takes cors: true as the default configuration", async () => {
      new Bucket("MyBucket", { cors: true });
      await pulumi.settle();
      expect(resource("MyBucketCors").inputs.corsRules).toEqual([
        {
          allowedHeaders: ["*"],
          allowedMethods: ["DELETE", "GET", "HEAD", "POST", "PUT"],
          allowedOrigins: ["*"],
          exposeHeaders: ["ETag"],
          maxAgeSeconds: 0,
        },
      ]);
    });

    it("says where the options that are gone went", async () => {
      expect(() => new Bucket("MyBucket", { public: true } as any)).toThrow(
        /"public" isn't an option for the "MyBucket" bucket. Use "access" instead/,
      );
      expect(
        () =>
          new Bucket("MyBucket", {
            transform: { publicAccessBlock: false },
          } as any),
      ).toThrow(/To not create one, set "publicAccessBlock" to false/);
      await pulumi.settle();
    });
  });

  describe("an existing bucket", () => {
    it("is used the way it is", async () => {
      const bucket = Bucket.get("MyBucket", "existing-bucket");
      await pulumi.settle();

      expect(names()).toEqual(["MyBucket", "MyBucketBucket"]);
      expect(resource("MyBucketBucket").kind).toBe("read");
      expect(bucket.nodes.policy).toBeUndefined();
      expect(await new Promise((done) => bucket.name.apply(done))).toBe(
        "existing-bucket",
      );
    });

    it("can't be configured", async () => {
      expect(
        () =>
          new Bucket("MyBucket", {
            existing: { bucket: "existing-bucket" },
            cors: false,
            versioning: true,
          }),
      ).toThrow(
        /is given an existing "bucket", which it uses the way it is. Remove "cors", "versioning"/,
      );
      await pulumi.settle();
    });

    // A `$transform` for every bucket runs on one from `get` too, and isn't
    // meant for it
    it("leaves what a $transform sets on one from get", async () => {
      const { $transform } = await import("../../../src/components/component");
      $transform(Bucket, (args, _opts, name) => {
        if (name === "Shared") args!.versioning = true;
      });
      Bucket.get("Shared", "existing-bucket");
      await pulumi.settle();
      expect(resource("SharedBucket").kind).toBe("read");
    });
  });

  it("says what to write in place of SST 4's subscribe methods", () => {
    const bucket = new Bucket("MyBucket") as any;
    expect(() => bucket.subscribe("src/subscriber.handler")).toThrow(
      /"subscribe" isn't a method of the "MyBucket" bucket. Notify the function with "notify"/,
    );
    expect(() => bucket.subscribeQueue(QUEUE_ARN)).toThrow(
      /notifications: \[\{ name: "MyQueue", queue \}\]/,
    );
    expect(() => bucket.subscribeTopic(QUEUE_ARN)).toThrow(
      /notifications: \[\{ name: "MyTopic", topic \}\]/,
    );
    const Static = Bucket as any;
    for (const method of ["subscribe", "subscribeQueue", "subscribeTopic"])
      expect(() => Static[method]("arn:aws:s3:::shared", QUEUE_ARN)).toThrow(
        /reference (it|the bucket) with "get" and call "notify" on that: sst\.aws\.Bucket\.get\(/,
      );
    expect(() =>
      Static.subscribeEventBridge("Resizer", "shared", FUNCTION_ARN),
    ).toThrow(/"subscribeEventBridge" is a method of the bucket/);
  });

  it("gives a transform function plain values from a plain config, as SST 4 did", async () => {
    let origins: any, rules: any;
    new Bucket("MyBucket", {
      cors: { allowOrigins: ["https://example.com"] },
      lifecycle: [{ id: "tmp", prefix: "tmp/", expiresIn: "1 day" }],
      transform: {
        cors: (args) => {
          origins = (args.corsRules as any[])[0].allowedOrigins;
        },
        lifecycle: (args) => {
          rules = args.rules;
        },
      },
    });
    await pulumi.settle();

    expect(origins).toEqual(["https://example.com"]);
    expect(rules).toEqual([
      {
        id: "tmp",
        status: "Enabled",
        expiration: { days: 1, date: undefined },
        filter: { prefix: "tmp/" },
      },
    ]);
  });

  it("names the bucket when a lifecycle rule's id is wrong", async () => {
    const { output } = await import("@pulumi/pulumi");
    // Rules given as plain values are checked right away
    expect(
      () =>
        new Bucket("MyBucket", {
          lifecycle: [
            { id: "same", expiresIn: "1 day" },
            { id: "same", expiresIn: "2 days" },
          ],
        }),
    ).toThrow(
      'Lifecycle rules 0 and 1 of the "MyBucket" bucket have the same "id", "same".',
    );
    // and one with an output in it once it resolves
    const errors = await applyErrors(() => {
      new Bucket("Other", {
        lifecycle: [{ id: output(" "), expiresIn: "1 day" }],
      });
    }, pulumi.settle);
    expect(errors).toContainEqual(
      expect.stringContaining(
        'Lifecycle rule 0 of the "Other" bucket has an empty "id".',
      ),
    );
  });

  it("links with its name and permission to use the bucket", async () => {
    const { Link } = await import("../../../src/components/link");
    const bucket = new Bucket("MyBucket");
    await pulumi.settle();

    expect(Link.isLinkable(bucket)).toBe(true);
    const definition = (bucket as any).getSSTLink();
    expect(Object.keys(definition.properties)).toEqual(["name"]);
    expect(definition.include).toMatchObject([
      { type: "aws.permission", actions: ["s3:*"] },
    ]);
    const resources = await new Promise<string[]>((done) =>
      $util
        .all(definition.include[0].resources as $util.Input<string>[])
        .apply(done),
    );
    expect(resources).toEqual([
      "arn:aws:mock:us-east-1:123456789012:MyBucketBucket",
      "arn:aws:mock:us-east-1:123456789012:MyBucketBucket/*",
    ]);
  });

  // The 4.x static `subscribeEventBridge` keeps each subscription in a
  // component at the top of the app, named after the bucket's own name
  describe("subscribeEventBridge", () => {
    const pattern = {
      detailType: ["Object Created"],
      detail: { object: { key: [{ prefix: "uploads/" }] } },
    };
    const BUS_SUBSCRIBER = /^sst:aws:BusLambdaSubscriber::\w+EventBridgeSubscriberResizer$/;
    const DEFAULT_BUS = /^aws:cloudwatch\/eventBus:EventBus::\w+EventBridgeSubscriberResizerDefaultBus$/;

    it("takes over a subscriber of a bucket in the app", async () => {
      const result = await pulumi.takesOver(
        () => {
          const bucket = new OriginalBucket("MyBucket");
          OriginalBucket.subscribeEventBridge("Resizer", bucket.name, FUNCTION_ARN, {
            pattern,
          });
        },
        () =>
          new Bucket("MyBucket").subscribeEventBridge("Resizer", FUNCTION_ARN, {
            pattern,
          }),
      );
      // What goes: the subscriber component and the default bus 4.x looked
      // up, which have nothing in AWS behind them
      expect(result.unclaimed).toHaveLength(2);
      expect(result.unclaimed.some((u) => BUS_SUBSCRIBER.test(u))).toBe(true);
      expect(result.unclaimed.some((u) => DEFAULT_BUS.test(u))).toBe(true);
      expect(result.changed).toEqual([]);
    });

    it("takes over a subscriber of a bucket that isn't in the app", async () => {
      const result = await pulumi.takesOver(
        () =>
          OriginalBucket.subscribeEventBridge(
            "Resizer",
            "my-uploads",
            "src/resize.handler",
          ),
        () =>
          Bucket.get("Uploads", "my-uploads").subscribeEventBridge(
            "Resizer",
            "src/resize.handler",
          ),
      );
      expect(result.unclaimed).toEqual([
        "aws:cloudwatch/eventBus:EventBus::MyuploadsEventBridgeSubscriberResizerDefaultBus",
        "sst:aws:BusLambdaSubscriber::MyuploadsEventBridgeSubscriberResizer",
      ]);
      expect(result.changed).toEqual([]);
    });

    it("matches only the bucket's own events", async () => {
      Bucket.get("Uploads", "my-uploads").subscribeEventBridge(
        "Resizer",
        FUNCTION_ARN,
        { pattern: { detail: { bucket: { region: ["us-east-1"] } } } },
      );
      await pulumi.settle();

      const rule = pulumi.resources.find(
        (r) => r.name === "UploadsEventBridgeRuleResizer",
      )!;
      expect(JSON.parse(rule.inputs.eventPattern)).toEqual({
        source: ["aws.s3"],
        detail: { bucket: { region: ["us-east-1"], name: ["my-uploads"] } },
      });
      expect(rule.inputs.eventBusName).toBe("default");
    });

    it("refuses a subscriber's transform, and a name used twice", () => {
      const bucket = new Bucket("MyBucket").subscribeEventBridge(
        "Resizer",
        FUNCTION_ARN,
      );
      expect(() =>
        bucket.subscribeEventBridge("Other", FUNCTION_ARN, {
          transform: {},
        } as any),
      ).toThrow(/its "eventBridgeRule" and "eventBridgeTarget" apply/);
      expect(() => bucket.subscribeEventBridge("Resizer", FUNCTION_ARN)).toThrow();
    });
  });
});
