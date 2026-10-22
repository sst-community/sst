import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$jsonStringify = pulumi.jsonStringify;
// @ts-ignore
global.$cli = {
  paths: { root: "/", work: "/.sst", platform: "/" },
  state: { version: {} },
};

interface Created {
  type: string;
  name: string;
  inputs: any;
}

let created: Created[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      created.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}_id`,
        state: { ...args.inputs, arn: `arn:test:${args.name}` },
      };
    },
    call: (args) => {
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: args.provider ? "aws-cn" : "aws" };
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity")
        return { accountId: "111111111111" };
      if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument")
        return { ...args.inputs, json: JSON.stringify(args.inputs.statements) };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

async function settle() {
  let count = -1;
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = created.length === count ? quiet + 1 : 0;
    count = created.length;
  }
}

// The statements of the inline policy of the role of the state machine
async function statements(provider?: aws.Provider) {
  const { StepFunctions } = await import(
    "../../src/components/aws/step-functions"
  );
  const { Map } = await import("../../src/components/aws/step-functions/map");
  const { Pass } = await import("../../src/components/aws/step-functions/pass");

  created = [];
  new StepFunctions(
    provider ? "Cn" : "Default",
    {
      definition: new Map({
        name: "Read",
        mode: "standard",
        processor: new Pass({ name: "Process" }),
        itemReader: { type: "jsonl", bucket: "data", key: "a.jsonl" },
        resultWriter: { bucket: "out", prefix: "results" },
      }),
    },
    provider ? { provider } : undefined,
  );
  await settle();

  const role = created.find((r) => r.type === "aws:iam/role:Role");
  expect(role).toBeDefined();
  const policy: string = await new Promise((resolve) =>
    pulumi.output(role!.inputs.inlinePolicies[0].policy).apply(resolve as any),
  );
  return JSON.parse(policy) as { actions: string[]; resources: string[] }[];
}

describe("StepFunctions role with a Map", () => {
  beforeAll(async () => {
    await import("../../src/components/aws/step-functions");
  });

  it("lets the Map read and write in S3", async () => {
    const perms = await statements();
    const s3 = perms.filter((p) => p.actions.some((a) => a.startsWith("s3:")));
    expect(s3.map((p) => p.resources)).toEqual([
      ["arn:aws:s3:::data/a.jsonl"],
      ["arn:aws:s3:::out/results/*"],
    ]);
  });

  it("uses the partition of the provider of the component", async () => {
    const provider = new aws.Provider("cn", { region: "cn-north-1" });
    const perms = await statements(provider);
    const s3 = perms.filter((p) => p.actions.some((a) => a.startsWith("s3:")));
    expect(s3.map((p) => p.resources)).toEqual([
      ["arn:aws-cn:s3:::data/a.jsonl"],
      ["arn:aws-cn:s3:::out/results/*"],
    ]);
  });
});
