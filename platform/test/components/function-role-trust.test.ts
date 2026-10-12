import { describe, beforeAll, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "function-trust-"));
const out = path.join(root, "out");
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, "index.mjs"), "export const handler = async () => 1;\n");

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
      if (method === "Provider.Aws.Appsync")
        return { http: "http://appsync", realtime: "ws://appsync" };
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

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: `${args.name}_id`,
        state: { ...args.inputs, arn: `arn:aws:test:::${args.name}` },
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
        return {
          ...args.inputs,
          json: JSON.stringify({
            Statement: args.inputs.statements.map((s: any) => ({
              Principal: Object.fromEntries(
                (s.principals ?? []).map((p: any) => [p.type, p.identifiers]),
              ),
            })),
          }),
        };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

async function settle() {
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function trustOf(name: string) {
  await settle();
  const role = createdResources.find(
    (r) => r.type === "aws:iam/role:Role" && r.name === `${name}Role`,
  );
  expect(role).toBeDefined();
  return JSON.stringify(await new Promise((r) => pulumi.output(role!.inputs.assumeRolePolicy).apply(r)));
}

describe("Function role trust policy", function () {
  let Function: typeof import("../../src/components/aws/function").Function;

  beforeAll(async function () {
    Function = (await import("../../src/components/aws/function")).Function;
  });

  beforeEach(function () {
    createdResources = [];
  });

  it("trusts only the Lambda service when deployed", async () => {
    // @ts-ignore
    global.$dev = false;
    new Function("Deployed", { handler: "index.handler", bundle: out });
    const trust = await trustOf("Deployed");
    expect(trust).toContain("lambda.amazonaws.com");
    expect(trust).not.toContain(":root");
  });

  it("also trusts the account root in sst dev", async () => {
    // @ts-ignore
    global.$dev = true;
    new Function("Dev", { handler: "index.handler", bundle: out });
    const trust = await trustOf("Dev");
    expect(trust).toContain("lambda.amazonaws.com");
    expect(trust).toContain("111111111111");
  });
});
