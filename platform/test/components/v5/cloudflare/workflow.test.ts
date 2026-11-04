import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";

const WORKFLOW = "cloudflare:index/workflow:Workflow";
// The mock builds a worker into a file of this extension
const handler = "src/workflow.mjs";
const className = "OrderProcessor";

const pulumi = mockPulumi();

type WorkflowClass =
  | typeof import("../../../../src/components/cloudflare/workflow").Workflow
  | typeof import("../../../../src/components/cloudflare/v5/workflow").Workflow;

describe("Workflow", () => {
  let Original: typeof import("../../../../src/components/cloudflare/workflow").Workflow;
  let Workflow: typeof import("../../../../src/components/cloudflare/v5/workflow").Workflow;
  let OriginalWorker: typeof import("../../../../src/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/v5/worker").Worker;
  let Secret: typeof import("../../../../src/components/secret").Secret;

  beforeAll(async () => {
    Original = (await import("../../../../src/components/cloudflare/workflow"))
      .Workflow;
    Workflow = (
      await import("../../../../src/components/cloudflare/v5/workflow")
    ).Workflow;
    OriginalWorker = (
      await import("../../../../src/components/cloudflare/worker")
    ).Worker;
    Worker = (await import("../../../../src/components/cloudflare/v5/worker"))
      .Worker;
    Secret = (await import("../../../../src/components/secret")).Secret;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const named = (type: string) =>
    pulumi.resources.filter((r) => r.type === type).map((r) => r.name);
  // A secret among them keeps them all secret, recorded under `value`
  const bindingsOf = (name: string) => {
    const bindings = resource(name).inputs.bindings;
    return (bindings.value ?? bindings) as Record<string, any>[];
  };

  // Each case deploys the 4.x Workflow, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs. Nothing moved.
  describe("takes over a deployed Workflow", () => {
    pulumi.takeoverCases<WorkflowClass, WorkflowClass>({
      original: () => Original,
      v5: () => Workflow,
      provider: "cloudflare",
      // SST 4's Worker waited on everything in what it's linked to, from
      // reading its name, like the URL setting of the workflow's own Worker.
      // Its bindings wait on the workflow they name, which is all Cloudflare
      // needs.
      needlessOrder: /^ApiScript before MyWorkflowScriptUrl$/,
      check: () => {
        expect(named(WORKFLOW)).toEqual(["MyWorkflowWorkflow"]);
        expect(resource("MyWorkflowWorkflow").inputs).toMatchObject({
          className,
          scriptName: "app-test-myworkflowscriptscript",
        });
      },
      cases: {
        "a workflow": (Workflow, opts) => {
          new Workflow("MyWorkflow", { handler, className }, opts);
        },
        "a workflow with links and environment variables": (Workflow, opts) => {
          const secret = new Secret("MySecret", "shh");
          new Workflow(
            "MyWorkflow",
            {
              handler,
              className,
              link: [secret],
              environment: { MODE: "orders" },
            },
            opts,
          );
        },
        "a workflow transformed": (Workflow, opts) => {
          new Workflow(
            "MyWorkflow",
            {
              handler,
              className,
              transform: {
                worker: { url: true },
                workflow: { limits: { steps: 100 } },
              },
            },
            opts,
          );
        },
        // The binding a worker gets is the same from either
        "a workflow a worker is linked to": {
          original: (opts) => {
            const workflow = new Original(
              "MyWorkflow",
              { handler, className },
              opts,
            );
            new OriginalWorker("Api", { handler, link: [workflow] });
          },
          v5: (opts) => {
            const workflow = new Workflow(
              "MyWorkflow",
              { handler, className },
              opts,
            );
            new Worker("Api", { handler, link: [workflow] });
          },
          check: () =>
            expect(bindingsOf("ApiScript")).toContainEqual({
              type: "workflow",
              name: "MyWorkflow",
              workflowName: resource("MyWorkflowWorkflow").inputs.workflowName,
              className,
              scriptName: "app-test-myworkflowscriptscript",
            }),
        },
      },
    });
  });

  it("creates its Worker and binds a worker linked to it", async () => {
    const workflow = new Workflow("MyWorkflow", { handler, className });
    new Worker("Api", { handler, link: [workflow] });
    await pulumi.settle();
    expect(resource("MyWorkflowScriptScript").parent).toMatch(
      /sst:cloudflare:Worker::MyWorkflowScript$/,
    );
    expect(
      bindingsOf("ApiScript").find((b) => b.type === "workflow"),
    ).toMatchObject({ name: "MyWorkflow", className });
  });

  it("refuses a link list that's an output", () => {
    expect(
      () =>
        new Workflow("MyWorkflow", {
          handler,
          className,
          link: output([]) as any,
        }),
    ).toThrow(
      'The "link" of the "MyWorkflow" workflow has to be a plain value, not an output.',
    );
  });

  it("refuses an existing worker or workflow", () => {
    expect(
      () =>
        new Workflow("MyWorkflow", {
          handler,
          className,
          existing: { workflow: "id" },
        }),
    ).toThrow(
      `"existing.workflow" isn't an option for the "MyWorkflow" workflow.`,
    );
  });
});
