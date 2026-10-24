// What the dev-appsync tests share: they build a function and a task in
// sst dev, with Provider.Aws.Appsync mocked by each test file, and read the
// AppSync statements of their roles' inline policies.
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

export const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-appsync-"));
export const out = path.join(root, "out");
fs.mkdirSync(out);
fs.writeFileSync(
  path.join(out, "index.mjs"),
  "export const handler = async () => 1;\n",
);

export const bootstrapMock = {
  bootstrap: {
    forRegion: async () => ({
      asset: "sst-asset-test",
      assetEcrRegistryId: "111111111111",
      assetEcrUrl: "111111111111.dkr.ecr.us-east-1.amazonaws.com/sst-asset",
    }),
  },
};

export function rpcMock(appsync: object) {
  return {
    rpc: {
      call: async (method: string) => {
        if (method === "Runtime.Build")
          return { handler: "index.handler", out, errors: [], sourcemaps: [] };
        if (method === "Provider.Aws.Appsync") return appsync;
        return {};
      },
    },
  };
}

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;
// @ts-ignore
global.$dev = true;
// @ts-ignore
global.$cli = {
  paths: { root, work: path.join(root, ".sst"), platform: root },
  state: { version: {} },
};
// @ts-ignore
global.$jsonStringify = JSON.stringify;
process.env.SST_AWS_REGION = "us-east-1";

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

const createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      const name = args.inputs.name || args.name;
      return {
        id: `${name}_id`,
        state: {
          ...args.inputs,
          arn: `arn:aws:test:::${name}`,
          name,
          tags: {
            "sst:ref:version": "1",
            "sst:ref:sg": "sg-mock-id",
            "sst:ref:vpc-id": "vpc-123",
          },
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
        return {
          ...args.inputs,
          json: JSON.stringify({
            Statement: (args.inputs.statements ?? []).map((s: any) => ({
              Effect: s.effect,
              Action: s.actions,
              Resource: s.resources,
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

// Waits until no resource has been registered for 250 ms.
async function settle() {
  let count = -1;
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = createdResources.length === count ? quiet + 1 : 0;
    count = createdResources.length;
  }
}

// The resources of the AppSync statements in a role's inline policy
export async function appsyncResourcesOf(role: string): Promise<string[][]> {
  await settle();
  const created = createdResources.find(
    (r) => r.type === "aws:iam/role:Role" && r.name === role,
  );
  if (!created) throw new Error(`no role ${role}`);
  const policies: any[] = await new Promise((resolve) =>
    pulumi.output(created.inputs.inlinePolicies).apply(resolve as any),
  );
  return policies.flatMap((p) =>
    JSON.parse(p.policy)
      .Statement.filter((s: any) =>
        [s.Action].flat().some((a: string) => a.startsWith("appsync:")),
      )
      .map((s: any) => [s.Resource].flat()),
  );
}

export async function build() {
  const { Function } = await import("../../src/components/aws/function");
  const { Cluster } = await import("../../src/components/aws/cluster");
  const { Task } = await import("../../src/components/aws/task");
  new Function("DevFn", { handler: "index.handler", bundle: out });
  const cluster = new Cluster("DevCluster", {
    vpc: {
      id: "vpc-123",
      securityGroups: ["sg-123"],
      containerSubnets: ["subnet-a"],
      loadBalancerSubnets: ["subnet-a"],
    },
  });
  new Task("DevTask", { cluster, image: "nginx:latest" });
}
