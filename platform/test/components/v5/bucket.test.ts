import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { mockPulumi, type TakeoverWay } from "../../helpers/graph";

// A policy document is worked out by AWS. Here it's the statements it's given,
// so two policies compare equal when their statements are the same. A bucket
// that's looked up is named what it was looked up by.
const pulumi = mockPulumi({
  state: (args) =>
    args.type === "aws:s3/bucket:Bucket" && args.id ? { bucket: args.id } : {},
  call: (args) =>
    args.token === "aws:iam/getPolicyDocument:getPolicyDocument"
      ? { json: JSON.stringify(sorted(args.inputs)) }
      : undefined,
});

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
  | typeof import("../../../src/components/aws/bucket").Bucket
  | typeof import("../../../src/components/aws/v5/bucket").Bucket;
type OriginalBucketArgs = import("../../../src/components/aws/bucket").BucketArgs;
type NotifyArgs = Parameters<
  import("../../../src/components/aws/bucket").Bucket["notify"]
>[0] &
  Parameters<import("../../../src/components/aws/v5/bucket").Bucket["notify"]>[0];
type BucketArgs = import("../../../src/components/aws/v5/bucket").BucketArgs;

describe("Bucket", () => {
  let OriginalBucket: typeof import("../../../src/components/aws/bucket").Bucket;
  let Bucket: typeof import("../../../src/components/aws/v5/bucket").Bucket;
  let OriginalQueue: typeof import("../../../src/components/aws/queue").Queue;
  let OriginalSnsTopic: typeof import("../../../src/components/aws/sns-topic").SnsTopic;

  beforeAll(async () => {
    OriginalQueue = (await import("../../../src/components/aws/queue")).Queue;
    OriginalSnsTopic = (await import("../../../src/components/aws/sns-topic")).SnsTopic;
    OriginalBucket = (await import("../../../src/components/aws/bucket")).Bucket;
    Bucket = (await import("../../../src/components/aws/v5/bucket")).Bucket;
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
                { name: "Orders", queue: new OriginalQueue("Orders") },
                { name: "Uploads", topic: new OriginalSnsTopic("Uploads") },
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
          [`${SUBSCRIBER}FunctionFunction`, ["description"]],
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
      expect((fn.constructor as any).__pulumiType).toBe("sst:aws:FunctionV5");
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
      const { Queue } = await import("../../../src/components/aws/v5/queue");
      const { SnsTopic } = await import(
        "../../../src/components/aws/v5/sns-topic"
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
      ).toThrow(/Cannot call "notify" on the "MyBucket" bucket multiple times/);
    });

    it("rejects a notification without one target, or a name used twice", async () => {
      const notify = (...notifications: any[]) => {
        const bucket = new Bucket("MyBucket");
        return () => bucket.notify({ notifications });
      };
      expect(notify({ name: "A" })).toThrow(
        /At least one of function, queue, or topic is required for the "A"/,
      );
      expect(
        notify({ name: "A", function: FUNCTION_ARN, queue: QUEUE_ARN }),
      ).toThrow(/Only one of function, queue, or topic is allowed for the "A"/);
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

    it("says where the options that are gone went", async () => {
      expect(() => new Bucket("MyBucket", { public: true } as any)).toThrow(
        /"public" isn't an option here. Use "access" instead/,
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
});
