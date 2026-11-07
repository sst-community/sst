import { describe, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-workflow-"));
const out = path.join(root, "out");
fs.mkdirSync(out);
fs.writeFileSync(
  path.join(out, "index.mjs"),
  "export const handler = async () => 1;\n",
);

vi.mock("../../src/components/aws/helpers/bootstrap", () => ({
  bootstrap: {
    forRegion: async () => ({ asset: "sst-asset-test" }),
  },
}));

vi.mock("../../src/components/rpc/rpc", () => ({
  rpc: {
    call: async (method: string) => {
      if (method === "Runtime.Build")
        return { handler: "index.handler", out, errors: [], sourcemaps: [] };
      return {};
    },
  },
}));

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$cli = {
  paths: { root, work: path.join(root, ".sst"), platform: root },
  state: { version: {} },
};

interface Registered {
  type: string;
  name: string;
  inputs: any;
}

let registered: Registered[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      registered.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      const arn = `arn:aws:lambda:us-east-1:111111111111:function:${args.name}`;
      return {
        id: `${args.name}_id`,
        state: {
          ...args.inputs,
          arn,
          ...(args.type === "aws:lambda/function:Function"
            ? {
                qualifiedArn: `${arn}:7`,
                version: "7",
                invokeArn: `invoke/${arn}`,
                qualifiedInvokeArn: `invoke/${arn}:7`,
                responseStreamingInvokeArn: `stream/${arn}`,
              }
            : {}),
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity")
        return { accountId: "111111111111" };
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: "aws" };
      if (args.token === "aws:index/getRegion:getRegion")
        return { name: "us-east-1", region: "us-east-1" };
      if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument")
        return { ...args.inputs, json: "{}" };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

// Waits until no resource has been registered for 250 ms.
async function settle() {
  let count = -1;
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = registered.length === count ? quiet + 1 : 0;
    count = registered.length;
  }
}

async function subscribe(name: string, timeout: { execution: string }) {
  const { Workflow } = await import("../../src/components/aws/workflow");
  const { QueueLambdaSubscriber } = await import(
    "../../src/components/aws/queue-lambda-subscriber"
  );
  const workflow = new Workflow(`${name}Workflow`, {
    handler: "src/workflow.handler",
    timeout: timeout as any,
  });
  const subscriber = new QueueLambdaSubscriber(`${name}Subscriber`, {
    queue: { arn: "arn:aws:sqs:us-east-1:111111111111:jobs" },
    subscriber: workflow,
    batch: { size: 1 },
  });
  return (subscriber.nodes.eventSourceMapping.functionName as any).promise();
}

describe("Queue subscriber with a Workflow", () => {
  beforeEach(() => {
    registered = [];
  });

  it("maps the queue to the workflow's published version, without a second function", async () => {
    const functionName = await subscribe("Direct", {
      execution: "15 minutes",
    });
    await settle();

    expect(functionName).toBe(
      "arn:aws:lambda:us-east-1:111111111111:function:DirectWorkflowHandlerFunction:7",
    );
    const mapping = registered.filter(
      (r) => r.type === "aws:lambda/eventSourceMapping:EventSourceMapping",
    );
    expect(mapping).toHaveLength(1);
    expect(mapping[0].inputs.batchSize).toBe(1);
    expect(
      registered.filter((r) => r.type === "aws:lambda/function:Function"),
    ).toHaveLength(1);
  });
});

// The subscriber runs this check on the workflow's execution timeout before it
// creates the mapping. A refused timeout fails the deploy, which the Pulumi
// mocks report as an unhandled error, so the check is tested on its own.
describe("checkQueueWorkflowTimeout", () => {
  it("allows up to 15 minutes", async () => {
    const { checkQueueWorkflowTimeout } = await import(
      "../../src/components/aws/queue-lambda-subscriber"
    );
    expect(() =>
      checkQueueWorkflowTimeout("Jobs", "900 seconds"),
    ).not.toThrow();
    expect(() => checkQueueWorkflowTimeout("Jobs", "15 minutes")).not.toThrow();
  });

  it("refuses a workflow that may run longer than a queue can wait", async () => {
    const { checkQueueWorkflowTimeout } = await import(
      "../../src/components/aws/queue-lambda-subscriber"
    );
    expect(() => checkQueueWorkflowTimeout("Jobs", "16 minutes")).toThrow(
      /"Jobs" queue subscriber .* "16 minutes".*workflow\.dispatcher\(\)/,
    );
    // The Workflow's default.
    expect(() => checkQueueWorkflowTimeout("Jobs", "14 days")).toThrow(
      '"14 days"',
    );
  });
});
