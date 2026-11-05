// The V5 Function's and Task's stubs in `sst dev` with `dev.appsync` set to
// "stage": the CLI answers with the stage's own Event API's settings
// (pkg/transport works them out), and each stub's role reaches only it, as the
// 4.x components' do. The shared one, which the mock answers with, is in their
// takeover tests. The settings are asked for once, so this has a file of its
// own.
import { beforeAll, describe, expect, it } from "vitest";
import { rpc } from "../../../src/components/rpc/rpc";
import { mockPulumi } from "../../helpers/graph";

const ARN = "arn:aws:appsync:us-east-1:123456789012:apis/app-test";

const pulumi = mockPulumi();
const call = rpc.call;
rpc.call = (async (method: string, args: any) =>
  method === "Dev.Stub"
    ? {
        environment: {
          SST_APPSYNC_HTTP: "app-test.example.com",
          SST_APPSYNC_REALTIME: "app-test-realtime.example.com",
        },
        permissions: [{ actions: ["appsync:*"], resources: [ARN, `${ARN}/*`] }],
      }
    : call(method, args)) as typeof rpc.call;

describe("sst dev with the stage's own Event API", () => {
  beforeAll(async () => {
    // @ts-ignore
    global.$dev = true;
    const { Function } = await import("../../../src/components/aws/function");
    const { Task } = await import("../../../src/components/aws/task");
    const { Cluster } = await import("../../../src/components/aws/cluster");
    new Function("MyFunction", { handler: "src/index.handler" });
    new Task("MyTask", {
      cluster: new Cluster("MyCluster", {
        vpc: {
          id: "vpc-1",
          securityGroups: ["sg-1"],
          containerSubnets: ["subnet-private-1", "subnet-private-2"],
          loadBalancerSubnets: ["subnet-public-1", "subnet-public-2"],
          publicSubnets: ["subnet-public-1", "subnet-public-2"],
        },
      }),
      image: "nginx:latest",
      dev: { command: "node task.js" },
    });
    await pulumi.settle();
  });

  // What each AppSync statement of a role's policy reaches
  const appsync = (role: string) =>
    JSON.parse(
      pulumi.resources.find((r) => r.name === role)!.inputs.inlinePolicies[0]
        .policy,
    )
      .statements.filter((s: any) => s.actions.includes("appsync:*"))
      .map((s: any) => s.resources);

  it("lets a function's stub reach only the stage's Event API", () => {
    expect(appsync("MyFunctionRole")).toEqual([[ARN, `${ARN}/*`]]);
  });

  it("lets a task's stub reach only the stage's Event API", () => {
    expect(appsync("MyTaskTaskRole")).toEqual([[ARN, `${ARN}/*`]]);
  });
});
