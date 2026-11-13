import path from "path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as pulumiSdk from "@pulumi/pulumi";
import { Provider as CloudflareProvider } from "@pulumi/cloudflare";
import { Provider as VercelProvider } from "@pulumiverse/vercel";
import { mockPulumi } from "../../../../src/testing/mock";
import { rejectionsOf } from "../../../helpers/rejections";

// SST's Cloudflare and Vercel components in a program Pulumi runs on its own,
// which has no CLI to pick the account or give SST's provider credentials:
// they come from the program's own setup.

// The `sst` package, which such a program has SST's components from. This
// repo's tests have none.
vi.mock("../../../../src/components/sst-package", () => ({
  sstPackage: () => ({
    dir: path.resolve(__dirname, "../../../../.."),
    name: "sst",
    version: "5.0.0-test",
  }),
}));

let accounts: (provider: string) => { id: string }[] = () => [
  { id: "first-account" },
  { id: "second-account" },
];

const pulumi = mockPulumi({
  plain: true,
  call: (args) => {
    if (args.token === "cloudflare:index/getAccounts:getAccounts")
      return { results: accounts(String(args.provider ?? "")) };
    if (args.token === "cloudflare:index/getWorkersScripts:getWorkersScripts")
      return {
        results: [
          { id: "app-test-oldworkerscript", migrationTag: "v1" },
          { id: "unrelated", migrationTag: "v9" },
        ],
      };
    return undefined;
  },
});

// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

type Cloudflare = typeof import("../../../../src/components/cloudflare");

describe("Cloudflare's setup, in a Pulumi program", () => {
  let Kv: Cloudflare["Kv"];
  let Worker: Cloudflare["Worker"];
  let dns: Cloudflare["dns"];
  let vercelDns: typeof import("../../../../src/components/vercel").dns;
  let Router: typeof import("../../../../src/components/aws/router").Router;
  let Assets: typeof import("../../../../src/components/aws/assets").Assets;
  const config = pulumiSdk.runtime.allConfig();

  beforeAll(async () => {
    ({ Kv, Worker, dns } = await import(
      "../../../../src/components/cloudflare"
    ));
    ({ dns: vercelDns } = await import("../../../../src/components/vercel"));
    ({ Router } = await import("../../../../src/components/aws/router"));
    ({ Assets } = await import("../../../../src/components/aws/assets"));
  });

  beforeEach(() => pulumi.reset());

  afterEach(() => {
    pulumiSdk.runtime.setAllConfig(config, []);
    delete process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID;
    delete process.env.VERCEL_TEAM_ID;
    accounts = () => [{ id: "first-account" }, { id: "second-account" }];
  });

  const resource = (name: string) => {
    const found = pulumi.resources.find((r) => r.name === name);
    if (!found) throw new Error(`No ${name} was created`);
    return found;
  };
  const sstProviders = () =>
    pulumi.resources.filter((r) => r.type === "pulumi:providers:sst");
  // A secret input, as the mock has it
  const revealed = (value: any) =>
    value && typeof value === "object" && "value" in value
      ? value.value
      : value;

  describe("the account", () => {
    it("is the first one Cloudflare's provider lists, as SST's CLI picks it", async () => {
      new Kv("MyKv");
      await pulumi.settle();
      expect(resource("MyKvNamespace").inputs.accountId).toBe("first-account");
    });

    it("is CLOUDFLARE_DEFAULT_ACCOUNT_ID when it's set", async () => {
      process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID = "set-account";
      new Kv("MyKv");
      await pulumi.settle();
      expect(resource("MyKvNamespace").inputs.accountId).toBe("set-account");
    });

    it("is the component's own when it's given one", async () => {
      new Kv("MyKv", { accountId: "given-account" });
      await pulumi.settle();
      expect(resource("MyKvNamespace").inputs.accountId).toBe("given-account");
    });

    it("is listed with the component's Cloudflare provider", async () => {
      accounts = (provider) =>
        provider.includes("::Other::")
          ? [{ id: "other-account" }]
          : [{ id: "first-account" }];
      const other = new CloudflareProvider("Other", { apiToken: "t" });
      new Kv("MyKv");
      new Kv("OtherKv", {}, { providers: [other] });
      await pulumi.settle();
      expect(resource("MyKvNamespace").inputs.accountId).toBe("first-account");
      expect(resource("OtherKvNamespace").inputs.accountId).toBe(
        "other-account",
      );
    });

    it("is an error when Cloudflare's provider lists none", async () => {
      accounts = () => [];
      const failures = await rejectionsOf(async () => {
        new Kv("MyKv");
        await pulumi.settle();
      });
      expect((failures[0] as Error).message).toMatch(
        /it lists none\. Set CLOUDFLARE_DEFAULT_ACCOUNT_ID, or give the component its "accountId"/,
      );
    });
  });

  describe("SST's provider", () => {
    it("has the stack's Cloudflare token, as a secret", async () => {
      pulumiSdk.runtime.setConfig("cloudflare:apiToken", "stack-token");
      new Worker("Api", { handler, url: true });
      await pulumi.settle();

      const [provider] = sstProviders();
      expect(provider.name).toBe("sst-cloudflare");
      expect(provider.inputs.cloudflareApiToken).toEqual(
        expect.objectContaining({ value: "stack-token" }),
      );
      expect(resource("ApiUrl").options.provider).toContain(
        "pulumi:providers:sst::sst-cloudflare::",
      );
    });

    it("has an explicit Cloudflare provider's token, for that provider's components", async () => {
      pulumiSdk.runtime.setConfig("cloudflare:apiToken", "stack-token");
      const other = new CloudflareProvider("Other", {
        apiToken: "other-token",
      });
      new Worker("Api", { handler, url: true });
      new Worker("OtherApi", { handler, url: true }, { providers: [other] });
      await pulumi.settle();

      expect(
        sstProviders()
          .map((r) => r.name)
          .sort(),
      ).toEqual(["sst-Other", "sst-cloudflare"]);
      expect(revealed(resource("sst-Other").inputs.cloudflareApiToken)).toBe(
        "other-token",
      );
      expect(resource("OtherApiUrl").options.provider).toContain(
        "pulumi:providers:sst::sst-Other::",
      );
      expect(resource("ApiUrl").options.provider).toContain(
        "pulumi:providers:sst::sst-cloudflare::",
      );
    });

    it("has no token when the program sets none, and reads the environment's", async () => {
      new Worker("Api", { handler, url: true });
      await pulumi.settle();

      const [provider] = sstProviders();
      expect(provider.name).toBe("sst-cloudflare");
      expect(provider.inputs).not.toHaveProperty("cloudflareApiToken");
    });

    it("takes the placement and a DNS record too", async () => {
      pulumiSdk.runtime.setConfig("cloudflare:apiToken", "stack-token");
      new Worker("Api", { handler, placement: { mode: "smart" } });
      new Assets("Assets");
      new Router("Web", {
        domain: { name: "web.example.com", dns: dns() },
      });
      await pulumi.settle();

      expect(resource("ApiPlacement").options.provider).toContain(
        "::sst-cloudflare::",
      );
      const record = pulumi.resources.find(
        (r) => r.type === "sst:cloudflare:DnsRecord",
      )!;
      expect(record.options.provider).toContain("::sst-cloudflare::");
    });

    it("has the stack's Vercel token, and the record its team", async () => {
      pulumiSdk.runtime.setConfig("vercel:apiToken", "vercel-token");
      pulumiSdk.runtime.setConfig("vercel:team", "my-team");
      new Assets("Assets");
      new Router("Web", {
        domain: {
          name: "web.example.com",
          dns: vercelDns({ domain: "example.com" }),
        },
      });
      await pulumi.settle();

      const vercel = resource("sst-vercel");
      expect(vercel.inputs.vercelApiToken).toEqual(
        expect.objectContaining({ value: "vercel-token" }),
      );
      const record = pulumi.resources.find(
        (r) => r.type === "sst:vercel:DnsRecord",
      )!;
      expect(record.options.provider).toContain("::sst-vercel::");
      expect(record.inputs.teamId).toBe("my-team");
    });

    it("has an explicit Vercel provider's token and team", async () => {
      const team = new VercelProvider("Team", {
        apiToken: "team-token",
        team: "other-team",
      });
      new Assets("Assets");
      new Router(
        "Web",
        {
          domain: {
            name: "web.example.com",
            dns: vercelDns({ domain: "example.com" }),
          },
        },
        { providers: [team] },
      );
      await pulumi.settle();

      expect(revealed(resource("sst-Team").inputs.vercelApiToken)).toBe(
        "team-token",
      );
      const record = pulumi.resources.find(
        (r) => r.type === "sst:vercel:DnsRecord",
      )!;
      expect(record.inputs.teamId).toBe("other-team");
    });
  });

  it("reads a Worker's migration tag with its Cloudflare provider", async () => {
    new Worker("OldWorker", {
      handler,
      migrations: [
        { tag: "v1", newSqliteClasses: ["Counter"] },
        { tag: "v2", newSqliteClasses: ["Store"] },
      ],
    });
    await pulumi.settle();

    const script = resource("OldWorkerScript");
    expect(script.inputs.migrations).toEqual({
      oldTag: "v1",
      newTag: "v2",
      steps: [{ newSqliteClasses: ["Store"] }],
    });
  });
});
