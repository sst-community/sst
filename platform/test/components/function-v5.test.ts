import fs from "fs";
import os from "os";
import path from "path";
import * as aws from "@pulumi/aws";
import { ComponentResource, output } from "@pulumi/pulumi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

const ROLE = "aws:iam/role:Role";
const LAMBDA = "aws:lambda/function:Function";
const LOG_GROUP = "aws:cloudwatch/logGroup:LogGroup";
const ROLE_ARN = "arn:aws:iam::123456789012:role/my-role";
const DISTRIBUTION_ARN = "arn:aws:cloudfront::123456789012:distribution/E123";

// Two source maps, for the function that's built with them
const maps = fs.mkdtempSync(path.join(os.tmpdir(), "sst-test-maps-"));
const SOURCEMAPS = ["index.mjs.map", "chunk.mjs.map"].map((file) => {
  fs.writeFileSync(path.join(maps, file), "{}");
  return path.join(maps, file);
});

const pulumi = mockPulumi({
  state: (args) => {
    // A resource that's looked up has the name and ARN it has
    if (args.type === ROLE && args.id)
      return { arn: `arn:aws:iam::123456789012:role/${args.id}` };
    if (args.type === LOG_GROUP && args.id) return { name: args.id };
    if (args.type === LAMBDA) {
      const arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.name}`;
      return {
        ...(args.id ? { name: args.id } : {}),
        arn,
        version: "3",
        qualifiedArn: `${arn}:3`,
      };
    }
    if (args.type === "aws:lambda/functionUrl:FunctionUrl")
      return { functionUrl: `https://${args.name.toLowerCase()}.lambda-url.on.aws/` };
    return {};
  },
  sourcemaps: (id) => (id === "Mapped" ? SOURCEMAPS : []),
});

type FunctionArgs = import("../../src/components/aws/function").FunctionArgs;
type FunctionV5Args =
  import("../../src/components/aws/function-v5").FunctionV5Args;
type Router = import("../../src/components/aws/router").Router;

// What a function reads from the router its URL is behind
class FakeRouter extends ComponentResource {
  _hasInlineRoutes = output(false);
  _kvNamespace = output("ns");
  _kvStoreArn = output("arn:aws:cloudfront::123456789012:key-value-store/kv");
  _distributionArn = output(DISTRIBUTION_ARN);
  url = output("https://router.example.com");
  nodes = { cdn: { nodes: { distribution: { id: output("E123") } } } };
  _protection;

  constructor(mode: "none" | "oac") {
    super("test:Router", "MyRouter");
    this._protection = output({ mode });
  }
}
const router = (mode: "none" | "oac") =>
  new FakeRouter(mode) as unknown as Router;

describe("FunctionV5", () => {
  let Function: typeof import("../../src/components/aws/function").Function;
  let FunctionV5: typeof import("../../src/components/aws/function-v5").FunctionV5;
  let permission: typeof import("../../src/components/aws/permission").permission;

  beforeAll(async () => {
    Function = (await import("../../src/components/aws/function")).Function;
    FunctionV5 = (await import("../../src/components/aws/function-v5"))
      .FunctionV5;
    permission = (await import("../../src/components/aws/permission")).permission;
    await import("../../src/components/aws/takeover/function");
  });

  beforeEach(() => {
    pulumi.reset();
    Function.reset();
    // @ts-ignore
    global.$dev = false;
  });

  // Each case deploys a Function, then the same thing as a FunctionV5.
  // Everything the Function created has to be kept by the FunctionV5, with
  // the same inputs.
  describe("takes over a deployed Function", () => {
    const handler = "src/index.handler";
    const sameArgs: Record<string, () => FunctionArgs & FunctionV5Args> = {
      "a handler": () => ({ handler }),
      "every setting": () => ({
        handler,
        name: "my-function",
        description: "Does things",
        runtime: "nodejs22.x",
        architecture: "arm64",
        timeout: "3 minutes",
        memory: "2048 MB",
        storage: "1 GB",
        environment: { DEBUG: "true" },
        permissions: [{ actions: ["s3:*"], resources: ["*"] }],
        policies: ["arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"],
        layers: ["arn:aws:lambda:us-east-1:123456789012:layer:my-layer:1"],
        tags: { team: "platform" },
        retries: 1,
        versioning: true,
        concurrency: { provisioned: 2, reserved: 10 },
        logging: { retention: "1 week", format: "json" },
        nodejs: { install: ["sharp"] },
      }),
      "no logging": () => ({ handler, logging: false }),
      "a url": () => ({ handler, url: true }),
      "a url with iam authorization and cors": () => ({
        handler,
        streaming: true,
        url: {
          authorization: "iam",
          cors: { allowOrigins: ["https://example.com"], maxAge: "1 day" },
        },
      }),
      "a url without cors": () => ({ handler, url: { cors: false } }),
      "a url behind a router": () => ({
        handler,
        url: {
          router: {
            instance: router("none"),
            path: "/api",
            readTimeout: "10 seconds",
          },
        },
      }),
      "a url behind a router that signs its requests": () => ({
        handler,
        url: { router: { instance: router("oac"), domain: "api.example.com" } },
      }),
      "a url with iam authorization behind a router": () => ({
        handler,
        url: { authorization: "iam", router: { instance: router("none") } },
      }),
      "a durable function with a url": () => ({
        handler,
        durable: { timeout: "1 day" },
        url: true,
      }),
      "a vpc and a volume": () => ({
        handler,
        vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] },
        volume: {
          efs: "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-1",
        },
      }),
      "a python container": () => ({
        handler: "functions/src/functions/api.handler",
        runtime: "python3.12",
        python: { container: true },
      }),
      "a python container without the build cache": () => ({
        handler: "functions/src/functions/api.handler",
        runtime: "python3.12",
        python: { container: { cache: false } },
      }),
      "a go function": () => ({ handler: "./src", runtime: "go" }),
      "injections around a streaming handler": () => ({
        handler,
        streaming: true,
        injections: ["outer:import x from 'x';", "  x();"],
      }),
      transforms: () => ({
        handler,
        retries: 0,
        transform: {
          function: { tracingConfig: { mode: "Active" } },
          role: (args: any): undefined => {
            args.path = "/custom/";
          },
          logGroup: { retentionInDays: 3 },
          eventInvokeConfig: { maximumEventAgeInSeconds: 60 },
        },
      }),
    };

    for (const [name, args] of Object.entries(sameArgs)) {
      it(name, async () => {
        await pulumi.expectTakeover(
          () => new Function("MyFunction", args()),
          () => new FunctionV5("MyFunction", args()),
        );
      });
    }

    it("linked resources and copied files", async () => {
      const { Linkable } = await import("../../src/components/linkable");
      const args = () => ({
        handler,
        link: [
          new Linkable("MyLink", {
            properties: { value: "linked" },
            include: [
              permission({ actions: ["sqs:SendMessage"], resources: ["*"] }),
              { type: "environment" as const, env: { LINKED: "yes" } },
            ],
          }),
        ],
        copyFiles: [{ from: maps, to: "maps" }],
      });
      await pulumi.expectTakeover(
        () => new Function("MyFunction", args()),
        () => new FunctionV5("MyFunction", args()),
      );
      const role = pulumi.resources.find((r) => r.type === ROLE)!;
      expect(role.inputs.inlinePolicies[0].policy).toContain("sqs:SendMessage");
      const fn = pulumi.resources.find((r) => r.type === LAMBDA)!;
      expect(fn.inputs.environment.variables.LINKED).toBe("yes");
    });

    it("source maps", async () => {
      await pulumi.expectTakeover(
        () => new Function("Mapped", { handler }),
        () => new FunctionV5("Mapped", { handler }),
      );
      expect(
        pulumi.resources
          .filter((r) => r.name.startsWith("MappedSourcemap"))
          .map((r) => [r.name, r.options.retainOnDelete]),
      ).toEqual([
        ["MappedSourcemap0", true],
        ["MappedSourcemap1", true],
      ]);
    });

    it("environment variables added later", async () => {
      await pulumi.expectTakeover(
        () => new Function("MyFunction", { handler }).addEnvironment({ A: "1" }),
        () =>
          new FunctionV5("MyFunction", { handler }).addEnvironment({ A: "1" }),
      );
    });

    // `Function` takes the role's ARN and a log group's name. `FunctionV5`
    // takes both in `existing`.
    it("a role and a log group the user has", async () => {
      await pulumi.expectTakeover(
        () =>
          new Function("MyFunction", {
            handler,
            role: ROLE_ARN,
            logging: { logGroup: "/my/logs", format: "json" },
          }),
        () =>
          new FunctionV5("MyFunction", {
            handler,
            logging: { format: "json" },
            existing: { role: "my-role", logGroup: "/my/logs" },
          }),
      );
      const fn = pulumi.resources.find((r) => r.type === LAMBDA)!;
      expect(fn.inputs.role).toBe(ROLE_ARN);
      expect(fn.inputs.loggingConfig).toEqual({
        logFormat: "JSON",
        logGroup: "/my/logs",
      });
      // Looked up, not created
      expect(
        pulumi
          .graph()
          .filter((r) => r.type === ROLE || r.type === LOG_GROUP)
          .map((r) => [r.name, r.kind, r.options.id]),
      ).toEqual([
        ["MyFunctionLogGroup", "read", "/my/logs"],
        ["MyFunctionRole", "read", "my-role"],
      ]);
    });

    describe("in sst dev", () => {
      beforeEach(() => {
        // @ts-ignore
        global.$dev = true;
      });

      const dev: Record<string, () => FunctionArgs & FunctionV5Args> = {
        "a live function": () => ({
          handler,
          description: "Does things",
          runtime: "python3.12",
          architecture: "arm64",
          streaming: true,
          url: true,
          injections: ["  setup();"],
          // The stub is deployed whatever the transform says
          transform: { function: { runtime: "nodejs20.x" } },
        }),
        "a live durable function": () => ({ handler, durable: true }),
        "a python container, which is live too": () => ({
          handler: "functions/src/functions/api.handler",
          runtime: "python3.12",
          python: { container: true },
        }),
        "a function that isn't live": () => ({ handler, dev: false }),
      };

      for (const [name, args] of Object.entries(dev)) {
        it(name, async () => {
          await pulumi.expectTakeover(
            () => new Function("MyFunction", args()),
            () => {
              // The stub's code is uploaded once for the app
              Function.reset();
              new FunctionV5("MyFunction", args());
            },
          );
        });
      }

      it("deploys the stub, and shares its code with Function", async () => {
        new Function("Old", { handler });
        new FunctionV5("New", { handler, description: "Does things" });
        await pulumi.settle();

        expect(
          pulumi.resources
            .filter((r) => r.name.startsWith("DevBridgeCode"))
            .map((r) => [r.name, r.parent, r.options.retainOnDelete]),
        ).toEqual([["DevBridgeCodeUseast1Bridge", "", true]]);

        const fn = pulumi.resources.find((r) => r.name === "NewFunction")!;
        expect(fn.inputs).toMatchObject({
          description: "Does things (live)",
          runtime: "provided.al2023",
          architectures: ["x86_64"],
          handler: "bootstrap",
        });
        expect(fn.inputs.environment.variables).toMatchObject({
          SST_FUNCTION_ID: "New",
          SST_APPSYNC_HTTP: "appsync.example.com",
          SST_ASSET_BUCKET: "sst-asset-bucket",
        });
        // No code of its own
        expect(pulumi.resources.some((r) => r.name === "NewCode")).toBe(false);
      });
    });
  });

  describe("parts", () => {
    const handler = "src/index.handler";

    it("has its resources in nodes, not outputs of them", async () => {
      const fn = new FunctionV5("MyFunction", { handler, url: true, retries: 2 });
      // Before anything has resolved
      expect(fn.nodes.function).toBeInstanceOf(aws.lambda.Function);
      expect(fn.nodes.role).toBeInstanceOf(aws.iam.Role);
      expect(fn.nodes.logGroup).toBeInstanceOf(aws.cloudwatch.LogGroup);
      expect(fn.nodes.code).toBeInstanceOf(aws.s3.BucketObjectv2);
      expect(fn.nodes.url).toBeInstanceOf(aws.lambda.FunctionUrl);
      expect(fn.nodes.urlAccess).toBeInstanceOf(aws.lambda.Permission);
      expect(fn.nodes.urlInvoke).toBeInstanceOf(aws.lambda.Permission);
      expect(fn.nodes.eventInvokeConfig).toBeDefined();
      expect(fn.nodes.image).toBeUndefined();
      expect(fn.nodes.provisioned).toBeUndefined();
      await pulumi.settle();
    });

    it("transforms every part", async () => {
      const router = new FakeRouter("oac") as unknown as Router;
      new FunctionV5("MyFunction", {
        handler,
        durable: true,
        url: { router: { instance: router } },
        versioning: true,
        concurrency: { provisioned: 1 },
        transform: {
          code: { storageClass: "STANDARD_IA" },
          url: { invokeMode: "RESPONSE_STREAM" },
          urlAlias: { description: "For the URL" },
          urlAccess: { statementId: "access" },
          urlInvoke: { statementId: "invoke" },
          routeKey: { purge: true },
          routesUpdate: { key: "other" },
          provisioned: { provisionedConcurrentExecutions: 5 },
        },
      });
      await pulumi.settle();

      // One of SST's own provider resources has its type after its name
      const inputs = (name: string) =>
        pulumi.resources.find(
          (r) => r.name.split(".")[0] === `MyFunction${name}`,
        )!.inputs;
      expect(inputs("Code").storageClass).toBe("STANDARD_IA");
      expect(inputs("Url").invokeMode).toBe("RESPONSE_STREAM");
      expect(inputs("UrlAlias").description).toBe("For the URL");
      expect(inputs("UrlAccess")).toMatchObject({
        statementId: "access",
        principal: "cloudfront.amazonaws.com",
        sourceArn: DISTRIBUTION_ARN,
      });
      expect(inputs("UrlInvoke").statementId).toBe("invoke");
      expect(inputs("RouteKey").purge).toBe(true);
      expect(inputs("RoutesUpdate").key).toBe("other");
      expect(inputs("Provisioned").provisionedConcurrentExecutions).toBe(5);
    });

    it("gives no one access to a url with iam authorization", async () => {
      const fn = new FunctionV5("MyFunction", {
        handler,
        url: { authorization: "iam" },
      });
      await pulumi.settle();
      expect(fn.nodes.urlAccess).toBeUndefined();
      expect(fn.nodes.urlInvoke).toBeUndefined();
      const url = pulumi.resources.find((r) => r.name === "MyFunctionUrl")!;
      expect(url.inputs.authorizationType).toBe("AWS_IAM");
    });

    it("references a function that's already deployed", async () => {
      const fn = FunctionV5.get("MyFunction", "app-dev-existing");
      await pulumi.settle();

      expect(pulumi.graph().map((r) => [r.kind, r.name, r.options.id])).toEqual([
        ["read", "MyFunctionFunction", "app-dev-existing"],
        ["register", "MyFunction", undefined],
      ]);
      const link = await pulumi.resolve(fn.link());
      expect(link.properties.name).toBe("app-dev-existing");
      expect(link.include[0].actions).toEqual(["lambda:InvokeFunction"]);
    });

    it("links a durable function with its qualifier", async () => {
      const fn = new FunctionV5("MyFunction", { handler, durable: true });
      const link = await pulumi.resolve(fn.link());
      expect(link.properties.qualifier).toBe("3");
      expect(link.include[0].actions).toContain("lambda:GetDurableExecution");
      expect(link.include[0].resources[0]).toMatch(/:\*$/);
      await pulumi.settle();
    });

    it("is linked through getSSTLink, like Function", async () => {
      const target = new FunctionV5("Target", { handler });
      new Function("Caller", { handler, link: [target] });
      await pulumi.settle();
      const role = pulumi.resources.find((r) => r.name === "CallerRole")!;
      expect(role.inputs.inlinePolicies[0].policy).toContain(
        "lambda:InvokeFunction",
      );
    });
  });

  // The V5 components create their functions as FunctionV5, with
  // `functionPart()`.
  describe("as a part of another component", () => {
    const handler = "src/subscriber.handler";
    let Queue: typeof import("../../src/components/aws/queue").Queue;
    let QueueV5: typeof import("../../src/components/aws/queue-v5").QueueV5;

    beforeAll(async () => {
      Queue = (await import("../../src/components/aws/queue")).Queue;
      QueueV5 = (await import("../../src/components/aws/queue-v5")).QueueV5;
      await import("../../src/components/aws/takeover/queue");
    });

    const inputs = (name: string) =>
      pulumi.resources.find((r) => r.name === name)!.inputs;

    // What `Function` takes that `FunctionV5` takes somewhere else: `live`,
    // `role` and `logging.logGroup`
    it("takes over a function written the way Function takes it", async () => {
      // @ts-ignore
      global.$dev = true;
      const subscriber = () => ({
        handler,
        live: false as const,
        role: ROLE_ARN,
        logging: { logGroup: "/my/logs", format: "json" as const },
      });
      const result = await pulumi.takesOver(
        () => new Queue("MyQueue").subscribe(subscriber()),
        () => new QueueV5("MyQueue").subscribe(subscriber()),
      );

      // Only the component 4.x wraps a subscriber in goes
      expect(result.unclaimed).toEqual([
        "sst:aws:QueueLambdaSubscriber::MyQueueSubscriberVkxuom",
      ]);
      // The description names the queue now, where it named that component
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["MyQueueSubscriberVkxuomFunctionFunction", ["description"]],
      ]);

      expect(inputs("MyQueueSubscriberFunction")).toMatchObject({
        // Not the stub that's deployed in `sst dev`
        handler: "index.handler",
        role: ROLE_ARN,
        loggingConfig: { logFormat: "JSON", logGroup: "/my/logs" },
      });
    });

    it("takes the deprecated url.route of Function", async () => {
      new QueueV5("MyQueue").subscribe({
        handler,
        url: { route: { router: router("none"), path: "/jobs" } },
      });
      await pulumi.settle();

      expect(
        pulumi
          .graph()
          .filter((r) => r.name.startsWith("MyQueueSubscriberRout"))
          .map((r) => r.name.split(".")[0]),
      ).toEqual(["MyQueueSubscriberRouteKey", "MyQueueSubscriberRoutesUpdate"]);
    });

    it("is transformed through the component, down to its own parts", async () => {
      new QueueV5("MyQueue", {
        transform: {
          subscriber: {
            memory: "512 MB",
            environment: { ADDED: "yes" },
            transform: { function: { tracingConfig: { mode: "Active" } } },
          },
        },
      }).subscribe({ handler, environment: { MINE: "yes" } });
      await pulumi.settle();

      const fn = inputs("MyQueueSubscriberFunction");
      expect(fn.memorySize).toBe(512);
      expect(fn.tracingConfig).toEqual({ mode: "Active" });
      // An object in a transform is merged into what's there
      expect(fn.environment.variables).toMatchObject({ ADDED: "yes", MINE: "yes" });
    });

    it("uses a function passed in existing as it is", async () => {
      const mine = new FunctionV5("Mine", { handler });
      const queue = new QueueV5("MyQueue", { existing: { subscriber: mine } });
      queue.subscribe("src/unused.handler");
      await pulumi.settle();

      expect(await pulumi.resolve(queue.nodes.subscriber)).toBe(mine);
      expect(pulumi.resources.some((r) => r.name === "MyQueueSubscriber")).toBe(
        false,
      );
      expect(inputs("MyQueueEventSourceMapping").functionName).toContain(
        "MineFunction",
      );
    });
  });

  describe("says what to write instead", () => {
    const handler = "src/index.handler";
    const create = (args: object) => () =>
      new FunctionV5("MyFunction", { handler, ...args } as FunctionV5Args);

    it("for options that moved", () => {
      expect(create({ live: false })).toThrow(/"live" isn't an option.*dev: false/);
      expect(create({ role: ROLE_ARN })).toThrow(/"role" isn't an option.*existing/);
      expect(create({ logging: { logGroup: "/my/logs" } })).toThrow(
        /"logGroup" isn't an option.*existing/,
      );
      expect(create({ url: { route: {} } })).toThrow(
        /"route" isn't an option.*url\.router/,
      );
    });

    it("for args that have to be plain values", () => {
      for (const args of [
        { dev: output(false) },
        { logging: output(false) },
        { url: output(true) },
        { url: { authorization: output("iam") } },
        { python: output({}) },
        { python: { container: output(true) } },
        { concurrency: output({}) },
        { concurrency: { provisioned: output(1) } },
      ])
        expect(create(args)).toThrow(/has to be a plain value, not an output/);
    });

    it("for a retention on a log group the user has", () => {
      expect(
        create({
          logging: { retention: "1 week" },
          existing: { logGroup: "/my/logs" },
        }),
      ).toThrow(/Cannot set "logging.retention"/);
    });

    it("for a second addEnvironment", async () => {
      const fn = new FunctionV5("MyFunction", { handler });
      fn.addEnvironment({ A: "1" });
      expect(() => fn.addEnvironment({ B: "2" })).toThrow(
        /"addEnvironment" was already called/,
      );
      await pulumi.settle();
    });
  });
});
