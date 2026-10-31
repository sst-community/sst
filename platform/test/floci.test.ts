import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  checkComponent,
  checkInvoke,
  checkResource,
} from "../src/floci/profile";

const hooks = vi.hoisted(() => ({
  resource: undefined as any,
  legacy: undefined as any,
  invoke: undefined as any,
}));
vi.mock("@pulumi/pulumi", () => ({
  output: (value: unknown) => ({
    apply: (fn: any) => (value instanceof Promise ? value.then(fn) : fn(value)),
  }),
  runtime: {
    registerStackTransformation: vi.fn((fn: any) => {
      hooks.legacy = fn;
    }),
    registerResourceTransform: vi.fn((fn: any) => {
      hooks.resource = fn;
    }),
    registerInvokeTransform: vi.fn((fn: any) => {
      hooks.invoke = fn;
    }),
  },
}));
import {
  checkFlociComponent,
  flociDynamicOptions,
  registerFlociChecks,
} from "../src/floci/check";

vi.mock("../src/components/rpc/rpc", () => ({
  rpc: { call: vi.fn(() => Promise.resolve({ asset: "cloud" })) },
}));
import { runtime } from "@pulumi/pulumi";
import { rpc } from "../src/components/rpc/rpc";
import { bootstrap } from "../src/components/aws/helpers/bootstrap";

describe("Floci versioned profile", () => {
  it("accepts the initial component set", () => {
    for (const [type, props] of Object.entries({
      Function: {
        handler: "src/index.handler",
        runtime: "nodejs22.x",
        url: true,
        link: [],
      },
      Bucket: {},
      Dynamo: { fields: { id: "string" }, primaryIndex: { hashKey: "id" } },
      Queue: {},
      QueueLambdaSubscriber: {
        queue: { arn: "arn" },
        subscriber: "src/index.handler",
      },
    }))
      expect(checkComponent(`sst:aws:${type}`, type, props)).toEqual([]);
  });
  it("rejects unknown components and options, including nested URL routes", () => {
    expect(checkComponent("sst:aws:Nextjs", "Web")).toHaveLength(1);
    expect(
      checkComponent("sst:aws:Function", "Fn", { vpc: {}, durable: true }),
    ).toHaveLength(2);
    expect(
      checkComponent("sst:aws:Function", "Fn", { runtime: "python3.12" }),
    ).toHaveLength(1);
    expect(
      checkComponent("sst:aws:Function", "Fn", { url: { route: {} } }),
    ).toHaveLength(1);
  });
  it("rejects disabling local live workers", () => {
    for (const key of ["dev", "live"]) {
      expect(
        checkComponent("sst:aws:Function", "Fn", { [key]: false }),
      ).toMatchObject([{ operation: `option.${key}` }]);
    }
  });
  it("validates nested component and resource options", () => {
    expect(
      checkComponent("sst:aws:Function", "Fn", {
        url: { cors: { unexpected: true } },
        logging: { unexpected: true },
      }),
    ).toHaveLength(2);
    expect(
      checkComponent("sst:aws:Dynamo", "Table", {
        globalIndexes: { byOwner: { hashKey: "owner", unexpected: true } },
      }),
    ).toHaveLength(1);
    expect(
      checkComponent("sst:aws:QueueLambdaSubscriber", "Sub", {
        batch: { unexpected: true },
      }),
    ).toHaveLength(1);
    expect(
      checkResource("aws:lambda/function:Function", "Fn", {
        loggingConfig: { unexpected: true },
      }),
    ).toHaveLength(1);
  });
  it("accepts only Node raw Lambda runtimes and the trusted SST bridge", () => {
    for (const runtime of ["python3.12", "provided.al2023", "nodejs18.x"])
      expect(
        checkResource("aws:lambda/function:Function", "Fn", { runtime }),
      ).toHaveLength(1);
    expect(
      checkResource("aws:lambda/function:Function", "Fn", {
        runtime: "nodejs24.x",
      }),
    ).toEqual([]);
    expect(
      checkResource(
        "aws:lambda/function:Function",
        "Fn",
        { runtime: "provided.al2023" },
        true,
      ),
    ).toEqual([]);
    expect(
      checkResource("aws:lambda/functionUrl:FunctionUrl", "Url", {
        invokeMode: "RESPONSE_STREAM",
      }),
    ).toHaveLength(1);
  });
  it("rejects unknown raw resources, advanced options and invokes", () => {
    expect(checkResource("aws:ec2/vpc:Vpc", "Vpc")).toHaveLength(1);
    expect(
      checkResource("aws:lambda/function:Function", "Fn", { vpcConfig: {} }),
    ).toHaveLength(1);
    expect(
      checkResource("aws:dynamodb/table:Table", "Table", {
        streamEnabled: true,
      }),
    ).toHaveLength(1);
    expect(
      checkResource("pulumi-nodejs:dynamic:Resource", "Untrusted"),
    ).toHaveLength(1);
    expect(checkInvoke("aws:ec2/getVpc:getVpc")).toHaveLength(1);
    expect(checkInvoke("aws:iam/getPolicyDocument:getPolicyDocument")).toEqual(
      [],
    );
  });
});

describe("Floci enforcement hooks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sst-floci-test-"));
    vi.stubEnv("SST_FLOCI_ENDPOINT", "http://127.0.0.1:4566");
    vi.stubEnv("SST_FLOCI_PREFLIGHT", "1");
    vi.stubEnv("SST_FLOCI_REPORT", path.join(dir, "report.json"));
    vi.stubEnv("AWS_REGION", "us-east-1");
    registerFlociChecks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  it("aggregates component, option, resource and invoke failures in preview", async () => {
    checkFlociComponent("sst:aws:Nextjs", "Web");
    checkFlociComponent("sst:aws:Function", "Fn", { vpc: {} });
    await hooks.resource({
      type: "aws:ec2/vpc:Vpc",
      name: "Vpc",
      props: {},
      opts: {},
    });
    expect(() => hooks.invoke({ token: "aws:ec2/getVpc:getVpc" })).toThrow(
      "No AWS fallback was attempted",
    );
    const report = JSON.parse(
      readFileSync(path.join(dir, "report.json"), "utf8"),
    );
    expect(report.violations).toHaveLength(4);
    expect(report.profile).toBe("floci-2.3.0-v1");
  });
  it("checks deferred runtime, Node options and live worker options when resolved", async () => {
    checkFlociComponent("sst:aws:Function", "Fn", {
      runtime: Promise.resolve("python3.12"),
      nodejs: Promise.resolve({ unsupported: true }),
      dev: Promise.resolve(false),
      live: Promise.resolve(false),
    });
    await Promise.resolve();
    const report = JSON.parse(
      readFileSync(path.join(dir, "report.json"), "utf8"),
    );
    expect(report.violations.map((v: any) => v.operation).sort()).toEqual([
      "option.dev",
      "option.live",
      "option.nodejs.unsupported",
      "option.runtime",
    ]);
  });
  it("throws on late unsupported resources during up", async () => {
    vi.stubEnv("SST_FLOCI_PREFLIGHT", "");
    await expect(
      hooks.resource({
        type: "aws:ec2/vpc:Vpc",
        name: "Vpc",
        props: {},
        opts: {},
      }),
    ).rejects.toThrow("aws:ec2/vpc:Vpc");
  });
  it("forces explicit providers to the local endpoint and dummy credentials", async () => {
    const result = await hooks.resource({
      type: "pulumi:providers:aws",
      name: "Aws",
      props: {
        region: "us-east-1",
        accessKey: "real",
        secretKey: "real",
        endpoints: [{ s3: "https://s3.amazonaws.com" }],
      },
      opts: {},
    });
    expect(result.props.accessKey).toBe("test");
    expect(result.props.secretKey).toBe("test");
    expect(result.props.endpoints[0].s3).toBe("http://127.0.0.1:4566");
    expect(result.props.skipMetadataApiCheck).toBe(true);
  });
  it("rejects regional and credential-chain escape hatches even in preview", async () => {
    for (const props of [
      { region: "eu-west-1" },
      { profile: "production" },
      { httpProxy: "https://proxy.example.com" },
      { assumeRoles: [{ roleArn: "arn" }] },
    ]) {
      await expect(
        hooks.resource({
          type: "pulumi:providers:aws",
          name: "Aws",
          props,
          opts: {},
        }),
      ).rejects.toThrow();
    }
  });
  it("rejects spoofed dynamic resource names and accepts branded SST constructors", async () => {
    const args = {
      type: "pulumi-nodejs:dynamic:Resource",
      name: "Fn.sst.aws.FunctionEnvironmentUpdate",
      resource: {},
      props: {},
      opts: {},
    };
    expect(() => hooks.legacy(args)).toThrow("Untrusted dynamic provider");
    const opts = flociDynamicOptions();
    opts.transformations![0](args as any);
    expect(() => hooks.legacy(args)).not.toThrow();
    await expect(hooks.resource(args)).resolves.toBeUndefined();
  });
  it("recognizes bridge runtime only under the registered SST Function", async () => {
    vi.stubEnv("SST_FLOCI_PREFLIGHT", "");
    vi.stubEnv("SST_FLOCI_BRIDGE", "http://127.0.0.1:13557");
    checkFlociComponent("sst:aws:Function", "Fn", { handler: "index.handler" });
    const args = {
      type: "aws:lambda/function:Function",
      name: "FnFunction",
      props: { runtime: "provided.al2023" },
      opts: { parent: { urn: "urn:pulumi:test::app::sst:aws:Function::Fn" } },
    };
    await expect(hooks.resource(args)).resolves.toBeUndefined();
    await expect(
      hooks.resource({ ...args, name: "SpoofedFunction" }),
    ).rejects.toThrow("provided.al2023");
    await expect(hooks.resource({ ...args, opts: {} })).rejects.toThrow(
      "provided.al2023",
    );
  });
  it("uses nonmutating bootstrap placeholders during preflight", async () => {
    vi.mocked(rpc.call).mockClear();
    const result = await bootstrap.forRegion("us-east-1");
    expect(result.asset).toBe("sst-floci-preflight-assets");
    expect(rpc.call).not.toHaveBeenCalled();
    vi.stubEnv("SST_FLOCI_PREFLIGHT", "");
    await bootstrap.forRegion("us-east-1");
    expect(rpc.call).toHaveBeenCalledWith("Provider.Aws.Bootstrap", {
      region: "us-east-1",
    });
  });
  it("does not install hooks or apply preflight placeholders without an explicit target", async () => {
    vi.stubEnv("SST_FLOCI_ENDPOINT", "");
    vi.mocked(runtime.registerStackTransformation).mockClear();
    vi.mocked(runtime.registerResourceTransform).mockClear();
    vi.mocked(runtime.registerInvokeTransform).mockClear();
    vi.mocked(rpc.call).mockClear();
    registerFlociChecks();
    expect(runtime.registerStackTransformation).not.toHaveBeenCalled();
    expect(runtime.registerResourceTransform).not.toHaveBeenCalled();
    expect(runtime.registerInvokeTransform).not.toHaveBeenCalled();
    expect(await bootstrap.forRegion("eu-west-1")).toEqual({ asset: "cloud" });
    expect(rpc.call).toHaveBeenCalledWith("Provider.Aws.Bootstrap", {
      region: "eu-west-1",
    });
    const opts = { protect: true };
    expect(flociDynamicOptions(opts)).toBe(opts);
  });
  it("keeps the same definitions and provider inputs intact across Floci → cloud → Floci", async () => {
    const components = [
      { type: "sst:aws:Bucket", name: "Files", props: {} },
      {
        type: "sst:aws:Dynamo",
        name: "Records",
        props: { fields: { id: "string" }, primaryIndex: { hashKey: "id" } },
      },
      { type: "sst:aws:Queue", name: "Jobs", props: {} },
      {
        type: "sst:aws:Function",
        name: "Api",
        props: { handler: "src/api.handler", runtime: "nodejs24.x", url: true },
      },
    ];
    const resources = [
      {
        type: "aws:s3/bucket:Bucket",
        name: "FilesBucket",
        props: { forceDestroy: true },
        opts: {},
      },
      {
        type: "aws:dynamodb/table:Table",
        name: "RecordsTable",
        props: { hashKey: "id", attributes: [{ name: "id", type: "S" }] },
        opts: {},
      },
      { type: "aws:sqs/queue:Queue", name: "JobsQueue", props: {}, opts: {} },
      {
        type: "aws:lambda/function:Function",
        name: "ApiFunction",
        props: { runtime: "nodejs24.x" },
        opts: {},
      },
    ];
    const provider = {
      type: "pulumi:providers:aws",
      name: "Aws",
      props: Object.freeze({
        region: "us-east-1",
        accessKey: "ordinary-key",
        secretKey: "ordinary-secret",
      }),
      opts: {},
    };
    const original = JSON.stringify({ components, resources, provider });
    for (const endpoint of [
      "http://127.0.0.1:4566",
      "",
      "http://127.0.0.1:4566",
    ]) {
      vi.stubEnv("SST_FLOCI_ENDPOINT", endpoint);
      registerFlociChecks();
      for (const component of components)
        checkFlociComponent(component.type, component.name, component.props);
      for (const resource of resources)
        await expect(hooks.resource(resource)).resolves.toBeUndefined();
      const result = await hooks.resource(provider);
      if (endpoint) {
        expect(result.props.accessKey).toBe("test");
        expect(result.props.endpoints[0].s3).toBe(endpoint);
        expect(
          JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8"))
            .violations,
        ).toEqual([]);
      } else {
        // Even callbacks retained in a reused worker must not rewrite a cloud provider.
        expect(result).toBeUndefined();
        checkFlociComponent("sst:aws:Function", "CloudOnly", {
          runtime: "python3.12",
          dev: false,
        });
        await expect(
          hooks.resource({
            type: "aws:ec2/vpc:Vpc",
            name: "CloudVpc",
            props: {},
            opts: {},
          }),
        ).resolves.toBeUndefined();
        expect(() =>
          hooks.invoke({ token: "aws:ec2/getVpc:getVpc" }),
        ).not.toThrow();
      }
      expect(JSON.stringify({ components, resources, provider })).toBe(
        original,
      );
    }
  });
  it("has no effect in cloud mode", () => {
    vi.stubEnv("SST_FLOCI_ENDPOINT", "");
    expect(() => checkFlociComponent("sst:aws:Nextjs", "Web")).not.toThrow();
  });
});
