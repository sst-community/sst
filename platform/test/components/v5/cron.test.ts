import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, sided, sidedClass } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

const RULE = "aws:cloudwatch/eventRule:EventRule";
const FUNCTION = "aws:lambda/function:Function";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-cron-job";

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
  | typeof import("../../fixtures/v4/components/aws/cron").Cron
  | typeof import("../../../src/components/aws/cron").Cron;

describe("Cron", () => {
  let OriginalCron: typeof import("../../fixtures/v4/components/aws/cron").Cron;
  let Cron: typeof import("../../../src/components/aws/cron").Cron;
  let OriginalFunction: typeof import("../../fixtures/v4/components/aws/function").Function;
  let Function: typeof import("../../../src/components/aws/function").Function;
  // SST 4's for SST 4's side, SST 5's for SST 5's
  let Workflow: any;
  let Vpc: any;
  let Cluster: any;
  let SidedTask: any;
  let SidedFunction: any;

  beforeAll(async () => {
    OriginalCron = (await import("../../fixtures/v4/components/aws/cron")).Cron;
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
    await import("../../../src/components/aws/takeover/cron");
    await import("../../../src/components/aws/takeover/function");
    // SST 4's for SST 4's Cron, SST 5's for SST 5's Cron
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

  // Each case deploys the 4.x Cron, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs.
  describe("takes over a deployed Cron", () => {
    pulumi.takeoverCases({
      original: () => OriginalCron,
      v5: () => Cron,
      check: () => expect(resource("MyCronJobRule").type).toBe(RULE),
      cases: {
        "a function from a handler": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            { function: "src/cron.handler", schedule: "rate(1 minute)" },
            opts,
          );
        },
        "a function from its args, with an event": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: {
                handler: "src/cron.handler",
                timeout: "60 seconds",
                environment: { STAGE: "test" },
              },
              schedule: "cron(15 10 * * ? *)",
              event: { foo: "bar", nested: { n: 1 } },
              enabled: false,
            },
            opts,
          );
        },
        // 4.x took the function's args in an output. The V5 one takes them
        // as a plain value, since whether a function is created is decided
        // from them, with outputs inside.
        "a function given as an output": {
          original: (opts) =>
            new OriginalCron(
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
            { function: FUNCTION_ARN, schedule: "rate(1 minute)" },
            opts,
          );
        },
        "a version of a function given as an arn": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            { function: `${FUNCTION_ARN}:live`, schedule: "rate(1 minute)" },
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
        "settings given as outputs": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: "src/cron.handler",
              schedule: output("rate(1 day)" as const),
              enabled: output(true),
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
        "a task with an event": (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              task: task(),
              schedule: "rate(1 day)",
              event: { foo: "bar" },
              enabled: output(false),
            },
            opts,
          );
        },
        "the deprecated job, written as function": {
          original: (opts) =>
            new OriginalCron(
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
        transforms: (Cron, opts) => {
          new Cron(
            "MyCronJob",
            {
              function: "src/cron.handler",
              schedule: "rate(1 minute)",
              transform: {
                rule: { description: "Nightly cleanup" },
                target: (args, opts) => {
                  args.retryPolicy = { maximumRetryAttempts: 2 };
                  opts.retainOnDelete = true;
                },
              },
            },
            opts,
          );
        },
        // V5 merges an object transform into the defaults. 4.x replaced a
        // nested object whole, which left the target with no task to run.
        "an object transform that sets part of the task's target": {
          create: (Cron, opts) => {
            new Cron(
              "MyCronJob",
              {
                task: task(),
                schedule: "rate(1 day)",
                transform: {
                  target: { ecsTarget: { platformVersion: "1.4.0" } as any },
                },
              },
              opts,
            );
          },
          changed: [["MyCronJobTarget", ["ecsTarget"]]],
          check: () =>
            expect(resource("MyCronJobTarget").inputs.ecsTarget).toEqual({
              launchType: "FARGATE",
              platformVersion: "1.4.0",
              taskDefinitionArn:
                "arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition",
              networkConfiguration: {
                subnets: ["MyVpcPublicSubnet1_id", "MyVpcPublicSubnet2_id"],
                securityGroups: ["MyVpcSecurityGroup_id"],
                assignPublicIp: true,
              },
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

      create(OriginalCron);
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

  it("invokes a function on a schedule, with permission to", async () => {
    const cron = new Cron("MyCronJob", {
      function: "src/cron.handler",
      schedule: "rate(1 minute)",
      event: { foo: "bar" },
    });
    await pulumi.settle();

    const fn = resource("MyCronJobFunctionFunction");
    expect(fn.type).toBe(FUNCTION);
    expect(resource("MyCronJobFunction").type).toBe("sst:aws:Function");
    expect(resource("MyCronJobRule").inputs).toMatchObject({
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
    });
    expect(resource("MyCronJobTarget").inputs).toMatchObject({
      arn: "arn:aws:mock:us-east-1:123456789012:MyCronJobFunctionFunction",
      input: '{"foo":"bar"}',
    });
    expect(resource("MyCronJobPermission").inputs).toMatchObject({
      action: "lambda:InvokeFunction",
      function: "arn:aws:mock:us-east-1:123456789012:MyCronJobFunctionFunction",
      principal: "events.amazonaws.com",
      sourceArn: "arn:aws:mock:us-east-1:123456789012:MyCronJobRule",
    });
    // A job that invokes a function needs no role
    expect(named("MyCronJobTargetRole")).toEqual([]);
    expect(cron.nodes.role).toBe(undefined);
    expect(await pulumi.resolve(cron.nodes.function.apply((fn) => fn.name))).toBe(
      await pulumi.resolve(fn.inputs.name),
    );
    expect(cron.nodes.rule).toBeDefined();
    expect(cron.nodes.target).toBeDefined();
    expect(cron.nodes.permission).toBeDefined();
  });

  it("runs a task on a schedule, with a role of its own", async () => {
    const cron = new Cron("MyCronJob", {
      task: task(),
      schedule: "rate(1 day)",
      event: { foo: "bar" },
    });
    await pulumi.settle();

    expect(resource("MyCronJobTarget").inputs).toMatchObject({
      arn: "arn:aws:mock:us-east-1:123456789012:MyClusterCluster",
      roleArn: "arn:aws:mock:us-east-1:123456789012:MyCronJobTargetRole",
      input: JSON.stringify({
        containerOverrides: [
          {
            name: "MyTask",
            environment: [{ name: "SST_EVENT", value: '{"foo":"bar"}' }],
          },
        ],
      }),
      ecsTarget: {
        launchType: "FARGATE",
        taskDefinitionArn: "arn:aws:mock:us-east-1:123456789012:MyTaskTaskDefinition",
        networkConfiguration: {
          subnets: ["MyVpcPublicSubnet1_id", "MyVpcPublicSubnet2_id"],
          securityGroups: ["MyVpcSecurityGroup_id"],
          assignPublicIp: true,
        },
      },
    });
    const role = resource("MyCronJobTargetRole").inputs;
    expect(JSON.stringify(role.assumeRolePolicy)).toContain(
      '"Service":"events.amazonaws.com"',
    );
    expect(JSON.parse(role.inlinePolicies[0].policy).statements).toEqual([
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
    // A job that runs a task has no function, and no permission for one
    expect(cron.nodes.function).toBe(undefined);
    expect(cron.nodes.permission).toBe(undefined);
    expect(named("MyCronJobFunction")).toEqual([]);
    expect(named("MyCronJobPermission")).toEqual([]);
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

    expect(resource("ByArnTarget").inputs.arn).toBe(FUNCTION_ARN);
    expect(resource("ByFunctionTarget").inputs.arn).toBe(
      "arn:aws:mock:us-east-1:123456789012:MyFunctionFunction",
    );
    expect(named("ByArnFunction")).toEqual([]);
    expect(named("ByFunctionFunction")).toEqual([]);
  });

  it("invokes the published version of a workflow", async () => {
    new Cron("MyCronJob", {
      function: new Workflow("MyWorkflow", { handler: "src/workflow.handler" }),
      schedule: "rate(1 hour)",
    });
    await pulumi.settle();

    expect(resource("MyCronJobTarget").inputs.arn).toBe(
      "arn:aws:mock:us-east-1:123456789012:MyWorkflowHandlerFunction:3",
    );
  });

  it("transforms the function, the permission and the task's role", async () => {
    new Cron("MyCronJob", {
      function: { handler: "src/cron.handler", environment: { A: "1" } },
      schedule: "rate(1 minute)",
      transform: {
        function: {
          timeout: "2 minutes",
          transform: { function: { environment: { variables: { B: "2" } } } },
        },
        permission: { statementId: "AllowCron" },
      },
    });
    new Cron("TaskJob", {
      task: task(),
      schedule: "rate(1 day)",
      transform: { role: { description: "Runs the task" } },
    });
    await pulumi.settle();

    expect(resource("MyCronJobFunctionFunction").inputs).toMatchObject({
      timeout: 120,
      environment: { variables: { A: "1", B: "2" } },
    });
    expect(resource("MyCronJobPermission").inputs.statementId).toBe("AllowCron");
    expect(resource("TaskJobTargetRole").inputs.description).toBe(
      "Runs the task",
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
      expect(resource("MyCronJobTarget").inputs.arn).toBe(fn);
      expect(resource("MyCronJobPermission").inputs.function).toBe(fn);
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

    it("uses a rule, a target or a task's role you already have", async () => {
      new Cron("ByRule", {
        function: FUNCTION_ARN,
        schedule: "rate(1 minute)",
        existing: { rule: "my-rule" },
      });
      new Cron("ByTarget", {
        function: FUNCTION_ARN,
        schedule: "rate(1 minute)",
        existing: { target: "my-rule/my-target" },
      });
      new Cron("ByRole", {
        task: task(),
        schedule: "rate(1 day)",
        existing: { role: "events-role" },
      });
      await pulumi.settle();

      expect(resource("ByRuleRule")).toMatchObject({
        kind: "read",
        options: { id: "my-rule" },
      });
      expect(resource("ByRuleTarget").inputs.rule).toBe(
        await pulumi.resolve(resource("ByRuleRule").inputs.name),
      );
      expect(resource("ByTargetTarget")).toMatchObject({
        kind: "read",
        options: { id: "my-rule/my-target" },
      });
      expect(resource("ByRoleTargetRole")).toMatchObject({
        kind: "read",
        options: { id: "events-role" },
      });
      expect(resource("ByRoleTarget").inputs.roleArn).toBe(
        "arn:aws:mock:us-east-1:123456789012:ByRoleTargetRole",
      );
    });

    // Settings of a resource given in `existing` would be dropped, and so
    // would a part the job doesn't have
    it("refuses what an existing rule or target, or the job, wouldn't use", () => {
      expect(
        () =>
          new Cron("Off", {
            function: FUNCTION_ARN,
            schedule: "rate(1 minute)",
            enabled: false,
            existing: { rule: "my-rule" },
          }),
      ).toThrow(
        'The "Off" cron job is given an existing "rule", which it uses the way it is. Remove "enabled" from its args.',
      );
      expect(
        () =>
          new Cron("WithEvent", {
            function: FUNCTION_ARN,
            schedule: "rate(1 minute)",
            event: { foo: "bar" },
            existing: { target: "my-rule/my-target" },
          }),
      ).toThrow(
        'The "WithEvent" cron job is given an existing "target", which it uses the way it is. Remove "event" from its args.',
      );
      expect(
        () =>
          new Cron("FunctionRole", {
            function: FUNCTION_ARN,
            schedule: "rate(1 minute)",
            existing: { role: "events-role" },
          }),
      ).toThrow(
        `"existing.role" isn't an option for the "FunctionRole" cron job. A cron job that invokes a function needs no role: the function's permission lets EventBridge invoke it.`,
      );
      expect(
        () =>
          new Cron("TaskPermission", {
            task: task(),
            schedule: "rate(1 day)",
            existing: { permission: "my-permission" },
          }),
      ).toThrow(
        `"existing.permission" isn't an option for the "TaskPermission" cron job. A cron job that runs a task gives no function permission to be invoked.`,
      );
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
