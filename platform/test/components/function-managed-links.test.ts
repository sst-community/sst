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
  it("moves selected grants out of inline policies while preserving bindings and explicit grants", async () => {
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
    expect(managed).toHaveLength(1);
    expect(JSON.parse(managed[0].inputs.policy).Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: ["arn:aws:s3:::example/*"],
      },
    ]);
    const role = roles("Managed")[0].inputs;
    expect(JSON.parse(role.inlinePolicies[0].policy).Statement).toEqual([
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
    expect(role.managedPolicyArns).toContain(
      "arn:aws:iam::111111111111:policy/existing",
    );
    expect(role.managedPolicyArns).toContain(
      `arn:aws:test:::${managed[0].name}`,
    );
    expect(builds.get("Managed").links).toMatchObject({
      Storage: { bucket: "example" },
      Other: { bucket: "example" },
    });
  });

  it("keeps grants inline by default", async () => {
    const storage = linked("DefaultStorage");
    new Function("Default", { ...args, link: [storage] });
    await settle();
    expect(policiesFor("Default")).toHaveLength(0);
    expect(
      JSON.parse(roles("Default")[0].inputs.inlinePolicies[0].policy)
        .Statement[0].Resource,
    ).toEqual(["arn:aws:s3:::example/*"]);
  });

  it("retains inline grants during staged migration", async () => {
    const storage = linked("MigrationStorage");
    new Function("Migration", {
      ...args,
      link: [storage],
      linkPermissions: { managed: { Storage: [storage] }, retainInline: true },
    } as any);
    await settle();
    expect(policiesFor("Migration")).toHaveLength(1);
    expect(
      JSON.parse(roles("Migration")[0].inputs.inlinePolicies[0].policy)
        .Statement[0].Resource,
    ).toEqual(["arn:aws:s3:::example/*"]);
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
    // Keep one exact, bounded statement instead of the provider's unsafe empty sentinel.
    const inline = roles("Large")[0].inputs.inlinePolicies[0];
    expect(inline.name).toBe("inline");
    expect(
      JSON.stringify(JSON.parse(inline.policy)).length,
    ).toBeLessThanOrEqual(6144);
    expect(JSON.parse(inline.policy).Statement).toEqual([
      JSON.parse(documents[0]).Statement[0],
    ]);
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
    expect(
      JSON.parse(roles("Denied")[0].inputs.inlinePolicies[0].policy).Statement,
    ).toEqual(JSON.parse(policiesFor("Denied")[0].inputs.policy).Statement);
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
      const inline = JSON.parse(
        roles("DevManaged")[0].inputs.inlinePolicies[0].policy,
      ).Statement;
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
});
