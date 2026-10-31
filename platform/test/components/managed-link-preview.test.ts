import { expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { Provider } from "@pulumi/aws";
import { createManagedLinkPermissions } from "../../src/components/aws/helpers/managed-link-permissions";

const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push(args);
      return { id: args.name, state: args.inputs };
    },
    call: (args) => args.inputs,
  },
  "project",
  "stack",
  true,
);

it("registers stable named policies when all linked grants are unknown during preview", async () => {
  const provider = new Provider("Aws", { region: "us-east-1" });
  const parent = new pulumi.ComponentResource(
    "test:component:Parent",
    "Fn",
    {},
    { provider },
  );
  const unknown = pulumi.output(pulumi.unknown as any);
  const result = createManagedLinkPermissions(
    "Fn",
    unknown,
    { managed: { Storage: unknown, Jobs: unknown } },
    { parent },
  );
  await Promise.all(
    result.policies.map((p) => new Promise((resolve) => p.urn.apply(resolve))),
  );
  expect(
    resources
      .filter((r) => r.type === "aws:iam/policy:Policy")
      .map((r) => r.name)
      .sort(),
  ).toEqual(["FnLinkJobsPolicy", "FnLinkStoragePolicy"]);
  expect(
    result.policies.every(
      (p) => p.getProvider("aws:iam/policy:Policy") === provider,
    ),
  ).toBe(true);
});

it("keeps policies visible for known linked resources whose permission ARNs are unknown", async () => {
  const parent = new pulumi.ComponentResource(
    "test:component:Parent",
    "Partial",
    {},
  );
  const unknown = pulumi.output(pulumi.unknown as any);
  class Linked extends pulumi.ComponentResource {
    getSSTLink() {
      return {
        properties: { name: "known" },
        include: [
          {
            type: "aws.permission",
            actions: ["s3:GetObject"],
            resources: [unknown],
          },
        ],
      };
    }
  }
  const linked = new Linked("test:component:Linked", "UnknownArn", {});
  const result = createManagedLinkPermissions(
    "Partial",
    [linked],
    { managed: { Storage: [linked] } },
    { parent },
  );
  await new Promise((resolve) => result.policies[0].urn.apply(resolve));
  expect(
    resources.filter(
      (r) =>
        r.type === "aws:iam/policy:Policy" &&
        r.name === "PartialLinkStoragePolicy",
    ),
  ).toHaveLength(1);
});

it("rejects an empty managed map instead of retaining an unmanaged inline policy", () => {
  const parent = new pulumi.ComponentResource("test:component:Parent", "Empty");
  expect(() =>
    createManagedLinkPermissions("Empty", [], { managed: {} }, { parent }),
  ).toThrow("at least one");
});
