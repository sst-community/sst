import { beforeEach, describe, expect, it } from "vitest";
import { ComponentResource, output } from "@pulumi/pulumi";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi();

// What SST 5's components use of `sst.aws.dns()`, `sst.cloudflare.dns()` and
// `sst.vercel.dns()`: records created directly, named from plain values as
// SST 4 named them, so a component that switches keeps them.
describe("the DNS adapters", () => {
  let parent: ComponentResource;
  const opts = () => ({ parent });
  const names = (type: string) =>
    pulumi.resources
      .filter((r) => r.type === type)
      .map((r) => r.name)
      .sort();
  const input = (name: string, key: string) =>
    pulumi.resources.find((r) => r.name === name)?.inputs[key];

  beforeEach(() => {
    pulumi.reset();
    parent = new ComponentResource("acme:index:Owner", "Owner");
  });

  describe("on Route 53", () => {
    it("names records as SST 4 did, and finds their zone with SST's provider", async () => {
      const { dns } = await import("../../src/components/aws/dns");
      const adapter = dns();
      adapter.alias(
        "Web",
        {
          name: "app.example.com",
          aliasName: "d1.cloudfront.net",
          aliasZone: "Z2",
        },
        opts(),
      );
      adapter.record(
        "Mail",
        { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1" },
        opts(),
      );
      // A record whose name in DNS is only known later, named after a key
      adapter.record(
        "WebSsl",
        {
          type: "CNAME",
          key: "example.com",
          name: output("_abc.example.com."),
          value: "_def",
        },
        opts(),
      );
      await pulumi.settle();

      expect(names("aws:route53/record:Record")).toEqual([
        "MailTXTRecordDmarcexamplecom",
        "WebAAAARecordAppexamplecom",
        "WebARecordAppexamplecom",
        "WebSslCNAMERecordExamplecom",
      ]);
      expect(input("MailTXTRecordDmarcexamplecom", "records")).toEqual([
        "v=DMARC1",
      ]);
      expect(input("MailTXTRecordDmarcexamplecom", "ttl")).toBe(60);
      expect(input("WebARecordAppexamplecom", "aliases")).toEqual([
        { name: "d1.cloudfront.net", zoneId: "Z2", evaluateTargetHealth: true },
      ]);
      // In the zone SST's provider finds
      expect(input("WebARecordAppexamplecom", "zoneId")).toBe(
        "example-com-zone",
      );
      expect(input("WebSslCNAMERecordExamplecom", "zoneId")).toBe(
        "example-com-zone",
      );
      // No lookup is a resource
      expect(
        pulumi.resources.filter((r) => r.name.includes("ZoneLookup")),
      ).toEqual([]);
      expect(adapter.caa("Web", "example.com", opts())).toEqual([]);
    });

    it("needs a key for a record whose name isn't a plain value", async () => {
      const { dns } = await import("../../src/components/aws/dns");
      expect(() =>
        dns().record(
          "Mail",
          { type: "CNAME", name: output("_abc.example.com"), value: "x" },
          opts(),
        ),
      ).toThrow(
        /The name of a DNS record of "Mail" has to be a plain value.*"key"/,
      );
      expect(() =>
        dns().alias(
          "Web",
          {
            name: output("example.com") as any,
            aliasName: "d1",
            aliasZone: "Z2",
          },
          opts(),
        ),
      ).toThrow(/The domain of "Web" has to be a plain value/);
    });
  });

  describe("on Cloudflare", () => {
    it("names records as SST 4 did, and finds the zone with Cloudflare's provider", async () => {
      const { dns } = await import("../../src/components/cloudflare/dns");
      const adapter = dns({ accountId: "acct", proxy: true });
      adapter.alias(
        "Web",
        {
          name: "app.example.com",
          aliasName: "d1.cloudfront.net",
          aliasZone: "Z2",
        },
        opts(),
      );
      adapter.record(
        "Mail",
        { type: "txt", name: "_dmarc.example.com", value: "v=DMARC1" },
        opts(),
      );
      adapter.caa("WebSsl", "example.com", opts());
      await pulumi.settle();

      expect(names("cloudflare:index/dnsRecord:DnsRecord")).toEqual([
        "MailtxtRecordDmarcexamplecom",
        "WebCNAMERecordAppexamplecom",
      ]);
      // The longest zone the domain ends with
      expect(input("WebCNAMERecordAppexamplecom", "zoneId")).toBe(
        "example-com-zone",
      );
      // Only what a domain points to is proxied
      expect(input("WebCNAMERecordAppexamplecom", "proxied")).toBe(true);
      expect(input("WebCNAMERecordAppexamplecom", "ttl")).toBe(1);
      expect(input("MailtxtRecordDmarcexamplecom", "proxied")).toBe(false);
      expect(input("MailtxtRecordDmarcexamplecom", "type")).toBe("TXT");
      expect(input("MailtxtRecordDmarcexamplecom", "content")).toBe(
        '"v=DMARC1"',
      );
      // What lets Amazon issue certificates for the domain
      expect(
        pulumi.resources
          .filter((r) => r.name.startsWith("WebSslCAA"))
          .map((r) => r.name.replace(/\.sst\..*$/, ""))
          .sort(),
      ).toEqual([
        "WebSslCAAWildcardexample.comRecord",
        "WebSslCAAexample.comRecord",
      ]);
      expect(
        pulumi.resources.filter((r) => r.name.includes("ZoneLookup")),
      ).toEqual([]);
    });
  });

  describe("on Vercel", () => {
    it("names records as SST 4 did", async () => {
      const { dns } = await import("../../src/components/vercel/dns");
      const adapter = dns({ domain: "example.com" });
      adapter.alias(
        "Web",
        {
          name: "example.com",
          aliasName: "d1.cloudfront.net",
          aliasZone: "Z2",
        },
        opts(),
      );
      adapter.alias(
        "App",
        {
          name: "app.example.com",
          aliasName: "d1.cloudfront.net",
          aliasZone: "Z2",
        },
        opts(),
      );
      adapter.caa("WebSsl", "example.com", opts());
      await pulumi.settle();

      expect(names("vercel:index/dnsRecord:DnsRecord")).toEqual([
        "AppCNAMERecordAppexamplecom",
        // A CNAME can't be at the domain's apex
        "WebALIASRecordExamplecom",
      ]);
      // Its name within the domain
      expect(input("AppCNAMERecordAppexamplecom", "name")).toBe("app");
      expect(input("WebALIASRecordExamplecom", "name")).toBe("");
      expect(
        pulumi.resources
          .filter((r) => r.name.startsWith("WebSslCaa"))
          .map((r) => r.name.replace(/\.sst\..*$/, ""))
          .sort(),
      ).toEqual(["WebSslCaaRecord", "WebSslCaaWildcardRecord"]);
    });

    it("needs its domain as a plain value to point a domain at a service", async () => {
      const { dns } = await import("../../src/components/vercel/dns");
      expect(() =>
        dns({ domain: output("example.com") }).alias(
          "Web",
          { name: "example.com", aliasName: "d1", aliasZone: "Z2" },
          opts(),
        ),
      ).toThrow(/The "domain" of sst.vercel.dns\(\) has to be a plain value/);
    });
  });
});

// What's given as `dns` is checked for each of SST 4's methods: one of the
// app's in place of SST's is refused only where SST 5's method that would be
// called in its place is still SST's own
describe("checkAdapter", () => {
  let checkAdapter: typeof import("../../src/components/dns-adapter").checkAdapter;
  let dns: typeof import("../../src/components/aws/dns").dns;
  const fn = (() => []) as any;

  beforeEach(async () => {
    pulumi.reset();
    ({ checkAdapter } = await import("../../src/components/dns-adapter"));
    ({ dns } = await import("../../src/components/aws/dns"));
  });

  it("takes one of SST's with both an SST 4 method and its SST 5 one replaced", () => {
    const adapter = { ...dns(), createAlias: fn, alias: fn };
    expect(checkAdapter(adapter, `"dns"`)).toBe(adapter);
  });

  it("refuses one of SST's with an SST 4 method replaced and its SST 5 one SST's, whatever else is replaced", () => {
    expect(() =>
      checkAdapter({ ...dns(), record: fn, createAlias: fn }, `"dns"`),
    ).toThrow(
      `"dns" is one of SST's adapters with "createAlias" replaced, which SST 5's components don't call: they call "alias". Replace that instead.`,
    );
  });

  it("refuses what isn't an adapter, with what to write", () => {
    for (const value of [null, "aws", 1])
      expect(() => checkAdapter(value, `"dns"`)).toThrow(
        /^"dns" isn't a DNS adapter\. Use sst\.aws\.dns\(\)/,
      );
    expect(checkAdapter(undefined, `"dns"`)).toBeUndefined();
    expect(checkAdapter(false, `"dns"`)).toBe(false);
  });

  it("is applied by the certificate and the redirect, which take one too", async () => {
    const { DnsValidatedCertificate } = await import(
      "../../src/components/aws/dns-validated-certificate"
    );
    const { HttpsRedirect } = await import(
      "../../src/components/aws/https-redirect"
    );
    const sst4 = {
      provider: "aws",
      createRecord: fn,
      createAlias: fn,
      createCaa: fn,
    } as any;
    expect(
      () =>
        new DnsValidatedCertificate("Cert", {
          domainName: "example.com",
          dns: sst4,
        }),
    ).toThrow(/is written the way SST 4's adapters were/);
    expect(
      () =>
        new HttpsRedirect("Redirect", {
          sourceDomains: ["www.example.com"],
          targetDomain: "example.com",
          dns: sst4,
        }),
    ).toThrow(/is written the way SST 4's adapters were/);
  });
});
