import fs from "fs";
import os from "os";
import path from "path";
import * as aws from "@pulumi/aws";
import {
  ComponentResource,
  type ComponentResourceOptions,
  output,
} from "@pulumi/pulumi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

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

type FunctionClass =
  | typeof import("../../../src/components/aws/function").Function
  | typeof import("../../../src/components/aws/v5/function").Function;
type OriginalFunctionArgs = import("../../../src/components/aws/function").FunctionArgs;
type FunctionArgs =
  import("../../../src/components/aws/v5/function").FunctionArgs;
type Router = import("../../../src/components/aws/router").Router;

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

describe("Function", () => {
  let OriginalFunction: typeof import("../../../src/components/aws/function").Function;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;
  let permission: typeof import("../../../src/components/aws/permission").permission;
  let Linkable: typeof import("../../../src/components/linkable").Linkable;

  beforeAll(async () => {
    ({ Linkable } = await import("../../../src/components/linkable"));
    OriginalFunction = (await import("../../../src/components/aws/function")).Function;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
    permission = (await import("../../../src/components/aws/permission")).permission;
    await import("../../../src/components/aws/takeover/function");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  // Each case deploys the 4.x Function, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with
  // the same inputs.
  describe("takes over a deployed Function", () => {
    const handler = "src/index.handler";
    const sameArgs: Record<string, () => OriginalFunctionArgs & FunctionArgs> = {
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
      // Its linked resources are read from its own file in the bundle
      "its own bundle": () => ({ handler: "index.handler", bundle: "dist" }),
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

    const fn =
      (args: () => OriginalFunctionArgs & FunctionArgs, name = "MyFunction") =>
      (Function: FunctionClass, opts?: ComponentResourceOptions) =>
        new Function(name, args(), opts);

    pulumi.takeoverCases({
      original: () => OriginalFunction,
      v5: () => Function,
      cases: {
        ...Object.fromEntries(
          Object.entries(sameArgs).map(([name, args]) => [name, fn(args)]),
        ),
        // The 4.x Function creates the alias a durable function's URL points at
        // with no parent, so with the app's provider whatever the function is
        // given. V5 creates it inside the function, with the function's
        // provider, which replaces it.
        "a durable function with a url": {
          create: fn(sameArgs["a durable function with a url"]),
          changed: (way) =>
            way === "with another provider"
              ? [["MyFunctionDurable", ["options.provider"]]]
              : [],
        },
        "linked resources and copied files": {
          create: fn(() => ({
            handler,
            link: [
              new Linkable("MyLink", {
                properties: { value: "linked" },
                include: [
                  permission({
                    actions: ["sqs:SendMessage"],
                    resources: ["*"],
                  }),
                  { type: "environment" as const, env: { LINKED: "yes" } },
                ],
              }),
            ],
            copyFiles: [{ from: maps, to: "maps" }],
          })),
          check: () => {
            const role = pulumi.resources.find((r) => r.type === ROLE)!;
            expect(role.inputs.inlinePolicies[0].policy).toContain(
              "sqs:SendMessage",
            );
            const fn = pulumi.resources.find((r) => r.type === LAMBDA)!;
            expect(fn.inputs.environment.variables.LINKED).toBe("yes");
          },
        },
        "source maps": {
          create: fn(() => ({ handler }), "Mapped"),
          check: () =>
            expect(
              pulumi.resources
                .filter((r) => r.name.startsWith("MappedSourcemap"))
                .map((r) => [r.name, r.options.retainOnDelete]),
            ).toEqual([
              ["MappedSourcemap0", true],
              ["MappedSourcemap1", true],
            ]),
        },
        "environment variables added later": (Function, opts) =>
          new Function("MyFunction", { handler }, opts).addEnvironment({
            A: "1",
          }),
        // 4.x takes the role's ARN and a log group's name. V5 takes both in
        // `existing`.
        "a role and a log group the user has": {
          original: (opts) =>
            new OriginalFunction(
              "MyFunction",
              {
                handler,
                role: ROLE_ARN,
                logging: { logGroup: "/my/logs", format: "json" },
              },
              opts,
            ),
          v5: (opts) =>
            new Function(
              "MyFunction",
              {
                handler,
                logging: { format: "json" },
                existing: { role: "my-role", logGroup: "/my/logs" },
              },
              opts,
            ),
          check: () => {
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
          },
        },
        // Neither one looks a role up that's passed by its ARN
        "a role the user has, by its ARN": {
          original: (opts) =>
            new OriginalFunction(
              "MyFunction",
              { handler, role: ROLE_ARN },
              opts,
            ),
          v5: (opts) =>
            new Function(
              "MyFunction",
              { handler, existing: { role: ROLE_ARN } },
              opts,
            ),
          check: () => {
            const fn = pulumi.resources.find((r) => r.type === LAMBDA)!;
            expect(fn.inputs.role).toBe(ROLE_ARN);
            expect(pulumi.graph().filter((r) => r.type === ROLE)).toEqual([]);
          },
        },
      },
    });

    describe("in sst dev", () => {
      beforeEach(() => {
        // @ts-ignore
        global.$dev = true;
      });

      const dev: Record<string, () => OriginalFunctionArgs & FunctionArgs> = {
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

      pulumi.takeoverCases({
        original: () => OriginalFunction,
        v5: () => Function,
        cases: Object.fromEntries(
          Object.entries(dev).map(([name, args]) => [
            name,
            {
              original: (opts?: ComponentResourceOptions) =>
                new OriginalFunction("MyFunction", args(), opts),
              v5: (opts?: ComponentResourceOptions) =>
                new Function("MyFunction", args(), opts),
            },
          ]),
        ),
      });

      it("deploys the stub, and shares its code with Function", async () => {
        new OriginalFunction("Old", { handler });
        new Function("New", { handler, description: "Does things" });
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
      const fn = new Function("MyFunction", { handler, url: true, retries: 2 });
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

    // A lookup is an IAM GetRole on every run, for each function that shares
    // the role
    for (const [way, args] of [
      ["in existing", { existing: { role: ROLE_ARN } }],
      ["the way 4.x takes it", { role: ROLE_ARN }],
    ] as const)
      it(`looks up a role passed by its ARN ${way} only when nodes.role is read`, async () => {
        const fn = new Function("MyFunction", {
          handler,
          ...args,
        } as FunctionArgs);
        await pulumi.settle();
        const roles = () => pulumi.resources.filter((r) => r.type === ROLE);

        expect(roles()).toEqual([]);
        expect(
          pulumi.resources.find((r) => r.type === LAMBDA)!.inputs.role,
        ).toBe(ROLE_ARN);

        expect(fn.nodes.role).toBeInstanceOf(aws.iam.Role);
        expect(fn.nodes.role).toBe(fn.nodes.role);
        await pulumi.settle();
        expect(
          roles().map((r) => [r.name, r.kind, r.options.id]),
        ).toEqual([["MyFunctionRole", "read", "my-role"]]);
      });

    it("looks up a role passed as an output by its name, even when it's an ARN", async () => {
      new Function("MyFunction", {
        handler,
        existing: { role: output(ROLE_ARN) },
      });
      await pulumi.settle();

      expect(
        pulumi.resources
          .filter((r) => r.type === ROLE)
          .map((r) => [r.name, r.kind, r.options.id]),
      ).toEqual([["MyFunctionRole", "read", "my-role"]]);
      expect(
        await pulumi.resolve(
          pulumi.resources.find((r) => r.type === LAMBDA)!.inputs.role,
        ),
      ).toBe(ROLE_ARN);
    });

    it("transforms every part", async () => {
      const router = new FakeRouter("oac") as unknown as Router;
      new Function("MyFunction", {
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
      const fn = new Function("MyFunction", {
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
      const fn = Function.get("MyFunction", "app-dev-existing");
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
      const fn = new Function("MyFunction", { handler, durable: true });
      const link = await pulumi.resolve(fn.link());
      expect(link.properties.qualifier).toBe("3");
      expect(link.include[0].actions).toContain("lambda:GetDurableExecution");
      expect(link.include[0].resources[0]).toMatch(/:\*$/);
      await pulumi.settle();
    });

    it("is linked through getSSTLink, like Function", async () => {
      const target = new Function("Target", { handler });
      new OriginalFunction("Caller", { handler, link: [target] });
      await pulumi.settle();
      const role = pulumi.resources.find((r) => r.name === "CallerRole")!;
      expect(role.inputs.inlinePolicies[0].policy).toContain(
        "lambda:InvokeFunction",
      );
    });
  });

  // The V5 components create their functions as the V5 Function, with
  // `functionPart()`.
  describe("as a part of another component", () => {
    const handler = "src/subscriber.handler";
    let OriginalQueue: typeof import("../../../src/components/aws/queue").Queue;
    let Queue: typeof import("../../../src/components/aws/v5/queue").Queue;

    beforeAll(async () => {
      OriginalQueue = (await import("../../../src/components/aws/queue")).Queue;
      Queue = (await import("../../../src/components/aws/v5/queue")).Queue;
      await import("../../../src/components/aws/takeover/queue");
    });

    const inputs = (name: string) =>
      pulumi.resources.find((r) => r.name === name)!.inputs;

    // A function part is inside the component it's linked to here. Its code
    // is built from the links, and a link's name is read from the linked
    // component: if the code depended on that, it would depend on everything
    // in the component, itself included, and never be created.
    it("is created when it links the component it's a part of", async () => {
      const queue = new Queue("MyQueue");
      queue.subscribe({ handler, link: [queue] });
      await pulumi.settle();

      expect(inputs("MyQueueSubscriberFunction").handler).toBe("bundle.handler");
      const policy = inputs("MyQueueSubscriberRole").inlinePolicies[0].policy;
      expect(JSON.parse(policy).statements).toContainEqual(
        expect.objectContaining({ actions: ["sqs:*"] }),
      );
    });

    // The CLI builds it with the commands, and it's deployed with the Lambda
    // runtime they name. In `sst dev` the CLI is told the commands too, to run
    // it with.
    it("is built by a runtime made of commands", async () => {
      const { runtime } = await import("../../../src/components/runtime");
      const ruby = runtime({
        lambda: "ruby3.4",
        build: { command: "bundle install" },
        dev: { command: "bundle exec aws_lambda_ric $_HANDLER" },
        watch: ["*.rb", "Gemfile.lock"],
      });
      const commands = {
        build: { command: "bundle install" },
        dev: { command: "bundle exec aws_lambda_ric $_HANDLER" },
        watch: ["*.rb", "Gemfile.lock"],
      };
      new Function("MyFunction", { handler: "functions/ruby/app.handler", runtime: ruby });
      await pulumi.settle();
      const fn = pulumi.resources.find((r) => r.type === LAMBDA)!;
      expect(fn.inputs.runtime).toBe("ruby3.4");
      expect(fn.inputs.handler).toBe("bundle.handler");
      const built = pulumi.graph().find((r) => r.name === "MyFunction")!.build!;
      expect(built.runtime).toBe("ruby3.4");
      expect(built.commands).toEqual(commands);

      pulumi.reset();
      // @ts-ignore
      global.$dev = true;
      new Function("MyFunction", { handler: "functions/ruby/app.handler", runtime: ruby });
      await pulumi.settle();
      const stub = pulumi.resources.find((r) => r.type === LAMBDA)!;
      expect(stub.inputs.runtime).toBe("provided.al2023");
      expect(pulumi.graph().find((r) => r.name === "MyFunction")!.build!.commands).toEqual(commands);
    });

    it("needs a runtime made of commands to say how it's deployed and run", async () => {
      const { runtime } = await import("../../../src/components/runtime");
      // @ts-expect-error
      expect(() => runtime({ dev: { command: "ruby x.rb" } })).toThrow(/lambda/);
      // @ts-expect-error
      expect(() => runtime({ lambda: "ruby3.4" })).toThrow(/dev.command/);
    });

    // What's built is read from these, and a preview has to know it
    it("turns down what it's built from in an output", async () => {
      const { runtime } = await import("../../../src/components/runtime");
      const ruby = runtime({ lambda: "ruby3.4", dev: { command: "ruby x.rb" } });
      const given: [string, Record<string, unknown>][] = [
        ["runtime", { runtime: output(ruby) }],
        ["handler", { handler: output(handler) }],
        ["bundle", { bundle: output("src") }],
        ["architecture", { architecture: output("arm64") }],
        ["nodejs", { nodejs: { install: output(["sharp"]) } }],
        ["copyFiles", { copyFiles: [{ from: output("a.txt") }] }],
      ];
      for (const [arg, args] of given)
        expect(() => new Function("MyFunction", { handler, ...args } as any)).toThrow(
          `The "${arg}" of the "MyFunction" function has to be a plain value, not an output. The function is built from it, and a preview has to know what's built.`,
        );
      await pulumi.settle();
    });

    // A component built the 5.0 way takes a function part's args as a plain
    // value, so a preview knows the function is created
    it("is built by a runtime made of commands, given in a function part's args", async () => {
      const { runtime } = await import("../../../src/components/runtime");
      const { Queue } = await import("../../../src/components/aws/v5/queue");
      const ruby = runtime({ lambda: "ruby3.4", dev: { command: "ruby x.rb" } });
      new Queue("MyQueue").subscribe({
        handler: "functions/ruby/app.handler",
        runtime: ruby,
      });
      await pulumi.settle();
      const fn = pulumi.resources.find((r) => r.type === LAMBDA)!;
      expect(fn.inputs.runtime).toBe("ruby3.4");
      expect(pulumi.graph().find((r) => r.type === "sst:aws:Function")!.build!.commands).toEqual({
        build: {},
        dev: { command: "ruby x.rb" },
      });
    });

    it("turns down what isn't a runtime", async () => {
      const { runtime } = await import("../../../src/components/runtime");
      const ruby = runtime({ lambda: "ruby3.4", dev: { command: "ruby x.rb" } });
      expect(
        () => new Function("MyFunction", { handler, runtime: { lambda: "ruby3.4" } as any }),
      ).toThrow(/a runtime's name, like "nodejs24.x", or a runtime from sst.runtime/);
      expect(
        () =>
          new Function("Injected", {
            handler: "functions/ruby/app.handler",
            runtime: ruby,
            injections: ["console.log(1)"],
          }),
      ).toThrow(/"injections", which are for a Node.js function SST builds/);
      // a $transform written for the V5 Function runs on the 4.x one too
      expect(() => new OriginalFunction("Old", { handler, runtime: ruby as any })).toThrow(
        /A runtime from sst.runtime is for sst.aws.v5.Function/,
      );
      await pulumi.settle();
    });

    // The permissions and the environment are what say what the function
    // needs in AWS. What it's built from is files on this machine.
    it("has code that doesn't depend on what's linked", async () => {
      const other = new Queue("Other");
      new Function("MyFunction", { handler, link: [other] });
      await pulumi.settle();

      const code = pulumi.resources.find((r) => r.name === "MyFunctionCode")!;
      expect(code.options.dependencies ?? []).toEqual([]);
      expect(pulumi.dependsOn("MyFunctionRole", "OtherQueue")).toBe(true);
    });

    // What 4.x takes that V5 takes somewhere else: `live`, `role` and
    // `logging.logGroup`
    it("takes over a function written the way the 4.x Function takes it", async () => {
      // @ts-ignore
      global.$dev = true;
      const subscriber = () => ({
        handler,
        live: false as const,
        role: ROLE_ARN,
        logging: { logGroup: "/my/logs", format: "json" as const },
      });
      const result = await pulumi.takesOver(
        () => new OriginalQueue("MyQueue").subscribe(subscriber()),
        () => new Queue("MyQueue").subscribe(subscriber()),
      );

      // Only the component 4.x wraps a subscriber in goes
      expect(result.unclaimed).toEqual([
        "sst:aws:QueueLambdaSubscriber::MyQueueSubscriberVkxuom",
      ]);
      // The description names the queue now, where it named that component
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
        ["MyQueueSubscriberVkxuomFunction", ["description"]],
      ]);

      expect(inputs("MyQueueSubscriberFunction")).toMatchObject({
        // Not the stub that's deployed in `sst dev`
        handler: "bundle.handler",
        role: ROLE_ARN,
        loggingConfig: { logFormat: "JSON", logGroup: "/my/logs" },
      });
    });

    it("takes the deprecated url.route of Function", async () => {
      new Queue("MyQueue").subscribe({
        handler,
        // @ts-expect-error The way the 4.x Function takes it works, untyped
        url: { route: { router: router("none"), path: "/jobs" } },
      });
      await pulumi.settle();

      expect(
        pulumi
          .graph()
          .filter((r) => r.name.startsWith("MyQueueSubscriberRout"))
          .map((r) => r.name.split(".")[0])
          .sort(),
      ).toEqual(["MyQueueSubscriberRouteKey", "MyQueueSubscriberRoutesUpdate"]);
    });

    it("names the router as it was given when it's an output", async () => {
      expect(() =>
        new Queue("MyQueue").subscribe({
          handler,
          // @ts-expect-error The way the 4.x Function takes it works, untyped
          url: { route: { router: output(router("oac")), path: "/jobs" } },
        }),
      ).toThrow(/The "url.route.router" of the "MyQueueSubscriber" function has to be a plain value/);
      expect(() =>
        new Queue("Other").subscribe({
          handler,
          url: { router: { instance: output(router("oac")) as any } },
        }),
      ).toThrow(/The "url.router.instance" of the "OtherSubscriber" function has to be a plain value/);
      await pulumi.settle();
    });

    it("is transformed through the component, down to its own parts", async () => {
      new Queue("MyQueue", {
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
      const mine = new Function("Mine", { handler });
      const queue = new Queue("MyQueue", { existing: { subscriber: mine } });
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

    it("uses the ARN of a function passed in existing", async () => {
      const arn = "arn:aws:lambda:us-east-1:123456789012:function:mine";
      new Queue("MyQueue", { existing: { subscriber: arn } }).subscribe(
        "src/unused.handler",
      );
      await pulumi.settle();

      expect(pulumi.resources.some((r) => r.name === "MyQueueSubscriber")).toBe(
        false,
      );
      expect(inputs("MyQueueEventSourceMapping").functionName).toBe(arn);
    });

    // `existing` is for a function you have. A name or a handler there
    // would have created a function from it.
    it("refuses what isn't a function or its ARN in existing", async () => {
      for (const given of ["mine", "src/mine.handler", { handler }])
        expect(() =>
          new Queue(`MyQueue${Math.random()}`.replace(".", ""), {
            existing: { subscriber: given as any },
          }).subscribe("src/unused.handler"),
        ).toThrow(
          /The "existing\.subscriber" of "MyQueue\d+Subscriber" isn't a function or the ARN of one/,
        );
      // What the queues registered, before the next test
      await pulumi.settle();
    });
  });

  // The 4.x Function takes a few options another way: `live`, `role`,
  // `logging.logGroup` and `url.route`. The V5 one takes those too, because a
  // `$transform` written for the 4.x one runs on it: they have the same type.
  describe("takes what's written for the 4.x Function", () => {
    const handler = "src/index.handler";
    const inputs = (name: string) =>
      pulumi.resources.find((r) => r.name === name)!.inputs;

    it("as its own args", async () => {
      // @ts-ignore
      global.$dev = true;
      const args = () => ({
        handler,
        live: false as const,
        role: ROLE_ARN,
        logging: { logGroup: "/my/logs", format: "json" as const },
        url: { route: { router: router("none"), path: "/jobs" } },
      });
      const result = await pulumi.takesOver(
        () => new OriginalFunction("MyFunction", args()),
        () => new Function("MyFunction", args() as FunctionArgs),
      );

      expect(result.unclaimed).toEqual([]);
      expect(result.changed.map((c) => [c.name, c.fields])).toEqual([]);
      expect(inputs("MyFunctionFunction")).toMatchObject({
        // Not the stub that's deployed in `sst dev`
        handler: "bundle.handler",
        role: ROLE_ARN,
        loggingConfig: { logFormat: "JSON", logGroup: "/my/logs" },
      });
    });

    it("in a $transform, which applies to both", async () => {
      const { $transform } = await import("../../../src/components/component");
      $transform(OriginalFunction, (args, _opts, name) => {
        if (!name.startsWith("Transformed")) return;
        args.memory = "2 GB";
        args.role = ROLE_ARN;
      });

      new OriginalFunction("TransformedOriginal", { handler });
      new Function("Transformed", { handler });
      // A function a V5 component creates
      const { Queue } = await import("../../../src/components/aws/v5/queue");
      new Queue("TransformedQueue").subscribe(handler);
      await pulumi.settle();

      for (const name of [
        "TransformedOriginalFunction",
        "TransformedFunction",
        "TransformedQueueSubscriberFunction",
      ])
        expect(inputs(name), name).toMatchObject({
          memorySize: 2048,
          role: ROLE_ARN,
        });
      // The role is the one that's passed: none is created
      expect(
        pulumi.resources.filter(
          (r) => r.type === "aws:iam/role:Role" && r.kind === "register",
        ),
      ).toEqual([]);
    });

    // 4.x left a function part's environment, link and permissions as they
    // were given, so a `$transform` could spread them. Spreading an output
    // copies the output, and what's added is lost without an error.
    it("in a $transform that adds to what a function part is given", async () => {
      const { $transform } = await import("../../../src/components/component");
      $transform(OriginalFunction, (args, _opts, name) => {
        if (!name.startsWith("Spread")) return;
        args.environment = { ...(args.environment ?? {}), EXTRA: "1" };
        args.link = [...((args.link as unknown[]) ?? [])];
      });

      const { Queue } = await import("../../../src/components/aws/v5/queue");
      const { Cron } = await import("../../../src/components/aws/v5/cron");
      const { Bus } = await import("../../../src/components/aws/v5/bus");
      new Queue("SpreadQueue").subscribe(handler);
      new Cron("SpreadCron", { function: handler, schedule: "rate(1 hour)" });
      new Bus("SpreadBus").subscribe("Logger", {
        handler,
        environment: { MINE: "yes" },
      });
      await pulumi.settle();

      for (const name of [
        "SpreadQueueSubscriberFunction",
        "SpreadCronFunctionFunction",
        "SpreadBusSubscriberLoggerFunction",
      ])
        expect(inputs(name).environment.variables, name).toMatchObject({
          EXTRA: "1",
        });
      expect(
        inputs("SpreadBusSubscriberLoggerFunction").environment.variables,
      ).toMatchObject({ MINE: "yes" });
    });

    it("unless the V5 way of writing it is there too", async () => {
      new Function("MyFunction", {
        handler,
        role: ROLE_ARN,
        existing: { role: "another-role" },
      } as FunctionArgs);
      await pulumi.settle();

      expect(
        pulumi.resources.filter((r) => r.type === "aws:iam/role:Role"),
      ).toMatchObject([{ kind: "read", options: { id: "another-role" } }]);
    });
  });

  describe("says what to write instead", () => {
    const handler = "src/index.handler";
    const create = (args: object) => () =>
      new Function("MyFunction", { handler, ...args } as FunctionArgs);

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
        { retries: output(0) },
      ])
        expect(create(args)).toThrow(/has to be a plain value, not an output/);
    });

    it("for args next to a function it's given", async () => {
      expect(create({ url: true, existing: { function: "existing" } })).toThrow(
        'The "MyFunction" function is given an existing "function", which it uses the way it is. Remove "handler", "url" from its args.',
      );
      // What a `$transform` for every function sets isn't meant for one from
      // `get`
      const { $transform } = await import("../../../src/components/component");
      $transform(Function, (args, _opts, name) => {
        if (name === "Shared") args.runtime = "nodejs22.x";
      });
      Function.get("Shared", "app-dev-existing");
      await pulumi.settle();
    });

    // Another resource would be read as the ids of a VPC
    it("for a vpc that isn't a Vpc, or one given as SST 4 did", async () => {
      const vpc = new aws.ec2.Vpc("Mine", { cidrBlock: "10.0.0.0/16" });
      expect(create({ vpc })).toThrow(
        'The "vpc" of the "MyFunction" function isn\'t a "Vpc" component.',
      );
      const errors = await applyErrors(
        create({ vpc: { subnets: ["subnet-1"], securityGroups: ["sg-1"] } }),
        pulumi.settle,
      );
      expect(errors).toContainEqual(
        expect.stringContaining(
          '"vpc.subnets" isn\'t an option for the "MyFunction" function. It\'s "vpc.privateSubnets" now.',
        ),
      );
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
      const fn = new Function("MyFunction", { handler });
      fn.addEnvironment({ A: "1" });
      expect(() => fn.addEnvironment({ B: "2" })).toThrow(
        /"addEnvironment" was already called/,
      );
      await pulumi.settle();
    });
  });
});
