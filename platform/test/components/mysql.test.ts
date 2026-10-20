import { describe, beforeAll, beforeEach, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = { name: "app", stage: "test" };
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$cli = { state: { version: {} } };
global.$util = pulumi;

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: args.name + "_id",
        state: { ...args.inputs, address: "db.example.com", port: 3306 },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

async function settle() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const vpc = { subnets: ["subnet-a", "subnet-b"] };

function ofType(type: string) {
  return createdResources.filter((r) => r.type === type);
}

describe("Mysql version", function () {
  let Mysql: typeof import("../../src/components/aws/mysql").Mysql;

  beforeAll(async function () {
    Mysql = (await import("../../src/components/aws/mysql")).Mysql;
  });

  beforeEach(function () {
    createdResources = [];
  });

  // RDS stopped offering 8.0.40, the default this replaced. With only the major
  // version, RDS uses its current minor version, so the default can't go stale.
  it("defaults to MySQL 8.0", async () => {
    new Mysql("Default", { vpc });
    await settle();
    const [instance] = ofType("aws:rds/instance:Instance");
    expect(instance.inputs.engineVersion).toBe("8.0");
    const [group] = ofType("aws:rds/parameterGroup:ParameterGroup");
    expect(group.inputs.family).toBe("mysql8.0");
  });

  it("uses the version it's given", async () => {
    new Mysql("Pinned", { vpc, version: "8.4.3" });
    await settle();
    const [instance] = ofType("aws:rds/instance:Instance");
    expect(instance.inputs.engineVersion).toBe("8.4.3");
    const [group] = ofType("aws:rds/parameterGroup:ParameterGroup");
    expect(group.inputs.family).toBe("mysql8.4");
  });
});
