import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

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

type BucketArgs = import("../../src/components/aws/bucket").BucketArgs;
type BucketV5Args = import("../../src/components/aws/bucket-v5").BucketV5Args;

describe("BucketV5", () => {
  let Bucket: typeof import("../../src/components/aws/bucket").Bucket;
  let BucketV5: typeof import("../../src/components/aws/bucket-v5").BucketV5;

  beforeAll(async () => {
    Bucket = (await import("../../src/components/aws/bucket")).Bucket;
    BucketV5 = (await import("../../src/components/aws/bucket-v5")).BucketV5;
    await import("../../src/components/aws/takeover/bucket");
    await import("../../src/components/aws/takeover/function");
  });

  beforeEach(() => pulumi.reset());

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name).sort();

  // Each case deploys a Bucket, then the same thing as a BucketV5. Everything
  // the Bucket created has to be kept, with the same inputs.
  describe("takes over a deployed Bucket", () => {
    const cases: Record<string, BucketArgs & BucketV5Args> = {
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

    it.each(Object.entries(cases))("%s", async (_, args) => {
      expect(
        await pulumi.takesOver(
          () => new Bucket("MyBucket", args),
          () => new BucketV5("MyBucket", args),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    it("every part of the bucket", async () => {
      await pulumi.takesOver(
        () => new Bucket("MyBucket", { versioning: true, lifecycle: [{}] }),
        () => new BucketV5("MyBucket", { versioning: true, lifecycle: [{}] }),
      );
      expect(names()).toEqual([
        "MyBucket",
        "MyBucketBucket",
        "MyBucketCors",
        "MyBucketLifecycle",
        "MyBucketPolicy",
        "MyBucketPublicAccessBlock",
        "MyBucketVersioning",
      ]);
    });

    it("no public access block", async () => {
      expect(
        await pulumi.takesOver(
          () =>
            new Bucket("MyBucket", { transform: { publicAccessBlock: false } }),
          () => new BucketV5("MyBucket", { publicAccessBlock: false }),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
      expect(names()).not.toContain("MyBucketPublicAccessBlock");
    });

    // Bucket.get looks the bucket up outside of the component. BucketV5 looks
    // the same bucket up inside it, which this can't match: a lookup has no
    // aliases. Nothing is deployed for a lookup, so nothing is deleted.
    it("a bucket referenced with get", async () => {
      expect(
        await pulumi.takesOver(
          () => Bucket.get("MyBucket", "existing-bucket"),
          () => BucketV5.get("MyBucket", "existing-bucket"),
        ),
      ).toEqual({ unclaimed: ["aws:s3/bucket:Bucket::MyBucketBucket"], changed: [] });
      expect(resource("MyBucketBucket")).toMatchObject({
        kind: "read",
        options: { id: "existing-bucket" },
      });
      expect(names()).toEqual(["MyBucket", "MyBucketBucket"]);
    });

    // What goes is the component Bucket wraps its notifications in, which has
    // nothing in AWS behind it.
    describe("with notifications", () => {
      const WRAPPER = "sst:aws:BucketNotification::MyBucketNotifications";

      it("functions given as arns", async () => {
        const args = {
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
        };
        expect(
          await pulumi.takesOver(
            () => new Bucket("MyBucket").notify(args),
            () => new BucketV5("MyBucket").notify(args),
          ),
        ).toEqual({ unclaimed: [WRAPPER], changed: [] });
      });

      it("a function created from a handler", async () => {
        const args = {
          notifications: [{ name: "Resizer", function: "src/resize.handler" }],
        };
        const result = await pulumi.takesOver(
          () => new Bucket("MyBucket").notify(args),
          () => new BucketV5("MyBucket").notify(args),
        );
        expect(result.unclaimed).toEqual([WRAPPER]);
        // The function is kept. Its description is updated: it names the
        // bucket now, where it named the notification component.
        expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
          ["MyBucketNotificationsNotificationResizerFunction", ["description"]],
        ]);
        // The function and what it's made of are now inside the bucket
        expect(
          names().filter((name) => name.startsWith("MyBucketSubscriber")),
        ).toEqual([
          "MyBucketSubscriberResizer",
          "MyBucketSubscriberResizerCode",
          "MyBucketSubscriberResizerFunction",
          "MyBucketSubscriberResizerLogGroup",
          "MyBucketSubscriberResizerRole",
        ]);
      });

      it("a queue and a topic given as arns", async () => {
        const args = {
          notifications: [
            { name: "Orders", queue: QUEUE_ARN },
            {
              name: "Uploads",
              topic: TOPIC_ARN,
              events: ["s3:ObjectRemoved:*" as const],
            },
          ],
        };
        expect(
          await pulumi.takesOver(
            () => new Bucket("MyBucket").notify(args),
            () => new BucketV5("MyBucket").notify(args),
          ),
        ).toEqual({ unclaimed: [WRAPPER], changed: [] });
        expect(resource("MyBucketQueuePolicyOrders").options.retainOnDelete).toBe(
          true,
        );
      });

      it("a function, a queue and a topic with the same name apart", async () => {
        const args = {
          notifications: [
            { name: "A", function: FUNCTION_ARN },
            { name: "B", queue: QUEUE_ARN },
            { name: "C", topic: TOPIC_ARN },
          ],
          transform: { notification: { eventbridge: true } },
        };
        const { transform, notifications } = args;
        expect(
          await pulumi.takesOver(
            () => new Bucket("MyBucket").notify(args),
            () =>
              new BucketV5("MyBucket", { transform }).notify({ notifications }),
          ),
        ).toEqual({ unclaimed: [WRAPPER], changed: [] });
      });

      it("a queue and a topic given as components", async () => {
        const { Queue } = await import("../../src/components/aws/queue");
        const { SnsTopic } = await import("../../src/components/aws/sns-topic");
        const notifications = () => [
          { name: "Orders", queue: new Queue("Orders") },
          { name: "Uploads", topic: new SnsTopic("Uploads") },
        ];
        expect(
          await pulumi.takesOver(
            () =>
              new Bucket("MyBucket").notify({ notifications: notifications() }),
            () =>
              new BucketV5("MyBucket").notify({
                notifications: notifications(),
              }),
          ),
        ).toEqual({ unclaimed: [WRAPPER], changed: [] });
      });

      it("on a bucket referenced with get", async () => {
        const args = {
          notifications: [{ name: "Resizer", function: FUNCTION_ARN }],
        };
        expect(
          await pulumi.takesOver(
            () => Bucket.get("MyBucket", "existing-bucket").notify(args),
            () => BucketV5.get("MyBucket", "existing-bucket").notify(args),
          ),
        ).toEqual({
          // The lookup, as above
          unclaimed: ["aws:s3/bucket:Bucket::MyBucketBucket", WRAPPER],
          changed: [],
        });
      });
    });

    // `subscribe`, `subscribeQueue` and `subscribeTopic` are deprecated in
    // Bucket and gone from BucketV5, where the subscriber becomes a
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
          () => new Bucket("MyBucket").subscribe(FUNCTION_ARN),
          () =>
            new BucketV5("MyBucket").notify({
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
          () => new Bucket("MyBucket").subscribe("src/resize.handler"),
          () =>
            new BucketV5("MyBucket").notify({
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
            () => new Bucket("MyBucket").subscribe(fn),
            () =>
              new BucketV5("MyBucket").notify({
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
              ? new Bucket("MyBucket").subscribeQueue(QUEUE_ARN)
              : new Bucket("MyBucket").subscribeTopic(TOPIC_ARN),
          () =>
            new BucketV5("MyBucket").notify({
              notifications: [{ name: "Orders", ...target }],
            }),
        );
        expect(unclaimed).toEqual([`${wrapper}::${SUBSCRIBER}`]);
        expect(changed.map((c) => c.name)).toEqual([notification]);
      });
    });

    // `notify()` created its component with the bucket's own options, so
    // inside whatever the bucket is inside.
    it("notifications of a bucket inside another component", async () => {
      const { ComponentResource } = await import("@pulumi/pulumi");
      const notifications = [
        { name: "Resizer", function: FUNCTION_ARN },
        { name: "Orders", queue: QUEUE_ARN },
      ];
      expect(
        await pulumi.takesOver(
          () => {
            const parent = new ComponentResource("acme:Storage", "Storage");
            new Bucket("MyBucket", {}, { parent }).notify({ notifications });
          },
          () => {
            const parent = new ComponentResource("acme:Storage", "Storage");
            new BucketV5("MyBucket", {}, { parent }).notify({ notifications });
          },
        ),
      ).toEqual({
        unclaimed: ["sst:aws:BucketNotification::MyBucketNotifications"],
        changed: [],
      });
    });
  });

  describe("policy", () => {
    const statements = () =>
      JSON.parse(resource("MyBucketPolicy").inputs.policy).statements;
    const ARN = "arn:aws:mock:us-east-1:123456789012:MyBucketBucket";

    it("denies requests that aren't over https by default", async () => {
      new BucketV5("MyBucket");
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
      new BucketV5("MyBucket", { access: "public", enforceHttps: false });
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
      new BucketV5("MyBucket");
      await pulumi.settle();

      expect(resource("MyBucketPolicy").options.dependencies).toContainEqual(
        expect.stringContaining("::MyBucketPublicAccessBlock"),
      );
    });
  });

  it("makes what uses the bucket wait for its policy", async () => {
    const aws = await import("@pulumi/aws");
    const bucket = new BucketV5("MyBucket");
    new aws.ssm.Parameter("BucketName", { type: "String", value: bucket.name });
    await pulumi.settle();

    const dependencies: string[] = resource("BucketName").options.dependencies;
    expect(dependencies.some((urn) => urn.endsWith("::MyBucketPolicy"))).toBe(
      true,
    );
  });

  describe("notify", () => {
    it("holds each notification's resources by its name", async () => {
      const bucket = new BucketV5("MyBucket").notify({
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
      expect(fn.constructor.name).toBe("FunctionV5");
    });

    it("puts every notification in one notification configuration", async () => {
      new BucketV5("MyBucket").notify({
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
      const { QueueV5 } = await import("../../src/components/aws/queue-v5");
      const { SnsTopicV5 } = await import(
        "../../src/components/aws/sns-topic-v5"
      );
      new BucketV5("MyBucket").notify({
        notifications: [
          { name: "Orders", queue: new QueueV5("Orders") },
          { name: "Uploads", topic: new SnsTopicV5("Uploads") },
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
      new BucketV5("MyBucket", {
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
      const bucket = new BucketV5("MyBucket");
      await pulumi.settle();
      expect(() =>
        bucket.notify({ notifications: [], transform: {} } as any),
      ).toThrow(
        /"transform" isn't an option here. Use the "transform" of the "MyBucket" bucket/,
      );
    });

    it("can only be called once", async () => {
      const bucket = new BucketV5("MyBucket").notify({
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
        const bucket = new BucketV5("MyBucket");
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
      const bucket = new BucketV5("MyBucket");
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
          () => new BucketV5("MyBucket", { [arg]: output(false) as any }),
        ).toThrow(
          new RegExp(`The "${arg}" of the "MyBucket" bucket has to be a plain value`),
        );
      await pulumi.settle();
    });

    it("says where the options that are gone went", async () => {
      expect(() => new BucketV5("MyBucket", { public: true } as any)).toThrow(
        /"public" isn't an option here. Use "access" instead/,
      );
      expect(
        () =>
          new BucketV5("MyBucket", {
            transform: { publicAccessBlock: false },
          } as any),
      ).toThrow(/To not create one, set "publicAccessBlock" to false/);
      await pulumi.settle();
    });
  });

  describe("an existing bucket", () => {
    it("is used the way it is", async () => {
      const bucket = BucketV5.get("MyBucket", "existing-bucket");
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
          new BucketV5("MyBucket", {
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
    const { Link } = await import("../../src/components/link");
    const bucket = new BucketV5("MyBucket");
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
