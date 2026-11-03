import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { rejectionsOf } from "../../helpers/rejections";

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
      qualifiedInvokeArn: invoke("2015-03-31", "invocations").replace(
        arn,
        `${arn}:3`,
      ),
      responseStreamingInvokeArn: invoke(
        "2021-11-15",
        "response-streaming-invocations",
      ),
    };
  },
  call: (args) =>
    args.token === "aws:index/getAvailabilityZones:getAvailabilityZones"
      ? { names: ["us-east-1a", "us-east-1b"] }
      : undefined,
});

type CronClass =
  | typeof import("../../../src/components/aws/cron").Cron
  | typeof import("../../../src/components/aws/v5/cron").Cron;

describe("Cron", () => {
  let OriginalCron: typeof import("../../../src/components/aws/cron").Cron;
  let Cron: typeof import("../../../src/components/aws/v5/cron").Cron;
  let OriginalFunction: typeof import("../../../src/components/aws/function").Function;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;
  let Workflow: typeof import("../../../src/components/aws/workflow").Workflow;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Cluster: typeof import("../../../src/components/aws/cluster").Cluster;
  let OriginalTask: typeof import("../../../src/components/aws/task").Task;

  beforeAll(async () => {
    OriginalCron = (await import("../../../src/components/aws/cron")).Cron;
    Cron = (await import("../../../src/components/aws/v5/cron")).Cron;
    OriginalFunction = (await import("../../../src/components/aws/function"))
      .Function;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
    Workflow = (await import("../../../src/components/aws/workflow")).Workflow;
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Cluster = (await import("../../../src/components/aws/cluster")).Cluster;
    OriginalTask = (await import("../../../src/components/aws/task")).Task;
    await import("../../../src/components/aws/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  const named = (prefix: string) =>
    names()
      .filter((name) => name.startsWith(prefix))
      .sort();
  const task = () =>
    new OriginalTask("MyTask", {
      cluster: new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }),
      image: "nginx:latest",
    });

  // Each case deploys the 4.x Cron, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs.
  describe("takes over a deployed Cron", () => {
    pulumi.takeoverCases<CronClass, CronClass>({
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
              function: new OriginalFunction("MyFunction", {
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
                target: (args: any) => {
                  args.retryPolicy = { maximumRetryAttempts: 2 };
                },
              },
            },
            opts,
          );
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
    expect(resource("MyCronJobFunction").type).toBe("sst:aws:Function");
    expect(resource("MyCronJobTarget").inputs).toMatchObject({
      arn: "arn:aws:mock:us-east-1:123456789012:MyCronJobFunctionFunction",
      input: '{"foo":"bar"}',
    });
    expect(resource("MyCronJobPermission").inputs).toMatchObject({
      action: "lambda:InvokeFunction",
      principal: "events.amazonaws.com",
    });
    expect(names()).not.toContain("MyCronJobTargetRole");
    const fn = await pulumi.resolve(cron.nodes.function);
    expect(fn).toBeInstanceOf(Function);
  });

  it("runs a task with a role of its own", async () => {
    const cron = new Cron("MyCronJob", {
      task: task(),
      schedule: "rate(1 day)",
    });
    await pulumi.settle();
    expect(names()).toContain("MyCronJobTargetRole");
    expect(names()).not.toContain("MyCronJobPermission");
    expect(cron.nodes.role).toBeDefined();
  });

  it("runs a V5 task", async () => {
    const { Task } = await import("../../../src/components/aws/v5/task");
    new Cron("MyCronJob", {
      task: new Task("MyTask", {
        cluster: new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }),
        image: "nginx:latest",
      }),
      schedule: "rate(1 day)",
      event: { foo: "bar" },
    });
    await pulumi.settle();
    expect(names()).toContain("MyCronJobTargetRole");
    const target = await pulumi.resolve(resource("MyCronJobTarget").inputs);
    expect(target.ecsTarget.launchType).toBe("FARGATE");
    expect(target.input).toContain("SST_EVENT");
  });

  it("turns down the deprecated job, both a function and a task, or neither", () => {
    expect(
      () =>
        new Cron("MyCronJob", {
          // @ts-expect-error
          job: "src/cron.handler",
          schedule: "rate(1 minute)",
        }),
    ).toThrow(/"job" isn't an option/);
    expect(
      () =>
        new Cron("MyCronJob", {
          function: "src/cron.handler",
          task: task(),
          schedule: "rate(1 minute)",
        }),
    ).toThrow(/both a function and a task/);
    expect(() => new Cron("MyCronJob", { schedule: "rate(1 minute)" })).toThrow(
      /either a function or a task/,
    );
  });

  it("refuses a function's args given as an output", async () => {
    const failures = await rejectionsOf(async () => {
      new Cron("MyCronJob", {
        function: output({ handler: "src/cron.handler" }) as any,
        schedule: "rate(1 minute)",
      });
      await pulumi.settle();
    });
    expect(new Set(failures).size).toBe(1);
    expect((failures[0] as Error).message).toMatch(
      /The "function" of the "MyCronJob" cron job is an output that isn't a function/,
    );
  });
});
