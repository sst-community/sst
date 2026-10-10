import { describe, beforeAll, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
global.$util = pulumi;

// The policy statements the Bucket passes to getPolicyDocument, per bucket.
let policyCalls: any[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs): {
      id: string;
      state: any;
    } {
      return {
        id: args.inputs.name + "_id",
        state: { ...args.inputs, arn: `arn:aws:s3:::${args.name}` },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity")
        return { accountId: "TESTACCOUNT" };
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: "aws" };
      if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument") {
        policyCalls.push(args.inputs);
        return { json: JSON.stringify(args.inputs) };
      }
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

async function statementsFor(access?: "public" | "cloudfront") {
  const { Bucket } = await import("./../../src/components/aws/bucket");
  policyCalls = [];
  const bucket = new Bucket("Files", access ? { access } : {});
  // The policy is built inside apply()s: wait for the bucket's outputs first.
  await new Promise((resolve) => pulumi.all([bucket.name]).apply(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return policyCalls.flatMap((c) => c.statements ?? []);
}

describe("Bucket access", () => {
  beforeAll(async () => {
    await import("./../../src/components/aws/bucket");
  });

  it("limits a cloudfront bucket to distributions in the same account", async () => {
    const statements = await statementsFor("cloudfront");
    const read = statements.find((s: any) =>
      s.actions?.includes("s3:GetObject"),
    );

    expect(read.principals).toEqual([
      { type: "Service", identifiers: ["cloudfront.amazonaws.com"] },
    ]);
    expect(read.conditions).toEqual([
      {
        test: "StringLike",
        variable: "aws:SourceArn",
        values: ["arn:aws:cloudfront::TESTACCOUNT:distribution/*"],
      },
    ]);
  });

  it("leaves a public bucket without a condition", async () => {
    const statements = await statementsFor("public");
    const read = statements.find((s: any) =>
      s.actions?.includes("s3:GetObject"),
    );

    expect(read.principals).toEqual([{ type: "*", identifiers: ["*"] }]);
    expect(read.conditions).toBeUndefined();
  });

  it("adds no read statement to a bucket with no access", async () => {
    const statements = await statementsFor();

    expect(
      statements.some((s: any) => s.actions?.includes("s3:GetObject")),
    ).toBe(false);
  });
});
