import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import http from "node:http";
import * as pulumi from "@pulumi/pulumi";

// What sst pulumi dev says a function is deployed as
const stub = {
  code: "/app/.sst/platform/dist/bridge",
  handler: "bootstrap",
  runtime: "provided.al2023",
  architectures: ["x86_64"],
  environment: { SST_FUNCTION_ID: "Api", SST_APP: "shop", SST_STAGE: "dev" },
  permissions: [{ actions: ["appsync:*"], resources: ["*"] }],
};

// What sst.dev.yaml names: the functions to run locally, and the roles its
// dev commands run as
const liveFunctions = new Set(["Api", "Snappy"]);
const commandRoles = new Set(["Reporter", "OneStatement"]);

const calls: { path?: string; body: any }[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const parsed = JSON.parse(body);
    calls.push({ path: request.url, body: parsed });
    const [args] = parsed.params;
    let result: unknown = null;
    if (parsed.method === "PulumiDev.Function")
      result = liveFunctions.has(args.name)
        ? { live: true, stub }
        : { live: false };
    if (parsed.method === "PulumiDev.Role")
      result = { trust: commandRoles.has(args.name) };
    response.end(JSON.stringify({ result, error: null }));
  });
});

// What Pulumi's mocks were asked to create, and the stack transforms
// registered
const created: { type: string; name: string; inputs: any }[] = [];
let registeredTransforms = 0;

function value(input: pulumi.Input<any>): Promise<any> {
  return new Promise((resolve) => pulumi.output(input).apply(resolve));
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const found = read();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("never registered");
}

// sst/pulumi reads whether it's in sst pulumi dev when it's loaded, so each case
// loads its own copy
type Library = typeof import("../src/pulumi/index.ts");
const load = (copy: string) =>
  import(`../src/pulumi/index.ts?${copy}`) as Promise<Library>;
let plain: Library;
let sst: Library;
let transformsBeforeDev = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await pulumi.runtime.setMocks(
    {
      newResource(args) {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call(args) {
        if (args.token === "aws:index/getCallerIdentity:getCallerIdentity")
          return {
            accountId: "123456789012",
            arn: "arn:aws:iam::123456789012:user/dev",
            userId: "AIDA",
          };
        return {};
      },
      registerTransform() {
        registeredTransforms++;
      },
    } as pulumi.runtime.Mocks,
    "shop",
    "dev",
    false,
  );

  delete process.env.SST_DEV;
  delete process.env.SST_SERVER;
  plain = await load("plain");
  transformsBeforeDev = registeredTransforms;
  process.env.SST_DEV = "true";
  process.env.SST_SERVER = `http://127.0.0.1:${port}/token`;
  sst = await load("dev");
  delete process.env.SST_DEV;
  delete process.env.SST_SERVER;
});

afterAll(() => {
  server.close();
});

const fn = {
  custom: true,
  type: "aws:lambda/function:Function",
  name: "Api",
  props: {
    runtime: "nodejs22.x",
    role: "arn:aws:iam::123456789012:role/service/api-role",
    handler: "index.handler",
    s3Bucket: "builds",
    s3Key: "api.zip",
    sourceCodeHash: "abc",
    timeout: 30,
    environment: { variables: { DB_HOST: "localhost" } },
  },
  opts: {},
};

const role = (name: string, assumeRolePolicy: unknown) => ({
  ...fn,
  type: "aws:iam/role:Role",
  name,
  props: { assumeRolePolicy },
});

describe("outside sst pulumi dev", () => {
  it("isn't dev, and registers nothing", () => {
    expect(plain.dev).toBe(false);
    expect(transformsBeforeDev).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("in sst pulumi dev", () => {
  it("is dev, and registers one transform for the stack", async () => {
    expect(sst.dev).toBe(true);
    await eventually(() => (registeredTransforms > 0 ? true : undefined));
    expect(registeredTransforms).toBe(1);
  });

  it("deploys the stub in place of a function sst pulumi dev runs", async () => {
    const result = await sst.transform(fn);
    expect(calls.at(-1)).toEqual({
      path: "/token/rpc",
      body: {
        jsonrpc: "1.0",
        method: "PulumiDev.Function",
        params: [{ name: "Api", runtime: "nodejs22.x", image: false }],
      },
    });
    // the resource's options are kept as they are
    expect(result!.opts).toBeUndefined();
    const props = result!.props as any;
    expect(props.code).toBeInstanceOf(pulumi.asset.FileArchive);
    expect(await props.code.path).toBe(stub.code);
    expect(props.handler).toBe("bootstrap");
    expect(props.runtime).toBe("provided.al2023");
    expect(props.architectures).toEqual(["x86_64"]);
    expect(props.packageType).toBe("Zip");
    expect(props.timeout).toBe(30);
    // the code is the stub's
    expect(props.s3Bucket).toBeUndefined();
    expect(props.s3Key).toBeUndefined();
    expect(props.sourceCodeHash).toBeUndefined();
    expect(await value(props.environment)).toEqual({
      variables: { DB_HOST: "localhost", ...stub.environment },
    });

    // its role may reach sst pulumi dev
    const policy = await eventually(() =>
      created.find((r) => r.type === "aws:iam/rolePolicy:RolePolicy"),
    );
    expect(policy.name).toBe("ApiSstDev");
    expect(policy.inputs.role).toBe("api-role");
    expect(JSON.parse(policy.inputs.policy)).toEqual({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["appsync:*"], Resource: ["*"] }],
    });
  });

  it("leaves a function sst pulumi dev doesn't run as it is", async () => {
    expect(await sst.transform({ ...fn, name: "Cron" })).toBeUndefined();
    expect(calls.at(-1)!.body.params[0].name).toBe("Cron");
  });

  it("tells sst pulumi dev a function is made in one of SST's components", async () => {
    // SST's Function, and a part of it made in a component of its own
    const component = new pulumi.ComponentResource("sst:aws:Function", "Web");
    const inner = new pulumi.ComponentResource(
      "acme:index:Inner",
      "WebInner",
      {},
      {
        parent: component,
      },
    );
    for (const parent of [component, inner]) {
      expect(
        await sst.transform({ ...fn, name: "WebFunction", opts: { parent } }),
      ).toBeUndefined();
      expect(calls.at(-1)!.body.params[0]).toEqual({
        name: "WebFunction",
        runtime: "nodejs22.x",
        image: false,
        component: { type: "sst:aws:Function", name: "Web" },
      });
    }
    // a component of the program's own isn't SST's
    const own = new pulumi.ComponentResource("acme:index:Api", "Own");
    await sst.transform({ ...fn, name: "OwnFunction", opts: { parent: own } });
    expect(calls.at(-1)!.body.params[0].component).toBeUndefined();
  });

  it("tells sst pulumi dev a function is a container image, or its runtime isn't known yet", async () => {
    await sst.transform({
      ...fn,
      name: "Image",
      props: { ...fn.props, packageType: "Image", imageUri: "repo:tag" },
    });
    expect(calls.at(-1)!.body.params[0]).toEqual({
      name: "Image",
      runtime: "nodejs22.x",
      image: true,
    });
    await sst.transform({
      ...fn,
      name: "Computed",
      props: { ...fn.props, runtime: pulumi.output("nodejs22.x") },
    });
    expect(calls.at(-1)!.body.params[0].runtime).toBe("");
  });

  it("drops SnapStart, which the stub's runtime doesn't have", async () => {
    const result = await sst.transform({
      ...fn,
      name: "Snappy",
      props: { ...fn.props, snapStart: { applyOn: "PublishedVersions" } },
    });
    expect((result!.props as any).snapStart).toBeUndefined();
  });

  it("lets the account take a role a dev command runs as", async () => {
    const result = await sst.transform(
      role(
        "Reporter",
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      ),
    );
    expect(calls.at(-1)!.body).toMatchObject({
      method: "PulumiDev.Role",
      params: [{ name: "Reporter" }],
    });
    expect(result!.opts).toBeUndefined();
    const document = JSON.parse(
      await value((result!.props as any).assumeRolePolicy),
    );
    expect(document.Statement).toEqual([
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::123456789012:root" },
        Action: "sts:AssumeRole",
      },
    ]);
  });

  it("lets the account take a role whose policy has one statement", async () => {
    const result = await sst.transform(
      role("OneStatement", {
        Version: "2012-10-17",
        Statement: {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      }),
    );
    const document = JSON.parse(
      await value((result!.props as any).assumeRolePolicy),
    );
    expect(document.Statement).toHaveLength(2);
    expect(document.Statement[0].Principal).toEqual({
      Service: "ecs-tasks.amazonaws.com",
    });
  });

  it("leaves a role no dev command runs as as it is", async () => {
    expect(await sst.transform(role("ApiRole", "{}"))).toBeUndefined();
  });

  it("leaves other resources as they are, without asking", async () => {
    const before = calls.length;
    expect(
      await sst.transform({ ...fn, type: "aws:s3/bucket:Bucket" }),
    ).toBeUndefined();
    expect(calls).toHaveLength(before);
  });
});
