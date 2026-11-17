// A function's runtime from sst.runtime: it's built and run in `sst dev` by
// its commands, which the CLI is given with the build, and deployed with the
// Lambda runtime it names. A runtime's name builds as it always has.
import { describe, beforeAll, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";
import { runtime } from "../../src/components/runtime";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "function-runtime-"));
const out = path.join(root, "out");
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, "app.rb"), "def handler(event:, context:) = 1\n");

vi.mock("../../src/components/aws/helpers/bootstrap", () => ({
  bootstrap: {
    forRegion: async () => ({ asset: "sst-asset-test" }),
  },
}));

interface Call {
  method: string;
  input: any;
}
let calls: Call[] = [];

vi.mock("../../src/components/rpc/rpc", () => ({
  rpc: {
    call: async (method: string, input: any) => {
      calls.push({ method, input });
      if (method === "Runtime.Build")
        return { handler: "app.handler", out, errors: [], sourcemaps: [] };
      if (method === "Provider.Aws.Appsync")
        return {
          http: "http://appsync",
          realtime: "ws://appsync",
          arn: "arn:aws:appsync:us-east-1:111111111111:apis/test",
          shared: false,
        };
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
// @ts-ignore
global.$jsonStringify = JSON.stringify;
process.env.SST_AWS_REGION = "us-east-1";

interface Registered {
  type: string;
  name: string;
  inputs: any;
}
let registered: Registered[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      registered.push({ type: args.type, name: args.name, inputs: args.inputs });
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

const lambdaOf = (name: string) =>
  registered.find(
    (r) => r.type === "aws:lambda/function:Function" && r.name === `${name}Function`,
  );
const callsTo = (method: string, functionID: string) =>
  calls.filter((c) => c.method === method && c.input?.functionID === functionID);

const ruby = runtime({
  lambda: "ruby3.4",
  build: { command: "bundle install" },
  dev: { command: "bundle exec aws_lambda_ric $_HANDLER" },
  watch: ["*.rb", "Gemfile.lock"],
});
const rubyCommands = {
  build: { command: "bundle install" },
  dev: { command: "bundle exec aws_lambda_ric $_HANDLER" },
  watch: ["*.rb", "Gemfile.lock"],
};

describe("Function runtime", function () {
  let Function: typeof import("../../src/components/aws/function").Function;

  beforeAll(async function () {
    Function = (await import("../../src/components/aws/function")).Function;
  });

  beforeEach(function () {
    registered = [];
    calls = [];
    // @ts-ignore
    global.$dev = false;
  });

  it("builds a function with its runtime's commands, and deploys it with the runtime's Lambda runtime", async () => {
    new Function("Ruby", { handler: "functions/ruby/app.handler", runtime: ruby });
    await settle();
    const builds = callsTo("Runtime.Build", "Ruby");
    expect(builds).toHaveLength(1);
    expect(builds[0].input.runtime).toBe("ruby3.4");
    expect(builds[0].input.commands).toEqual(rubyCommands);
    expect(lambdaOf("Ruby")?.inputs.runtime).toBe("ruby3.4");
    expect(lambdaOf("Ruby")?.inputs.handler).toBe("app.handler");
  });

  it("takes a runtime given through an output", async () => {
    new Function("RubyOutput", {
      handler: "functions/ruby/app.handler",
      runtime: pulumi.output(ruby),
    });
    await settle();
    expect(callsTo("Runtime.Build", "RubyOutput")[0].input.commands).toEqual(
      rubyCommands,
    );
    expect(lambdaOf("RubyOutput")?.inputs.runtime).toBe("ruby3.4");
  });

  it("builds a runtime's name as before, with no commands", async () => {
    new Function("Node", { handler: "index.handler", bundle: out });
    new Function("Go", { handler: "functions/go", runtime: "go" });
    await settle();
    const node = callsTo("Runtime.Build", "Node")[0].input;
    expect(node.runtime).toBe("nodejs24.x");
    expect("commands" in node).toBe(false);
    expect(lambdaOf("Node")?.inputs.runtime).toBe("nodejs24.x");
    const go = callsTo("Runtime.Build", "Go")[0].input;
    expect(go.runtime).toBe("go");
    expect("commands" in go).toBe(false);
    expect(lambdaOf("Go")?.inputs.runtime).toBe("provided.al2023");
  });

  it("tells sst dev the runtime's commands, and deploys the stub", async () => {
    // @ts-ignore
    global.$dev = true;
    new Function("RubyDev", { handler: "functions/ruby/app.handler", runtime: ruby });
    await settle();
    const targets = callsTo("Runtime.AddTarget", "RubyDev");
    expect(targets).toHaveLength(1);
    expect(targets[0].input.runtime).toBe("ruby3.4");
    expect(targets[0].input.commands).toEqual(rubyCommands);
    expect(callsTo("Runtime.Build", "RubyDev")).toHaveLength(0);
    expect(lambdaOf("RubyDev")?.inputs.runtime).toBe("provided.al2023");
  });

  it("refuses injections with a runtime from sst.runtime", async () => {
    expect(
      () =>
        new Function("RubyInjected", {
          handler: "functions/ruby/app.handler",
          runtime: ruby,
          injections: ["console.log('first')"],
        }),
    ).toThrow(
      `The "RubyInjected" function has "injections", which are for a Node.js function SST builds, not one built by a runtime from sst.runtime.`,
    );
    await settle();
    expect(callsTo("Runtime.Build", "RubyInjected")).toHaveLength(0);
    expect(lambdaOf("RubyInjected")).toBeUndefined();
  });

  it("refuses a runtime that's neither a name nor from sst.runtime", async () => {
    expect(
      () =>
        new Function("Unknown", {
          handler: "functions/ruby/app.handler",
          runtime: { lambda: "ruby3.4", dev: { command: "ruby" } } as any,
        }),
    ).toThrow(
      `The "runtime" of the "Unknown" function is a runtime's name, like "nodejs24.x", or a runtime from sst.runtime.`,
    );
    await settle();
    expect(lambdaOf("Unknown")).toBeUndefined();
  });

  it("asks a runtime for its Lambda runtime and its dev command", () => {
    expect(() => runtime({ dev: { command: "ruby" } } as any)).toThrow(
      `A runtime needs "lambda", the Lambda runtime its functions are deployed with, like "ruby3.4".`,
    );
    expect(() => runtime({ lambda: "ruby3.4" } as any)).toThrow(
      'A runtime needs "dev.command", the command that runs a function in `sst dev`.',
    );
  });
});
