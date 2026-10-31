import { describe, expect, it } from "vitest";
import {
  selectManagedLinks,
  managedPolicyDocument,
  managedPolicyAttachments,
} from "../../src/components/aws/helpers/managed-link-permissions";

const link = (
  include: any[] = [
    {
      type: "aws.permission",
      actions: ["s3:GetObject"],
      resources: ["arn:aws:s3:::example/*"],
    },
  ],
) => ({ getSSTLink: () => ({ properties: {}, include }) });
describe("managed link policy boundaries", () => {
  it("rejects unlinked resources and duplicate membership", () => {
    const a = link();
    const b = link();
    expect(() => selectManagedLinks([a], { Storage: [b] })).toThrow(/link/);
    expect(() => selectManagedLinks([a], { One: [a], Two: [a] })).toThrow(
      /more than once/,
    );
  });
  it("rejects groups with no AWS permissions", () => {
    const a = link([]);
    expect(() => selectManagedLinks([a], { Empty: [a] })).toThrow(
      /no AWS permissions/,
    );
  });
  it("does not remove unselected grants", () => {
    const a = link();
    const b = link();
    expect(selectManagedLinks([a, b], { Storage: [a] }).remaining).toEqual([b]);
  });
  it("enforces the entire managed document size without deleting whitespace in conditions", () => {
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: ["*"],
          Condition: { StringEquals: { "aws:PrincipalTag/team": "read only" } },
        },
      ],
    };
    const compact = managedPolicyDocument(
      "Storage",
      JSON.stringify(policy, null, 2),
    );
    expect(JSON.parse(compact)).toEqual(policy);
    const overhead = JSON.stringify(policy).length;
    policy.Statement[0].Resource = ["x".repeat(6144 - overhead + 1)];
    expect(
      managedPolicyDocument("Storage", JSON.stringify(policy)).length,
    ).toBe(6144);
    policy.Statement[0].Resource[0] += "x";
    expect(() =>
      managedPolicyDocument("Storage", JSON.stringify(policy)),
    ).toThrow(/split/i);
  });
  it("counts existing and generated attachments together", () => {
    const arns = Array.from(
      { length: 25 },
      (_, i) => `arn:aws:iam::111111111111:policy/${i}`,
    );
    expect(managedPolicyAttachments("Fn", [...arns, arns[0]])).toHaveLength(25);
    expect(() =>
      managedPolicyAttachments("Fn", [
        ...arns,
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ]),
    ).toThrow(/25/);
  });
  it("matches cloned structural links by URN and only uses grants from the linked definition", () => {
    const original = {
      ...link(),
      urn: "urn:pulumi:test::app::test:Link::Storage",
    };
    const clone = {
      ...original,
      getSSTLink: () => ({
        properties: {},
        include: [{ type: "aws.permission", actions: ["*"], resources: ["*"] }],
      }),
    };
    const selected = selectManagedLinks([original], { Storage: [clone] });
    expect(selected.remaining).toEqual([]);
    expect(selected.permissions.Storage[0].actions).toEqual(["s3:GetObject"]);
    expect(() =>
      selectManagedLinks([original], { One: [original], Two: [clone] }),
    ).toThrow(/more than once/);
  });
});
