import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { rejectionsOf } from "../../helpers/rejections";

// The app's folder, with the image's contexts
const root = fs.mkdtempSync(path.join(os.tmpdir(), "microvm-v5-"));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
write("sandbox/Dockerfile", "FROM node:24-alpine\n");
write("sandbox/app.mjs", "// app\n");
write("nested/docker/Dockerfile.prod", "FROM scratch\n");
write("nested/app.mjs", "// app\n");
write("typed/Dockerfile", "FROM scratch\n");
write("typed/app.mjs", "// app\n");
write("typed/sst-env.d.ts", "// types\n");
write("typed/lib/sst-env.d.ts", "// types\n");
write("ignored/Dockerfile", "FROM scratch\n");
write("ignored/.dockerignore", "node_modules\n!node_modules/keep\n");

const IMAGE = "aws:lambdamicrovms/image:Image";
const ROLE = "aws:iam/role:Role";
const CONNECTOR = "aws:lambda/coreNetworkConnector:CoreNetworkConnector";

const pulumi = mockPulumi({
  root,
  state: (args) =>
    args.type === IMAGE
      ? { imageVersion: "3" }
      : args.type === ROLE
        ? { createDate: new Date(0).toISOString() }
        : {},
  call: (args) =>
    args.token === "aws:index/getAvailabilityZones:getAvailabilityZones"
      ? { names: ["us-east-1a", "us-east-1b"] }
      : undefined,
});

type MicroVmClass =
  | typeof import("../../../src/components/aws/microvm").MicroVm
  | typeof import("../../../src/components/aws/v5/microvm").MicroVm;

describe("MicroVm", () => {
  let OriginalMicroVm: typeof import("../../../src/components/aws/microvm").MicroVm;
  let MicroVm: typeof import("../../../src/components/aws/v5/microvm").MicroVm;
  let OriginalVpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Vpc: typeof import("../../../src/components/aws/v5/vpc").Vpc;

  beforeAll(async () => {
    OriginalMicroVm = (await import("../../../src/components/aws/microvm"))
      .MicroVm;
    MicroVm = (await import("../../../src/components/aws/v5/microvm")).MicroVm;
    OriginalVpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Vpc = (await import("../../../src/components/aws/v5/vpc")).Vpc;
    await import("../../../src/components/aws/takeover/index");
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

  // Each case deploys the 4.x MicroVm, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs. The image isn't built again: its code's zip is the same.
  describe("takes over a deployed MicroVm", () => {
    pulumi.takeoverCases<MicroVmClass, MicroVmClass>({
      original: () => OriginalMicroVm,
      v5: () => MicroVm,
      check: () =>
        expect(resource("SandboxLogGroup").type).toBe(
          "aws:cloudwatch/logGroup:LogGroup",
        ),
      cases: {
        "an image from its context": (MicroVm, opts) => {
          new MicroVm("Sandbox", { image: { context: "sandbox" } }, opts);
        },
        "an image with everything it's run with": (MicroVm, opts) => {
          new MicroVm(
            "Sandbox",
            {
              image: {
                context: "nested",
                dockerfile: "docker/Dockerfile.prod",
              },
              port: 3000,
              environment: { GREETING: "hi" },
              permissions: [
                { actions: ["bedrock:InvokeModel"], resources: ["*"] },
              ],
              duration: "4 hours",
              idle: { suspendAfter: "10 minutes", terminateAfter: "1 hour" },
              logging: { retention: "1 week" },
            },
            opts,
          );
        },
        "an image linked to a bucket": async (MicroVm, opts) => {
          const { Bucket } = await import(
            "../../../src/components/aws/v5/bucket"
          );
          new MicroVm(
            "Sandbox",
            { image: { context: "sandbox" }, link: [new Bucket("MyBucket")] },
            opts,
          );
        },
        "in a VPC, by its ids": (MicroVm, opts) => {
          new MicroVm(
            "Sandbox",
            {
              image: { context: "sandbox" },
              vpc: {
                privateSubnets: ["subnet-1", "subnet-2"],
                securityGroups: ["sg-1"],
              },
            },
            opts,
          );
        },
        "in a Vpc": (MicroVm, opts) => {
          new MicroVm(
            "Sandbox",
            {
              image: { context: "sandbox" },
              vpc: new OriginalVpc("MyVpc", { nat: "managed" }),
            },
            opts,
          );
        },
        "resources transformed": (MicroVm, opts) => {
          new MicroVm(
            "Sandbox",
            {
              image: { context: "sandbox" },
              vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] },
              transform: {
                image: (args) => {
                  args.tags = { team: "agents" };
                },
                logGroup: { tags: { team: "agents" } },
                executionRole: { description: "runs the sandbox" },
                buildRole: { description: "builds the sandbox" },
                operatorRole: { description: "connects the sandbox" },
              },
            },
            opts,
          );
        },
        // In `sst dev`, nothing but the log group and the execution role is
        // deployed. The 4.x MicroVm created a component for the pane `sst
        // dev` shows; the V5 one reports it in its outputs.
        "in sst dev": {
          create: (MicroVm, opts) => {
            // @ts-ignore
            global.$dev = true;
            new MicroVm(
              "Sandbox",
              {
                image: { context: "sandbox" },
                dev: { command: "node app.mjs", url: "http://localhost:9000" },
              },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::SandboxDev"],
          changed: [["Sandbox", ["outputs"]]],
          check: () => {
            expect(ofType(IMAGE)).toEqual([]);
            expect(pulumi.reportOf("Sandbox")).toHaveProperty("dev");
          },
        },
        "in sst dev, in a VPC, linked": {
          create: async (MicroVm, opts) => {
            const { Bucket } = await import(
              "../../../src/components/aws/v5/bucket"
            );
            // @ts-ignore
            global.$dev = true;
            new MicroVm(
              "Sandbox",
              {
                image: { context: "sandbox" },
                link: [new Bucket("MyBucket")],
                vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] },
                dev: { command: "node app.mjs" },
              },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::SandboxDev"],
          changed: [["Sandbox", ["outputs"]]],
          check: () => {
            expect(ofType(CONNECTOR)).toEqual([]);
            expect(pulumi.reportOf("Sandbox")?.dev.links).toEqual(["MyBucket"]);
          },
        },
        "in sst dev, built": {
          create: (MicroVm, opts) => {
            // @ts-ignore
            global.$dev = true;
            new MicroVm(
              "Sandbox",
              { image: { context: "sandbox" }, dev: false },
              opts,
            );
          },
          check: () => expect(pulumi.reportOf("Sandbox")).toBeUndefined(),
        },
      },
    });
  });

  it("builds the image from its context, with the environment", async () => {
    new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      environment: { GREETING: "hi" },
    });
    await pulumi.settle();

    const image = resource("SandboxImage").inputs;
    expect(image.baseImageArn).toBe(
      "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
    );
    expect(image.name).toMatch(/^app-test-Sandbox-[a-z]{8}$/);
    expect(image.codeArtifact.uri).toBe(
      `s3://sst-asset-bucket/assets/microvm/${image.name}.zip`,
    );
    expect(image.description).toMatch(/^Code [0-9a-f]{16}$/);
    expect(image.environmentVariables.GREETING).toBe("hi");
    expect(JSON.parse(image.environmentVariables.SST_RESOURCE_App)).toEqual({
      name: "app",
      stage: "test",
    });

    expect(resource("SandboxImagePrune").inputs).toMatchObject({
      imageArn: "arn:aws:mock:us-east-1:123456789012:SandboxImage",
      imageVersion: "3",
      region: "us-east-1",
      keep: 5,
    });
    const logGroup = resource("SandboxLogGroup").inputs;
    expect(logGroup.name).toBe(`/aws/lambda-microvms/${image.name}`);
    expect(logGroup.retentionInDays).toBe(30);
  });

  // SST 4 replaced a nested object of a transform whole
  it("keeps its variables next to ones set with an object transform", async () => {
    new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      environment: { GREETING: "hi" },
      transform: { image: { environmentVariables: { EXTRA: "1" } } },
    });
    await pulumi.settle();
    const variables = resource("SandboxImage").inputs.environmentVariables;
    expect(variables).toMatchObject({ GREETING: "hi", EXTRA: "1" });
    expect(variables).toHaveProperty("SST_RESOURCE_App");
  });

  it("has every part in nodes", async () => {
    const vm = new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] },
    });
    await pulumi.settle();
    expect(Object.keys(vm.nodes).sort()).toEqual([
      "buildRole",
      "code",
      "executionRole",
      "image",
      "imagePrune",
      "logGroup",
      "networkConnector",
      "operatorRole",
    ]);
    expect(await pulumi.resolve(vm.arn)).toBe(
      "arn:aws:mock:us-east-1:123456789012:SandboxImage",
    );
  });

  it("lets only Lambda assume the roles outside sst dev", async () => {
    new MicroVm("Sandbox", { image: { context: "sandbox" } });
    await pulumi.settle();

    expect(
      ofType(ROLE)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["SandboxBuildRole", "SandboxExecutionRole"]);
    for (const role of ["SandboxBuildRole", "SandboxExecutionRole"])
      expect(trustOf(role).statements).toEqual([
        {
          actions: ["sts:AssumeRole", "sts:TagSession"],
          principals: [
            { type: "Service", identifiers: ["lambda.amazonaws.com"] },
          ],
        },
      ]);

    const imageName = resource("SandboxImage").inputs.name;
    expect(policyOf("SandboxBuildRole").statements[0].resources).toEqual([
      `arn:aws:s3:::sst-asset-bucket/assets/microvm/${imageName}.zip`,
    ]);
  });

  it("gives the execution role the permissions and the links'", async () => {
    const { Bucket } = await import("../../../src/components/aws/v5/bucket");
    new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      link: [new Bucket("MyBucket")],
      permissions: [{ actions: ["bedrock:InvokeModel"], resources: ["*"] }],
    });
    await pulumi.settle();

    const actions = policyOf("SandboxExecutionRole").statements.map(
      (s: any) => s.actions,
    );
    expect(actions[0]).toEqual(["bedrock:InvokeModel"]);
    expect(actions.flat()).toContain("s3:*");
    expect(actions.at(-1)).toEqual([
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]);
  });

  it("links what the SDK runs MicroVMs with, and lets it run them", async () => {
    const vm = new MicroVm("Sandbox", { image: { context: "sandbox" } });
    const link = vm.link();
    expect(
      (await pulumi.resolve(link.include)).map((p: any) => [
        p.actions,
        p.resources,
      ]),
    ).toEqual([
      [
        [
          "lambda:RunMicrovm",
          "lambda:GetMicrovm",
          "lambda:SuspendMicrovm",
          "lambda:ResumeMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:CreateMicrovmAuthToken",
        ],
        ["arn:aws:mock:us-east-1:123456789012:SandboxImage"],
      ],
      [["lambda:ListMicrovms", "lambda:PassNetworkConnector"], ["*"]],
      [
        ["iam:PassRole"],
        ["arn:aws:mock:us-east-1:123456789012:SandboxExecutionRole"],
      ],
    ]);

    expect(await pulumi.resolve(link.properties)).toEqual({
      imageArn: "arn:aws:mock:us-east-1:123456789012:SandboxImage",
      imageVersion: "3",
      executionRoleArn:
        "arn:aws:mock:us-east-1:123456789012:SandboxExecutionRole",
      logGroup: expect.stringMatching(
        /^\/aws\/lambda-microvms\/app-test-Sandbox-/,
      ),
      ingressNetworkConnectors: [
        "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
      ],
      egressNetworkConnectors: [
        "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
      ],
      port: 8080,
      duration: 3600,
      idle: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 900,
      },
    });
  });

  it("leaves out the idle policy when idle is false", async () => {
    const vm = new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      idle: false,
      duration: "8 hours",
    });
    const properties = await pulumi.resolve(vm.link().properties);
    expect(properties.duration).toBe(28800);
    expect(properties.idle).toBeUndefined();
  });

  it("refuses a duration longer than 8 hours, and a short suspendAfter", async () => {
    for (const [args, message] of [
      [{ duration: "9 hours" }, /"Sandbox" MicroVm's "duration" is 9 hours/],
      [
        { idle: { suspendAfter: "30 seconds" } },
        /"Sandbox" MicroVm's "idle.suspendAfter" is 30 seconds/,
      ],
    ] as const) {
      pulumi.reset();
      let error: Error | undefined;
      await rejectionsOf(async () => {
        const vm = new MicroVm("Sandbox", {
          image: { context: "sandbox" },
          ...args,
        });
        // Checked where the SDK's defaults are read
        error = await (vm.link().properties.duration as any)
          .promise()
          .catch((e: Error) => e);
        await pulumi.settle();
      });
      expect(error?.message).toMatch(message);
    }
  });

  it("puts a dockerfile from elsewhere in the context at the root of the zip", async () => {
    new MicroVm("Nested", {
      image: { context: "nested", dockerfile: "docker/Dockerfile.prod" },
    });
    await pulumi.settle();
    const zip = resource("NestedCode").inputs.source;
    // File names are stored uncompressed in a zip's headers
    const names = fs.readFileSync(zip.path).toString("latin1");
    expect(names).toContain("Dockerfile");
    expect(names).toContain("app.mjs");
    expect(names).toContain("docker/Dockerfile.prod");
  });

  it("leaves the sst-env.d.ts files out of the zip", async () => {
    new MicroVm("Typed", { image: { context: "typed" } });
    await pulumi.settle();
    const names = fs
      .readFileSync(resource("TypedCode").inputs.source.path)
      .toString("latin1");
    expect(names).toContain("app.mjs");
    expect(names).not.toContain("sst-env.d.ts");
  });

  it("refuses what it can't build from", async () => {
    for (const [image, message] of [
      [{ context: "missing" }, /"Sandbox" MicroVm can't find its Dockerfile/],
      [{ context: "ignored" }, /\.dockerignore has an exception/],
    ] as const) {
      pulumi.reset();
      const failures = await rejectionsOf(async () => {
        new MicroVm("Sandbox", { image });
        await pulumi.settle();
      });
      expect((failures[0] as Error).message).toMatch(message);
    }
  });

  it("runs MicroVMs through a network connector in the VPC", async () => {
    const vm = new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      vpc: {
        privateSubnets: ["subnet-1", "subnet-2"],
        securityGroups: ["sg-1"],
      },
    });
    await pulumi.settle();

    const connector = resource("SandboxNetworkConnector").inputs;
    expect(connector.configuration).toEqual({
      vpcEgressConfiguration: {
        associatedComputeResourceTypes: ["MicroVm"],
        networkProtocol: "IPv4",
        subnetIds: ["subnet-1", "subnet-2"],
        securityGroupIds: ["sg-1"],
      },
    });
    expect(connector.operatorRole).toBe(
      "arn:aws:mock:us-east-1:123456789012:SandboxOperatorRole",
    );
    expect(
      resource("SandboxOperatorRole").inputs.assumeRolePolicy.Statement[0]
        .Principal,
    ).toEqual({ Service: "network-connectors.lambda.amazonaws.com" });
    expect(
      (await pulumi.resolve(vm.link().properties)).egressNetworkConnectors,
    ).toEqual(["arn:aws:mock:us-east-1:123456789012:SandboxNetworkConnector"]);
  });

  it("takes either kind of Vpc", async () => {
    for (const vpc of [
      () => new OriginalVpc("MyVpc", { nat: "managed" }),
      () => new Vpc("MyVpc", { nat: "managed" }),
    ]) {
      pulumi.reset();
      new MicroVm("Sandbox", { image: { context: "sandbox" }, vpc: vpc() });
      await pulumi.settle();
      const egress = resource("SandboxNetworkConnector").inputs.configuration
        .vpcEgressConfiguration;
      expect(egress.subnetIds).toEqual([
        "MyVpcPrivateSubnet1_id",
        "MyVpcPrivateSubnet2_id",
      ]);
      expect(egress.securityGroupIds).toEqual(["MyVpcSecurityGroup_id"]);
    }
  });

  it("refuses another resource as the ids of a VPC", async () => {
    const { ec2 } = await import("@pulumi/aws");
    expect(
      () =>
        new MicroVm("Sandbox", {
          image: { context: "sandbox" },
          vpc: new ec2.Vpc("Other", { cidrBlock: "10.0.0.0/16" }) as any,
        }),
    ).toThrow(/The "vpc" of the "Sandbox" MicroVm isn't a "Vpc" component/);
  });

  it("shares a network connector it's given in place of a VPC", async () => {
    const first = new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] },
    });
    const second = new MicroVm("Grader", {
      image: { context: "sandbox" },
      existing: { networkConnector: first.nodes.networkConnector! },
    });
    await pulumi.settle();

    expect(ofType(CONNECTOR).map((r) => r.name)).toEqual([
      "SandboxNetworkConnector",
    ]);
    expect(resource("GraderOperatorRole")).toBeUndefined();
    expect(second.nodes.networkConnector).toBe(first.nodes.networkConnector);
    expect(
      (await pulumi.resolve(second.link().properties)).egressNetworkConnectors,
    ).toEqual(["arn:aws:mock:us-east-1:123456789012:SandboxNetworkConnector"]);
  });

  it("looks up a network connector it's given by its ARN", async () => {
    const arn =
      "arn:aws:lambda:us-east-1:123456789012:network-connector:shared";
    const vm = new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      existing: { networkConnector: arn },
    });
    await pulumi.settle();
    expect(
      ofType(CONNECTOR).map((r) => [r.kind ?? "create", r.options.id]),
    ).toEqual([["read", arn]]);
    expect(resource("SandboxOperatorRole")).toBeUndefined();
    expect(await pulumi.resolve(vm.nodes.networkConnector!.id)).toBe(arn);
  });

  it("uses an execution role it's given", async () => {
    const { iam } = await import("@pulumi/aws");
    const role = new iam.Role("Shared", { assumeRolePolicy: "{}" });
    const vm = new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      existing: { executionRole: role },
    });
    await pulumi.settle();
    expect(resource("SandboxExecutionRole")).toBeUndefined();
    expect((await pulumi.resolve(vm.link().properties)).executionRoleArn).toBe(
      "arn:aws:mock:us-east-1:123456789012:Shared",
    );
  });

  it("uses a build role it's given, and an execution role with no permissions", async () => {
    const { iam } = await import("@pulumi/aws");
    new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      permissions: [],
      existing: {
        buildRole: new iam.Role("Builds", { assumeRolePolicy: "{}" }),
        executionRole: new iam.Role("Runs", { assumeRolePolicy: "{}" }),
      },
    });
    await pulumi.settle();
    expect(
      ofType(ROLE)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["Builds", "Runs"]);
    expect(resource("SandboxImage").inputs.buildRoleArn).toBe(
      "arn:aws:mock:us-east-1:123456789012:Builds",
    );
  });

  it("uses an operator role it's given for the connector it creates", async () => {
    const { iam } = await import("@pulumi/aws");
    new MicroVm("Sandbox", {
      image: { context: "sandbox" },
      vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] },
      existing: {
        operatorRole: new iam.Role("Connects", { assumeRolePolicy: "{}" }),
      },
    });
    await pulumi.settle();
    expect(resource("SandboxOperatorRole")).toBeUndefined();
    expect(resource("SandboxNetworkConnector").inputs.operatorRole).toBe(
      "arn:aws:mock:us-east-1:123456789012:Connects",
    );
  });

  it("refuses what it can't be given in existing", async () => {
    const { iam } = await import("@pulumi/aws");
    const given =
      (existing: object, more: object = {}) =>
      () =>
        new MicroVm("Sandbox", {
          image: { context: "sandbox" },
          existing,
          ...more,
        } as any);
    expect(given({ logGroup: "/aws/lambda-microvms/mine" })).toThrow(
      /"existing.logGroup" isn't an option for the "Sandbox" MicroVm\. Lambda writes an image's build logs to a log group named after it.*"transform.logGroup"/,
    );
    for (const key of ["code", "image", "imagePrune"])
      expect(given({ [key]: "x" })).toThrow(
        `"existing.${key}" isn't an option for the "Sandbox" MicroVm. It builds its image from "image"`,
      );
    expect(
      given(
        { executionRole: new iam.Role("Shared", { assumeRolePolicy: "{}" }) },
        { permissions: [{ actions: ["s3:*"], resources: ["*"] }] },
      ),
    ).toThrow(
      /is given an existing "executionRole".*Add the "permissions" to the role itself/,
    );
    expect(
      given(
        { networkConnector: "arn:aws:lambda:us-east-1:1:network-connector:x" },
        { vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] } },
      ),
    ).toThrow(
      `The "Sandbox" MicroVm is given an existing "networkConnector", which it uses the way it is. Remove "vpc" from its args.`,
    );
    const connector = "arn:aws:lambda:us-east-1:1:network-connector:x";
    expect(
      given({ networkConnector: connector, operatorRole: "a-role" }),
    ).toThrow(
      `"existing.operatorRole" isn't an option for the "Sandbox" MicroVm. It's given an existing "networkConnector", so it creates no connector to use it for.`,
    );
    expect(
      given(
        { networkConnector: connector },
        { transform: { operatorRole: { description: "x" } } },
      ),
    ).toThrow(
      `The "Sandbox" MicroVm is given an existing "networkConnector", so it creates no connector and no "operatorRole". Remove "operatorRole" from its "transform".`,
    );
    expect(given({ operatorRole: "a-role" })).toThrow(
      `"existing.operatorRole" isn't an option for the "Sandbox" MicroVm. It's only used to create a network connector for "vpc". Set "vpc", or remove it.`,
    );
    expect(given({}, { dev: output(false) })).toThrow(
      /The "dev" of the "Sandbox" MicroVm has to be a plain value/,
    );
    // The roles made for it register after the test, otherwise
    await pulumi.settle();
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    it("runs the app locally, as the execution role, without building the image", async () => {
      const vm = new MicroVm("Sandbox", {
        image: { context: "sandbox" },
        environment: { GREETING: "hi" },
        dev: { command: "node app.mjs", url: "http://localhost:9000" },
      });
      await pulumi.settle();

      expect(ofType(IMAGE)).toEqual([]);
      expect(ofType(ROLE).map((r) => r.name)).toEqual(["SandboxExecutionRole"]);
      expect(trustOf("SandboxExecutionRole").statements[1]).toEqual({
        actions: ["sts:AssumeRole"],
        principals: [{ type: "AWS", identifiers: ["123456789012"] }],
      });
      expect(pulumi.reportOf("Sandbox")).toEqual({
        contract: expect.any(Number),
        dev: {
          title: "Sandbox",
          command: "node app.mjs",
          directory: "sandbox",
          autostart: true,
          links: [],
          environment: { GREETING: "hi", AWS_REGION: "us-east-1" },
          aws: {
            role: "arn:aws:mock:us-east-1:123456789012:SandboxExecutionRole",
          },
        },
      });

      const link = vm.link();
      expect(link.include).toBeUndefined();
      expect(await pulumi.resolve(link.properties)).toEqual({
        dev: { url: "http://localhost:9000" },
        port: 8080,
      });
      expect(vm.arn).toBeUndefined();
      expect(() => vm.nodes.image).toThrow(
        /Cannot access `nodes.image` of "Sandbox" in `sst dev`/,
      );
      expect(vm.nodes.executionRole).toBeDefined();
    });

    it("runs the command where it's told, and listens on the port", async () => {
      const vm = new MicroVm("Sandbox", {
        image: { context: "sandbox" },
        port: 3000,
        dev: { command: "npm run dev", directory: "." },
      });
      await pulumi.settle();
      expect(pulumi.reportOf("Sandbox")?.dev.directory).toBe(".");
      expect((await pulumi.resolve(vm.link().properties)).dev).toEqual({
        url: "http://localhost:3000",
      });
    });

    it("shares a connector as the docs show it, in sst dev too", async () => {
      // @ts-ignore
      const $dev = global.$dev;
      const sandbox = new MicroVm("Sandbox", {
        image: { context: "sandbox" },
        vpc: { privateSubnets: ["subnet-1"], securityGroups: ["sg-1"] },
      });
      new MicroVm("Grader", {
        image: { context: "sandbox" },
        existing: $dev
          ? {}
          : { networkConnector: sandbox.nodes.networkConnector },
      });
      await pulumi.settle();
      expect(ofType(CONNECTOR)).toEqual([]);
      expect(Object.keys(pulumi.reportOf("Grader")?.dev ?? {})).toContain(
        "aws",
      );
    });

    it("leaves a connector it's given alone", async () => {
      new MicroVm("Sandbox", {
        image: { context: "sandbox" },
        existing: {
          networkConnector:
            "arn:aws:lambda:us-east-1:123456789012:network-connector:shared",
        },
      });
      await pulumi.settle();
      expect(ofType(CONNECTOR)).toEqual([]);
    });

    it("builds the image with dev set to false", async () => {
      const vm = new MicroVm("Sandbox", {
        image: { context: "sandbox" },
        dev: false,
      });
      await pulumi.settle();
      expect(ofType(IMAGE)).toHaveLength(1);
      expect(trustOf("SandboxExecutionRole").statements).toHaveLength(1);
      expect(pulumi.reportOf("Sandbox")).toBeUndefined();
      expect(
        (await pulumi.resolve(vm.link().properties)).imageArn,
      ).toBeDefined();
    });
  });
});
