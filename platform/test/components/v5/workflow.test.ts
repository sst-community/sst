import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const FUNCTION = "aws:lambda/function:Function";

const pulumi = mockPulumi({
  // A workflow's function publishes versions, and is invoked by its version
  state: (args) => {
    // A log group that's looked up has the name it's looked up by
    if (args.type === "aws:cloudwatch/logGroup:LogGroup" && args.id)
      return { name: args.id };
    if (args.type !== FUNCTION) return {};
    const arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.name}`;
    const invoke = (api: string, path: string) =>
      `arn:aws:apigateway:us-east-1:lambda:path/${api}/functions/${arn}/${path}`;
    return {
      arn,
      qualifiedArn: `${arn}:3`,
      version: "3",
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
});

type WorkflowClass =
  | typeof import("../../../src/components/aws/workflow").Workflow
  | typeof import("../../../src/components/aws/v5/workflow").Workflow;

describe("Workflow", () => {
  let Original: typeof import("../../../src/components/aws/workflow").Workflow;
  let Workflow: typeof import("../../../src/components/aws/v5/workflow").Workflow;
  let OriginalCronV2: typeof import("../../../src/components/aws/cron-v2").CronV2;
  let CronV2: typeof import("../../../src/components/aws/v5/cron-v2").CronV2;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;
  let Bucket: typeof import("../../../src/components/aws/v5/bucket").Bucket;

  beforeAll(async () => {
    Original = (await import("../../../src/components/aws/workflow")).Workflow;
    Workflow = (await import("../../../src/components/aws/v5/workflow"))
      .Workflow;
    OriginalCronV2 = (await import("../../../src/components/aws/cron-v2"))
      .CronV2;
    CronV2 = (await import("../../../src/components/aws/v5/cron-v2")).CronV2;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
    Bucket = (await import("../../../src/components/aws/v5/bucket")).Bucket;
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

  // Each case deploys the 4.x Workflow, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept, with the same inputs.
  describe("takes over a deployed Workflow", () => {
    pulumi.takeoverCases<WorkflowClass, WorkflowClass>({
      original: () => Original,
      v5: () => Workflow,
      cases: {
        "from a handler": {
          create: (W, opts) => {
            new W("MyWorkflow", { handler: "src/workflow.handler" }, opts);
          },
          check: () =>
            expect(resource("MyWorkflowHandler").type).toBe("sst:aws:Function"),
        },
        "with timeouts, retention, a runtime and links": (W, opts) => {
          const bucket = new Bucket("MyBucket");
          new W(
            "MyWorkflow",
            {
              handler: "src/workflow.handler",
              runtime: "nodejs22.x",
              retention: "7 days",
              timeout: { execution: "2 hours", invocation: "30 seconds" },
              link: [bucket],
              environment: { STAGE: "test" },
              memory: "512 MB",
            },
            opts,
          );
        },
        "without logs": (W, opts) => {
          new W(
            "MyWorkflow",
            { handler: "src/workflow.handler", logging: false },
            opts,
          );
        },
        "with logs kept a week": (W, opts) => {
          new W(
            "MyWorkflow",
            {
              handler: "src/workflow.handler",
              logging: { retention: "1 week" },
            },
            opts,
          );
        },
        "with a log group of its own": (W, opts) => {
          new W(
            "MyWorkflow",
            {
              handler: "src/workflow.handler",
              logging: { logGroup: "/existing/log-group" },
            },
            opts,
          );
        },
        // 4.x took the function's own transform in `transform.function`. The
        // V5 one transforms the function's args there, as every part's does,
        // and the function's own goes in its `transform`.
        "with the function transformed": {
          original: (opts) =>
            new Original(
              "MyWorkflow",
              {
                handler: "src/workflow.handler",
                transform: {
                  function: { function: { description: "Durable" } },
                },
              },
              opts,
            ),
          v5: (opts) =>
            new Workflow(
              "MyWorkflow",
              {
                handler: "src/workflow.handler",
                transform: {
                  function: {
                    transform: { function: { description: "Durable" } },
                  },
                },
              },
              opts,
            ),
        },
        "subscribed to a bus": {
          original: async (opts) => {
            const { Bus } = await import("../../../src/components/aws/bus");
            return new Bus("MyBus", {}, opts).subscribe(
              "MySubscriber",
              new Original(
                "MyWorkflow",
                { handler: "src/workflow.handler" },
                opts,
              ),
              { pattern: { detailType: ["app.requested"] } },
            );
          },
          v5: async (opts) => {
            const { Bus } = await import("../../../src/components/aws/v5/bus");
            return new Bus("MyBus", {}, opts).subscribe(
              "MySubscriber",
              new Workflow(
                "MyWorkflow",
                { handler: "src/workflow.handler" },
                opts,
              ),
              { pattern: { detailType: ["app.requested"] } },
            );
          },
          // 4.x kept the subscription in a component of its own, with nothing
          // in the cloud behind it, as the Bus's own tests say
          unclaimed: [
            "sst:aws:BusLambdaSubscriber::MyBusSubscriberMySubscriber",
          ],
        },
        "run by a cron job": {
          original: (opts) =>
            new OriginalCronV2(
              "MyCron",
              {
                schedule: "rate(1 minute)",
                function: new Original(
                  "MyWorkflow",
                  { handler: "src/workflow.handler" },
                  opts,
                ),
              },
              opts,
            ),
          v5: (opts) =>
            new CronV2(
              "MyCron",
              {
                schedule: "rate(1 minute)",
                function: new Workflow(
                  "MyWorkflow",
                  { handler: "src/workflow.handler" },
                  opts,
                ),
              },
              opts,
            ),
        },
      },
    });
  });

  it("runs its function durably, with versions", async () => {
    const workflow = new Workflow("MyWorkflow", {
      handler: "src/workflow.handler",
      timeout: { execution: "1 hour" },
    });
    await pulumi.settle();
    expect(workflow.getFunction()).toBeInstanceOf(Function);
    expect(workflow.nodes.function).toBeInstanceOf(Function);
    const fn = resource("MyWorkflowHandlerFunction").inputs;
    expect(fn.publish).toBe(true);
    expect(fn.durableConfig ?? fn.durable).toBeDefined();
    expect(await pulumi.resolve(workflow.qualifier)).toBe("3");
  });

  it("refuses SST 4's transform of the function, which goes in its transform now", () => {
    expect(
      () =>
        new Workflow("MyWorkflow", {
          handler: "src/workflow.handler",
          transform: {
            function: { function: { memorySize: 2048 } } as any,
          },
        }),
    ).toThrow(/"transform.function.transform"/);
  });

  it("refuses logging or a runtime given as an output", () => {
    expect(
      () =>
        new Workflow("MyWorkflow", {
          handler: "src/workflow.handler",
          // @ts-expect-error
          logging: output(false),
        }),
    ).toThrow(/"logging"/);
    expect(
      () =>
        new Workflow("MyWorkflow", {
          handler: "src/workflow.handler",
          // @ts-expect-error
          runtime: output("nodejs22.x"),
        }),
    ).toThrow(/"runtime"/);
  });

  it("can be linked by a function, with its version", async () => {
    const workflow = new Workflow("MyWorkflow", {
      handler: "src/workflow.handler",
    });
    new Function("Api", { handler: "src/api.handler", link: [workflow] });
    await pulumi.settle();
    expect(names()).toContain("ApiFunction");
    const link = workflow.link();
    expect(await pulumi.resolve(link.properties.qualifier)).toBe("3");
  });
});
