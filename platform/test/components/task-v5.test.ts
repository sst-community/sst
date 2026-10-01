import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../helpers/graph";

const TASK_DEFINITION = "aws:ecs/taskDefinition:TaskDefinition";
const IMAGE = "docker-build:index:Image";
const ROLE = "aws:iam/role:Role";
const ECR = "123456789012.dkr.ecr.us-east-1.amazonaws.com/sst-asset";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === IMAGE) return { digest: `sha256:${args.name}` };
    // A role that's looked up has the ARN it has
    if (args.type === ROLE && args.id)
      return { arn: `arn:aws:iam::123456789012:role/${args.id}` };
    return {};
  },
  call: (args) => {
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b"] };
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
  | typeof import("../../src/components/aws/task").Task
  | typeof import("../../src/components/aws/task-v5").TaskV5;
type Cluster = import("../../src/components/aws/cluster").Cluster;

describe("TaskV5", () => {
  let Task: typeof import("../../src/components/aws/task").Task;
  let TaskV5: typeof import("../../src/components/aws/task-v5").TaskV5;
  let Vpc: typeof import("../../src/components/aws/vpc").Vpc;
  let ClusterClass: typeof import("../../src/components/aws/cluster").Cluster;
  let Efs: typeof import("../../src/components/aws/efs").Efs;
  let BucketV5: typeof import("../../src/components/aws/bucket-v5").BucketV5;
  // Where the Dockerfiles are. Building an image adds `.sst` to the ignore
  // file next to its Dockerfile.
  let app: string;
  let admin: string;

  beforeAll(async () => {
    Task = (await import("../../src/components/aws/task")).Task;
    TaskV5 = (await import("../../src/components/aws/task-v5")).TaskV5;
    Vpc = (await import("../../src/components/aws/vpc")).Vpc;
    ClusterClass = (await import("../../src/components/aws/cluster")).Cluster;
    Efs = (await import("../../src/components/aws/efs")).Efs;
    BucketV5 = (await import("../../src/components/aws/bucket-v5")).BucketV5;
    await import("../../src/components/aws/takeover/task");
    await import("../../src/components/aws/takeover/bucket");

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

  // Each case deploys a Task, then the same thing as a TaskV5. Everything the
  // Task created has to be kept by the TaskV5, with the same inputs. Each
  // case also has to register the same thing for `sst dev` to run.
  describe("takes over a deployed Task", () => {
    const cases: Record<string, (Task: TaskClass, cluster: Cluster) => void> = {
      "an image that's pulled": (Task, cluster) => {
        new Task("MyTask", { cluster, image: "nginx:latest" });
      },
      "an image built from the Dockerfile at the root": (Task, cluster) => {
        new Task("MyTask", { cluster, image: { context: app } });
      },
      "an image built with every setting": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
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
        });
      },
      "the size of the task": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          image: "nginx:latest",
          cpu: "1 vCPU",
          memory: "4 GB",
          storage: "50 GB",
        });
      },
      "what the container runs with": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          image: "nginx:latest",
          command: ["node", "index.js"],
          entrypoint: ["/usr/bin/tini", "--"],
          environment: { STAGE: "test", LEVEL: "debug" },
          environmentFiles: ["arn:aws:s3:::my-bucket/my-env-file.env"],
          ssm: { API_KEY: "arn:aws:ssm:us-east-1:123456789012:parameter/key" },
          logging: { retention: "1 week", name: "/custom/task" },
          permissions: [
            { actions: ["s3:GetObject"], resources: ["arn:aws:s3:::my-bucket/*"] },
            { effect: "deny", actions: ["s3:DeleteObject"], resources: ["*"] },
          ],
        });
      },
      "linked resources": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          image: { context: app },
          link: [new BucketV5("MyBucket")],
        });
      },
      "settings given as outputs": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          architecture: output("arm64" as const),
          image: output("nginx:latest"),
          command: output(["node", output("index.js")]),
          environment: output({ STAGE: output("test") }),
          logging: output({ retention: "1 week" as const }),
          ssm: output({ API_KEY: output("arn:aws:ssm:us-east-1:1:parameter/key") }),
        });
      },
      "an image to build given as an output": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          image: output({ context: output(app), target: "runner" }),
        });
      },
      "several containers": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
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
        });
      },
      "a volume given by its ids": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          image: "nginx:latest",
          volumes: [
            {
              efs: { fileSystem: "fs-1", accessPoint: "fsap-1" },
              path: "/mnt/efs",
            },
          ],
        });
      },
      "a volume several containers mount": (Task, cluster) => {
        const efs = new Efs("MyEfs", {
          vpc: { id: "vpc-1", subnets: ["subnet-1"] },
        });
        new Task("MyTask", {
          cluster,
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
                { efs: { fileSystem: "fs-2", accessPoint: "fsap-2" }, path: "/more" },
              ],
            },
          ],
        });
      },
      "settings on each container": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          containers: [
            {
              name: "app",
              image: "nginx:latest",
              cpu: "0.125 vCPU",
              command: ["node", "index.js"],
              entrypoint: ["/usr/bin/tini", "--"],
              environment: { ROLE: "app" },
              environmentFiles: ["arn:aws:s3:::my-bucket/app.env"],
              ssm: { API_KEY: "arn:aws:ssm:us-east-1:123456789012:parameter/key" },
              logging: { name: "/custom/app", retention: "2 weeks" },
            },
            {
              name: "worker",
              image: output("nginx:latest"),
              environment: output({ ROLE: "worker" }),
              logging: output({ retention: "forever" as const }),
            },
          ],
        });
      },
      "a public task": (Task, cluster) => {
        new Task("MyTask", { cluster, image: "nginx:latest", public: true });
      },
      "a task without a public ip": (Task, cluster) => {
        new Task("MyTask", { cluster, image: "nginx:latest", publicIp: false });
      },
      transforms: (Task, cluster) => {
        new Task("MyTask", {
          cluster,
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
        });
      },
      "dev settings outside of sst dev": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          image: { context: app },
          dev: { command: "node task.js", directory: "packages/task" },
        });
      },
    };

    for (const [name, create] of Object.entries(cases)) {
      it(name, async () => {
        let before: unknown;
        expect(
          await takesOver(
            () => {
              create(Task, cluster());
              // What the Task tells `sst dev` to run
              pulumi.settle().then(() => (before = pulumi.outputsOf("MyTask")));
            },
            () => create(TaskV5, cluster()),
          ),
        ).toEqual({ unclaimed: [], changed: [] });
        expect(resource("MyTaskTaskDefinition").type).toBe(TASK_DEFINITION);
        expect(before).toBeDefined();
        expect(pulumi.outputsOf("MyTask")).toEqual(before);
      });
    }

    // With no image settings the Dockerfile at the root of the app is built
    it("a task with no image settings", async () => {
      // @ts-ignore
      const paths = global.$cli.paths;
      const root = paths.root;
      paths.root = app;
      try {
        const create = (Task: TaskClass) => () =>
          new Task("MyTask", { cluster: cluster() });

        expect(await takesOver(create(Task), create(TaskV5))).toEqual({
          unclaimed: [],
          changed: [],
        });
        expect(resource("MyTaskImageMyTask").inputs).toMatchObject({
          context: { location: app },
          dockerfile: { location: path.join(app, "Dockerfile") },
        });
        expect(pulumi.outputsOf("MyTask")).toEqual({ _task: { directory: "." } });
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

        const original = await read(create(Task));
        pulumi.reset();
        expect(await read(create(TaskV5))).toEqual(original);
        expect(original.containers.length).toBeGreaterThan(0);
      });
    }

    it("a task in a VPC of your own", async () => {
      const create = (Task: TaskClass) => () =>
        new Task("MyTask", {
          cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
          image: "nginx:latest",
          public: true,
        });

      expect(await takesOver(create(Task), create(TaskV5))).toEqual({
        unclaimed: [],
        changed: [],
      });
      expect(resource("MyTaskPublicSecurityGroup").inputs.vpcId).toBe("vpc-1");
    });

    it("roles you already have", async () => {
      expect(
        await takesOver(
          () =>
            new Task("MyTask", {
              cluster: cluster(),
              image: "nginx:latest",
              taskRole: "my-task-role",
              executionRole: "my-execution-role",
            }),
          () =>
            new TaskV5("MyTask", {
              cluster: cluster(),
              image: "nginx:latest",
              existing: {
                taskRole: "my-task-role",
                executionRole: "my-execution-role",
              },
            }),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
      expect(resource("MyTaskTaskRole")).toMatchObject({
        kind: "read",
        options: { id: "my-task-role" },
      });
      expect(resource("MyTaskTaskDefinition").inputs).toMatchObject({
        taskRoleArn: "arn:aws:iam::123456789012:role/my-task-role",
        executionRoleArn: "arn:aws:iam::123456789012:role/my-execution-role",
      });
    });

    it("a task inside another component", async () => {
      const { ComponentResource } = await import("@pulumi/pulumi");
      class Jobs extends ComponentResource {
        constructor(name: string) {
          super("test:Jobs", name);
        }
      }
      const create = (Task: TaskClass) => () =>
        new Task(
          "MyTask",
          {
            cluster: cluster(),
            containers: [{ name: "app", image: { context: app } }],
            public: true,
          },
          { parent: new Jobs("Jobs") },
        );

      expect(await takesOver(create(Task), create(TaskV5))).toEqual({
        unclaimed: [],
        changed: [],
      });
      expect(resource("MyTaskTaskDefinition").parent).toMatch(
        /::test:Jobs\$sst:aws:TaskV5::MyTask$/,
      );
      expect(resource("MyTaskImageApp").parent).toMatch(
        /::test:Jobs\$sst:aws:TaskV5::MyTask$/,
      );
    });

    it("a task deployed with another provider", async () => {
      const { Provider } = await import("@pulumi/aws");
      const create = (Task: TaskClass) => () =>
        new Task(
          "MyTask",
          { cluster: cluster(), image: "nginx:latest", public: true },
          { provider: new Provider("West", { region: "us-west-2" }) },
        );
      const providers = () =>
        pulumi.resources
          .filter(
            (r) =>
              r.custom && r.type.startsWith("aws:") && r.name.startsWith("MyTask"),
          )
          .map((r) => r.options.provider as string);

      create(Task)();
      await pulumi.settle();
      const original = providers();
      expect(original).toHaveLength(5);
      expect(new Set(original).size).toBe(1);
      expect(original[0]).toMatch(/::West::/);
      const before = pulumi
        .graph()
        .filter((r) => !r.type.startsWith("pulumi:providers:"));

      pulumi.reset();
      create(TaskV5)();
      await pulumi.settle();
      expect(pulumi.takeover(before)).toEqual({ unclaimed: [], changed: [] });
      expect(providers()).toEqual(original);
    });

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

      create(Task);
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
      create(TaskV5);
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
      expect(pulumi.takeover(original)).toEqual({ unclaimed: [], changed: [] });
    });

    // TaskV5 merges an object transform into the defaults. Task replaced a
    // nested object whole, which dropped the operating system here.
    it("an object transform that sets part of the platform", async () => {
      const create = (Task: TaskClass) => () =>
        new Task("MyTask", {
          cluster: cluster(),
          image: "nginx:latest",
          transform: {
            taskDefinition: {
              runtimePlatform: { cpuArchitecture: "ARM64" },
            },
          },
        });

      expect(await takesOver(create(Task), create(TaskV5))).toEqual({
        unclaimed: [],
        changed: [["MyTaskTask", ["runtimePlatform"]]],
      });
      expect(resource("MyTaskTaskDefinition").inputs.runtimePlatform).toEqual({
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
      });
    });
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    const stubbed: Record<string, (Task: TaskClass, cluster: Cluster) => void> = {
      "a task with a command to run": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          image: { context: app },
          environment: { STAGE: "test" },
          command: ["node", "index.js"],
          dev: { command: "node task.js" },
        });
      },
      "the first of several containers": (Task, cluster) => {
        new Task("MyTask", {
          cluster,
          containers: [
            { name: "app", image: { context: app }, entrypoint: ["tini"] },
            { name: "admin", image: { context: admin } },
          ],
        });
      },
      "a task that's deployed all the same": (Task, cluster) => {
        new Task("MyTask", { cluster, image: { context: app }, dev: false });
      },
    };

    for (const [name, create] of Object.entries(stubbed)) {
      it(`takes over ${name}`, async () => {
        let before: unknown;
        expect(
          await takesOver(
            () => {
              create(Task, cluster());
              pulumi.settle().then(() => (before = pulumi.outputsOf("MyTask")));
            },
            () => create(TaskV5, cluster()),
          ),
        ).toEqual({ unclaimed: [], changed: [] });
        expect(before).toBeDefined();
        expect(pulumi.outputsOf("MyTask")).toEqual(before);
      });
    }

    it("deploys a stub in place of the task", async () => {
      const task = new TaskV5("MyTask", {
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
        _task: {
          directory: "packages/task",
          command: "node task.js",
        },
      });
    });
  });

  it("runs one container named after the task by default", async () => {
    const task = new TaskV5("MyTask", { cluster: cluster(), image: "nginx:latest" });
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
    expect(pulumi.outputsOf("MyTask")).toEqual({ _task: { directory: "" } });
  });

  it("builds an image from a Dockerfile and pushes it", async () => {
    const task = new TaskV5("MyTask", {
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
    expect(pulumi.outputsOf("MyTask")).toEqual({ _task: { directory: app } });
  });

  it("keeps a container's image and log group under its name", async () => {
    const task = new TaskV5("MyTask", {
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

  it("opens a public task to the internet", async () => {
    const task = new TaskV5("MyTask", {
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
    const task = new TaskV5("MyTask", {
      cluster: new ClusterClass("MyCluster", { vpc: customVpc }),
      image: "nginx:latest",
    });
    await pulumi.settle();

    expect(
      await pulumi.resolve([task.subnets, task.securityGroups, task.assignPublicIp]),
    ).toEqual([["subnet-private-1", "subnet-private-2"], ["sg-1"], false]);
  });

  it("links what's needed to run it", async () => {
    const task = new TaskV5("MyTask", { cluster: cluster(), image: "nginx:latest" });
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
    const { CronV2V5 } = await import("../../src/components/aws/cron-v2-v5");
    await import("../../src/components/aws/takeover/cron-v2");
    new CronV2V5("MyCronJob", {
      task: new TaskV5("MyTask", { cluster: cluster(), image: "nginx:latest" }),
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

  // CronV2 reads a task through its getters, which TaskV5 has too. Its type
  // only says Task.
  it("is run by a CronV2 the way a Task is", async () => {
    const { CronV2 } = await import("../../src/components/aws/cron-v2");
    const target = async (Task: TaskClass) => {
      pulumi.reset();
      new CronV2("MyCronJob", {
        task: new Task("MyTask", {
          cluster: cluster(),
          image: "nginx:latest",
        }) as any,
        schedule: "rate(1 day)",
        event: { foo: "bar" },
      });
      await pulumi.settle();
      return JSON.parse(
        JSON.stringify([
          resource("MyCronJobSchedule").inputs.target,
          resource("MyCronJobRole").inputs.inlinePolicies,
        ]).replaceAll("MyTaskTaskDefinition", "MyTaskTask"),
      );
    };

    const original = await target(Task);
    expect(original[0].ecsParameters.taskDefinitionArn).toMatch(/MyTaskTask$/);
    expect(await target(TaskV5)).toEqual(original);
  });

  describe("what it's given", () => {
    it("points taskRole at existing", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            taskRole: "my-task-role",
          } as any),
      ).toThrow(
        /"taskRole" isn't an option here. Pass the role, or its name, as "existing: { taskRole }" in the "MyTask" task/,
      );
    });

    it("points executionRole at existing", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            executionRole: "my-execution-role",
          } as any),
      ).toThrow(/as "existing: { executionRole }" in the "MyTask" task/);
    });

    it("can't have both public and publicIp", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            public: true,
            publicIp: true,
          }),
      ).toThrow(/Do not set both "public" and "publicIp" for the "MyTask" Task/);
    });

    it("can't have both containers and a top-level image", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            image: "nginx:latest",
            containers: [{ name: "app", image: "nginx:latest" }],
          }),
      ).toThrow(/You cannot provide both "containers" and "image"/);
    });

    it("rejects containers given as an output", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            containers: output([{ name: "app" }]) as any,
          }),
      ).toThrow(/The "containers" of the "MyTask" task has to be a plain value/);
    });

    it("rejects a container given as an output", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            containers: [output({ name: "app" }) as any],
          }),
      ).toThrow(/Container 1 of the "MyTask" task has to be a plain value/);
    });

    it("takes an image you already have as the container's image", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            existing: { image: { MyTask: "my-image" } } as any,
          }),
      ).toThrow(
        /"image" isn't an option here. Set the "image" of the container to the image's reference in the "MyTask" task/,
      );
    });

    it("rejects a container name given as an output", () => {
      expect(
        () =>
          new TaskV5("MyTask", {
            cluster: cluster(),
            containers: [{ name: output("app") as any }],
          }),
      ).toThrow(
        /The "name" of container 1 of the "MyTask" task has to be a plain value/,
      );
    });
  });
});
