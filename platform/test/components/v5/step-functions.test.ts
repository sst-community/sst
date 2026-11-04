import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { rejectionsOf } from "../../helpers/rejections";

const STATE_MACHINE = "aws:sfn/stateMachine:StateMachine";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-function";

const pulumi = mockPulumi({
  call: (args) =>
    args.token === "aws:index/getAvailabilityZones:getAvailabilityZones"
      ? { names: ["us-east-1a", "us-east-1b"] }
      : undefined,
});

type Module =
  | typeof import("../../../src/components/aws/step-functions")
  | typeof import("../../../src/components/aws/v5/step-functions");
type SfnClass = Module["StepFunctions"];

describe("StepFunctions", () => {
  let Original: typeof import("../../../src/components/aws/step-functions").StepFunctions;
  let StepFunctions: typeof import("../../../src/components/aws/v5/step-functions").StepFunctions;
  let OriginalFunction: typeof import("../../../src/components/aws/function").Function;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;
  let OriginalQueue: typeof import("../../../src/components/aws/queue").Queue;
  let Queue: typeof import("../../../src/components/aws/v5/queue").Queue;
  let OriginalTopic: typeof import("../../../src/components/aws/sns-topic").SnsTopic;
  let SnsTopic: typeof import("../../../src/components/aws/v5/sns-topic").SnsTopic;
  let OriginalBus: typeof import("../../../src/components/aws/bus").Bus;
  let Bus: typeof import("../../../src/components/aws/v5/bus").Bus;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Cluster: typeof import("../../../src/components/aws/cluster").Cluster;
  let OriginalTask: typeof import("../../../src/components/aws/task").Task;

  beforeAll(async () => {
    Original = (await import("../../../src/components/aws/step-functions"))
      .StepFunctions;
    StepFunctions = (
      await import("../../../src/components/aws/v5/step-functions")
    ).StepFunctions;
    OriginalFunction = (await import("../../../src/components/aws/function"))
      .Function;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
    OriginalQueue = (await import("../../../src/components/aws/queue")).Queue;
    Queue = (await import("../../../src/components/aws/v5/queue")).Queue;
    OriginalTopic = (await import("../../../src/components/aws/sns-topic"))
      .SnsTopic;
    SnsTopic = (await import("../../../src/components/aws/v5/sns-topic"))
      .SnsTopic;
    OriginalBus = (await import("../../../src/components/aws/bus")).Bus;
    Bus = (await import("../../../src/components/aws/v5/bus")).Bus;
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
  const definitionOf = async (name: string) =>
    JSON.parse(
      await pulumi.resolve(
        resource(`${name}StateMachine`).inputs.definition as any,
      ),
    );

  // A machine that passes, then succeeds
  const simple = (S: SfnClass) =>
    S.pass({ name: "Foo" }).next(S.succeed({ name: "Bar" }));

  // Each case deploys the 4.x StepFunctions, then the same thing as the V5
  // one, its static methods too. Everything the 4.x one created has to be
  // kept, with the same inputs.
  describe("takes over a deployed StepFunctions", () => {
    pulumi.takeoverCases<SfnClass, SfnClass>({
      original: () => Original,
      v5: () => StepFunctions,
      check: () =>
        expect(resource("MyMachineStateMachine").type).toBe(STATE_MACHINE),
      cases: {
        "a pass and a succeed": (S, opts) => {
          new S("MyMachine", { definition: simple(S) }, opts);
        },
        "express, logging everything with the data": (S, opts) => {
          new S(
            "MyMachine",
            {
              type: "express",
              definition: simple(S),
              logging: {
                retention: "1 week",
                level: "all",
                includeData: true,
              },
            },
            opts,
          );
        },
        // 4.x gave the state machine a log destination of `undefined:*`,
        // which AWS turns down, so no 4.x state machine was deployed this way.
        // The V5 one leaves it out.
        "without logging": {
          create: (S, opts) => {
            new S("MyMachine", { definition: simple(S), logging: false }, opts);
          },
          changed: [["MyMachineStateMachine", ["loggingConfiguration"]]],
        },
        // 4.x took `logging` as an output. The V5 one takes it as a plain
        // value, since it decides whether the log group is created, with
        // outputs inside.
        "logging given as an output": {
          original: (opts) =>
            new Original(
              "MyMachine",
              {
                definition: simple(Original),
                logging: output({ retention: "1 day" as const }),
              },
              opts,
            ),
          v5: (opts) =>
            new StepFunctions(
              "MyMachine",
              {
                definition: simple(StepFunctions),
                logging: { retention: output("1 day" as const) },
              },
              opts,
            ),
        },
        "invoking a function from a handler and one from its args": (
          S,
          opts,
        ) => {
          const a = S.lambdaInvoke({
            name: "InvokeA",
            function: "src/a.handler",
            payload: { id: "{% $states.input.id %}" },
          });
          const b = S.lambdaInvoke({
            name: "InvokeB",
            function: { handler: "src/b.handler", timeout: "60 seconds" },
          });
          new S("MyMachine", { definition: a.next(b) }, opts);
        },
        "invoking a function the app has, and one by its ARN": {
          original: (opts) => {
            const fn = new OriginalFunction("MyFn", {
              handler: "src/fn.handler",
            });
            const a = Original.lambdaInvoke({ name: "InvokeA", function: fn });
            const b = Original.lambdaInvoke({
              name: "InvokeB",
              function: FUNCTION_ARN,
            });
            return new Original("MyMachine", { definition: a.next(b) }, opts);
          },
          v5: (opts) => {
            const fn = new Function("MyFn", { handler: "src/fn.handler" });
            const a = StepFunctions.lambdaInvoke({
              name: "InvokeA",
              function: fn,
            });
            const b = StepFunctions.lambdaInvoke({
              name: "InvokeB",
              function: FUNCTION_ARN,
            });
            return new StepFunctions(
              "MyMachine",
              { definition: a.next(b) },
              opts,
            );
          },
        },
        "publishing to a topic, sending to a queue, and putting events": {
          original: (opts) => {
            const topic = new OriginalTopic("MyTopic");
            const queue = new OriginalQueue("MyQueue");
            const bus = new OriginalBus("MyBus");
            const publish = Original.snsPublish({
              name: "Publish",
              topic,
              message: "{% $states.input.message %}",
              subject: "Hi",
            });
            const send = Original.sqsSendMessage({
              name: "Send",
              queue,
              messageBody: { id: "{% $states.input.id %}" },
            });
            const put = Original.eventBridgePutEvents({
              name: "Put",
              events: [
                { bus, source: "app", detailType: "done" },
                { bus, source: "app", detailType: "again" },
              ],
            });
            return new Original(
              "MyMachine",
              { definition: publish.next(send).next(put) },
              opts,
            );
          },
          v5: (opts) => {
            const topic = new SnsTopic("MyTopic");
            const queue = new Queue("MyQueue");
            const bus = new Bus("MyBus");
            const publish = StepFunctions.snsPublish({
              name: "Publish",
              topic,
              message: "{% $states.input.message %}",
              subject: "Hi",
            });
            const send = StepFunctions.sqsSendMessage({
              name: "Send",
              queue,
              messageBody: { id: "{% $states.input.id %}" },
            });
            const put = StepFunctions.eventBridgePutEvents({
              name: "Put",
              events: [
                { bus, source: "app", detailType: "done" },
                { bus, source: "app", detailType: "again" },
              ],
            });
            return new StepFunctions(
              "MyMachine",
              { definition: publish.next(send).next(put) },
              opts,
            );
          },
        },
        "running an ECS task, with its environment": (S, opts) => {
          const task = new OriginalTask("MyTask", {
            cluster: new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }),
            image: "nginx:latest",
          });
          const run = S.ecsRunTask({
            name: "Run",
            task,
            integration: "sync",
            environment: { ID: "{% $states.input.id %}" },
          });
          new S("MyMachine", { definition: run }, opts);
        },
        "a map that reads objects from a bucket and writes its results": (
          S,
          opts,
        ) => {
          const map = S.map({
            name: "Map",
            mode: "distributed",
            processor: S.pass({ name: "Each" }),
            itemReader: {
              type: "objects",
              bucket: "my-bucket",
              prefix: "documents/",
            },
            resultWriter: { bucket: "my-bucket", prefix: "results/read" },
          } as any);
          new S("MyMachine", { definition: map }, opts);
        },
        "a choice, a parallel and a wait": (S, opts) => {
          const choice = S.choice({ name: "Choose" });
          const parallel = S.parallel({ name: "Both" });
          parallel.branch(S.pass({ name: "Left" }));
          parallel.branch(S.pass({ name: "Right" }));
          choice.when("{% $states.input.go %}", parallel);
          choice.otherwise(
            S.wait({ name: "Hold", time: "10 seconds" }).next(
              S.fail({ name: "Stop", error: "Stopped" }),
            ),
          );
          new S("MyMachine", { definition: choice }, opts);
        },
        "with the state machine and log group transformed": (S, opts) => {
          new S(
            "MyMachine",
            {
              definition: simple(S),
              transform: {
                stateMachine: (args: any) => {
                  args.tags = { team: "data" };
                },
                logGroup: (args: any) => {
                  args.retentionInDays = 3;
                },
              },
            },
            opts,
          );
        },
      },
    });
  });

  it("creates a V5 function at the top of the app, named after the state", async () => {
    const invoke = StepFunctions.lambdaInvoke({
      name: "Invoke",
      function: "src/a.handler",
    });
    new StepFunctions("MyMachine", { definition: invoke });
    await pulumi.settle();
    const fn = pulumi.graph().find((r) => r.name === "InvokeFunction")!;
    expect(fn.type).toBe("sst:aws:Function");
    expect(fn.parent).not.toContain("StepFunctions");
    const definition = await definitionOf("MyMachine");
    expect(definition.States.Invoke.Resource).toBe(
      "arn:aws:states:::lambda:invoke",
    );
  });

  it("refuses a function's args given as an output", async () => {
    const failures = await rejectionsOf(async () => {
      StepFunctions.lambdaInvoke({
        name: "Invoke",
        function: output({ handler: "src/a.handler" }) as any,
      });
      await pulumi.settle();
    });
    expect(new Set(failures).size).toBe(1);
    expect((failures[0] as Error).message).toMatch(
      /The "function" of the "Invoke" state is an output that isn't a function/,
    );
  });

  it("takes a function given as an output", async () => {
    const fn = new Function("MyFn", { handler: "src/fn.handler" });
    const invoke = StepFunctions.lambdaInvoke({
      name: "Invoke",
      function: output(fn),
    });
    new StepFunctions("MyMachine", { definition: invoke });
    await pulumi.settle();
    expect(names()).not.toContain("InvokeFunction");
    const definition = await definitionOf("MyMachine");
    expect(definition.States.Invoke.Arguments.FunctionName).toMatch(/MyFn/);
  });

  it("refuses logging given as an output", () => {
    expect(
      () =>
        new StepFunctions("MyMachine", {
          definition: simple(StepFunctions),
          // @ts-expect-error
          logging: output(false),
        }),
    ).toThrow(/"logging"/);
  });

  it("refuses an existing log group without logging, or with a retention", () => {
    const existing = { logGroup: "/aws/states/mine" };
    expect(
      () =>
        new StepFunctions("Quiet", {
          definition: simple(StepFunctions),
          logging: false,
          existing,
        }),
    ).toThrow(
      /"existing.logGroup" isn't an option for the "Quiet" state machine. Its logs go to a log group only with "logging"/,
    );
    expect(
      () =>
        new StepFunctions("Kept", {
          definition: simple(StepFunctions),
          logging: { retention: "1 week" },
          existing,
        }),
    ).toThrow(
      /is given an existing "logGroup", which it uses the way it is. Remove "retention" from its "logging"/,
    );
  });

  it("has no log group without logging, and its role and log group in nodes", async () => {
    const quiet = new StepFunctions("Quiet", {
      definition: simple(StepFunctions),
      logging: false,
    });
    const loud = new StepFunctions("Loud", {
      definition: StepFunctions.pass({ name: "Loud" }),
    });
    await pulumi.settle();
    expect(names()).not.toContain("QuietLogGroup");
    expect(names()).toContain("LoudLogGroup");
    expect(quiet.nodes.logGroup).toBeUndefined();
    expect(loud.nodes.logGroup).toBeDefined();
    expect(loud.nodes.role).toBeDefined();
    expect(resource("QuietStateMachine").inputs.loggingConfiguration).toEqual(
      expect.objectContaining({ level: "OFF" }),
    );
  });

  it("gives its role what its states need", async () => {
    const topic = new SnsTopic("MyTopic");
    const publish = StepFunctions.snsPublish({
      name: "Publish",
      topic,
      message: "hi",
    });
    new StepFunctions("MyMachine", { definition: publish });
    await pulumi.settle();
    const policy = JSON.stringify(
      await pulumi.resolve(resource("MyMachineRole").inputs.inlinePolicies),
    );
    expect(policy).toContain("sns:Publish");
    expect(policy).toContain("states:StartExecution");
  });

  it("can be linked by a function, which may then run it", async () => {
    const machine = new StepFunctions("MyMachine", {
      definition: simple(StepFunctions),
    });
    new Function("Api", { handler: "src/api.handler", link: [machine] });
    await pulumi.settle();
    const policy = JSON.stringify(
      await pulumi.resolve(resource("ApiRole").inputs.inlinePolicies),
    );
    expect(policy).toContain("states:*");
    expect(policy).toContain("states:SendTaskSuccess");
    expect(policy).toContain("MyMachineStateMachine");
  });

  it("runs a V5 task", async () => {
    const { Task } = await import("../../../src/components/aws/v5/task");
    const task = new Task("MyTask", {
      cluster: new Cluster("MyCluster", { vpc: new Vpc("MyVpc") }),
      image: "nginx:latest",
    });
    new StepFunctions("MyMachine", {
      definition: StepFunctions.ecsRunTask({ name: "Run", task }),
    });
    await pulumi.settle();
    const definition = await definitionOf("MyMachine");
    expect(definition.States.Run.Resource).toBe("arn:aws:states:::ecs:runTask");
    expect(definition.States.Run.Arguments.LaunchType).toBe("FARGATE");
    const policy = JSON.stringify(
      await pulumi.resolve(resource("MyMachineRole").inputs.inlinePolicies),
    );
    expect(policy).toContain("ecs:RunTask");
    expect(policy).toContain("iam:PassRole");
  });

  it("invokes a 4.x Function, and one given as an output", async () => {
    const fn = new OriginalFunction("Old", { handler: "src/old.handler" });
    const a = StepFunctions.lambdaInvoke({ name: "A", function: fn });
    const b = StepFunctions.lambdaInvoke({ name: "B", function: output(fn) });
    new StepFunctions("MyMachine", { definition: a.next(b) });
    await pulumi.settle();
    expect(names()).not.toContain("AFunction");
    expect(names()).not.toContain("BFunction");
    const definition = await definitionOf("MyMachine");
    expect(definition.States.A.Arguments.FunctionName).toMatch(/Old/);
    expect(definition.States.B.Arguments.FunctionName).toMatch(/Old/);
  });
});
