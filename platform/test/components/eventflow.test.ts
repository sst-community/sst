import { describe, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eventflow-"));
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
          ...(args.type === "random:index/randomPassword:RandomPassword" ? { result: "signing-key" } : {}),
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

function count(type: string) {
  return registered.filter((r) => r.type === type).length;
}

function find(type: string, name: string) {
  const r = registered.filter((r) => r.type === type && r.name === name).pop();
  if (!r) throw new Error(`No ${type} ${name}. Have: ${registered.map((r) => `${r.type} ${r.name}`).join(", ")}`);
  return r;
}

async function resolve(value: any): Promise<any> {
  if (value && typeof value.promise === "function") return resolve(await value.promise());
  if (Array.isArray(value)) return Promise.all(value.map(resolve));
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolve(v);
    return out;
  }
  return value;
}

describe("EventFlow", () => {
  beforeEach(() => {
    registered = [];
  });

  it("makes one fixed set of resources", async () => {
    const { EventFlow } = await import("../../src/components/aws/eventflow");
    new EventFlow("Flow", { handler: "src/flow.handler" });
    await settle();

    // One worker and one router, whatever the number of functions in the handler.
    expect(count("aws:lambda/function:Function")).toBe(2);
    expect(count("aws:sqs/queue:Queue")).toBe(2);
    expect(count("aws:dynamodb/table:Table")).toBe(1);
    expect(count("aws:scheduler/schedule:Schedule")).toBe(1);
    expect(count("aws:lambda/eventSourceMapping:EventSourceMapping")).toBe(1);
    expect(count("random:index/randomPassword:RandomPassword")).toBe(1);

    const worker = find("aws:lambda/function:Function", "FlowWorkerHandlerFunction");
    expect(worker.inputs.name).toMatch(/^app-test-FlowWorker-[a-z0-9]{8}$/);
    expect(worker.inputs.durableConfig).toBeDefined();
    const router = find("aws:lambda/function:Function", "FlowRouterFunction");
    expect(router.inputs.name).toMatch(/^app-test-FlowRouter-[a-z0-9]{8}$/);
    expect(router.inputs.durableConfig).toBeUndefined();
    expect(router.inputs.timeout).toBe(60);

    const flow = JSON.parse(router.inputs.environment.variables.SST_EVENTFLOW);
    expect(flow.workerName).toBe(worker.inputs.name);
    expect(flow.workerQualifier).toBe("7");
    expect(flow.runTimeoutSeconds).toBe(14 * 86400);
    expect(router.inputs.environment.variables.SST_EVENTFLOW_KEY).toBeDefined();
    expect(worker.inputs.environment.variables.SST_EVENTFLOW_KEY).toBe(router.inputs.environment.variables.SST_EVENTFLOW_KEY);

    const mapping = find("aws:lambda/eventSourceMapping:EventSourceMapping", "FlowRouterEventSourceMapping");
    expect(mapping.inputs.functionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(mapping.inputs.batchSize).toBe(10);

    const main = find("aws:sqs/queue:Queue", "FlowQueueQueue");
    expect(JSON.parse(main.inputs.redrivePolicy).maxReceiveCount).toBe(6);
    const dead = find("aws:sqs/queue:Queue", "FlowDeadLetterQueueQueue");
    expect(dead.inputs.messageRetentionSeconds).toBe(1_209_600);

    const table = find("aws:dynamodb/table:Table", "FlowTableTable");
    expect(table.inputs.ttl).toEqual({ attributeName: "expires", enabled: true });

    const schedule = find("aws:scheduler/schedule:Schedule", "FlowTickSchedule");
    expect(schedule.inputs.scheduleExpression).toBe("rate(1 minute)");
    expect(JSON.parse(schedule.inputs.target.input)).toEqual({
      "sst:eventflow:tick": "<aws.scheduler.scheduled-time>",
    });
  });

  it("makes a second set only for a second EventFlow, and keeps a schedule that's off", async () => {
    const { EventFlow } = await import("../../src/components/aws/eventflow");
    new EventFlow("Second", { handler: "src/flow.handler" });
    new EventFlow("Media", { handler: "src/media.handler", memory: "4 GB", schedule: false });
    await settle();
    expect(count("aws:lambda/function:Function")).toBe(4);
    expect(count("aws:dynamodb/table:Table")).toBe(2);
    expect(count("aws:scheduler/schedule:Schedule")).toBe(2);
    expect(find("aws:scheduler/schedule:Schedule", "MediaTickSchedule").inputs.state).toBe("DISABLED");
    const media = find("aws:lambda/function:Function", "MediaWorkerHandlerFunction");
    expect(media.inputs.memorySize).toBe(4096);
  });

  it("links sending only, and the admin link invokes the router", async () => {
    const { EventFlow } = await import("../../src/components/aws/eventflow");
    const flow = new EventFlow("Linked", { handler: "src/flow.handler" });
    const link = await resolve(flow.getSSTLink());
    expect(Object.keys(link.properties).sort()).toEqual(["queueUrl", "routerName"]);
    expect(link.include.flatMap((p: any) => p.actions)).toEqual(["sqs:SendMessage"]);
    const admin = await resolve((flow.admin as any).getSSTLink());
    expect(admin.include.flatMap((p: any) => p.actions)).toEqual(["lambda:InvokeFunction"]);
    expect(admin.include[0].resources[0]).toMatch(/:function:app-test-LinkedRouter-/);
  });

  it("refuses a role, and a maxConcurrency AWS won't take", async () => {
    const { EventFlow } = await import("../../src/components/aws/eventflow");
    expect(() => new EventFlow("Roled", { handler: "src/flow.handler", role: "arn:aws:iam::1:role/x" } as any)).toThrow("role");
  });

  it("sets a batching window for a batch over 10", async () => {
    const { EventFlow } = await import("../../src/components/aws/eventflow");
    new EventFlow("Batch", { handler: "src/flow.handler", router: { maxConcurrency: 10, batchSize: 50 } });
    await settle();
    const mapping = find("aws:lambda/eventSourceMapping:EventSourceMapping", "BatchRouterEventSourceMapping");
    expect(mapping.inputs.scalingConfig).toEqual({ maximumConcurrency: 10 });
    expect(mapping.inputs.batchSize).toBe(50);
    expect(mapping.inputs.maximumBatchingWindowInSeconds).toBe(1);
  });
});
