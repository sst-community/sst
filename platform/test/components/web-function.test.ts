import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as pulumi from "@pulumi/pulumi";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build as bundleTest } from "esbuild";

const fixture = vi.hoisted(() => ({ out: "", errors: [] as string[] }));
const build = vi.hoisted(() => vi.fn());

vi.mock("../../src/components/rpc/rpc", () => ({
  rpc: {
    call: async (method: string, input: unknown) => {
      if (method !== "Runtime.Build")
        throw new Error(`Unexpected RPC: ${method}`);
      build(input);
      return {
        handler: "index.main",
        out: fixture.out,
        errors: fixture.errors,
        sourcemaps: [],
      };
    },
  },
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-function-"));
const platformRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repositoryRoot = path.dirname(platformRoot);
const out = path.join(root, "bundle");
fs.mkdirSync(out);
fixture.out = out;

// @ts-ignore
global.$app = { name: "app", stage: "test", home: "aws" };
global.$util = pulumi;
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$cli = {
  paths: { root, work: path.join(root, ".sst"), platform: root },
  state: { version: {} },
};

interface CreatedResource {
  type: string;
  name: string;
  inputs: Record<string, any>;
}

const resources: CreatedResource[] = [];
const registrations: string[] = [];
const componentOutputs = vi.spyOn(
  pulumi.ComponentResource.prototype as unknown as {
    registerOutputs(outputs: pulumi.Inputs): void;
  },
  "registerOutputs",
);

pulumi.runtime.setMocks(
  {
    async newResource(args) {
      resources.push({ type: args.type, name: args.name, inputs: args.inputs });
      // Check an explicit stack dependency, rather than declaration order.
      if (args.type === "aws:s3/bucketPolicy:BucketPolicy")
        await new Promise((resolve) => setTimeout(resolve, 25));
      registrations.push(args.name);
      const state = {
        ...args.inputs,
        arn:
          args.type === "aws:s3/bucket:Bucket"
            ? `arn:aws:s3:::${args.inputs.bucket}`
            : `arn:aws:test:us-east-1:111111111111:${args.name}`,
        name: args.inputs.name ?? args.name,
        bucket: args.inputs.bucket ?? args.name.toLowerCase(),
        versionId: `${args.name}-version`,
        outputs: {
          FunctionArn: `arn:aws:lambda:us-east-1:111111111111:web-function:${args.name}`,
          RevisionArn: `arn:aws:lambda:us-east-1:111111111111:web-function-revision:${args.name}`,
          EndpointArn: `arn:aws:lambda:us-east-1:111111111111:web-function-endpoint:${args.name}`,
          DomainName: `${args.name.toLowerCase()}.example.com`,
        },
      };
      return { id: `${args.name}_id`, state };
    },
    call(args) {
      switch (args.token) {
        case "aws:index/getCallerIdentity:getCallerIdentity":
          return { accountId: "111111111111" };
        case "aws:index/getPartition:getPartition":
          return { partition: "aws" };
        case "aws:index/getRegion:getRegion":
          return { name: "us-east-1", region: "us-east-1" };
        case "aws:iam/getPolicyDocument:getPolicyDocument":
          return {
            ...args.inputs,
            json: JSON.stringify({
              Version: "2012-10-17",
              Statement: (args.inputs.statements ?? []).map(
                (statement: any) => ({
                  Effect: statement.effect ?? "Allow",
                  Action: statement.actions,
                  Resource: statement.resources,
                  Principal: statement.principals
                    ? Object.fromEntries(
                        statement.principals.map((principal: any) => [
                          principal.type,
                          principal.identifiers,
                        ]),
                      )
                    : undefined,
                  Condition: statement.conditions
                    ? Object.fromEntries(
                        [
                          ...new Set(
                            statement.conditions.map(
                              (condition: any) => condition.test,
                            ),
                          ),
                        ].map((test) => [
                          test,
                          Object.fromEntries(
                            statement.conditions
                              .filter(
                                (condition: any) => condition.test === test,
                              )
                              .map((condition: any) => [
                                condition.variable,
                                condition.values,
                              ]),
                          ),
                        ]),
                      )
                    : undefined,
                }),
              ),
            }),
          };
        default:
          throw new Error(`Unexpected AWS invoke: ${args.token}`);
      }
    },
  },
  "project",
  "stack",
  false,
);

// Pulumi Output's promise observes failures as well as successful values. Using
// apply alone would leave a failure assertion waiting forever.
function resolved<T>(input: pulumi.Input<T>): Promise<T> {
  return (
    pulumi.output(input) as unknown as { promise(): Promise<T> }
  ).promise();
}

function ofType(type: string) {
  return resources.filter((resource) => resource.type === type);
}

function named(name: string, type: string) {
  const resource = resources.find(
    (item) => item.name === name && item.type === type,
  );
  expect(resource, `Expected ${type} ${name}`).toBeDefined();
  return resource!;
}

function template(name: string) {
  return JSON.parse(
    unwrapSecret(
      named(`${name}Stack`, "aws:cloudformation/stack:Stack").inputs
        .templateBody,
    ),
  );
}

function unwrapSecret(value: any): any {
  return value &&
    typeof value === "object" &&
    "4dabf18193072939515e22adb298388d" in value &&
    "value" in value
    ? unwrapSecret(value.value)
    : value;
}

async function archive(name: string) {
  const code = named(`${name}Code`, "aws:s3/bucketObjectv2:BucketObjectv2");
  const zip = fs.readFileSync(await code.inputs.source.path);
  // Read the central directory; no system unzip or provider/network calls.
  const names: string[] = [];
  const contents = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  for (let offset = zip.length - 22; offset >= 0; offset--) {
    if (zip.readUInt32LE(offset) !== 0x06054b50) continue;
    let directory = zip.readUInt32LE(offset + 16);
    const count = zip.readUInt16LE(offset + 10);
    for (let index = 0; index < count; index++) {
      expect(zip.readUInt32LE(directory)).toBe(0x02014b50);
      const length = zip.readUInt16LE(directory + 28);
      const name = zip
        .subarray(directory + 46, directory + 46 + length)
        .toString();
      names.push(name);
      modes.set(name, zip.readUInt32LE(directory + 38) >>> 16);
      const local = zip.readUInt32LE(directory + 42);
      const start =
        local +
        30 +
        zip.readUInt16LE(local + 26) +
        zip.readUInt16LE(local + 28);
      const compressed = zip.subarray(
        start,
        start + zip.readUInt32LE(directory + 20),
      );
      contents.set(
        name,
        zip.readUInt16LE(directory + 10) === 0
          ? compressed
          : inflateRawSync(compressed),
      );
      directory +=
        46 +
        length +
        zip.readUInt16LE(directory + 30) +
        zip.readUInt16LE(directory + 32);
    }
    return {
      names,
      contents,
      modes,
      hash: crypto.createHash("sha256").update(zip).digest("hex"),
      code,
    };
  }
  throw new Error("ZIP central directory was not found");
}

function environment(name: string) {
  const config = template(name);
  const variables =
    config.Resources.Revision.Properties.ServiceConfig.EnvironmentVariables;
  const parameters = unwrapSecret(
    named(`${name}Stack`, "aws:cloudformation/stack:Stack").inputs.parameters,
  );
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [
      key,
      typeof value === "object" && value !== null && "Ref" in value
        ? parameters[(value as { Ref: string }).Ref]
        : value,
    ]),
  );
}

function fixtureFile(file: string, content = "excluded") {
  const target = path.join(out, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// Failed Pulumi Outputs fan out into many derived promises. Keep failure cases
// isolated, record every rejection, and reject unknown errors rather than hiding
// them from the main test runner. The child has mocked RPC and AWS throughout.
async function buildFailureHarness() {
  const target = path.join(root, "failure.cjs");
  fs.symlinkSync(
    path.join(repositoryRoot, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await bundleTest({
    stdin: {
      resolveDir: platformRoot,
      contents: `
        import * as pulumi from "@pulumi/pulumi";
        import { WebFunction } from "./src/components/aws/web-function";
        const root = process.argv[2];
        const mode = process.argv[3];
        global.$app = {name:"app",stage:"test"};
        global.$util = pulumi;
        global.$dev = false;
        global.$cli = {paths:{root,work:root+"/.sst",platform:root},state:{version:{}}};
        const registered = [];
        const errors = [];
        process.on("unhandledRejection", error => errors.push(String(error?.message ?? error)));
        pulumi.runtime.setMocks({
          newResource(args) {
            registered.push(args.type);
            return {id:args.name,state:{...args.inputs,arn:"arn:aws:test:::"+args.name,bucket:args.name,versionId:"v1"}};
          },
          call(args) {
            if(args.token.includes("getRegion")) return {region:"us-east-1",name:"us-east-1"};
            if(args.token.includes("getPartition")) return {partition:"aws"};
            if(args.token.includes("getPolicyDocument")) return {...args.inputs,json:"{}"};
            if(args.token.includes("getCallerIdentity")) return {accountId:"111111111111"};
            throw new Error("Unexpected AWS invoke: "+args.token);
          }
        },"project","stack",false);
        (async () => {
          let message;
          try {
            const bundleCase = mode.startsWith("env") || mode.startsWith("symlink");
            const fn = new WebFunction("Failed", {
              entrypoint:bundleCase ? "index.mjs" : mode === "missing" ? "not-found.ts" : "src/server.ts",
              ...(bundleCase ? {bundle:root+"/bundle"} : {}),
              ...(mode === "envCount" ? {environment:Object.fromEntries(Array.from({length:200},(_,i)=>["KEY"+i,"x"]))} : {}),
              ...(mode === "envBytes" ? {environment:{LARGE:"あ".repeat(1366)}} : {}),
              ...(mode === "envTotal" ? {environment:Object.fromEntries(Array.from({length:8},(_,i)=>["KEY"+i,"a".repeat(4096)]))} : {}),
              ...(mode === "envEmpty" ? {environment:{EMPTY:""}} : {}),
              ...(mode === "symlinkCopy" ? {copyFiles:[{from:"copy-symlink",to:"relocated"}]} : {}),
            });
            await fn.url.promise();
          } catch(error) { message = String(error.message); }
          await new Promise(resolve=>setTimeout(resolve,100));
          console.log(JSON.stringify({message,registered,errors}));
        })().catch(error=>{console.error(error);process.exitCode=1;});
      `,
    },
    outfile: target,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    logLevel: "silent",
    plugins: [
      {
        name: "offline-rpc",
        setup(plugin) {
          plugin.onLoad({ filter: /components\/rpc\/rpc\.ts$/ }, () => ({
            contents: `export const rpc={call:async(method)=>{
            if(method!=="Runtime.Build")throw new Error("Unexpected RPC: "+method);
            return {handler:"index.main",out:"",errors:["Cannot resolve dependency"],sourcemaps:[]};
          }};`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  return target;
}

describe("WebFunction", () => {
  let WebFunction: typeof import("../../src/components/aws/web-function").WebFunction;
  let failureHarness: string;

  beforeAll(async () => {
    WebFunction = (await import("../../src/components/aws/web-function"))
      .WebFunction;
    failureHarness = await buildFailureHarness();
  });

  beforeEach(() => {
    resources.length = 0;
    registrations.length = 0;
    componentOutputs.mockClear();
    build.mockClear();
    fixture.errors = [];
    // @ts-ignore
    global.$dev = false;
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out);
    fixtureFile("index.mjs", "import 'node:http';\n");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "server.ts"),
      "import 'node:http';\n",
    );
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("deploys HTTP Web Function resources without an event-driven Lambda", async () => {
    const fn = new WebFunction("Http", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    expect(await resolved(fn.url)).toBe("https://httpstack.example.com");

    const config = template("Http");
    expect(Object.keys(config.Resources).sort()).toEqual([
      "Endpoint",
      "Function",
      "Revision",
    ]);
    expect(config.Resources.Function.Type).toBe("AWS::Lambda::WebFunction");
    expect(config.Resources.Function.Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: "sst:app", Value: "app" },
        { Key: "sst:stage", Value: "test" },
      ]),
    );
    expect(config.Resources.Revision.Properties).not.toHaveProperty("Tags");
    expect(config.Resources.Endpoint.Properties).not.toHaveProperty("Tags");
    expect(config.Resources.Revision.Type).toBe(
      "AWS::Lambda::WebFunctionRevision",
    );
    expect(config.Resources.Endpoint.Type).toBe(
      "AWS::Lambda::WebFunctionEndpoint",
    );
    expect(config.Resources.Endpoint.Properties).toMatchObject({
      AuthType: "ApplicationManaged",
      EndpointType: "HomeRegion",
      RevisionWeights: [
        {
          RevisionId: { "Fn::GetAtt": ["Revision", "RevisionId"] },
          Weight: 100,
        },
      ],
    });
    expect(config.Resources.Revision.Properties).toMatchObject({
      BuildConfig: { RuntimeConfig: { Runtime: "nodejs24.x" } },
      ServiceConfig: { TimeoutSeconds: 30, MaxConcurrencyPerEnvironment: 64 },
    });
    expect(ofType("aws:lambda/function:Function")).toHaveLength(0);
    expect(ofType("aws:lambda/functionUrl:FunctionUrl")).toHaveLength(0);
    expect(build).not.toHaveBeenCalled();
    expect(await resolved(fn.arn)).toContain(":web-function:");
    expect(await resolved(fn.endpointArn)).toContain(":web-function-endpoint:");
    expect(
      named("HttpStack", "aws:cloudformation/stack:Stack").inputs.name,
    ).toMatch(/^app-test-/);
    const hint = componentOutputs.mock.calls
      .map(([value]) => value)
      .find((value) => "_hint" in value);
    expect(hint).toBeDefined();
    expect(await resolved(hint!._hint)).toBe(await resolved(fn.url));
  });

  it("keeps function identity independent of a transformed log group name", async () => {
    const fn = new WebFunction("CustomLogGroup", {
      entrypoint: "index.mjs",
      bundle: out,
      transform: {
        logGroup: { name: "/custom/logs/my-http-api", retentionInDays: 7 },
      },
    });
    await resolved(fn.url);
    const config = template("CustomLogGroup");
    const bucket = named("CustomLogGroupCodeBucket", "aws:s3/bucket:Bucket");
    expect(config.Resources.Function.Properties.FunctionName).toBe(
      bucket.inputs.bucket,
    );
    expect(
      config.Resources.Revision.Properties.ServiceConfig.TelemetryConfig
        .LoggingConfig.LogGroup,
    ).toBe("/custom/logs/my-http-api");
    expect(await resolved(fn.nodes.localLogGroup!.name)).toBe(
      "/custom/logs/my-http-api.local",
    );
    expect(await resolved(fn.nodes.localLogGroup!.retentionInDays)).toBe(7);
    expect(await resolved(fn.nodes.logGroup.retentionInDays)).toBe(7);
  });

  it("creates the local CloudWatch group with the central name and retention", async () => {
    const fn = new WebFunction("LogGroups", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(fn.url);
    expect(ofType("aws:cloudwatch/logGroup:LogGroup")).toHaveLength(2);
    expect(fn.nodes.localLogGroup).toBeDefined();
    const centralName = await resolved(fn.nodes.logGroup.name);
    const retention = await resolved(fn.nodes.logGroup.retentionInDays);
    expect(await resolved(fn.nodes.localLogGroup!.name)).toBe(
      `${centralName}.local`,
    );
    expect(await resolved(fn.nodes.localLogGroup!.retentionInDays)).toBe(
      retention,
    );
  });

  it("limits log writes to both log groups without granting code-bucket access", async () => {
    const fn = new WebFunction("LogPermissions", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(fn.url);
    const role = named("LogPermissionsRole", "aws:iam/role:Role");
    const statements = role.inputs.inlinePolicies.flatMap(
      (item: any) => JSON.parse(item.policy).Statement,
    );
    expect(statements).toHaveLength(1);
    expect(statements[0].Action.sort()).toEqual([
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]);
    expect(statements[0].Resource.sort()).toEqual(
      [
        `${await resolved(fn.nodes.logGroup.arn)}:*`,
        `${await resolved(fn.nodes.localLogGroup!.arn)}:*`,
      ].sort(),
    );
    expect(
      statements.some((statement: any) =>
        statement.Action.some((action: string) => action.startsWith("s3:")),
      ),
    ).toBe(false);
  });

  it("pins revisions to a versioned object in a private code bucket", async () => {
    const fn = new WebFunction("Pinned", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(fn.url);
    const code = (await archive("Pinned")).code;
    const versioning = named(
      "PinnedCodeVersioning",
      "aws:s3/bucketVersioning:BucketVersioning",
    );
    const block = named(
      "PinnedCodePublicAccessBlock",
      "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock",
    );
    expect(versioning.inputs.versioningConfiguration.status).toBe("Enabled");
    expect(block.inputs).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(code.inputs.bucket).toBe(versioning.inputs.bucket);
    expect(code.inputs.key).toBe("code.zip");
    expect(
      template("Pinned").Resources.Revision.Properties.BuildConfig.CodeConfig,
    ).toEqual({
      S3Object: {
        Bucket: code.inputs.bucket,
        Key: "code.zip",
        VersionId: "PinnedCode-version",
      },
    });
    expect(registrations.indexOf("PinnedCodeVersioning")).toBeLessThan(
      registrations.indexOf("PinnedCode"),
    );
  });

  it("grants Lambda revision access to code.zip before creating the stack", async () => {
    const fn = new WebFunction("ArtifactAccess", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(fn.url);
    const policy = named(
      "ArtifactAccessCodeBucketPolicy",
      "aws:s3/bucketPolicy:BucketPolicy",
    );
    const bucket = named("ArtifactAccessCodeBucket", "aws:s3/bucket:Bucket");
    const statements = JSON.parse(policy.inputs.policy).Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Principal).toEqual({
      Service: "lambda.amazonaws.com",
    });
    expect(statements[0].Action).toEqual(
      expect.arrayContaining(["s3:GetObject", "s3:GetObjectVersion"]),
    );
    expect(statements[0].Resource).toBe(
      `arn:aws:s3:::${bucket.inputs.bucket}/code.zip`,
    );
    expect(statements[0].Condition.StringEquals["aws:SourceAccount"]).toBe(
      "111111111111",
    );
    expect(statements[0].Condition.ArnLike["aws:SourceArn"]).toBe(
      `arn:aws:lambda:us-east-1:111111111111:web-function/${bucket.inputs.bucket}/revision/*`,
    );
    expect(
      registrations.indexOf("ArtifactAccessCodeBucketPolicy"),
    ).toBeLessThan(registrations.indexOf("ArtifactAccessStack"));
  });

  it("passes environment values through secret NoEcho parameters instead of template plaintext", async () => {
    const value = "secret-fixture-value-123";
    const fn = new WebFunction("SecretEnvironment", {
      entrypoint: "index.mjs",
      bundle: out,
      environment: { TOKEN: pulumi.secret(value) },
    });
    await resolved(fn.url);
    const stack = named(
      "SecretEnvironmentStack",
      "aws:cloudformation/stack:Stack",
    );
    const config = template("SecretEnvironment");
    expect(unwrapSecret(stack.inputs.templateBody)).not.toContain(value);
    const reference =
      config.Resources.Revision.Properties.ServiceConfig.EnvironmentVariables
        .TOKEN.Ref;
    expect(config.Parameters[reference]).toEqual({
      Type: "String",
      NoEcho: true,
    });
    for (const parameter of Object.values(config.Parameters)) {
      expect(parameter).toEqual({ Type: "String", NoEcho: true });
      expect(parameter).not.toHaveProperty("Default");
    }
    expect(environment("SecretEnvironment").TOKEN).toBe(value);
    expect(await pulumi.isSecret(fn.nodes.stack!.parameters)).toBe(true);
  });

  it("updates parameters while keeping environment template references stable", async () => {
    const first = new WebFunction("EnvBefore", {
      entrypoint: "index.mjs",
      bundle: out,
      environment: { TOKEN: "before", MESSAGE: "unchanged" },
    });
    await resolved(first.url);
    const second = new WebFunction("EnvAfter", {
      entrypoint: "index.mjs",
      bundle: out,
      environment: { TOKEN: "after", MESSAGE: "unchanged" },
    });
    await resolved(second.url);
    expect(template("EnvBefore").Parameters).toEqual(
      template("EnvAfter").Parameters,
    );
    expect(
      template("EnvBefore").Resources.Revision.Properties.ServiceConfig
        .EnvironmentVariables,
    ).toEqual(
      template("EnvAfter").Resources.Revision.Properties.ServiceConfig
        .EnvironmentVariables,
    );
    expect(environment("EnvBefore").TOKEN).toBe("before");
    expect(environment("EnvAfter").TOKEN).toBe("after");
  });

  it("accepts 200 environment parameters including SST links and a 4096-byte value", async () => {
    const fn = new WebFunction("EnvironmentLimits", {
      entrypoint: "index.mjs",
      bundle: out,
      environment: Object.fromEntries(
        Array.from({ length: 199 }, (_, index) => [
          `KEY${index}`,
          index === 0 ? "a".repeat(4096) : "x",
        ]),
      ),
    });
    await resolved(fn.url);
    expect(Object.keys(template("EnvironmentLimits").Parameters)).toHaveLength(
      200,
    );
    expect(environment("EnvironmentLimits").KEY0).toHaveLength(4096);
  });

  it("builds TypeScript for Node 24 Arm64 and starts the generated module", async () => {
    const fn = new WebFunction("Built", { entrypoint: "src/server.ts" });
    await resolved(fn.url);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0]).toMatchObject({
      handler: path.join(root, "src/server.main"),
      runtime: "nodejs24.x",
      properties: { architecture: "arm64" },
    });
    expect(
      template("Built").Resources.Revision.Properties.ServiceConfig
        .EnvironmentVariables.AWS_LAMBDA_NODEJS_ENTRYPOINT,
    ).toBe("index.mjs");
    expect((await archive("Built")).names).toContain("index.mjs");
  });

  it("keeps ZIP bytes stable across timestamps and changes them when code changes", async () => {
    const first = new WebFunction("ZipFirst", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(first.url);
    const firstHash = (await archive("ZipFirst")).hash;
    fs.utimesSync(path.join(out, "index.mjs"), new Date(), new Date());
    const second = new WebFunction("ZipSecond", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(second.url);
    expect((await archive("ZipSecond")).hash).toBe(firstHash);
    fixtureFile("index.mjs", "console.log('changed');\n");
    const third = new WebFunction("ZipChanged", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(third.url);
    expect((await archive("ZipChanged")).hash).not.toBe(firstHash);
  });

  it("excludes SST metadata and Git files without dropping application assets", async () => {
    fixtureFile(".sst/Other/resource.enc");
    fixtureFile(".sst/platform/config.d.ts");
    fixtureFile(".git/config");
    fixtureFile("sst-env.d.ts");
    fixtureFile("nested/sst-env.d.ts");
    fixtureFile("resource.enc");
    fixtureFile("public/logo.svg", "<svg />");
    const fn = new WebFunction("Filtered", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(fn.url);
    expect((await archive("Filtered")).names.sort()).toEqual([
      "index.mjs",
      "public/logo.svg",
    ]);
  });

  it("preserves internal relative directory symlinks used by pnpm bundles", async () => {
    fixtureFile(
      "node_modules/.pnpm/demo/node_modules/demo/index.js",
      "export const answer = 42;",
    );
    fs.symlinkSync(
      ".pnpm/demo/node_modules/demo",
      path.join(out, "node_modules/demo"),
      "dir",
    );
    const fn = new WebFunction("InternalSymlink", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(fn.url);
    const zipped = await archive("InternalSymlink");
    expect(zipped.contents.get("node_modules/demo")?.toString()).toBe(
      ".pnpm/demo/node_modules/demo",
    );
    expect(zipped.modes.get("node_modules/demo")! & 0xf000).toBe(0xa000);
    expect(zipped.names).toContain(
      "node_modules/.pnpm/demo/node_modules/demo/index.js",
    );
  });

  it.each([false, true])(
    "packages copied files and recursive directories with prebuilt bundle=%s",
    async (prebuilt) => {
      const source = path.join(root, "copy-input");
      fs.mkdirSync(path.join(source, "nested"), { recursive: true });
      fs.writeFileSync(path.join(source, "config.json"), '{"copied":true}');
      fs.writeFileSync(path.join(source, "nested", "logo.txt"), "asset bytes");
      fixtureFile("config.json", "old config");
      const name = prebuilt ? "CopyPrebuilt" : "CopyBuilt";
      const fn = new WebFunction(name, {
        entrypoint: prebuilt ? "index.mjs" : "src/server.ts",
        ...(prebuilt ? { bundle: out } : {}),
        copyFiles: [
          { from: "copy-input/config.json", to: "config.json" },
          { from: "copy-input/nested", to: "public" },
        ],
      });
      await resolved(fn.url);
      const zipped = await archive(name);
      expect(zipped.names).toContain("config.json");
      expect(zipped.names).toContain("public/logo.txt");
      expect(zipped.contents.get("config.json")?.toString()).toBe(
        '{"copied":true}',
      );
      expect(zipped.contents.get("public/logo.txt")?.toString()).toBe(
        "asset bytes",
      );
    },
  );

  it("preserves Output inputs and configures IAM authorization and scaling", async () => {
    const fn = new WebFunction("Outputs", {
      entrypoint: pulumi.output("index.mjs"),
      bundle: pulumi.output(out),
      environment: pulumi.output({ MESSAGE: pulumi.output("resolved") }),
      timeout: pulumi.output("15 minutes"),
      maxConcurrencyPerEnvironment: pulumi.output(128),
      scaling: {
        maxEnvironments: pulumi.output(200),
        rateLimit: pulumi.output(1000),
      },
      url: { authorization: pulumi.output("iam") },
    });
    await resolved(fn.url);
    const config = template("Outputs");
    expect(config.Resources.Endpoint.Properties.AuthType).toBe("IamAuth");
    expect(config.Resources.Endpoint.Properties.ScalingConfig).toMatchObject({
      MaxEnvironments: 200,
    });
    expect(config.Resources.Endpoint.Properties.ThrottleConfig).toMatchObject({
      RateLimit: 1000,
    });
    expect(config.Resources.Revision.Properties.ServiceConfig).toMatchObject({
      TimeoutSeconds: 900,
      MaxConcurrencyPerEnvironment: 128,
    });
    expect(environment("Outputs")).toMatchObject({
      MESSAGE: "resolved",
      AWS_LAMBDA_NODEJS_ENTRYPOINT: "index.mjs",
    });
  });

  it("injects linked values and grants only requested resource permissions", async () => {
    const linked = {
      urn: pulumi.output("urn:pulumi:stack::project::sst:sst:Linkable::Files"),
      getSSTLink: () => ({
        properties: { name: pulumi.output("files-bucket") },
        include: [
          {
            type: "aws.permission",
            actions: ["s3:GetObject"],
            resources: ["arn:aws:s3:::files-bucket/*"],
          },
        ],
      }),
    };
    const fn = new WebFunction("Linked", {
      entrypoint: "index.mjs",
      bundle: out,
      link: [linked],
      permissions: [
        {
          actions: ["ses:SendEmail"],
          resources: [
            "arn:aws:ses:us-east-1:111111111111:identity/example.com",
          ],
        },
      ],
    });
    await resolved(fn.url);
    const linkedEnvironment = environment("Linked");
    expect(JSON.parse(linkedEnvironment.SST_RESOURCE_Files)).toMatchObject({
      name: "files-bucket",
      type: "sst.sst.Linkable",
    });
    expect(JSON.parse(linkedEnvironment.SST_RESOURCE_App)).toEqual({
      name: "app",
      stage: "test",
    });
    const role = named("LinkedRole", "aws:iam/role:Role");
    const statements = role.inputs.inlinePolicies.flatMap(
      (item: any) => JSON.parse(item.policy).Statement,
    );
    const s3 = statements.find((item: any) =>
      item.Resource.includes("arn:aws:s3:::files-bucket/*"),
    );
    expect(s3.Resource).toEqual(["arn:aws:s3:::files-bucket/*"]);
    expect(
      statements.some((item: any) => item.Action.includes("ses:SendEmail")),
    ).toBe(true);
    expect(
      statements.some(
        (item: any) =>
          item.Action.includes("*") || item.Action.includes("s3:*"),
      ),
    ).toBe(false);
  });

  it("trusts Lambda in a deployment and adds account trust only in sst dev", async () => {
    const deployed = new WebFunction("CloudTrust", {
      entrypoint: "index.mjs",
      bundle: out,
    });
    await resolved(deployed.url);
    const cloudTrust = JSON.parse(
      named("CloudTrustRole", "aws:iam/role:Role").inputs.assumeRolePolicy,
    ).Statement;
    expect(cloudTrust).toHaveLength(1);
    expect(cloudTrust[0].Principal).toEqual({
      Service: ["lambda.amazonaws.com"],
    });
    // @ts-ignore
    global.$dev = true;
    const dev = new WebFunction("LocalTrust", {
      entrypoint: "src/server.ts",
      dev: { url: "http://localhost:3000" },
    });
    await resolved(dev.url);
    await resolved(dev.nodes.role.arn);
    const localTrust = JSON.parse(
      named("LocalTrustRole", "aws:iam/role:Role").inputs.assumeRolePolicy,
    ).Statement;
    expect(
      localTrust.flatMap((statement: any) => statement.Principal.AWS ?? []),
    ).toEqual(["111111111111"]);
  });

  it("runs locally during sst dev without creating a cloud revision or endpoint", async () => {
    // @ts-ignore
    global.$dev = true;
    const fn = new WebFunction("Local", {
      entrypoint: "src/server.ts",
      environment: { MESSAGE: "local" },
      dev: {
        url: "http://localhost:3000",
        command: "node --experimental-strip-types src/server.ts",
        directory: "service",
      },
    });
    expect(await resolved(fn.url)).toBe("http://localhost:3000");
    await resolved(fn.nodes.role.arn);
    expect(fn.nodes.stack).toBeUndefined();
    expect(fn.nodes.codeBucket).toBeUndefined();
    expect(fn.nodes.localLogGroup).toBeUndefined();
    expect(fn.arn).toBeUndefined();
    expect(fn.endpointArn).toBeUndefined();
    expect(ofType("aws:cloudformation/stack:Stack")).toHaveLength(0);
    expect(ofType("aws:lambda/function:Function")).toHaveLength(0);
    expect(ofType("aws:s3/bucketObjectv2:BucketObjectv2")).toHaveLength(0);
    expect(ofType("aws:cloudwatch/logGroup:LogGroup")).toHaveLength(1);
    expect(build).not.toHaveBeenCalled();
    const hint = componentOutputs.mock.calls
      .map(([value]) => value)
      .find((value) => "_hint" in value);
    expect(hint).toBeDefined();
    expect(await resolved(hint!._hint)).toBe("http://localhost:3000");
  });

  it("deploys in sst dev when dev is explicitly disabled", async () => {
    // @ts-ignore
    global.$dev = true;
    const fn = new WebFunction("DevDisabled", {
      entrypoint: "index.mjs",
      bundle: out,
      dev: false,
    });
    expect(await resolved(fn.url)).toBe("https://devdisabledstack.example.com");
    expect(template("DevDisabled").Resources.Endpoint.Type).toBe(
      "AWS::Lambda::WebFunctionEndpoint",
    );
    expect(fn.nodes.localLogGroup).toBeDefined();
    const trust = JSON.parse(
      named("DevDisabledRole", "aws:iam/role:Role").inputs.assumeRolePolicy,
    ).Statement;
    expect(
      trust.flatMap((statement: any) => statement.Principal.AWS ?? []),
    ).toEqual([]);
  });

  it.each([
    { timeout: "3 seconds" as const, concurrency: 1, seconds: 3 },
    { timeout: "15 minutes" as const, concurrency: 128, seconds: 900 },
  ])(
    "accepts request bounds $seconds seconds and $concurrency requests",
    async ({ timeout, concurrency, seconds }) => {
      const fn = new WebFunction(`Boundary${seconds}`, {
        entrypoint: "index.mjs",
        bundle: out,
        timeout,
        maxConcurrencyPerEnvironment: concurrency,
      });
      await resolved(fn.url);
      expect(
        template(`Boundary${seconds}`).Resources.Revision.Properties
          .ServiceConfig,
      ).toMatchObject({
        TimeoutSeconds: seconds,
        MaxConcurrencyPerEnvironment: concurrency,
      });
    },
  );

  it.each([0, -1, 129, 1.5, Number.NaN])(
    "rejects invalid concurrency %s before registering resources",
    (value) => {
      expect(
        () =>
          new WebFunction("InvalidConcurrency", {
            entrypoint: "index.mjs",
            bundle: out,
            maxConcurrencyPerEnvironment: value,
          }),
      ).toThrow(/maxConcurrencyPerEnvironment/);
      expect(resources).toHaveLength(0);
    },
  );

  it.each(["2 seconds", "16 minutes", "1.5 seconds"])(
    "rejects invalid timeout %s",
    (value) => {
      expect(
        () =>
          new WebFunction("InvalidTimeout", {
            entrypoint: "index.mjs",
            bundle: out,
            timeout: value as "3 seconds",
          }),
      ).toThrow(/timeout/);
    },
  );

  it.each([
    "AWS_LAMBDA_HTTP_ENDPOINT",
    "AWS_LAMBDA_NODEJS_ENTRYPOINT",
    "SST_RESOURCE_App",
    "SST_RESOURCE_Files",
  ])("rejects managed environment variable %s", (key) => {
    expect(
      () =>
        new WebFunction("SpoofedEnvironment", {
          entrypoint: "index.mjs",
          bundle: out,
          environment: { [key]: "spoofed" },
        }),
    ).toThrow(/reserved/);
  });

  it.each(["", " "])("requires a non-empty server entrypoint", (entrypoint) => {
    expect(() => new WebFunction("Empty", { entrypoint })).toThrow(
      /entrypoint/,
    );
  });

  it.each(["../outside.txt", "/absolute.txt"])(
    "rejects copyFiles destination %s",
    (to) => {
      expect(
        () =>
          new WebFunction("CopyEscape", {
            entrypoint: "index.mjs",
            bundle: out,
            copyFiles: [{ from: "src/server.ts", to }],
          }),
      ).toThrow(/copyFiles|bundle/);
    },
  );

  it("rejects a missing copyFiles source", () => {
    expect(
      () =>
        new WebFunction("MissingCopy", {
          entrypoint: "index.mjs",
          bundle: out,
          copyFiles: [{ from: "no-such-file.txt", to: "copied.txt" }],
        }),
    ).toThrow(/copyFiles|source|find/);
  });

  it("rejects ambiguous source extensions instead of building another file", () => {
    fs.writeFileSync(path.join(root, "src", "same.js"), "console.log('js');");
    fs.writeFileSync(path.join(root, "src", "same.ts"), "console.log('ts');");
    expect(
      () => new WebFunction("Ambiguous", { entrypoint: "src/same.js" }),
    ).toThrow(/ambiguous|extension|multiple/);
    expect(build).not.toHaveBeenCalled();
  });

  it.each([1, 10001, 2.5])(
    "rejects invalid maximum environments %s",
    (maxEnvironments) => {
      expect(
        () =>
          new WebFunction("InvalidScaling", {
            entrypoint: "index.mjs",
            bundle: out,
            scaling: { maxEnvironments },
          }),
      ).toThrow(/maxEnvironments/);
    },
  );

  it.each([50, 150, 1100, 2500, 10001])(
    "rejects unsupported request rate %s",
    (rateLimit) => {
      expect(
        () =>
          new WebFunction("InvalidRate", {
            entrypoint: "index.mjs",
            bundle: out,
            scaling: { rateLimit },
          }),
      ).toThrow(/rateLimit/);
    },
  );

  it.each([0, 100, 1000, 2000, 10000])(
    "accepts supported request rate %s",
    async (rateLimit) => {
      const fn = new WebFunction(`Rate${rateLimit}`, {
        entrypoint: "index.mjs",
        bundle: out,
        scaling: { rateLimit },
      });
      await resolved(fn.url);
      expect(
        template(`Rate${rateLimit}`).Resources.Endpoint.Properties
          .ThrottleConfig.RateLimit,
      ).toBe(rateLimit);
    },
  );

  it.each(["symlinkOutside", "symlinkAbsolute", "symlinkCopy"])(
    "rejects an invalid packaged symlink: %s",
    async (mode) => {
      const external = path.join(root, "outside.mjs");
      fs.writeFileSync(external, "console.log('outside');");
      if (mode === "symlinkCopy") {
        const link = path.join(root, "copy-symlink");
        fs.rmSync(link, { force: true });
        fs.symlinkSync("outside.mjs", link);
      } else {
        fs.unlinkSync(path.join(out, "index.mjs"));
        if (mode === "symlinkAbsolute") {
          fixtureFile("actual.mjs", "console.log('actual');");
          fs.symlinkSync(
            path.join(out, "actual.mjs"),
            path.join(out, "index.mjs"),
          );
        } else fs.symlinkSync("../outside.mjs", path.join(out, "index.mjs"));
      }
      const result = await promisify(execFile)(
        process.execPath,
        [failureHarness, root, mode],
        { timeout: 10000 },
      );
      const observed = JSON.parse(result.stdout.trim());
      const expected =
        "must point to an existing relative target inside the deployment package";
      expect(observed.message).toContain(expected);
      expect(observed.registered).not.toContain(
        "aws:cloudformation/stack:Stack",
      );
      expect(
        observed.errors.every((message: string) => message.includes(expected)),
      ).toBe(true);
    },
  );

  it.each([
    { mode: "build", expected: "Cannot resolve dependency" },
    { mode: "missing", expected: "can't find its entrypoint" },
    { mode: "envCount", expected: "at most 200 environment variables" },
    { mode: "envBytes", expected: "4096 UTF-8 bytes" },
    { mode: "envTotal", expected: "32 KiB" },
    { mode: "envEmpty", expected: "must be a non-empty string" },
  ])(
    "does not create a revision or endpoint after a $mode failure",
    async ({ mode, expected }) => {
      const result = await promisify(execFile)(
        process.execPath,
        [failureHarness, root, mode],
        { timeout: 10000 },
      );
      const observed = JSON.parse(result.stdout.trim());
      expect(observed.message).toContain(expected);
      expect(observed.registered).not.toContain(
        "aws:cloudformation/stack:Stack",
      );
      if (mode === "build" || mode === "missing")
        expect(observed.registered).not.toContain(
          "aws:s3/bucketObjectv2:BucketObjectv2",
        );
      expect(
        observed.errors.every((message: string) => message.includes(expected)),
      ).toBe(true);
    },
  );
});
