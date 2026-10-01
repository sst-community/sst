import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../helpers/graph";

const SCHEDULE = "aws:scheduler/schedule:Schedule";
const FUNCTION = "aws:lambda/function:Function";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-cron-job";
const DLQ_ARN = "arn:aws:sqs:us-east-1:123456789012:dead-letters";

const pulumi = mockPulumi({
  // A function that publishes versions, like a workflow's, is invoked by
  // its version
  state: (args) => {
    if (args.type !== FUNCTION) return {};
    const arn = `arn:aws:mock:us-east-1:123456789012:${args.name}`;
    const invoke = (api: string, path: string) =>
      `arn:aws:apigateway:us-east-1:lambda:path/${api}/functions/${arn}/${path}`;
    return {
      qualifiedArn: `${arn}:3`,
      invokeArn: invoke("2015-03-31", "invocations"),
      qualifiedInvokeArn: invoke("2015-03-31", "invocations").replace(arn, `${arn}:3`),
      responseStreamingInvokeArn: invoke("2021-11-15", "response-streaming-invocations"),
    };
  },
  call: (args) =>
    args.token === "aws:index/getAvailabilityZones:getAvailabilityZones"
      ? { names: ["us-east-1a", "us-east-1b"] }
      : undefined,
});

type CronClass =
  | typeof import("../../src/components/aws/cron-v2").CronV2
  | typeof import("../../src/components/aws/cron-v2-v5").CronV2V5;

describe("CronV2V5", () => {
  let CronV2: typeof import("../../src/components/aws/cron-v2").CronV2;
  let CronV2V5: typeof import("../../src/components/aws/cron-v2-v5").CronV2V5;
  let Function: typeof import("../../src/components/aws/function").Function;
  let FunctionV5: typeof import("../../src/components/aws/function-v5").FunctionV5;
  let Workflow: typeof import("../../src/components/aws/workflow").Workflow;
  let Vpc: typeof import("../../src/components/aws/vpc").Vpc;
  let Cluster: typeof import("../../src/components/aws/cluster").Cluster;
  let Task: typeof import("../../src/components/aws/task").Task;

  beforeAll(async () => {
    CronV2 = (await import("../../src/components/aws/cron-v2")).CronV2;
    CronV2V5 = (await import("../../src/components/aws/cron-v2-v5")).CronV2V5;
    Function = (await import("../../src/components/aws/function")).Function;
    FunctionV5 = (await import("../../src/components/aws/function-v5")).FunctionV5;
    Workflow = (await import("../../src/components/aws/workflow")).Workflow;
    Vpc = (await import("../../src/components/aws/vpc")).Vpc;
    Cluster = (await import("../../src/components/aws/cluster")).Cluster;
    Task = (await import("../../src/components/aws/task")).Task;
    await import("../../src/components/aws/takeover/cron-v2");
    await import("../../src/components/aws/takeover/function");
  });

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
  const task = () =>
    new Task("MyTask", {
      cluster: new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }),
      image: "nginx:latest",
    });
  const takesOver = async (original: () => void, v5: () => void) => {
    const result = await pulumi.takesOver(original, v5);
    return {
      unclaimed: result.unclaimed,
      changed: result.changed.map((c) => [c.name, c.fields]),
    };
  };

  // Each case deploys a CronV2, then the same thing as a CronV2V5. Everything
  // the CronV2 created has to be kept by the CronV2V5, with the same inputs.
  describe("takes over a deployed CronV2", () => {
    const cases: Record<string, (Cron: CronClass) => void> = {
      "a function from a handler": (Cron) => {
        new Cron("MyCronJob", {
          function: "src/cron.handler",
          schedule: "rate(1 minute)",
        });
      },
      "a function from its args": (Cron) => {
        new Cron("MyCronJob", {
          function: {
            handler: "src/cron.handler",
            timeout: "60 seconds",
            environment: { STAGE: "test" },
          },
          schedule: "cron(15 10 * * ? *)",
        });
      },
      "a function given as an output": (Cron) => {
        new Cron("MyCronJob", {
          function: output({ handler: "src/cron.handler", memory: "512 MB" as const }),
          schedule: output("rate(5 minutes)" as const),
        });
      },
      "a function given as an arn": (Cron) => {
        new Cron("MyCronJob", {
          function: FUNCTION_ARN,
          schedule: "rate(1 minute)",
        });
      },
      "a version of a function given as an arn": (Cron) => {
        new Cron("MyCronJob", {
          function: `${FUNCTION_ARN}:live`,
          schedule: "rate(1 minute)",
        });
      },
      "a function elsewhere in the app": (Cron) => {
        new Cron("MyCronJob", {
          function: new Function("MyFunction", { handler: "src/cron.handler" }),
          schedule: "rate(1 minute)",
        });
      },
      "a workflow": (Cron) => {
        new Cron("MyCronJob", {
          function: new Workflow("MyWorkflow", { handler: "src/workflow.handler" }),
          schedule: "rate(1 hour)",
        });
      },
      "every schedule setting": (Cron) => {
        new Cron("MyCronJob", {
          function: "src/cron.handler",
          schedule: "cron(15 10 * * ? *)",
          timezone: "America/New_York",
          enabled: false,
          retries: 3,
          dlq: DLQ_ARN,
          event: { foo: "bar", nested: { n: 1 } },
        });
      },
      "settings given as outputs": (Cron) => {
        new Cron("MyCronJob", {
          function: "src/cron.handler",
          schedule: output("at(2025-06-01T10:00:00)" as const),
          timezone: output("Europe/Berlin"),
          enabled: output(true),
          retries: output(5),
          dlq: output(DLQ_ARN),
          event: output({ foo: output("bar") }),
        });
      },
      "a task": (Cron) => {
        new Cron("MyCronJob", { task: task(), schedule: "rate(1 day)" });
      },
      "a task with an event, retries and a dead-letter queue": (Cron) => {
        new Cron("MyCronJob", {
          task: task(),
          schedule: "rate(1 day)",
          event: { foo: "bar" },
          retries: 2,
          dlq: DLQ_ARN,
          enabled: false,
        });
      },
      transforms: (Cron) => {
        new Cron("MyCronJob", {
          function: "src/cron.handler",
          schedule: "rate(1 minute)",
          transform: {
            schedule: { description: "Nightly cleanup", groupName: "jobs" },
            role: (args, opts) => {
              args.description = "Runs the cleanup";
              opts.protect = true;
            },
          },
        });
      },
      "a schedule transform as a function": (Cron) => {
        new Cron("MyCronJob", {
          task: task(),
          schedule: "rate(1 day)",
          transform: {
            schedule: (args, opts) => {
              args.flexibleTimeWindow = {
                mode: "FLEXIBLE",
                maximumWindowInMinutes: 15,
              };
              opts.retainOnDelete = true;
            },
          },
        });
      },
    };

    for (const [name, create] of Object.entries(cases)) {
      it(name, async () => {
        expect(
          await takesOver(
            () => create(CronV2),
            () => create(CronV2V5),
          ),
        ).toEqual({ unclaimed: [], changed: [] });
        expect(resource("MyCronJobSchedule").type).toBe(SCHEDULE);
        expect(resource("MyCronJobRole").type).toBe("aws:iam/role:Role");
      });
    }

    it("the deprecated job, written as function", async () => {
      expect(
        await takesOver(
          () =>
            new CronV2("MyCronJob", {
              job: { handler: "src/cron.handler", timeout: "30 seconds" },
              schedule: "rate(1 minute)",
            }),
          () =>
            new CronV2V5("MyCronJob", {
              function: { handler: "src/cron.handler", timeout: "30 seconds" },
              schedule: "rate(1 minute)",
            }),
        ),
      ).toEqual({ unclaimed: [], changed: [] });
    });

    it("a cron job inside another component", async () => {
      const { ComponentResource } = await import("@pulumi/pulumi");
      class Jobs extends ComponentResource {
        constructor(name: string) {
          super("test:Jobs", name);
        }
      }
      const create = (Cron: CronClass) => () =>
        new Cron(
          "MyCronJob",
          { function: "src/cron.handler", schedule: "rate(1 minute)" },
          { parent: new Jobs("Jobs") },
        );

      expect(await takesOver(create(CronV2), create(CronV2V5))).toEqual({
        unclaimed: [],
        changed: [],
      });
      expect(resource("MyCronJobSchedule").parent).toMatch(
        /::test:Jobs\$sst:aws:CronV2V5::MyCronJob$/,
      );
      expect(resource("MyCronJobFunctionFunction").parent).toMatch(
        /::test:Jobs\$sst:aws:CronV2V5\$sst:aws:FunctionV5::MyCronJobFunction$/,
      );
    });

    it("a cron job deployed with another provider", async () => {
      const { Provider } = await import("@pulumi/aws");
      const create = (Cron: CronClass) => () =>
        new Cron(
          "MyCronJob",
          { function: "src/cron.handler", schedule: "rate(1 minute)" },
          { provider: new Provider("West", { region: "us-west-2" }) },
        );
      const providers = () =>
        pulumi.resources
          .filter((r) => r.custom && r.type.startsWith("aws:"))
          .map((r) => r.options.provider as string);

      create(CronV2)();
      await pulumi.settle();
      const original = providers();
      expect(original.length).toBeGreaterThan(4);
      expect(new Set(original).size).toBe(1);
      expect(original[0]).toMatch(/::West::/);
      const before = pulumi
        .graph()
        .filter((r) => !r.type.startsWith("pulumi:providers:"));

      pulumi.reset();
      create(CronV2V5)();
      await pulumi.settle();
      expect(pulumi.takeover(before)).toEqual({ unclaimed: [], changed: [] });
      expect(providers()).toEqual(original);
    });

    // The function is named after its part now. What it's made of follows
    // it, and keeps the names it has in AWS.
    it("keeps the function it renames", async () => {
      const create = (Cron: CronClass) =>
        new Cron("MyCronJob", {
          function: "src/cron.handler",
          schedule: "rate(1 minute)",
        });

      create(CronV2);
      await pulumi.settle();
      const original = pulumi.graph();
      expect(named("MyCronJobHandler")).toEqual([
        "MyCronJobHandler",
        "MyCronJobHandlerCode",
        "MyCronJobHandlerFunction",
        "MyCronJobHandlerLogGroup",
        "MyCronJobHandlerRole",
      ]);

      pulumi.reset();
      create(CronV2V5);
      await pulumi.settle();
      expect(named("MyCronJobHandler")).toEqual([]);
      expect(named("MyCronJobFunction")).toEqual([
        "MyCronJobFunction",
        "MyCronJobFunctionCode",
        "MyCronJobFunctionFunction",
        "MyCronJobFunctionLogGroup",
        "MyCronJobFunctionRole",
      ]);
      expect(pulumi.takeover(original)).toEqual({ unclaimed: [], changed: [] });
    });

    // CronV2V5 merges an object transform into the defaults. CronV2 replaced
    // a nested object whole, which left the schedule with no target.
    it("an object transform that sets part of the target", async () => {
      const create = (Cron: CronClass) => () =>
        new Cron("MyCronJob", {
          function: FUNCTION_ARN,
          schedule: "rate(1 minute)",
          transform: {
            schedule: { target: { input: '{"from":"transform"}' } as any },
          },
        });

      expect(await takesOver(create(CronV2), create(CronV2V5))).toEqual({
        unclaimed: [],
        changed: [["MyCronJobSchedule", ["target"]]],
      });
      expect(resource("MyCronJobSchedule").inputs.target).toEqual({
        arn: FUNCTION_ARN,
        roleArn: "arn:aws:mock:us-east-1:123456789012:MyCronJobRole",
        input: '{"from":"transform"}',
        retryPolicy: { maximumRetryAttempts: 0 },
      });
    });
  });

  it("invokes a function on a schedule", async () => {
    const cron = new CronV2V5("MyCronJob", {
      function: "src/cron.handler",
      schedule: "rate(1 minute)",
      event: { foo: "bar" },
    });
    await pulumi.settle();

    const fn = resource("MyCronJobFunctionFunction");
    expect(fn.type).toBe(FUNCTION);
    expect(resource("MyCronJobFunction").type).toBe("sst:aws:FunctionV5");
    expect(resource("MyCronJobSchedule").inputs).toMatchObject({
      scheduleExpression: "rate(1 minute)",
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: {
        arn: "arn:aws:mock:us-east-1:123456789012:MyCronJobFunctionFunction",
        roleArn: "arn:aws:mock:us-east-1:123456789012:MyCronJobRole",
        input: '{"foo":"bar"}',
        retryPolicy: { maximumRetryAttempts: 0 },
      },
    });
    expect(
      JSON.parse(resource("MyCronJobRole").inputs.inlinePolicies[0].policy),
    ).toEqual({
      statements: [
        {
          actions: ["lambda:InvokeFunction"],
          resources: [
            "arn:aws:mock:us-east-1:123456789012:MyCronJobFunctionFunction",
          ],
        },
      ],
    });
    expect(await pulumi.resolve(cron.nodes.function.apply((fn) => fn.name))).toBe(
      await pulumi.resolve(fn.inputs.name),
    );
    expect(cron.nodes.schedule).toBeDefined();
    expect(cron.nodes.role).toBeDefined();
  });

  it("lets the schedule send to the dead-letter queue", async () => {
    new CronV2V5("MyCronJob", {
      function: FUNCTION_ARN,
      schedule: "rate(1 minute)",
      retries: 3,
      dlq: DLQ_ARN,
    });
    await pulumi.settle();

    expect(resource("MyCronJobSchedule").inputs.target).toMatchObject({
      arn: FUNCTION_ARN,
      retryPolicy: { maximumRetryAttempts: 3 },
      deadLetterConfig: { arn: DLQ_ARN },
    });
    expect(
      JSON.parse(resource("MyCronJobRole").inputs.inlinePolicies[0].policy)
        .statements,
    ).toEqual([
      { actions: ["lambda:InvokeFunction"], resources: [FUNCTION_ARN] },
      { actions: ["sqs:SendMessage"], resources: [DLQ_ARN] },
    ]);
    // Nothing is created for a function that's given as an ARN
    expect(named("MyCronJobFunction")).toEqual([]);
  });

  it("runs a task on a schedule", async () => {
    const cron = new CronV2V5("MyCronJob", {
      task: task(),
      schedule: "rate(1 day)",
      event: { foo: "bar" },
    });
    await pulumi.settle();

    expect(resource("MyCronJobSchedule").inputs.target).toEqual({
      arn: "arn:aws:mock:us-east-1:123456789012:MyClusterCluster",
      roleArn: "arn:aws:mock:us-east-1:123456789012:MyCronJobRole",
      input: JSON.stringify({
        containerOverrides: [
          {
            name: "MyTask",
            environment: [{ name: "SST_EVENT", value: '{"foo":"bar"}' }],
          },
        ],
      }),
      ecsParameters: {
        taskDefinitionArn: "arn:aws:mock:us-east-1:123456789012:MyTaskTask",
        launchType: "FARGATE",
        networkConfiguration: {
          subnets: ["MyVpcPublicSubnet1_id", "MyVpcPublicSubnet2_id"],
          securityGroups: ["MyVpcSecurityGroup_id"],
          assignPublicIp: true,
        },
      },
      retryPolicy: { maximumRetryAttempts: 0 },
    });
    expect(
      JSON.parse(resource("MyCronJobRole").inputs.inlinePolicies[0].policy)
        .statements,
    ).toEqual([
      {
        actions: ["ecs:RunTask"],
        resources: ["arn:aws:mock:us-east-1:123456789012:MyTaskTask"],
      },
      {
        actions: ["iam:PassRole"],
        resources: [
          "arn:aws:mock:us-east-1:123456789012:MyTaskExecutionRole",
          "arn:aws:mock:us-east-1:123456789012:MyTaskTaskRole",
        ],
      },
    ]);
    // A job that runs a task has no function
    expect(cron.nodes.function).toBe(undefined);
    expect(named("MyCronJobFunction")).toEqual([]);
  });

  it("invokes a FunctionV5 from elsewhere in the app", async () => {
    const fn = new FunctionV5("MyFunction", { handler: "src/cron.handler" });
    const cron = new CronV2V5("MyCronJob", {
      function: fn,
      schedule: "rate(1 minute)",
    });
    await pulumi.settle();

    expect(resource("MyCronJobSchedule").inputs.target.arn).toBe(
      "arn:aws:mock:us-east-1:123456789012:MyFunctionFunction",
    );
    expect(named("MyCronJobFunction")).toEqual([]);
    expect(await pulumi.resolve(cron.nodes.function)).toBe(fn);
  });

  it("invokes the published version of a workflow", async () => {
    new CronV2V5("MyCronJob", {
      function: new Workflow("MyWorkflow", { handler: "src/workflow.handler" }),
      schedule: "rate(1 hour)",
    });
    await pulumi.settle();

    const target = resource("MyCronJobSchedule").inputs.target.arn;
    expect(target).toBe(
      "arn:aws:mock:us-east-1:123456789012:MyWorkflowHandlerFunction:3",
    );
    expect(
      JSON.parse(resource("MyCronJobRole").inputs.inlinePolicies[0].policy)
        .statements[0].resources,
    ).toEqual([target]);
  });

  it("transforms the function it creates", async () => {
    new CronV2V5("MyCronJob", {
      function: { handler: "src/cron.handler", environment: { A: "1" } },
      schedule: "rate(1 minute)",
      transform: {
        function: {
          timeout: "2 minutes",
          transform: { function: { environment: { variables: { B: "2" } } } },
        },
      },
    });
    await pulumi.settle();

    expect(resource("MyCronJobFunctionFunction").inputs).toMatchObject({
      timeout: 120,
      environment: { variables: { A: "1", B: "2" } },
    });
  });

  it("uses a role you already have", async () => {
    new CronV2V5("MyCronJob", {
      function: FUNCTION_ARN,
      schedule: "rate(1 minute)",
      existing: { role: "scheduler-role" },
    });
    await pulumi.settle();

    expect(resource("MyCronJobRole")).toMatchObject({
      kind: "read",
      options: { id: "scheduler-role" },
    });
    expect(resource("MyCronJobSchedule").inputs.target.roleArn).toBe(
      "arn:aws:mock:us-east-1:123456789012:MyCronJobRole",
    );
  });

  describe("what it's given", () => {
    it("points the deprecated job at function", () => {
      expect(
        () =>
          new CronV2V5("MyCronJob", {
            job: "src/cron.handler",
            schedule: "rate(1 minute)",
          } as any),
      ).toThrow(/"job" isn't an option here. Use "function" in the "MyCronJob" cron job/);
    });

    it("needs a function or a task", () => {
      expect(
        () => new CronV2V5("MyCronJob", { schedule: "rate(1 minute)" }),
      ).toThrow(
        /You must provide either a function or a task in the "MyCronJob" CronV2V5 component/,
      );
    });

    it("can't have both a function and a task", () => {
      expect(
        () =>
          new CronV2V5("MyCronJob", {
            function: "src/cron.handler",
            task: task(),
            schedule: "rate(1 minute)",
          }),
      ).toThrow(
        /You cannot provide both a function and a task in the "MyCronJob" CronV2V5 component/,
      );
    });

    it("rejects a task given as an output", () => {
      expect(
        () =>
          new CronV2V5("MyCronJob", {
            task: output(task()) as any,
            schedule: "rate(1 minute)",
          }),
      ).toThrow(/The "task" of the "MyCronJob" cron job has to be a plain value/);
    });
  });
});
