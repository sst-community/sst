import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, setSide, sidedClass } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

const TASK_DEFINITION = "aws:ecs/taskDefinition:TaskDefinition";
const IMAGE = "docker-build:index:Image";
const ROLE = "aws:iam/role:Role";
const ECR = "123456789012.dkr.ecr.us-east-1.amazonaws.com/sst-asset";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === IMAGE) return { digest: `sha256:${args.name}` };
    // A task definition that's looked up has its containers and its roles.
    // A "bare" one has no roles.
    if (args.type === TASK_DEFINITION && args.id)
      return {
        arn: args.id,
        containerDefinitions: JSON.stringify([
          { name: "app" },
          { name: "worker" },
        ]),
        ...(args.id.includes("bare")
          ? {}
          : {
              executionRoleArn:
                "arn:aws:iam::123456789012:role/their-execution-role",
              taskRoleArn: "arn:aws:iam::123456789012:role/their-task-role",
            }),
      };
    // A role that's looked up has the ARN it has
    if (args.type === ROLE && args.id)
      return { arn: `arn:aws:iam::123456789012:role/${args.id}` };
    return {};
  },
  call: (args) => {
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b"] };
    // The region is the provider's, as AWS answers
    if (
      args.token === "aws:index/getRegion:getRegion" &&
      String(args.provider ?? "").includes("::West::")
    )
      return { name: "us-west-2", region: "us-west-2", id: "us-west-2" };
    if (args.token === "aws:ecr/getAuthorizationToken:getAuthorizationToken")
      return {
        proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com",
        userName: "AWS",
        password: "token",
      };
    return undefined;
  },
});

type TaskClass =
  | typeof import("../../fixtures/v4/components/aws/task").Task
  | typeof import("../../../src/components/aws/task").Task;

describe("Task", () => {
  let OriginalTask: typeof import("../../fixtures/v4/components/aws/task").Task;
  let Task: typeof import("../../../src/components/aws/task").Task;
  // SST 4's for SST 4's side, SST 5's for SST 5's
  let Vpc: any;
  let ClusterClass: any;
  let Efs: any;
  let Bucket: typeof import("../../../src/components/aws/bucket").Bucket;
  // Where the Dockerfiles are. Building an image adds `.sst` to the ignore
  // file next to its Dockerfile.
  let app: string;
  let admin: string;

  beforeAll(async () => {
    OriginalTask = (await import("../../fixtures/v4/components/aws/task")).Task;
    Task = (await import("../../../src/components/aws/task")).Task;
    Vpc = await sidedClass(
      "Vpc",
      import("../../fixtures/v4/components/aws/vpc"),
      import("../../../src/components/aws/vpc"),
      import("../../../src/components/aws/takeover/vpc"),
    );
    ClusterClass = await sidedClass(
      "Cluster",
      import("../../fixtures/v4/components/aws/cluster"),
      import("../../../src/components/aws/cluster"),
      import("../../../src/components/aws/takeover/cluster"),
    );
    Efs = await sidedClass(
      "Efs",
      import("../../fixtures/v4/components/aws/efs"),
      import("../../../src/components/aws/efs"),
      import("../../../src/components/aws/takeover/efs"),
    );
    Bucket = (await import("../../../src/components/aws/bucket")).Bucket;
    await import("../../../src/components/aws/takeover/task");
    await import("../../../src/components/aws/takeover/bucket");

    app = fs.mkdtempSync(path.join(os.tmpdir(), "sst-task-"));
    admin = path.join(app, "admin");
    fs.mkdirSync(admin);
  });

  afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const named = (prefix: string) =>
    pulumi.resources
      .filter((r) => r.name.startsWith(prefix))
      .map((r) => r.name)
      .sort();
  const cluster = () =>
    new ClusterClass("MyCluster", { vpc: new Vpc("MyVpc") });
  const customVpc = {
    id: "vpc-1",
    securityGroups: ["sg-1"],
    containerSubnets: ["subnet-private-1", "subnet-private-2"],
    loadBalancerSubnets: ["subnet-public-1", "subnet-public-2"],
    publicSubnets: ["subnet-public-1", "subnet-public-2"],
  };
  // The definitions are a secret when an image is built: it's pushed with
  // the registry's password
  const definitions = (name = "MyTaskTaskDefinition") => {
    const json = resource(name).inputs.containerDefinitions;
    return JSON.parse(typeof json === "string" ? json : json.value);
  };
  const takesOver = async (original: () => void, v5: () => void) => {
    const result = await pulumi.takesOver(original, v5);
    return {
      unclaimed: result.unclaimed,
      changed: result.changed.map((c) => [c.name, c.fields]),
    };
  };

  // Each case deploys the 4.x Task, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs. Each case also has to register the same thing for `sst dev` to run.
  describe("takes over a deployed Task", () => {
    pulumi.takeoverCases({
      original: () => OriginalTask,
      v5: () => Task,
      check: () => {
        expect(resource("MyTaskTaskDefinition").type).toBe(TASK_DEFINITION);
        // What the task tells `sst dev` to run is compared with the rest
        expect(pulumi.reportOf("MyTask")).toHaveProperty("task");
      },
      cases: {
        "an image that's pulled": (Task, opts) => {
          new Task(
            "MyTask",
            { cluster: cluster(), image: "nginx:latest" },
            opts,
          );
        },
        "an image built from the Dockerfile at the root": (Task, opts) => {
          new Task(
            "MyTask",
            { cluster: cluster(), image: { context: app } },
            opts,
          );
        },
        "an image built with every setting": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              architecture: "arm64",
              image: {
                context: app,
                dockerfile: "Dockerfile.task",
                args: { NODE_ENV: "production" },
                secrets: { NPM_TOKEN: "token" },
                tags: ["latest", "v1"],
                target: "runner",
                cache: false,
              },
            },
            opts,
          );
        },
        "the size of the task": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: "nginx:latest",
              cpu: "1 vCPU",
              memory: "4 GB",
              storage: "50 GB",
            },
            opts,
          );
        },
        "what the container runs with": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: "nginx:latest",
              command: ["node", "index.js"],
              entrypoint: ["/usr/bin/tini", "--"],
              environment: { STAGE: "test", LEVEL: "debug" },
              environmentFiles: ["arn:aws:s3:::my-bucket/my-env-file.env"],
              ssm: {
                API_KEY: "arn:aws:ssm:us-east-1:123456789012:parameter/key",
              },
              logging: { retention: "1 week", name: "/custom/task" },
              permissions: [
                {
                  actions: ["s3:GetObject"],
                  resources: ["arn:aws:s3:::my-bucket/*"],
                },
                {
                  effect: "deny",
                  actions: ["s3:DeleteObject"],
                  resources: ["*"],
                },
              ],
            },
            opts,
          );
        },
        "linked resources": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: { context: app },
              link: [new Bucket("MyBucket")],
            },
            opts,
          );
        },
        "settings given as outputs": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              architecture: output("arm64" as const),
              image: output("nginx:latest"),
              command: output(["node", output("index.js")]),
              environment: output({ STAGE: output("test") }),
              logging: output({ retention: "1 week" as const }),
              ssm: output({
                API_KEY: output("arn:aws:ssm:us-east-1:1:parameter/key"),
              }),
            },
            opts,
          );
        },
        "an image to build given as an output": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: output({ context: output(app), target: "runner" }),
            },
            opts,
          );
        },
        "several containers": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              containers: [
                {
                  name: "app",
                  image: "nginxdemos/hello:plain-text",
                  cpu: "0.125 vCPU",
                  memory: "0.25 GB",
                  environment: { ROLE: "app" },
                },
                {
                  name: "admin-panel",
                  image: { context: admin },
                  command: ["node", "admin.js"],
                  logging: { retention: "3 days" },
                },
              ],
            },
            opts,
          );
        },
        "a volume given by its ids": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: "nginx:latest",
              volumes: [
                {
                  efs: { fileSystem: "fs-1", accessPoint: "fsap-1" },
                  path: "/mnt/efs",
                },
              ],
            },
            opts,
          );
        },
        "a volume several containers mount": (Task, opts) => {
          const efs = new Efs("MyEfs", {
            vpc: { id: "vpc-1", subnets: ["subnet-1"] },
          });
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              containers: [
                {
                  name: "app",
                  image: "nginx:latest",
                  volumes: [{ efs, path: "/mnt/efs" }],
                },
                {
                  name: "worker",
                  image: "nginx:latest",
                  volumes: [
                    { efs, path: "/data" },
                    {
                      efs: { fileSystem: "fs-2", accessPoint: "fsap-2" },
                      path: "/more",
                    },
                  ],
                },
              ],
            },
            opts,
          );
        },
        // The 4.x Task let the containers' own environment files go
        // unread: only the top-level ones were granted. The execution role
        // is updated in place to read them.
        "settings on each container": {
          create: (Task, opts) => {
            new Task(
              "MyTask",
              {
                cluster: cluster(),
                containers: [
                  {
                    name: "app",
                    image: "nginx:latest",
                    cpu: "0.125 vCPU",
                    command: ["node", "index.js"],
                    entrypoint: ["/usr/bin/tini", "--"],
                    environment: { ROLE: "app" },
                    environmentFiles: ["arn:aws:s3:::my-bucket/app.env"],
                    ssm: {
                      API_KEY:
                        "arn:aws:ssm:us-east-1:123456789012:parameter/key",
                    },
                    logging: { name: "/custom/app", retention: "2 weeks" },
                  },
                  {
                    name: "worker",
                    image: output("nginx:latest"),
                    environment: output({ ROLE: "worker" }),
                    logging: output({ retention: "forever" as const }),
                  },
                ],
              },
              opts,
            );
          },
          changed: [["MyTaskExecutionRole", ["inlinePolicies"]]],
          check: () =>
            expect(
              JSON.parse(
                resource("MyTaskExecutionRole").inputs.inlinePolicies[0].policy,
              ).statements,
            ).toContainEqual({
              sid: "ReadEnvironmentFiles",
              actions: ["s3:GetObject"],
              resources: ["arn:aws:s3:::my-bucket/app.env"],
            }),
        },
        "a public task": (Task, opts) => {
          new Task(
            "MyTask",
            { cluster: cluster(), image: "nginx:latest", public: true },
            opts,
          );
        },
        "a task without a public ip": (Task, opts) => {
          new Task(
            "MyTask",
            { cluster: cluster(), image: "nginx:latest", publicIp: false },
            opts,
          );
        },
        transforms: (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: { context: app },
              transform: {
                taskRole: { description: "Runs the task" },
                executionRole: (args, opts) => {
                  args.description = "Starts the task";
                  opts.protect = true;
                },
                taskDefinition: (args) => {
                  args.family = "custom-family";
                  args.tags = { team: "data" };
                },
                logGroup: { kmsKeyId: "key-1" },
                image: (args: any) => {
                  args.noCache = true;
                  return undefined;
                },
              },
            },
            opts,
          );
        },
        "dev settings outside of sst dev": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: { context: app },
              dev: { command: "node task.js", directory: "packages/task" },
            },
            opts,
          );
        },
        "a task in a VPC of your own": {
          create: (Task, opts) => {
            new Task(
              "MyTask",
              {
                cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
                image: "nginx:latest",
                public: true,
              },
              opts,
            );
          },
          check: () =>
            expect(resource("MyTaskPublicSecurityGroup").inputs.vpcId).toBe(
              "vpc-1",
            ),
        },
        "roles you already have": {
          original: (opts) =>
            new OriginalTask(
              "MyTask",
              {
                cluster: cluster(),
                image: "nginx:latest",
                taskRole: "my-task-role",
                executionRole: "my-execution-role",
              },
              opts,
            ),
          v5: (opts) =>
            new Task(
              "MyTask",
              {
                cluster: cluster(),
                image: "nginx:latest",
                existing: {
                  taskRole: "my-task-role",
                  executionRole: "my-execution-role",
                },
              },
              opts,
            ),
          check: () => {
            expect(resource("MyTaskTaskRole")).toMatchObject({
              kind: "read",
              options: { id: "my-task-role" },
            });
            expect(resource("MyTaskTaskDefinition").inputs).toMatchObject({
              taskRoleArn: "arn:aws:iam::123456789012:role/my-task-role",
              executionRoleArn:
                "arn:aws:iam::123456789012:role/my-execution-role",
            });
          },
        },
        // V5 merges an object transform into the defaults. 4.x replaced a
        // nested object whole, which dropped the operating system here.
        "an object transform that sets part of the platform": {
          create: (Task, opts) => {
            new Task(
              "MyTask",
              {
                cluster: cluster(),
                image: "nginx:latest",
                transform: {
                  taskDefinition: {
                    runtimePlatform: { cpuArchitecture: "ARM64" },
                  },
                },
              },
              opts,
            );
          },
          changed: [["MyTaskTask", ["runtimePlatform"]]],
          check: () =>
            expect(
              resource("MyTaskTaskDefinition").inputs.runtimePlatform,
            ).toEqual({
              cpuArchitecture: "ARM64",
              operatingSystemFamily: "LINUX",
            }),
        },
      },
    });

    // With no image settings the Dockerfile at the root of the app is built
    it("a task with no image settings", async () => {
      // @ts-ignore
      const paths = global.$cli.paths;
      const root = paths.root;
      paths.root = app;
      try {
        const create = (Task: TaskClass) => () =>
          new Task("MyTask", { cluster: cluster() });

        expect(await takesOver(create(OriginalTask), create(Task))).toEqual({
          // SST 4's version markers, of the cluster and the VPC
          unclaimed: [
            "sst:sst:Version::MyClusterVersion",
            "sst:sst:Version::MyVpcVersion",
          ],
          changed: [],
        });
        expect(resource("MyTaskImageMyTask").inputs).toMatchObject({
          context: { location: app },
          dockerfile: { location: path.join(app, "Dockerfile") },
        });
        expect(pulumi.reportOf("MyTask")).toEqual({
          contract: 1,
          task: { directory: "." },
        });
      } finally {
        paths.root = root;
      }
    });

    // What a cron job, the SDK and anything linked run the task with has
    // to come out the same, wherever the task is
    const placements: Record<string, (Task: TaskClass) => any> = {
      "in an SST VPC": (Task) =>
        new Task("MyTask", { cluster: cluster(), image: "nginx:latest" }),
      "public in an SST VPC": (Task) =>
        new Task("MyTask", {
          cluster: cluster(),
          image: "nginx:latest",
          public: true,
        }),
      "without a public ip in an SST VPC": (Task) =>
        new Task("MyTask", {
          cluster: cluster(),
          image: "nginx:latest",
          publicIp: false,
        }),
      "in a VPC of your own": (Task) =>
        new Task("MyTask", {
          cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
          image: "nginx:latest",
        }),
      "public in a VPC of your own": (Task) =>
        new Task("MyTask", {
          cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
          image: "nginx:latest",
          public: true,
        }),
      "with a public ip in a VPC of your own": (Task) =>
        new Task("MyTask", {
          cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
          containers: [
            { name: "app", image: "nginx:latest" },
            { name: "worker", image: "nginx:latest" },
          ],
          publicIp: true,
        }),
    };

    for (const [name, create] of Object.entries(placements)) {
      it(`is run the same way ${name}`, async () => {
        const read = async (task: any) => {
          await pulumi.settle();
          const link = task.getSSTLink();
          const rename = (value: unknown) =>
            JSON.parse(
              JSON.stringify(value).replaceAll("MyTaskTaskDefinition", "MyTaskTask"),
            );
          return rename(
            await pulumi.resolve({
              taskDefinition: task.taskDefinition,
              cluster: task.cluster,
              containers: task.containers,
              subnets: task.subnets,
              securityGroups: task.securityGroups,
              assignPublicIp: task.assignPublicIp,
              link: link.properties,
              include: link.include,
            }),
          );
        };

        setSide("original");
        const original = await read(create(OriginalTask));
        pulumi.reset();
        setSide("v5");
        expect(await read(create(Task))).toEqual(original);
        expect(original.containers.length).toBeGreaterThan(0);
      });
    }

    // The task definition is named after its part, and a container's image
    // and log group after the container's name as a name is written
    it("keeps what it renames", async () => {
      const create = (Task: TaskClass) =>
        new Task("MyTask", {
          cluster: cluster(),
          containers: [
            { name: "app", image: { context: app } },
            { name: "admin-panel", image: { context: admin } },
          ],
        });

      setSide("original");
      create(OriginalTask);
      await pulumi.settle();
      const original = pulumi.graph();
      expect(named("MyTask")).toEqual([
        "MyTask",
        "MyTaskExecutionRole",
        "MyTaskImageadmin-panel",
        "MyTaskImageapp",
        "MyTaskLogGroupadmin-panel",
        "MyTaskLogGroupapp",
        "MyTaskTask",
        "MyTaskTaskRole",
      ]);

      pulumi.reset();
      setSide("v5");
      create(Task);
      await pulumi.settle();
      expect(named("MyTask")).toEqual([
        "MyTask",
        "MyTaskExecutionRole",
        "MyTaskImageAdminpanel",
        "MyTaskImageApp",
        "MyTaskLogGroupAdminpanel",
        "MyTaskLogGroupApp",
        "MyTaskTaskDefinition",
        "MyTaskTaskRole",
      ]);
      expect(pulumi.takeover(original)).toEqual({
        // SST 4's version markers, of the cluster and the VPC
        unclaimed: [
          "sst:sst:Version::MyClusterVersion",
          "sst:sst:Version::MyVpcVersion",
        ],
        changed: [],
        unordered: [],
        revealed: [],
      });
    });

  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    pulumi.takeoverCases({
      original: () => OriginalTask,
      v5: () => Task,
      check: () => expect(pulumi.reportOf("MyTask")).toHaveProperty("task"),
      cases: {
        "a task with a command to run": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              image: { context: app },
              environment: { STAGE: "test" },
              command: ["node", "index.js"],
              dev: { command: "node task.js" },
            },
            opts,
          );
        },
        "the first of several containers": (Task, opts) => {
          new Task(
            "MyTask",
            {
              cluster: cluster(),
              containers: [
                { name: "app", image: { context: app }, entrypoint: ["tini"] },
                { name: "admin", image: { context: admin } },
              ],
            },
            opts,
          );
        },
        "a task that's deployed all the same": (Task, opts) => {
          new Task(
            "MyTask",
            { cluster: cluster(), image: { context: app }, dev: false },
            opts,
          );
        },
      },
    });

    it("deploys a stub in place of the task", async () => {
      const task = new Task("MyTask", {
        cluster: cluster(),
        containers: [
          {
            name: "app",
            image: { context: app },
            command: ["node", "index.js"],
            environment: { STAGE: "test" },
          },
          { name: "admin", image: { context: admin } },
        ],
        dev: { command: "node task.js", directory: "packages/task" },
      });
      await pulumi.settle();

      // Only the first container, running the stub, and nothing is built
      expect(pulumi.resources.filter((r) => r.type === IMAGE)).toEqual([]);
      expect(named("MyTaskLogGroup")).toEqual(["MyTaskLogGroupApp"]);
      const [stub, ...others] = definitions();
      expect(others).toEqual([]);
      expect(stub).toMatchObject({
        name: "app",
        image: "ghcr.io/sst-community/sst/bridge-task:latest",
      });
      expect(stub.command).toBe(undefined);
      expect(stub.environment).toEqual(
        expect.arrayContaining([
          { name: "STAGE", value: "test" },
          { name: "SST_TASK_ID", value: "MyTask" },
          { name: "SST_APPSYNC_HTTP", value: "appsync.example.com" },
          { name: "SST_APPSYNC_REALTIME", value: "appsync-realtime.example.com" },
          { name: "SST_APP", value: "app" },
          { name: "SST_STAGE", value: "test" },
        ]),
      );
      // The process on the user's machine assumes the task's role, and the
      // stub reaches it over AppSync
      expect(resource("MyTaskTaskRole").inputs.assumeRolePolicy).toMatchObject({
        Statement: [
          {
            Principal: {
              Service: "ecs-tasks.amazonaws.com",
              AWS: "123456789012",
            },
          },
        ],
      });
      expect(
        JSON.parse(resource("MyTaskTaskRole").inputs.inlinePolicies[0].policy)
          .statements,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actions: ["appsync:*"], resources: ["*"] }),
        ]),
      );
      // Running it still names every container
      expect(await pulumi.resolve(task.containers)).toEqual(["app", "admin"]);
      expect(pulumi.outputsOf("MyTask")).toEqual({
        _sst: {
          contract: 1,
          task: { directory: "packages/task", command: "node task.js" },
        },
      });
    });
  });

  it("runs one container named after the task by default", async () => {
    const task = new Task("MyTask", { cluster: cluster(), image: "nginx:latest" });
    await pulumi.settle();

    expect(named("MyTask")).toEqual([
      "MyTask",
      "MyTaskExecutionRole",
      "MyTaskLogGroupMyTask",
      "MyTaskTaskDefinition",
      "MyTaskTaskRole",
    ]);
    expect(resource("MyTaskTaskDefinition").inputs).toMatchObject({
      family: expect.stringMatching(/-MyTask$/),
      cpu: "256",
      memory: "512",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      runtimePlatform: {
        cpuArchitecture: "X86_64",
        operatingSystemFamily: "LINUX",
      },
      executionRoleArn: "arn:aws:mock:us-east-1:123456789012:MyTaskExecutionRole",
      taskRoleArn: "arn:aws:mock:us-east-1:123456789012:MyTaskTaskRole",
      volumes: [],
    });
    expect(resource("MyTaskTaskDefinition").inputs.ephemeralStorage).toBe(
      undefined,
    );
    expect(definitions()).toEqual([
      {
        name: "MyTask",
        image: "nginx:latest",
        pseudoTerminal: true,
        portMappings: [{ containerPortRange: "1-65535" }],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": expect.stringMatching(
              /^\/sst\/cluster\/.+\/app-test-MyTask-.+\/MyTask$/,
            ),
            "awslogs-region": "us-east-1",
            "awslogs-stream-prefix": "/service",
          },
        },
        environment: [
          { name: "SST_RESOURCE_App", value: '{"name":"app","stage":"test"}' },
        ],
        linuxParameters: { initProcessEnabled: true },
        secrets: [],
      },
    ]);
    expect(resource("MyTaskLogGroupMyTask").inputs.retentionInDays).toBe(30);
    expect(resource("MyTaskLogGroupMyTask").options.ignoreChanges).toEqual(["name"]);

    // What a cron job or the SDK runs it with
    expect(
      await pulumi.resolve([
        task.taskDefinition,
        task.cluster,
        task.containers,
        task.subnets,
        task.securityGroups,
        task.assignPublicIp,
      ]),
    ).toEqual([
      "arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition",
      "arn:aws:mock:us-east-1:123456789012:MyClusterCluster",
      ["MyTask"],
      ["MyVpcPublicSubnet1_id", "MyVpcPublicSubnet2_id"],
      ["MyVpcSecurityGroup_id"],
      true,
    ]);
    expect(task.nodes.taskDefinition.urn).toBeDefined();
    expect(task.nodes.publicSecurityGroup).toBe(undefined);
    expect(pulumi.reportOf("MyTask")).toEqual({
      contract: 1,
      task: { directory: "" },
    });
  });

  it("builds an image from a Dockerfile and pushes it", async () => {
    const task = new Task("MyTask", {
      cluster: cluster(),
      image: { context: app, args: { NODE_ENV: "production" } },
    });
    await pulumi.settle();

    expect(resource("MyTaskImageMyTask").inputs).toMatchObject({
      context: { location: app },
      dockerfile: { location: path.join(app, "Dockerfile") },
      buildArgs: { NODE_ENV: "production" },
      platforms: ["linux/amd64"],
      tags: [`${ECR}:MyTask`],
      cacheFrom: [{ registry: { ref: `${ECR}:MyTask-cache` } }],
      push: true,
    });
    expect(definitions()[0].image).toBe(`${ECR}@sha256:MyTaskImageMyTask`);
    expect(fs.readFileSync(path.join(app, ".dockerignore"), "utf8")).toMatch(
      /^\.sst$/m,
    );
    expect(Object.keys(task.nodes.image)).toEqual(["MyTask"]);
    expect(pulumi.reportOf("MyTask")).toEqual({
      contract: 1,
      task: { directory: app },
    });
  });

  it("keeps a container's image and log group under its name", async () => {
    const task = new Task("MyTask", {
      cluster: cluster(),
      containers: [
        { name: "app", image: "nginx:latest", memory: "0.25 GB" },
        { name: "admin-panel", image: { context: admin } },
      ],
      transform: {
        logGroup: (args, _opts, _name, container) => {
          if (container === "admin-panel") args.retentionInDays = 7;
        },
      },
    });
    await pulumi.settle();

    expect(Object.keys(task.nodes.logGroup).sort()).toEqual(["admin-panel", "app"]);
    expect(Object.keys(task.nodes.image)).toEqual(["admin-panel"]);
    expect(resource("MyTaskLogGroupAdminpanel").inputs.retentionInDays).toBe(7);
    expect(resource("MyTaskLogGroupApp").inputs.retentionInDays).toBe(30);
    expect(definitions().map((c: any) => [c.name, c.memory])).toEqual([
      ["app", 256],
      ["admin-panel", undefined],
    ]);
    expect(await pulumi.resolve(task.containers)).toEqual(["app", "admin-panel"]);
  });

  it("gives a log group's transform function plain values from a plain config, as SST 4 did", async () => {
    const seen: Record<string, any> = {};
    new Task("MyTask", {
      cluster: cluster(),
      containers: [
        {
          name: "app",
          image: "nginx:latest",
          logging: { name: "/my/app", retention: "1 week" },
        },
        { name: "worker", image: "nginx:latest" },
      ],
      transform: {
        logGroup: (args, _opts, _name, container) => {
          seen[container!] = [args.name, args.retentionInDays];
        },
      },
    });
    await pulumi.settle();

    expect(seen.app).toEqual(["/my/app", 7]);
    // The name SST makes up waits on the cluster's
    expect(typeof seen.worker[0]).toBe("object");
    expect(seen.worker[1]).toBe(30);
  });

  it("opens a public task to the internet", async () => {
    const task = new Task("MyTask", {
      cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
      image: "nginx:latest",
      public: true,
    });
    await pulumi.settle();

    expect(resource("MyTaskPublicSecurityGroup").inputs).toMatchObject({
      vpcId: "vpc-1",
      ingress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    });
    expect(
      await pulumi.resolve([task.subnets, task.securityGroups, task.assignPublicIp]),
    ).toEqual([
      ["subnet-public-1", "subnet-public-2"],
      ["sg-1", "MyTaskPublicSecurityGroup_id"],
      true,
    ]);
  });

  it("stays in the private subnets of a VPC of your own", async () => {
    const task = new Task("MyTask", {
      cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
      image: "nginx:latest",
    });
    await pulumi.settle();

    expect(
      await pulumi.resolve([task.subnets, task.securityGroups, task.assignPublicIp]),
    ).toEqual([["subnet-private-1", "subnet-private-2"], ["sg-1"], false]);
  });

  it("links what's needed to run it", async () => {
    const task = new Task("MyTask", { cluster: cluster(), image: "nginx:latest" });
    await pulumi.settle();

    const link = (task as any).getSSTLink();
    expect(await pulumi.resolve(link.properties)).toEqual({
      cluster: "arn:aws:mock:us-east-1:123456789012:MyClusterCluster",
      containers: ["MyTask"],
      taskDefinition: "arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition",
      subnets: ["MyVpcPublicSubnet1_id", "MyVpcPublicSubnet2_id"],
      securityGroups: ["MyVpcSecurityGroup_id"],
      assignPublicIp: true,
    });
    expect(await pulumi.resolve(link.include)).toEqual([
      {
        type: "aws.permission",
        actions: ["ecs:*"],
        resources: [
          "arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition",
          "arn:aws:mock:us-east-1:123456789012:MyClusterCluster/*",
        ],
      },
      {
        type: "aws.permission",
        actions: ["iam:PassRole"],
        resources: [
          "arn:aws:mock:us-east-1:123456789012:MyTaskExecutionRole",
          "arn:aws:mock:us-east-1:123456789012:MyTaskTaskRole",
        ],
      },
    ]);
  });

  it("is run by a cron job", async () => {
    const { CronV2 } = await import("../../../src/components/aws/cron-v2");
    await import("../../../src/components/aws/takeover/cron-v2");
    new CronV2("MyCronJob", {
      task: new Task("MyTask", { cluster: cluster(), image: "nginx:latest" }),
      schedule: "rate(1 day)",
    });
    await pulumi.settle();

    expect(resource("MyCronJobSchedule").inputs.target).toMatchObject({
      arn: "arn:aws:mock:us-east-1:123456789012:MyClusterCluster",
      ecsParameters: {
        taskDefinitionArn:
          "arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition",
        networkConfiguration: { assignPublicIp: true },
      },
    });
    expect(JSON.parse(resource("MyCronJobSchedule").inputs.target.input)).toEqual({
      containerOverrides: [
        { name: "MyTask", environment: [{ name: "SST_EVENT", value: "{}" }] },
      ],
    });
  });

  // The 4.x CronV2 reads a task through its getters, which the V5 Task has
  // too. Its type only names the 4.x Task.
  // It's run the way it is: nothing it would be made with is created
  describe("with a task definition you already have", () => {
    const ARN = "arn:aws:ecs:us-east-1:123456789012:task-definition/theirs:3";
    const given = (args: object = {}, existing: object = {}) =>
      new Task("MyTask", {
        cluster: cluster(),
        ...args,
        existing: { taskDefinition: ARN, ...existing },
      } as any);

    it("creates no roles, images or log groups", async () => {
      const task = given({ public: true });
      await pulumi.settle();

      expect(named("MyTask")).toEqual([
        "MyTask",
        "MyTaskPublicSecurityGroup",
        "MyTaskTaskDefinition",
      ]);
      expect(resource("MyTaskTaskDefinition")).toMatchObject({
        kind: "read",
        options: { id: ARN },
      });
      expect(task.nodes.taskRole).toBeUndefined();
      expect(task.nodes.executionRole).toBeUndefined();
      expect(Object.keys(task.nodes.image)).toEqual([]);
      expect(Object.keys(task.nodes.logGroup)).toEqual([]);
      // There's no stub for `sst dev` to run it through
      expect(pulumi.reportOf("MyTask")).toBeUndefined();
    });

    it("is run with its containers, and its roles are passed", async () => {
      const task = given();
      await pulumi.settle();

      const link = (task as any).getSSTLink();
      expect(
        await pulumi.resolve({
          taskDefinition: link.properties.taskDefinition,
          containers: link.properties.containers,
          passed: link.include[1],
        }),
      ).toEqual({
        taskDefinition: ARN,
        containers: ["app", "worker"],
        passed: {
          type: "aws.permission",
          actions: ["iam:PassRole"],
          resources: [
            "arn:aws:iam::123456789012:role/their-execution-role",
            "arn:aws:iam::123456789012:role/their-task-role",
          ],
        },
      });
    });

    // IAM refuses a statement with no resources
    it("passes nothing for one with no roles", async () => {
      const bare = "arn:aws:ecs:us-east-1:123456789012:task-definition/bare:1";
      const task = given({}, { taskDefinition: bare });
      await pulumi.settle();

      expect(
        await pulumi.resolve((task as any).getSSTLink().include[1].resources),
      ).toEqual([bare]);
    });

    it("is run in sst dev too, with no stub", async () => {
      // @ts-ignore
      global.$dev = true;
      given();
      await pulumi.settle();

      expect(named("MyTask")).toEqual(["MyTask", "MyTaskTaskDefinition"]);
      expect(pulumi.reportOf("MyTask")).toBeUndefined();
    });

    it("refuses what would make one", async () => {
      expect(() =>
        given({ image: "nginx:latest", link: [], permissions: [] }),
      ).toThrow(
        `The "MyTask" task is given an existing "taskDefinition", which it uses the way it is. Remove "image", "link", "permissions" from its args.`,
      );
      expect(() =>
        given({
          containers: [{ name: "app", image: "nginx:latest" }],
          cpu: "1 vCPU",
          memory: "2 GB",
        }),
      ).toThrow(/Remove "containers", "cpu", "memory" from its args/);
      // There's no stub to run it through
      expect(() => given({ dev: { command: "node task.js" } })).toThrow(
        /Remove "dev" from its args/,
      );
      // How it's run is the task's
      expect(() =>
        given({ dev: false, public: true, publicIp: true }),
      ).not.toThrow();
      await pulumi.settle();
    });

    it("refuses in existing what it would be made with", () => {
      for (const [key, value] of Object.entries({
        taskRole: "my-task-role",
        executionRole: "my-execution-role",
        image: { MyTask: "my-image" },
        logGroup: { MyTask: "my-log-group" },
      }))
        expect(() => given({}, { [key]: value })).toThrow(
          `"existing.${key}" isn't an option for the "MyTask" task. It's given an existing "taskDefinition", which it uses the way it is, so it creates nothing this would stand in for. Remove it.`,
        );
    });
  });

  describe("what it's given", () => {
    it("points taskRole at existing", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            taskRole: "my-task-role",
          } as any),
      ).toThrow(
        `"taskRole" isn't an option for the "MyTask" task. Pass the role, or its name, as "existing: { taskRole }".`,
      );
    });

    it("points executionRole at existing", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            executionRole: "my-execution-role",
          } as any),
      ).toThrow(
        `"executionRole" isn't an option for the "MyTask" task. Pass the role, or its name, as "existing: { executionRole }".`,
      );
    });

    // 4.x refused the two together, and marked "publicIp" deprecated. It's
    // the one way to give a task in a VPC of your own a public IP without
    // making it public, so the V5 one keeps it, and refuses only what can't be.
    it("takes public with publicIp, unless publicIp is false", async () => {
      const both = new Task("Both", {
        cluster: cluster(),
        image: "nginx:latest",
        public: true,
        publicIp: true,
      });
      await pulumi.settle();
      expect(await pulumi.resolve(both.assignPublicIp)).toBe(true);
      expect(named("BothPublicSecurityGroup")).toEqual([
        "BothPublicSecurityGroup",
      ]);

      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            image: "nginx:latest",
            public: true,
            publicIp: false,
          }),
      ).toThrow(
        `"publicIp" can't be false when "public" is true in the "MyTask" task: a public task has a public IP.`,
      );
    });

    it("can't be public in a VPC given by its ids without public subnets", async () => {
      const { publicSubnets, ...vpc } = customVpc;
      const errors = await applyErrors(
        () =>
          new Task("MyTask", {
            cluster: new ClusterClass("MyCluster", { vpc }),
            image: "nginx:latest",
            public: true,
          }),
        pulumi.settle,
      );

      expect([...new Set(errors)]).toEqual([
        'The "MyTask" task is "public", and the "vpc" of its cluster has no "publicSubnets". Set them on the cluster.',
      ]);
    });

    it("can't have both containers and a top-level image", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            image: "nginx:latest",
            containers: [{ name: "app", image: "nginx:latest" }],
          }),
      ).toThrow(
        `"image" isn't an option for the "MyTask" task, which has "containers". Set it on each container.`,
      );
      // It would be dropped
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            command: ["node", "index.js"],
            containers: [{ name: "app", image: "nginx:latest" }],
          }),
      ).toThrow(
        `"command" isn't an option for the "MyTask" task, which has "containers". Set it on each container.`,
      );
    });

    it("rejects containers given as an output", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            containers: output([{ name: "app" }]) as any,
          }),
      ).toThrow(/The "containers" of the "MyTask" task has to be a plain value/);
    });

    it("rejects a container given as an output", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            containers: [output({ name: "app" }) as any],
          }),
      ).toThrow(/Container 1 of the "MyTask" task has to be a plain value/);
    });

    it("takes an image you already have as the container's image", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            existing: { image: { MyTask: "my-image" } } as any,
          }),
      ).toThrow(
        `"existing.image" isn't an option for the "MyTask" task. Set the "image" of the container to the image's reference.`,
      );
    });

    it("refuses a public security group when it isn't public", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            image: "nginx:latest",
            existing: { publicSecurityGroup: "sg-mine" },
          }),
      ).toThrow(
        `"existing.publicSecurityGroup" isn't an option for the "MyTask" task. It's only created when "public" is true.`,
      );
    });

    // The role is used the way it is
    it("refuses permissions for a task role it's given", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            image: "nginx:latest",
            permissions: [{ actions: ["s3:*"], resources: ["*"] }],
            existing: { taskRole: "my-task-role" },
          }),
      ).toThrow(
        `The "MyTask" task is given an existing "taskRole", which it doesn't change. Add the "permissions" to the role itself.`,
      );
    });

    it("takes dev as a plain value", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            image: "nginx:latest",
            dev: output(false) as any,
          }),
      ).toThrow(/The "dev" of the "MyTask" task has to be a plain value/);
    });

    it("refuses what isn't a cluster", async () => {
      const { Cluster: ClusterV1 } = await import(
        "../../fixtures/v4/components/aws/cluster-v1"
      );
      expect(
        () =>
          new Task("MyTask", {
            cluster: new ClusterV1("Old", { vpc: customVpc as any }) as any,
            image: "nginx:latest",
          }),
      ).toThrow(
        `The "cluster" of the "MyTask" task isn't a "Cluster" component. Pass a "Cluster".`,
      );
      await pulumi.settle();
    });

    it("refuses a size Fargate doesn't offer, as it's given", () => {
      const create = (args: object) => () =>
        new Task("MyTask", {
          cluster: cluster(),
          image: "nginx:latest",
          ...args,
        });
      expect(create({ cpu: "3 vCPU" })).toThrow(
        /^The "cpu" of the "MyTask" task is "3 vCPU". Fargate offers 0.25 vCPU, /,
      );
      expect(create({ cpu: "1 vCPU", memory: "1 GB" })).toThrow(
        /^The "memory" of the "MyTask" task is "1 GB". With 1 vCPU, Fargate offers 2 GB, /,
      );
      expect(create({ storage: "10 GB" })).toThrow(
        `The "storage" of the "MyTask" task is "10 GB". It has to be between "20 GB" and "200 GB".`,
      );
    });

    it("is in the region of the provider it's given", async () => {
      const { Provider } = await import("@pulumi/aws");
      new Task(
        "MyTask",
        { cluster: cluster(), image: "nginx:latest" },
        { providers: [new Provider("West", { region: "us-west-2" })] },
      );
      await pulumi.settle();

      expect(definitions()[0].logConfiguration.options).toMatchObject({
        "awslogs-region": "us-west-2",
      });
    });

    it("rejects a container name given as an output", () => {
      expect(
        () =>
          new Task("MyTask", {
            cluster: cluster(),
            containers: [{ name: output("app") as any }],
          }),
      ).toThrow(
        /The "name" of container 1 of the "MyTask" task has to be a plain value/,
      );
    });
  });
});
