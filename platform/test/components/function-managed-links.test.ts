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
fs.writeFileSync(
  path.join(out, "index.mjs"),
  "export const handler = async () => 1;\n",
);

vi.mock("../../src/components/aws/helpers/bootstrap", () => ({
  bootstrap: {
    forRegion: async () => ({ asset: "sst-asset-test" }),
  },
}));

vi.mock("../../src/components/rpc/rpc", () => ({
  rpc: {
    call: async (method: string, input: any) => {
      if (method === "Runtime.Build" || method === "Runtime.AddTarget")
        builds.set(input.functionID, input);
      if (method === "Runtime.Build")
        return { handler: "index.handler", out, errors: [], sourcemaps: [] };
      if (method === "Provider.Aws.Appsync")
        return {
          http: "http://appsync",
          realtime: "ws://appsync",
          arn: "arn:aws:appsync:us-east-1:111111111111:apis/dev",
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

interface Registered {
  type: string;
  name: string;
  id?: string;
  inputs: any;
}

let registered: Registered[] = [];
const builds = vi.hoisted(() => new Map<string, any>());

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
        return {
          ...args.inputs,
          json: JSON.stringify({
            Version: "2012-10-17",
            Statement: (args.inputs.statements ?? []).map((s: any) => ({
              Effect: s.effect ?? "Allow",
              Action: s.actions,
              Resource: s.resources,
              ...(s.conditions
                ? {
                    Condition: Object.fromEntries(
                      s.conditions.map((c: any) => [
                        c.test,
                        { [c.variable]: c.values },
                      ]),
                    ),
                  }
                : {}),
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

const dependencies = new Map<string, string[]>();
const monitor = pulumi.runtime.getMonitor() as any;
const registerResource = monitor.registerResource.bind(monitor);
monitor.registerResource = (request: any, callback: any) => {
  dependencies.set(request.getName(), request.getDependenciesList());
  return registerResource(request, callback);
};
const roleFor = (name: string) =>
  registered.find(
    (r) => r.type === "aws:iam/role:Role" && r.name === `${name}Role`,
  )!.inputs;
const inlineFor = (name: string) =>
  JSON.parse(roleFor(name).inlinePolicies[0].policy).Statement;
// Resources the earlier design used to take the role's policies away from it.
const ownershipTypes = [
  "aws:iam/rolePolicy:RolePolicy",
  "aws:iam/rolePoliciesExclusive:RolePoliciesExclusive",
  "aws:iam/rolePolicyAttachmentsExclusive:RolePolicyAttachmentsExclusive",
  "aws:iam/rolePolicyAttachment:RolePolicyAttachment",
  "sst:sst:Version",
];
const ownershipFor = (name: string) =>
  registered.filter(
    (r) => ownershipTypes.includes(r.type) && r.name.startsWith(name),
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
  registered.filter(
    (r) => r.type === "aws:iam/role:Role" && r.name === `${name}Role`,
  );

let Function: typeof import("../../src/components/aws/function").Function;
let Linkable: typeof import("../../src/components/linkable").Linkable;
beforeAll(async () => {
  Function = (await import("../../src/components/aws/function")).Function;
  Linkable = (await import("../../src/components/linkable")).Linkable;
});
const policiesFor = (prefix: string) =>
  registered.filter(
    (r) => r.type === "aws:iam/policy:Policy" && r.name.startsWith(prefix),
  );
function linked(
  name: string,
  resources: string[] = ["arn:aws:s3:::example/*"],
) {
  return new Linkable(name, {
    properties: { bucket: "example" },
    include: [{ type: "aws.permission", actions: ["s3:GetObject"], resources }],
  });
}
const args = { handler: "index.handler", bundle: out };

describe("Function managed link permissions", () => {
  it("attaches selected grants through the role and keeps the rest inline", async () => {
    const storage = linked("Storage");
    const other = linked("Other", ["arn:aws:s3:::other/*"]);
    new Function("Managed", {
      ...args,
      link: [storage, other],
      linkPermissions: { managed: { Storage: [storage] } },
      permissions: [
        {
          actions: ["sqs:SendMessage"],
          resources: ["arn:aws:sqs:us-east-1:111111111111:queue"],
        },
      ],
      policies: ["arn:aws:iam::111111111111:policy/existing"],
    } as any);
    await settle();
    const managed = policiesFor("Managed");
    expect(managed.map((p) => p.name)).toEqual(["ManagedLinkStoragePolicy"]);
    expect(JSON.parse(managed[0].inputs.policy).Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: ["arn:aws:s3:::example/*"],
      },
    ]);
    expect(inlineFor("Managed")).toEqual([
      {
        Effect: "Allow",
        Action: ["sqs:SendMessage"],
        Resource: ["arn:aws:sqs:us-east-1:111111111111:queue"],
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: ["arn:aws:s3:::other/*"],
      },
    ]);
    expect(roleFor("Managed").managedPolicyArns).toEqual(
      expect.arrayContaining([
        "arn:aws:test:::ManagedLinkStoragePolicy",
        "arn:aws:iam::111111111111:policy/existing",
      ]),
    );
    expect(ownershipFor("Managed")).toEqual([]);
    expect(builds.get("Managed").links).toMatchObject({
      Storage: { bucket: "example" },
      Other: { bucket: "example" },
    });
  });

  // PR #218 review: `sst remove` failed with DeleteConflict because nothing ordered
  // the role before the policies. Pulumi deletes dependents first, so the role,
  // which detaches its managed policies on delete, must depend on every policy.
  it("deletes the role before its managed policies", async () => {
    const files = linked("RemoveFiles");
    const jobs = linked("RemoveJobs", [
      "arn:aws:sqs:us-east-1:111111111111:jobs",
    ]);
    new Function("Remove", {
      ...args,
      link: [files, jobs],
      linkPermissions: { managed: { Storage: [files], Jobs: [jobs] } },
    });
    await settle();
    const role = dependencies.get("RemoveRole")!;
    expect(role).toContainEqual(
      expect.stringContaining("::RemoveLinkStoragePolicy"),
    );
    expect(role).toContainEqual(
      expect.stringContaining("::RemoveLinkJobsPolicy"),
    );
    // No other resource holds an attachment that could outlive the role.
    expect(ownershipFor("Remove")).toEqual([]);
  });

  it("keeps grants inline by default", async () => {
    const storage = linked("DefaultStorage");
    new Function("Default", { ...args, link: [storage] });
    await settle();
    expect(policiesFor("Default")).toHaveLength(0);
    expect(ownershipFor("Default")).toEqual([]);
    expect(inlineFor("Default")[0].Resource).toEqual([
      "arn:aws:s3:::example/*",
    ]);
    expect(roleFor("Default").managedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ]);
  });

  it("returns to the default resources when the option is removed, even with an old ownership record", async () => {
    // A stage deployed by the earlier design of this option recorded this key.
    $cli.state.version["sst:aws:Function::Restored::permissions"] = 2;
    const storage = linked("RestoredStorage");
    new Function("Restored", { ...args, link: [storage] });
    await settle();
    expect(policiesFor("Restored")).toHaveLength(0);
    expect(ownershipFor("Restored")).toEqual([]);
    expect(inlineFor("Restored")[0].Resource).toEqual([
      "arn:aws:s3:::example/*",
    ]);
    expect(roleFor("Restored").managedPolicyArns).toHaveLength(1);
  });

  it("keeps inline grants alongside the managed policies with retainInline", async () => {
    const storage = linked("MigrationStorage");
    new Function("Migration", {
      ...args,
      link: [storage],
      linkPermissions: { managed: { Storage: [storage] }, retainInline: true },
    } as any);
    await settle();
    expect(policiesFor("Migration")).toHaveLength(1);
    expect(inlineFor("Migration")[0].Resource).toEqual([
      "arn:aws:s3:::example/*",
    ]);
    expect(roleFor("Migration").managedPolicyArns).toContain(
      "arn:aws:test:::MigrationLinkStoragePolicy",
    );
  });

  it("handles more than 10,240 characters through separately bounded named groups", async () => {
    const groups = Array.from({ length: 3 }, (_, g) =>
      linked(
        `Large${g}`,
        Array.from(
          { length: 70 },
          (_, i) =>
            `arn:aws:s3:::bucket-${g}-${String(i).padStart(
              3,
              "0",
            )}-${"x".repeat(30)}/*`,
        ),
      ),
    );
    new Function("Large", {
      ...args,
      link: groups,
      linkPermissions: {
        managed: { One: [groups[0]], Two: [groups[1]], Three: [groups[2]] },
      },
    } as any);
    await settle();
    const documents = policiesFor("Large").map((p) => p.inputs.policy);
    expect(documents).toHaveLength(3);
    expect(documents.reduce((n, p) => n + p.length, 0)).toBeGreaterThan(10240);
    expect(documents.every((p) => p.length <= 6144)).toBe(true);
    // With nothing else inline, the role keeps a copy of one grouped grant inline,
    // from the first group by name ("One"), so its old inline policy is replaced.
    expect(inlineFor("Large")).toEqual(
      JSON.parse(policiesFor("LargeLinkOne")[0].inputs.policy).Statement.slice(
        0,
        1,
      ),
    );
    expect(roleFor("Large").managedPolicyArns).toHaveLength(4);
  });

  it("preserves deny effects and conditions", async () => {
    const deny = new Linkable("Conditional", {
      properties: { name: "example" },
      include: [
        {
          type: "aws.permission",
          effect: "deny",
          actions: ["s3:DeleteObject"],
          resources: ["arn:aws:s3:::example/*"],
          conditions: [
            {
              test: "StringEquals",
              variable: "aws:PrincipalTag/team",
              values: ["read only"],
            },
          ],
        },
      ],
    });
    new Function("Denied", {
      ...args,
      link: [deny],
      linkPermissions: { managed: { Restricted: [deny] } },
    } as any);
    await settle();
    expect(
      JSON.parse(policiesFor("Denied")[0].inputs.policy).Statement[0],
    ).toEqual({
      Effect: "Deny",
      Action: ["s3:DeleteObject"],
      Resource: ["arn:aws:s3:::example/*"],
      Condition: { StringEquals: { "aws:PrincipalTag/team": ["read only"] } },
    });
    expect(inlineFor("Denied")).toEqual(
      JSON.parse(policiesFor("Denied")[0].inputs.policy).Statement,
    );
  });

  // PR #218 review: with every grant in groups and no inline policy set, the inline
  // policy from before opting in stayed on the role, so unlinking a resource didn't
  // remove the function's access to it. The role must always pass an inline policy.
  it("replaces the inline policy when every grant is in a group", async () => {
    const uploads = linked("AllUploads", ["arn:aws:s3:::uploads/*"]);
    const reports = linked("AllReports", ["arn:aws:s3:::reports/*"]);
    const jobs = linked("AllJobs", ["arn:aws:sqs:us-east-1:111111111111:jobs"]);
    new Function("AllGrouped", {
      ...args,
      link: [uploads, reports, jobs],
      linkPermissions: {
        managed: { Storage: [uploads, reports], Jobs: [jobs] },
      },
    });
    // The same function after `reports` is unlinked.
    new Function("Unlinked", {
      ...args,
      link: [uploads, jobs],
      linkPermissions: { managed: { Storage: [uploads], Jobs: [jobs] } },
    });
    await settle();
    for (const name of ["AllGrouped", "Unlinked"]) {
      expect(roleFor(name).inlinePolicies).toHaveLength(1);
      expect(roleFor(name).inlinePolicies[0].name).toBe("inline");
      // A copy of the first grant of the first group by name, "Jobs".
      expect(inlineFor(name)).toEqual([
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: ["arn:aws:sqs:us-east-1:111111111111:jobs"],
        },
      ]);
    }
    expect(JSON.stringify(roleFor("Unlinked").inlinePolicies)).not.toContain(
      "reports",
    );
  });

  it("adds no copy when other grants are inline", async () => {
    const storage = linked("CopyStorage");
    new Function("NoCopy", {
      ...args,
      link: [storage],
      linkPermissions: { managed: { Storage: [storage] } },
      permissions: [
        {
          actions: ["sqs:SendMessage"],
          resources: ["arn:aws:sqs:us-east-1:111111111111:queue"],
        },
      ],
    });
    await settle();
    expect(inlineFor("NoCopy")).toEqual([
      {
        Effect: "Allow",
        Action: ["sqs:SendMessage"],
        Resource: ["arn:aws:sqs:us-east-1:111111111111:queue"],
      },
    ]);
  });

  it("names the managed policies like the role", async () => {
    const storage = linked("NamedStorage");
    new Function("Named", {
      ...args,
      link: [storage],
      linkPermissions: { managed: { Storage: [storage] } },
    });
    await settle();
    const [policy] = policiesFor("Named");
    expect(policy.inputs.name).toMatch(
      /^app-test-NamedLinkStoragePolicy-\w{8}$/,
    );
  });

  it("keeps live-dev bridge grants inline and exposes the same runtime bindings", async () => {
    Object.assign(global, { $dev: true, $jsonStringify: JSON.stringify });
    const storage = linked("DevStorage");
    try {
      new Function("DevManaged", {
        ...args,
        link: [storage],
        linkPermissions: { managed: { Storage: [storage] } },
      });
      await settle();
      expect(policiesFor("DevManaged")).toHaveLength(1);
      const inline = inlineFor("DevManaged");
      expect(inline.map((s: any) => s.Action)).toEqual([
        ["appsync:*"],
        ["s3:*"],
      ]);
      expect(inline[0].Resource).toEqual([
        "arn:aws:appsync:us-east-1:111111111111:apis/dev",
        "arn:aws:appsync:us-east-1:111111111111:apis/dev/*",
      ]);
      expect(builds.get("DevManaged").links.DevStorage.bucket).toBe("example");
    } finally {
      Object.assign(global, { $dev: false });
    }
  });

  it("rejects managed grants for externally supplied roles", () => {
    expect(
      () =>
        new Function("External", {
          ...args,
          role: "arn:aws:iam::111111111111:role/external",
          linkPermissions: {
            managed: { Storage: [linked("ExternalStorage")] },
          },
        } as any),
    ).toThrow(/role/);
  });

  it("applies role transforms instead of refusing them", async () => {
    const storage = linked("TransformedStorage");
    new Function("Transformed", {
      ...args,
      link: [storage],
      linkPermissions: { managed: { Storage: [storage] } },
      transform: { role: { description: "custom" } },
    });
    await settle();
    expect(roleFor("Transformed").description).toBe("custom");
    expect(roleFor("Transformed").managedPolicyArns).toContain(
      "arn:aws:test:::TransformedLinkStoragePolicy",
    );
  });
});
