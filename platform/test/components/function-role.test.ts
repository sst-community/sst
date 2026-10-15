import { describe, beforeAll, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "function-role-"));
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

interface Registered {
  type: string;
  name: string;
  id?: string;
  inputs: any;
}

let registered: Registered[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      registered.push({
        type: args.type,
        name: args.name,
        id: args.id,
        inputs: args.inputs,
      });
      return {
        id: args.id ?? `${args.name}_id`,
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

const roles = (name: string) =>
  registered.filter((r) => r.type === "aws:iam/role:Role" && r.name === `${name}Role`);

describe("Function role", function () {
  let Function: typeof import("../../src/components/aws/function").Function;
  let iam: typeof import("@pulumi/aws").iam;

  beforeAll(async function () {
    Function = (await import("../../src/components/aws/function")).Function;
    iam = (await import("@pulumi/aws")).iam;
  });

  beforeEach(function () {
    registered = [];
    vi.restoreAllMocks();
  });

  const roleArn = "arn:aws:iam::111111111111:role/shared";

  it("does not read a passed-in role until nodes.role is read", async () => {
    const fn = new Function("Passed", {
      handler: "index.handler",
      bundle: out,
      role: roleArn,
    });
    await settle();
    expect(roles("Passed")).toHaveLength(0);

    const role = fn.nodes.role;
    await settle();
    expect(roles("Passed")).toHaveLength(1);
    expect(roles("Passed")[0].id).toBe("shared");

    // a second read gives the same role and registers nothing new
    expect(fn.nodes.role).toBe(role);
    await settle();
    expect(roles("Passed")).toHaveLength(1);
  });

  it("registers the role once when nodes.role is read inside an apply", async () => {
    const fn = new Function("InApply", {
      handler: "index.handler",
      bundle: out,
      role: roleArn,
    });
    await settle();
    expect(roles("InApply")).toHaveLength(0);

    await new Promise((resolve) =>
      pulumi.output(fn.arn).apply(() => resolve(fn.nodes.role)),
    );
    await settle();
    expect(roles("InApply")).toHaveLength(1);
  });

  it("uses the passed-in role for the function", async () => {
    new Function("Wired", { handler: "index.handler", bundle: out, role: roleArn });
    await settle();
    const lambda = registered.find((r) => r.type === "aws:lambda/function:Function");
    expect(lambda).toBeDefined();
    expect(await new Promise((resolve) => pulumi.output(lambda!.inputs.role).apply(resolve as any))).toBe(roleArn);
    expect(roles("Wired")).toHaveLength(0);
  });

  it("creates its own role right away when none is passed", async () => {
    const fn = new Function("Own", { handler: "index.handler", bundle: out });
    await settle();
    expect(roles("Own")).toHaveLength(1);
    expect(roles("Own")[0].inputs.assumeRolePolicy).toBeDefined();

    const role = fn.nodes.role;
    expect(fn.nodes.role).toBe(role);
    await settle();
    expect(roles("Own")).toHaveLength(1);
  });

  it("throws the same error on every read if the first read fails", async () => {
    const error = new Error("read failed");
    const get = vi.spyOn(iam.Role, "get").mockImplementation(() => {
      throw error;
    });
    const fn = new Function("Failing", {
      handler: "index.handler",
      bundle: out,
      role: roleArn,
    });
    await settle();
    expect(get).not.toHaveBeenCalled();

    expect(() => fn.nodes.role).toThrow(error);
    expect(() => fn.nodes.role).toThrow(error);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
