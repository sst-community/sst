import { describe, expect, it } from "vitest";
import {
  inlinePolicyDocument,
  permissionOwnershipKey,
} from "../../src/components/aws/helpers/function-role-permissions";

describe("automatic function permission handover", () => {
  it("preserves policy semantics and enforces the inline rollback limit", () => {
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Action: ["s3:DeleteObject"],
          Resource: ["*"],
          Condition: { StringEquals: { "aws:PrincipalTag/team": "read only" } },
        },
      ],
    };
    expect(
      JSON.parse(inlinePolicyDocument("Fn", JSON.stringify(policy, null, 2))),
    ).toEqual(policy);
    const overhead = JSON.stringify(policy).length;
    policy.Statement[0].Resource = ["x".repeat(10240 - overhead + 1)];
    expect(inlinePolicyDocument("Fn", JSON.stringify(policy)).length).toBe(
      10240,
    );
    policy.Statement[0].Resource[0] += "x";
    expect(() => inlinePolicyDocument("Fn", JSON.stringify(policy))).toThrow(
      /Keep managed/,
    );
  });
  it("fails closed instead of retaining stale grants for an empty resolved document", () => {
    expect(() =>
      inlinePolicyDocument("Fn", '{"Version":"2012-10-17","Statement":[]}'),
    ).toThrow(/no inline grants/);
  });
  it("uses a namespaced marker rather than another component's ordinary name", () => {
    expect(permissionOwnershipKey("Reader")).toBe(
      "sst:aws:Function::Reader::permissions",
    );
    expect(permissionOwnershipKey("Reader")).not.toBe("ReaderPermissions");
  });
});
