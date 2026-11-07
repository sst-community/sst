import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, sidedClass } from "../../helpers/graph";
import { rejectionsOf } from "../../helpers/rejections";

// The app's folder, with a server's source and a prebuilt bundle
const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-function-v5-"));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
write("src/server.ts", "// server\n");
write("src/twice.ts", "// one\n");
write("src/twice.js", "// two\n");
write("dist/server.mjs", "// built\n");
write("dist/server.ts", "// source\n");
write("public/index.html", "<p>hi</p>\n");
write("src/caller.ts", "export const handler = () => {};\n");

const ROLE = "aws:iam/role:Role";

// As the CLI builds a web function: the server, and its links encrypted into
// `resource.enc`, in the bundle when it's given one. What's in the file
// follows the links, so a link given wrong changes the code's zip.
const builds = path.join(root, ".builds");
const pulumi = mockPulumi({
  root,
  // The key the links are encrypted with
  state: (args) =>
    args.type === "random:index/randomBytes:RandomBytes"
      ? { base64: Buffer.alloc(32, 1).toString("base64") }
      : {},
  cli: (method, args) => {
    if (method !== "Runtime.Build" || args.runtime !== "nodejs24.x")
      return undefined;
    if (args.bundle) {
      const file = path.join(args.bundle, ".sst", args.functionID);
      fs.mkdirSync(file, { recursive: true });
      fs.writeFileSync(
        path.join(file, "resource.enc"),
        JSON.stringify(args.links),
      );
      return {
        handler: args.handler,
        out: args.bundle,
        errors: [],
        sourcemaps: [],
      };
    }
    const out = path.join(builds, args.functionID);
    fs.mkdirSync(out, { recursive: true });
    const file =
      args.properties?.format === "cjs" ? "server.cjs" : "server.mjs";
    fs.writeFileSync(path.join(out, file), "// bundled\n");
    fs.writeFileSync(
      path.join(out, "resource.enc"),
      JSON.stringify(args.links),
    );
    return { handler: "server.main", out, errors: [], sourcemaps: [] };
  },
});

type WebFunctionClass =
  | typeof import("../../fixtures/v4/components/aws/web-function").WebFunction
  | typeof import("../../../src/components/aws/web-function").WebFunction;

describe("WebFunction", () => {
  let OriginalWebFunction: typeof import("../../fixtures/v4/components/aws/web-function").WebFunction;
  let WebFunction: typeof import("../../../src/components/aws/web-function").WebFunction;
  let SidedFunction: any;

  beforeAll(async () => {
    OriginalWebFunction = (
      await import("../../fixtures/v4/components/aws/web-function")
    ).WebFunction;
    WebFunction = (await import("../../../src/components/aws/web-function"))
      .WebFunction;
    await import("../../../src/components/aws/takeover/index");
    // SST 4's for SST 4's side, SST 5's for SST 5's
    SidedFunction = await sidedClass(
      "Function",
      import("../../fixtures/v4/components/aws/function"),
      import("../../../src/components/aws/function"),
    );
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const ofType = (type: string) =>
    pulumi.resources.filter((r) => r.type === type);
  const policyOf = (role: string) =>
    JSON.parse(resource(role).inputs.inlinePolicies[0].policy);
  const trustOf = (role: string) =>
    JSON.parse(resource(role).inputs.assumeRolePolicy);

  // Each case deploys SST 4's WebFunction, then the same thing as SST 5's.
  // Everything SST 4's created has to be kept by SST 5's, with the same
  // inputs: the code's zip is the same, so no new revision is made.
  describe("takes over a deployed WebFunction", () => {
    pulumi.takeoverCases<WebFunctionClass, WebFunctionClass>({
      original: () => OriginalWebFunction,
      v5: () => WebFunction,
      // SST 4's code waited for every resource of what it's linked to, as
      // a link's name is read from the linked component. SST 5's is built
      // from the links without depending on them, so a part of a linked
      // component can link the web function back. Nothing in AWS needs the
      // order: the code is a file in the web function's own bucket.
      needlessOrder: /^Web(Code|Revision) before MyBucket\w*$/,
      // What's deployed is there: a case where both sides failed to build
      // would compare nothing
      check: () => {
        expect(resource("WebLogGroup").type).toBe(
          "aws:cloudwatch/logGroup:LogGroup",
        );
        // @ts-ignore
        if (!global.$dev) expect(resource("WebEndpoint")).toBeDefined();
      },
      cases: {
        "a server from its entrypoint": (WebFunction, opts) => {
          new WebFunction("Web", { entrypoint: "src/server.ts" }, opts);
        },
        "a server with everything it's run with": (WebFunction, opts) => {
          new WebFunction(
            "Web",
            {
              entrypoint: "src/server.ts",
              environment: { GREETING: "hi" },
              permissions: [
                { actions: ["ses:SendEmail"], resources: ["*"] },
                {
                  effect: "deny",
                  actions: ["s3:DeleteObject"],
                  resources: ["*"],
                },
              ],
              nodejs: { install: ["pg"], format: "cjs", minify: false },
              copyFiles: [{ from: "public", to: "static" }],
              timeout: "2 minutes",
              maxConcurrencyPerEnvironment: 32,
              scaling: { maxEnvironments: 20, rateLimit: 1000 },
              url: { authorization: "iam" },
              logging: {
                retention: "1 week",
                applicationLogLevel: "WARN",
                systemLogLevel: "DEBUG",
              },
            },
            opts,
          );
        },
        "a prebuilt bundle": (WebFunction, opts) => {
          new WebFunction(
            "Web",
            { bundle: "dist", entrypoint: "server.mjs" },
            opts,
          );
        },
        "a server linked to a bucket": async (WebFunction, opts) => {
          const { Bucket } = await import("../../../src/components/aws/bucket");
          new WebFunction(
            "Web",
            { entrypoint: "src/server.ts", link: [new Bucket("MyBucket")] },
            opts,
          );
        },
        "resources transformed": (WebFunction, opts) => {
          new WebFunction(
            "Web",
            {
              entrypoint: "src/server.ts",
              transform: {
                role: { description: "runs the server" },
                logGroup: { tags: { team: "web" } },
                function: { tags: { team: "web" } },
                revision: (args) => {
                  args.description = "the server";
                },
                endpoint: { description: "the server's endpoint" },
              },
            },
            opts,
          );
        },
        // In `sst dev`, only the log group and the role are deployed. SST 4's
        // created a component for the pane `sst dev` shows; SST 5's reports
        // it in its outputs.
        "linked from a function": (WebFunction, opts) => {
          const web = new WebFunction(
            "Web",
            { entrypoint: "src/server.ts", url: { authorization: "iam" } },
            opts,
          );
          new SidedFunction(
            "Caller",
            { handler: "src/caller.handler", link: [web] },
            opts,
          );
        },
        "in sst dev": {
          create: (WebFunction, opts) => {
            // @ts-ignore
            global.$dev = true;
            new WebFunction(
              "Web",
              {
                entrypoint: "src/server.ts",
                dev: {
                  command: "tsx watch src/server.ts",
                  url: "http://localhost:3000",
                },
              },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::WebDev"],
          changed: [["Web", ["outputs"]]],
          check: () => {
            expect(ofType("aws:lambdaweb/function:Function")).toEqual([]);
            expect(pulumi.reportOf("Web")).toHaveProperty("dev");
          },
        },
        "in sst dev, linked, with a bundle": {
          create: async (WebFunction, opts) => {
            const { Bucket } = await import(
              "../../../src/components/aws/bucket"
            );
            // @ts-ignore
            global.$dev = true;
            new WebFunction(
              "Web",
              {
                bundle: "dist",
                entrypoint: "server.mjs",
                link: [new Bucket("MyBucket")],
              },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::WebDev"],
          changed: [["Web", ["outputs"]]],
          check: () =>
            expect(pulumi.reportOf("Web")?.dev.links).toEqual(["MyBucket"]),
        },
        "in sst dev, deployed": {
          create: (WebFunction, opts) => {
            // @ts-ignore
            global.$dev = true;
            new WebFunction(
              "Web",
              { entrypoint: "src/server.ts", dev: false },
              opts,
            );
          },
          check: () => {
            expect(resource("WebEndpoint")).toBeDefined();
            expect(pulumi.reportOf("Web")).not.toHaveProperty("dev");
          },
        },
      },
    });
  });

  it("creates the code bucket, the web function, its revision and its endpoint", async () => {
    const web = new WebFunction("Web", { entrypoint: "src/server.ts" });
    await pulumi.settle();

    expect(Object.keys(web.nodes).sort()).toEqual([
      "codeBucket",
      "codeBucketPolicy",
      "codeObject",
      "codePublicAccessBlock",
      "endpoint",
      "function",
      "localLogGroup",
      "logGroup",
      "revision",
      "role",
      "versioning",
    ]);
    // Named as SST 4 named them
    expect(
      pulumi.resources
        .filter((r) => !r.custom || r.name.startsWith("Web"))
        .map((r) => r.name)
        .filter((n) => n.startsWith("Web"))
        .sort(),
    ).toEqual([
      "Web",
      "WebCode",
      "WebCodeBucket",
      "WebCodeBucketPolicy",
      "WebCodePublicAccessBlock",
      "WebCodeVersioning",
      "WebEndpoint",
      "WebFunction",
      "WebLocalLogGroup",
      "WebLogGroup",
      "WebRevision",
      "WebRole",
    ]);
    const endpoint = resource("WebEndpoint").inputs;
    expect(endpoint).toMatchObject({
      endpointName: "default",
      endpointType: "HomeRegion",
      authType: "ApplicationManaged",
      autoDeploymentMode: "Disabled",
    });
    expect(resource("WebFunction").inputs.functionName).toMatch(/Web/);
    expect(resource("WebCode").inputs.key).toMatch(/^code\/[0-9a-f]{64}\.zip$/);
    expect(pulumi.reportOf("Web")).toHaveProperty("hint");
    // The revision's variables say where the server and the links are
    const variables =
      resource("WebRevision").inputs.serviceConfig.environmentVariables.value;
    expect(variables).toMatchObject({
      SST_KEY_FILE: "resource.enc",
      AWS_LAMBDA_NODEJS_ENTRYPOINT: "server.mjs",
    });
    expect(variables).toHaveProperty("SST_KEY");
    expect(variables).toHaveProperty("SST_RESOURCE_App");
  });

  it("puts the links and the copied files in the code, with the resource file of a bundle", async () => {
    const { Bucket } = await import("../../../src/components/aws/bucket");
    new WebFunction("Web", {
      bundle: "dist",
      entrypoint: "server.mjs",
      link: [new Bucket("MyBucket")],
      copyFiles: [{ from: "public", to: "static" }],
    });
    await pulumi.settle();

    const zip = resource("WebCode").inputs.source;
    // File names are stored uncompressed in a zip's headers
    const names = fs.readFileSync(zip.path).toString("latin1");
    expect(names).toContain("server.mjs");
    expect(names).toContain(".sst/Web/resource.enc");
    expect(names).toContain("static/index.html");
    expect(
      resource("WebRevision").inputs.serviceConfig.environmentVariables.value
        .SST_KEY_FILE,
    ).toBe(".sst/Web/resource.enc");
    const actions = policyOf("WebRole").statements.flatMap(
      (s: any) => s.actions,
    );
    expect(actions).toContain("logs:PutLogEvents");
    expect(actions.some((a: string) => a.startsWith("s3:"))).toBe(true);
  });

  it("lets only Lambda assume the role outside sst dev", async () => {
    new WebFunction("Web", { entrypoint: "src/server.ts" });
    await pulumi.settle();
    expect(trustOf("WebRole").statements).toHaveLength(1);
  });

  it("can be linked to what links it back: a queue's subscriber, a router's route", async () => {
    const { Queue } = await import("../../../src/components/aws/queue");
    const queue = new Queue("Jobs");
    const web = new WebFunction("Web", {
      entrypoint: "src/server.ts",
      link: [queue],
    });
    queue.subscribe({ handler: "src/caller.handler", link: [web] });
    await pulumi.settle();
    const names = () => pulumi.resources.map((r) => r.name);
    expect(names()).toContain("WebEndpoint");
    expect(ofType("aws:lambda/function:Function")).toHaveLength(1);

    pulumi.reset();
    const { Router } = await import("../../../src/components/aws/router");
    const router = new Router("Router");
    const routed = new WebFunction("Web", {
      entrypoint: "src/server.ts",
      link: [router],
    });
    router.route("/", routed.url);
    await pulumi.settle();
    expect(names()).toContain("WebEndpoint");
    expect(names().filter((n) => /^Router.*Route/.test(n))).not.toEqual([]);
  });

  it("is linked as its URL and ARNs, with the permission to call an IAM endpoint", async () => {
    const { Function } = await import("../../../src/components/aws/function");
    const web = new WebFunction("Web", {
      entrypoint: "src/server.ts",
      url: { authorization: "iam" },
    });
    new Function("Caller", { handler: "src/caller.handler", link: [web] });
    await pulumi.settle();

    expect(resource("WebEndpoint").inputs.authType).toBe("IamAuth");
    const statement = policyOf("CallerRole").statements.find((s: any) =>
      s.actions.includes("lambda:InvokeWebFunctionEndpoint"),
    );
    expect(statement).toBeDefined();
    const properties = web.link().properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "arn",
      "endpointArn",
      "url",
    ]);
  });

  it("uses a role given in existing, and refuses permissions next to it", async () => {
    new WebFunction("Web", {
      entrypoint: "src/server.ts",
      existing: { role: "my-role" },
    });
    await pulumi.settle();
    expect(ofType(ROLE).filter((r) => !r.custom)).toEqual([]);

    pulumi.reset();
    expect(
      () =>
        new WebFunction("Web", {
          entrypoint: "src/server.ts",
          existing: { role: "my-role" },
          permissions: [{ actions: ["s3:*"], resources: ["*"] }],
        }),
    ).toThrow(/permissions/);
  });

  it("refuses the parts it creates from its code in existing", () => {
    for (const key of [
      "logGroup",
      "codeBucket",
      "codeObject",
      "function",
      "endpoint",
    ]) {
      pulumi.reset();
      expect(
        () =>
          new WebFunction("Web", {
            entrypoint: "src/server.ts",
            existing: { [key]: "x" } as any,
          }),
      ).toThrow(
        new RegExp(
          `"existing.${key}" isn't an option for the "Web" web function`,
        ),
      );
    }
  });

  it("refuses what it's built from as an output", () => {
    expect(
      () =>
        new WebFunction("Web", { entrypoint: output("src/server.ts") as any }),
    ).toThrow(/"entrypoint" of the "Web" web function has to be a plain value/);
    expect(
      () =>
        new WebFunction("Web", {
          entrypoint: "src/server.ts",
          dev: output(false) as any,
        }),
    ).toThrow(/"dev" of the "Web" web function has to be a plain value/);
  });

  it("refuses an entrypoint it can't build, and settings Lambda doesn't take", () => {
    for (const [args, message] of [
      [{}, /needs an entrypoint/],
      [{ entrypoint: " " }, /can't be empty/],
      [{ entrypoint: "src/missing.ts" }, /can't find its entrypoint/],
      [{ entrypoint: "src/twice.ts" }, /ambiguous/],
      [
        { bundle: "dist", entrypoint: "missing.mjs" },
        /must be a file inside its bundle, "dist"/,
      ],
      [
        { bundle: "dist", entrypoint: "../src/server.ts" },
        /must be a file inside its bundle/,
      ],
      [
        { bundle: "dist", entrypoint: "server.ts" },
        /must be a JavaScript file, as it has a "bundle"/,
      ],
      [
        { entrypoint: "src/server.ts", timeout: "1 second" },
        /"timeout".*from 3 seconds to 15 minutes/,
      ],
      [
        { entrypoint: "src/server.ts", timeout: "1 hour" },
        /whole number of seconds or minutes/,
      ],
      [
        { entrypoint: "src/server.ts", maxConcurrencyPerEnvironment: 0 },
        /from 1 to 128/,
      ],
      [
        { entrypoint: "src/server.ts", scaling: { rateLimit: 150 } },
        /isn't a rate Lambda takes/,
      ],
      [
        { entrypoint: "src/server.ts", environment: { AWS_REGION: "x" } },
        /one Lambda or SST sets/,
      ],
      [
        { entrypoint: "src/server.ts", environment: { "1X": "x" } },
        /isn't a valid name/,
      ],
      [
        {
          entrypoint: "src/server.ts",
          copyFiles: [{ from: "public", to: "../out" }],
        },
        /must be inside its code/,
      ],
    ] as const) {
      pulumi.reset();
      expect(() => new WebFunction("Web", args as any)).toThrow(message);
    }
  });

  it("refuses an endpoint authorization it doesn't know", async () => {
    let error: Error | undefined;
    await rejectionsOf(async () => {
      const web = new WebFunction("Web", {
        entrypoint: "src/server.ts",
        url: { authorization: output("public" as any) },
      });
      error = await (web.nodes.endpoint.authType as any)
        .promise()
        .catch((e: Error) => e);
      await pulumi.settle();
    });
    expect(error?.message).toMatch(/"url.authorization".*"none" or "iam"/);
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    it("runs the server locally as the role, with its pane named after it", async () => {
      const { Bucket } = await import("../../../src/components/aws/bucket");
      const web = new WebFunction("Web", {
        entrypoint: "src/server.ts",
        link: [new Bucket("MyBucket")],
        environment: { GREETING: "hi" },
        dev: { url: "http://127.0.0.1:3000/app" },
      });
      await pulumi.settle();

      expect(ofType("aws:s3/bucketObjectv2:BucketObjectv2")).toEqual([]);
      expect(
        ofType("aws:cloudwatch/logGroup:LogGroup").map((r) => r.name),
      ).toEqual(["WebLogGroup"]);
      const report = pulumi.reportOf("Web")!;
      expect(report.hint).toBe("http://127.0.0.1:3000/app");
      expect(report.dev).toMatchObject({
        title: "Web",
        autostart: true,
        command: "node --watch 'src/server.ts'",
        links: ["MyBucket"],
        aws: { role: expect.stringContaining("WebRole") },
      });
      expect(report.dev.environment).toMatchObject({
        GREETING: "hi",
        AWS_LAMBDA_HTTP_ENDPOINT: "127.0.0.1:3000",
      });
      expect(report.dev.environment).toHaveProperty("SST_RESOURCE_App");
      expect(report.dev.environment).toHaveProperty("AWS_REGION");
      // The links' properties are given to the command by `sst dev`
      expect(report.dev.environment).not.toHaveProperty(
        "SST_RESOURCE_MyBucket",
      );
      // The CLI assumes the role to run the command
      expect(trustOf("WebRole").statements).toHaveLength(2);

      expect(await (web.url as any).promise()).toBe(
        "http://127.0.0.1:3000/app",
      );
      expect(web.arn).toBeUndefined();
      expect(web.endpointArn).toBeUndefined();
      expect(web.revisionArn).toBeUndefined();
      for (const part of [
        "function",
        "revision",
        "endpoint",
        "codeBucket",
      ] as const)
        expect(() => web.nodes[part]).toThrow(
          new RegExp(`\`nodes.${part}\` of "Web"`),
        );
      expect(Object.keys(web.link().properties)).toEqual(["url"]);
    });

    it("reports the pane SST 4's created, less the links' properties sst dev gives it", async () => {
      const { Bucket } = await import("../../../src/components/aws/bucket");
      const args = {
        entrypoint: "src/server.ts",
        environment: { GREETING: "hi" },
        dev: { url: "http://127.0.0.1:3000", directory: "src" },
      };
      new OriginalWebFunction("Web", {
        ...args,
        link: [new Bucket("MyBucket")],
      });
      await pulumi.settle();
      const {
        links: _links,
        environment: before,
        ...old
      } = pulumi.outputsOf("WebDev")!._dev;

      pulumi.reset();
      // @ts-ignore
      global.$dev = true;
      new WebFunction("Web", { ...args, link: [new Bucket("MyBucket")] });
      await pulumi.settle();
      const { links, environment, ...now } = pulumi.reportOf("Web")!.dev;
      expect(now).toEqual(old);
      expect(links).toEqual(["MyBucket"]);
      const { SST_RESOURCE_MyBucket, ...rest } = before;
      expect(SST_RESOURCE_MyBucket).toBeDefined();
      expect(environment).toEqual(rest);
    });

    it("runs with a role given in existing, as it is", async () => {
      new WebFunction("Web", {
        entrypoint: "src/server.ts",
        existing: { role: "my-role" },
      });
      await pulumi.settle();
      expect(ofType(ROLE).filter((r) => !r.custom)).toEqual([]);
      // The one looked up, which the CLI assumes as it is
      expect(pulumi.reportOf("Web")!.dev.aws.role).toBeDefined();
    });

    it("runs the command from the bundle, or the directory given", async () => {
      new WebFunction("Web", { bundle: "dist", entrypoint: "server.mjs" });
      await pulumi.settle();
      expect(pulumi.reportOf("Web")!.dev).toMatchObject({
        directory: "dist",
        command: "node --watch 'server.mjs'",
      });

      pulumi.reset();
      new WebFunction("Web", {
        bundle: "dist",
        entrypoint: "server.mjs",
        dev: { directory: ".", autostart: false },
      });
      await pulumi.settle();
      expect(pulumi.reportOf("Web")!.dev).toMatchObject({
        directory: ".",
        autostart: false,
        command: "node --watch 'dist/server.mjs'",
      });
    });
  });
});
