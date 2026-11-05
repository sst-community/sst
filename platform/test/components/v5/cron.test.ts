import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, sided, sidedClass } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

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
  | typeof import("../../fixtures/v4/components/aws/cron-v2").CronV2
  | typeof import("../../../src/components/aws/cron").Cron;

describe("Cron", () => {
  let OriginalCronV2: typeof import("../../fixtures/v4/components/aws/cron-v2").CronV2;
  let Cron: typeof import("../../../src/components/aws/cron").Cron;
  let OriginalFunction: typeof import("../../fixtures/v4/components/aws/function").Function;
  let Function: typeof import("../../../src/components/aws/function").Function;
  // SST 4's for SST 4's side, SST 5's for SST 5's
  let Workflow: any;
  let Vpc: any;
  let Cluster: any;
  let OriginalTask: typeof import("../../fixtures/v4/components/aws/task").Task;
  let SidedTask: any;
  let SidedFunction: any;

  beforeAll(async () => {
    OriginalCronV2 = (await import("../../fixtures/v4/components/aws/cron-v2")).CronV2;
    Cron = (await import("../../../src/components/aws/cron")).Cron;
    OriginalFunction = (await import("../../fixtures/v4/components/aws/function")).Function;
    Function = (await import("../../../src/components/aws/function")).Function;
    Workflow = await sidedClass(
      "Workflow",
      import("../../fixtures/v4/components/aws/workflow"),
      import("../../../src/components/aws/workflow"),
      import("../../../src/components/aws/takeover/workflow"),
    );
    Vpc = await sidedClass(
      "Vpc",
      import("../../fixtures/v4/components/aws/vpc"),
      import("../../../src/components/aws/vpc"),
      import("../../../src/components/aws/takeover/vpc"),
    );
    Cluster = await sidedClass(
      "Cluster",
      import("../../fixtures/v4/components/aws/cluster"),
      import("../../../src/components/aws/cluster"),
      import("../../../src/components/aws/takeover/cluster"),
    );
    OriginalTask = (await import("../../fixtures/v4/components/aws/task")).Task;
    await import("../../../src/components/aws/takeover/cron");
    await import("../../../src/components/aws/takeover/function");
    // SST 4's for SST 4's CronV2, SST 5's for SST 5's Cron
    SidedTask = await sidedClass(
      "Task",
      import("../../fixtures/v4/components/aws/task"),
      import("../../../src/components/aws/task"),
      import("../../../src/components/aws/takeover/task"),
    );
    SidedFunction = sided(
      () => OriginalFunction,
      () => Function,
    );
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
    new SidedTask("MyTask", {
      cluster: new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }),
      image: "nginx:latest",
    });

  // Each case deploys the 4.x CronV2, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs.
  describe("takes over a deployed CronV2", () => {
    pulumi.takeoverCases({
      original: () => OriginalCronV2,
      v5: () => Cron,
      check: () => {
        expect(resource("MyCronJobSchedule").type).toBe(SCHEDULE);
        expect(resource("MyCronJobRole").type).toBe("aws:iam/role:Role");
      },
      cases: {
        "a function from a handler": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: "src/cron.handler",
              schedule: "rate(1 minute)",
            },
            opts,
          );
        },
        "a function from its args": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: {
                handler: "src/cron.handler",
                timeout: "60 seconds",
                environment: { STAGE: "test" },
              },
              schedule: "cron(15 10 * * ? *)",
            },
            opts,
          );
        },
        // 4.x took the function's args in an output. The V5 one takes them
        // as a plain value, since whether a function is created is decided
        // from them, with outputs inside.
        "a function given as an output": {
          original: (opts) =>
            new OriginalCronV2(
              "MyCronJob",
              {
                function: output({
                  handler: "src/cron.handler",
                  memory: "512 MB" as const,
                }),
                schedule: output("rate(5 minutes)" as const),
              },
              opts,
            ),
          v5: (opts) =>
            new Cron(
              "MyCronJob",
              {
                function: {
                  handler: "src/cron.handler",
                  memory: output("512 MB" as const),
                },
                schedule: output("rate(5 minutes)" as const),
              },
              opts,
            ),
        },
        "a function given as an arn": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: FUNCTION_ARN,
              schedule: "rate(1 minute)",
            },
            opts,
          );
        },
        "a version of a function given as an arn": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: `${FUNCTION_ARN}:live`,
              schedule: "rate(1 minute)",
            },
            opts,
          );
        },
        "a function elsewhere in the app": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: new SidedFunction("MyFunction", {
                handler: "src/cron.handler",
              }),
              schedule: "rate(1 minute)",
            },
            opts,
          );
        },
        "a workflow": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: new Workflow("MyWorkflow", {
                handler: "src/workflow.handler",
              }),
              schedule: "rate(1 hour)",
            },
            opts,
          );
        },
        "every schedule setting": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: "src/cron.handler",
              schedule: "cron(15 10 * * ? *)",
              timezone: "America/New_York",
              enabled: false,
              retries: 3,
              dlq: DLQ_ARN,
              event: { foo: "bar", nested: { n: 1 } },
            },
            opts,
          );
        },
        "settings given as outputs": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: "src/cron.handler",
              schedule: output("at(2025-06-01T10:00:00)" as const),
              timezone: output("Europe/Berlin"),
              enabled: output(true),
              retries: output(5),
              dlq: output(DLQ_ARN),
              event: output({ foo: output("bar") }),
            },
            opts,
          );
        },
        "a task": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            { task: task(), schedule: "rate(1 day)" },
            opts,
          );
        },
        "a task with an event, retries and a dead-letter queue": (
          Cron,
          opts,
        ) => {
          new Cron(
            "MyCronJob",
            {
              task: task(),
              schedule: "rate(1 day)",
              event: { foo: "bar" },
              retries: 2,
              dlq: DLQ_ARN,
              enabled: false,
            },
            opts,
          );
        },
        transforms: (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: "src/cron.handler",
              schedule: "rate(1 minute)",
              transform: {
                schedule: { description: "Nightly cleanup", groupName: "jobs" },
                role: (args, opts) => {
                  args.description = "Runs the cleanup";
                  opts.protect = true;
                },
              },
            },
            opts,
          );
        },
        "a schedule transform as a function": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
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
            },
            opts,
          );
        },
        "the deprecated job, written as function": {
          original: (opts) =>
            new OriginalCronV2(
              "MyCronJob",
              {
                job: { handler: "src/cron.handler", timeout: "30 seconds" },
                schedule: "rate(1 minute)",
              },
              opts,
            ),
          v5: (opts) =>
            new Cron(
              "MyCronJob",
              {
                function: {
                  handler: "src/cron.handler",
                  timeout: "30 seconds",
                },
                schedule: "rate(1 minute)",
              },
              opts,
            ),
        },
        // V5 merges an object transform into the defaults. 4.x
        // replaced a nested object whole, which left the schedule with no
        // target.
        "an object transform that sets part of the target": {
          create: (Cron, opts) => {
            new Cron(
              "MyCronJob",
              {
                function: FUNCTION_ARN,
                schedule: "rate(1 minute)",
                transform: {
                  schedule: {
                    target: { input: '{"from":"transform"}' } as any,
                  },
                },
              },
              opts,
            );
          },
          changed: [["MyCronJobSchedule", ["target"]]],
          check: () =>
            expect(resource("MyCronJobSchedule").inputs.target).toEqual({
              arn: FUNCTION_ARN,
              roleArn: "arn:aws:mock:us-east-1:123456789012:MyCronJobRole",
              input: '{"from":"transform"}',
              retryPolicy: { maximumRetryAttempts: 0 },
            }),
        },
      },
    });

    // The function is named after its part now. What it's made of follows
    // it, and keeps the names it has in AWS.
    it("keeps the function it renames", async () => {
      const create = (Cron: CronClass) =>
        new Cron("MyCronJob", {
          function: "src/cron.handler",
          schedule: "rate(1 minute)",
        });

      create(OriginalCronV2);
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
      create(Cron);
      await pulumi.settle();
      expect(named("MyCronJobHandler")).toEqual([]);
      expect(named("MyCronJobFunction")).toEqual([
        "MyCronJobFunction",
        "MyCronJobFunctionCode",
        "MyCronJobFunctionFunction",
        "MyCronJobFunctionLogGroup",
        "MyCronJobFunctionRole",
      ]);
      expect(pulumi.takeover(original)).toEqual({
        unclaimed: [],
        changed: [],
        unordered: [],
        revealed: [],
      });
    });

  });

  it("invokes a function on a schedule", async () => {
    const cron = new Cron("MyCronJob", {
      function: "src/cron.handler",
      schedule: "rate(1 minute)",
      event: { foo: "bar" },
    });
    await pulumi.settle();

    const fn = resource("MyCronJobFunctionFunction");
    expect(fn.type).toBe(FUNCTION);
    expect(resource("MyCronJobFunction").type).toBe("sst:aws:Function");
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
    new Cron("MyCronJob", {
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
    const cron = new Cron("MyCronJob", {
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
        taskDefinitionArn: "arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition",
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
        resources: ["arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition"],
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

  // Whether a function is created is decided from what's given, which a
  // preview has to know. The error is thrown inside an apply, on deploy.
  it("refuses a handler or args in an output, and creates no function", async () => {
    const errors = await applyErrors(() => {
      new Cron("MyCronJob", {
        function: output("src/cron.handler"),
        schedule: "rate(1 minute)",
      });
      new Cron("Other", {
        function: output({ handler: "src/cron.handler" }) as any,
        schedule: "rate(1 minute)",
      });
    }, pulumi.settle);
    expect(
      pulumi.resources.filter((r) => r.type === "sst:aws:Function"),
    ).toEqual([]);
    for (const cron of ["MyCronJob", "Other"])
      expect(errors).toContainEqual(
        expect.stringContaining(
          `The "function" of the "${cron}" cron job is an output that isn't a function or the ARN of one.`,
        ),
      );
  });

  // An ARN creates nothing, and nor does a function that's already there, so
  // either can be an output
  it("invokes a function, or its ARN, given in an output", async () => {
    const fn = new Function("MyFunction", { handler: "src/cron.handler" });
    new Cron("ByArn", {
      function: output(FUNCTION_ARN),
      schedule: "rate(1 minute)",
    });
    new Cron("ByFunction", {
      function: output(fn),
      schedule: "rate(1 minute)",
    });
    await pulumi.settle();

    expect(resource("ByArnSchedule").inputs.target.arn).toBe(FUNCTION_ARN);
    expect(resource("ByFunctionSchedule").inputs.target.arn).toBe(
      "arn:aws:mock:us-east-1:123456789012:MyFunctionFunction",
    );
    expect(named("ByArnFunction")).toEqual([]);
    expect(named("ByFunctionFunction")).toEqual([]);
  });

  it("invokes a V5 Function from elsewhere in the app", async () => {
    const fn = new Function("MyFunction", { handler: "src/cron.handler" });
    const cron = new Cron("MyCronJob", {
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
    new Cron("MyCronJob", {
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
    new Cron("MyCronJob", {
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
    new Cron("MyCronJob", {
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
          new Cron("MyCronJob", {
            job: "src/cron.handler",
            schedule: "rate(1 minute)",
          } as any),
      ).toThrow(
        /"job" isn't an option for the "MyCronJob" cron job. Use "function"/,
      );
    });

    it("needs a function or a task", () => {
      expect(
        () => new Cron("MyCronJob", { schedule: "rate(1 minute)" }),
      ).toThrow(
        'The "MyCronJob" cron job needs a "function" or a "task" to run.',
      );
    });

    it("can't have both a function and a task", () => {
      expect(
        () =>
          new Cron("MyCronJob", {
            function: "src/cron.handler",
            task: task(),
            schedule: "rate(1 minute)",
          }),
      ).toThrow(
        'The "MyCronJob" cron job is given both a "function" and a "task". A cron job runs one or the other.',
      );
    });

    // A function you have can be given in `existing`, in place of `function`
    it("runs an existing function, and refuses a function or a task next to it", async () => {
      const fn = "arn:aws:lambda:us-east-1:123456789012:function:my-cron";
      new Cron("MyCronJob", {
        existing: { function: fn },
        schedule: "rate(1 minute)",
      });
      await pulumi.settle();
      expect(
        pulumi.resources.find((r) => r.name === "MyCronJobSchedule")!.inputs
          .target.arn,
      ).toBe(fn);
      expect(
        () =>
          new Cron("Other", {
            existing: { function: fn },
            function: "src/cron.handler",
            schedule: "rate(1 minute)",
          }),
      ).toThrow(
        'The "Other" cron job is given an existing "function", which it uses the way it is. Remove "function" from its args.',
      );
      expect(
        () =>
          new Cron("Third", {
            existing: { function: fn },
            task: task(),
            schedule: "rate(1 minute)",
          }),
      ).toThrow(
        'The "Third" cron job is given an existing "function" and a "task". A cron job runs one or the other.',
      );
      await pulumi.settle();
    });

    it("rejects a task given as an output", () => {
      expect(
        () =>
          new Cron("MyCronJob", {
            task: output(task()) as any,
            schedule: "rate(1 minute)",
          }),
      ).toThrow(/The "task" of the "MyCronJob" cron job has to be a plain value/);
    });
  });
});
