import { describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi({ preview: true });

describe("functionBuilder in a preview", () => {
  // A value that's only known once deployed, like the ARN of a layer that's
  // being replaced. The preview still has to create the function, or
  // `sst diff` shows it as deleted when the deploy will update it.
  it("creates a 4.x subscriber whose args aren't known yet", async () => {
    const sdk = await import("@pulumi/pulumi");
    const { Queue } = await import("../../src/components/aws/queue");
    const unknown = sdk.output(sdk.unknown) as any;
    new Queue("MyQueue").subscribe({
      handler: "src/subscriber.handler",
      environment: { LAYER: unknown },
      layers: [unknown],
    });
    await pulumi.settle();

    // The function, with its role and log group. The Lambda itself waits on
    // the zip and the log group, which a mock preview has no ids for, since
    // everything in it is new. In a diff of a deployed stage they come from
    // the state.
    const types = pulumi.resources.map((r) => r.type);
    expect(types.filter((t) => t === "sst:aws:Function")).toHaveLength(1);
    expect(types).toContain("aws:iam/role:Role");
    expect(types).toContain("aws:cloudwatch/logGroup:LogGroup");
  });

  // When everything is known, a preview builds the function from the values,
  // as a deploy does, so a transform sees the same args in both.
  it("gives a transform the values when they're known", async () => {
    const sdk = await import("@pulumi/pulumi");
    const { functionBuilder } = await import(
      "../../src/components/aws/helpers/function-builder"
    );
    let memory: unknown;
    functionBuilder(
      "Known",
      { handler: "src/index.handler", memory: sdk.output("256 MB") as any },
      {},
      (args) => {
        memory = args.memory;
      },
    );
    await pulumi.settle();
    expect(memory).toBe("256 MB");
  });
});
