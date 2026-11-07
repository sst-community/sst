import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// What the CLI passes on to the program for SST's own AWS calls
const ENV = {
  SST_AWS_ACCESS_KEY_ID: "fake-access-key",
  SST_AWS_SECRET_ACCESS_KEY: "fake-secret-key",
  SST_AWS_SESSION_TOKEN: "fake-session-token",
};

// @ts-ignore
global.$app = { name: "app", stage: "test", providers: {} };
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$cli = { command: "deploy", paths: { root: process.cwd() } };
Object.assign(process.env, ENV);

const created: { name: string; type: string; inputs: any }[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      created.push({ name: args.name, type: args.type, inputs: args.inputs });
      return { id: args.name + "_id", state: {} };
    },
    call: () => ({}),
  },
  "app",
  "test",
  false,
);

const settled = (value: pulumi.Output<unknown>) =>
  new Promise((resolve) => value.apply(resolve));

describe("SSR site builder", () => {
  beforeAll(async () => {
    const { buildApp } = await import(
      "../../src/components/base/base-ssr-site"
    );
    const site = new pulumi.ComponentResource("test:index:Site", "Site");
    await settled(buildApp(site, "Site", { buildCommand: "true" }, "site"));
  });

  it("keeps its environment as a secret", () => {
    const builder = created.find((r) => r.name === "SiteBuilder");
    expect(builder?.type).toBe("command:local:Command");
    const environment = builder!.inputs.environment;
    expect(pulumi.runtime.isRpcSecret(environment)).toBe(true);
    // The build still gets the same variables
    const values = pulumi.runtime.unwrapRpcSecret(environment);
    expect(values.SST).toBe("1");
    expect(values.SST_AWS_SECRET_ACCESS_KEY).toBe(
      ENV.SST_AWS_SECRET_ACCESS_KEY,
    );
  });
});
