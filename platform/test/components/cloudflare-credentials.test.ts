import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Credentials an app can give for Cloudflare and Vercel: in the config, in
// the environment, and as the CLI passes on what it resolved.
const CONFIG_TOKEN = "fake-config-token";
const ENV = {
  CLOUDFLARE_API_TOKEN: "fake-env-token",
  CLOUDFLARE_API_KEY: "fake-env-key",
  CLOUDFLARE_EMAIL: "fake-env@example.com",
  SST_CLOUDFLARE_API_TOKEN: "fake-cli-token",
  SST_CLOUDFLARE_API_KEY: "fake-cli-key",
  SST_CLOUDFLARE_EMAIL: "fake-cli@example.com",
  VERCEL_API_TOKEN: "fake-vercel-token",
};
const SECRETS = [CONFIG_TOKEN, ...Object.values(ENV)];

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
  providers: { cloudflare: { apiToken: CONFIG_TOKEN } },
};
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

describe("SST's Cloudflare and Vercel resources", () => {
  beforeAll(async () => {
    const root = "../../src/components";
    // What the provider in the `sst` binary serves, with the stage's
    // credentials from its environment
    const { WorkerUrl } = await import(
      `${root}/cloudflare/resources/worker-url`
    );
    const { WorkerPlacement } = await import(
      `${root}/cloudflare/resources/worker-placement`
    );
    const { DnsRecord } = await import(
      `${root}/cloudflare/resources/dns-record`
    );
    const { DnsRecord: VercelDnsRecord } = await import(
      `${root}/vercel/resources/dns-record`
    );
    // And the dynamic resources SST still makes, which call the CLI
    const { ZoneLookup } = await import(
      `${root}/cloudflare/providers/zone-lookup`
    );
    const { DnsRecord: DynamicDnsRecord } = await import(
      `${root}/cloudflare/providers/dns-record`
    );
    const { DnsRecord: DynamicVercelDnsRecord } = await import(
      `${root}/vercel/providers/dns-record`
    );
    const { buildApp } = await import(`${root}/base/base-ssr-site`);

    const resources: pulumi.Resource[] = [
      new WorkerUrl("Url", { accountId: "a", scriptName: "s", enabled: true }),
      new WorkerPlacement("Placement", {
        accountId: "a",
        scriptName: "s",
        mode: "smart",
      } as any),
      new DnsRecord("Caa", { zoneId: "z", type: "CAA", name: "example.com" }),
      new VercelDnsRecord("VercelCaa", {
        domain: "example.com",
        type: "CAA",
        name: "example.com",
        value: `0 issue "amazonaws.com"`,
      }),
      new ZoneLookup("Zone", { accountId: "a", domain: "example.com" }),
      new DynamicDnsRecord("DynamicCaa", {
        zoneId: "z",
        type: "CAA",
        name: "example.com",
      }),
      new DynamicVercelDnsRecord("DynamicVercelCaa", {
        domain: "example.com",
        type: "CAA",
        name: "example.com",
        value: `0 issue "amazonaws.com"`,
      }),
    ];
    const site = new pulumi.ComponentResource("test:index:Site", "Site");
    await Promise.all([
      ...resources.map((resource) => settled(resource.urn)),
      settled(buildApp(site, "Site", { buildCommand: "true" }, "site")),
    ]);
  });

  it("keep no credential in their inputs", () => {
    const own = created.filter((r) => r.name !== "SiteBuilder");
    expect(own.length).toBeGreaterThan(6);
    for (const resource of own) {
      const saved = JSON.stringify(resource.inputs);
      expect(
        SECRETS.filter((secret) => saved.includes(secret)),
        resource.name,
      ).toEqual([]);
    }
  });

  it("keep none in the code a dynamic one stores", () => {
    const dynamic = created.filter(
      (r) => r.type === "pulumi-nodejs:dynamic:Resource",
    );
    expect(dynamic.map((r) => r.name).sort()).toEqual(
      [
        "DynamicCaa.sst.cloudflare.DnsRecord",
        "DynamicVercelCaa.sst.vercel.DnsRecord",
        "Zone.sst.cloudflare.ZoneLookup",
      ].sort(),
    );
    for (const resource of dynamic) {
      const code = resource.inputs.__provider;
      expect(typeof code, resource.name).toBe("string");
      // In a deploy, `$app` is a value in the program, which the code would
      // capture with the config
      expect(code, resource.name).not.toMatch(/\$app\b/);
    }
  });

  it("don't pass the CLI's credentials on to a site's build", () => {
    const builder = created.find((r) => r.name === "SiteBuilder");
    expect(builder?.type).toBe("command:local:Command");
    const environment = pulumi.runtime.unwrapRpcSecret(
      builder!.inputs.environment,
    );
    expect(environment.SST).toBe("1");
    expect(
      Object.keys(environment).filter((key) =>
        key.startsWith("SST_CLOUDFLARE_"),
      ),
    ).toEqual([]);
  });
});
