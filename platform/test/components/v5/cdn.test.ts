import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Output, output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const DISTRIBUTION = "aws:cloudfront/distribution:Distribution";
const CERT_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/abc";

const pulumi = mockPulumi({
  state: (args) => {
    // A distribution that's looked up
    if (args.type === DISTRIBUTION && args.id)
      return {
        domainName: "d111111abcdef8.cloudfront.net",
        aliases: ["shared.example.com"],
      };
    if (args.type === DISTRIBUTION)
      return {
        domainName: `${args.name.toLowerCase()}.cloudfront.net`,
        hostedZoneId: "Z2FDTNDATAQYW2",
        etag: "E1",
      };
    if (args.type === "pulumi-nodejs:dynamic:Resource" && "etag" in args.inputs)
      return { isDone: true };
    return {};
  },
});

describe("Cdn", () => {
  let OriginalCdn: typeof import("../../fixtures/v4/components/aws/cdn").Cdn;
  let Cdn: typeof import("../../../src/components/aws/cdn").Cdn;
  let cloudflare: typeof import("../../../src/components/cloudflare/dns");
  let vercel: typeof import("../../../src/components/vercel/dns");

  beforeAll(async () => {
    OriginalCdn = (await import("../../fixtures/v4/components/aws/cdn")).Cdn;
    Cdn = (await import("../../../src/components/aws/cdn")).Cdn;
    cloudflare = await import("../../../src/components/cloudflare/dns");
    vercel = await import("../../../src/components/vercel/dns");
    // What the V5 Cdn creates for a domain takes over 4.x's by these
    await import(
      "../../../src/components/aws/takeover/dns-validated-certificate"
    );
    await import("../../../src/components/aws/takeover/https-redirect");
    await import("../../../src/components/aws/takeover/bucket");
    // Its waiter takes the place of 4.x's, which is released
    await import("../../../src/components/aws/takeover/cdn");
  });

  beforeEach(() => {
    pulumi.reset();
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  const valueOf = <T>(value: Output<T>) =>
    new Promise<T>((resolve) => value.apply(resolve));
  const origin = {
    origins: [
      {
        originId: "default",
        domainName: "placeholder.sst.dev",
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: "http-only",
          originReadTimeout: 20,
          originSslProtocols: ["TLSv1.2"],
        },
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: "default",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
    },
  };

  // Each case deploys the 4.x Cdn, then the same thing as the V5 one, which
  // has to keep everything with the same inputs.
  describe("takes over a deployed Cdn", () => {
    pulumi.takeoverCases({
      original: () => OriginalCdn as any,
      v5: () => Cdn as any,
      check: () => expect(names()).toContain("MyCdnDistribution"),
      cases: {
        "no domain": (Cdn, opts) => {
          new Cdn("MyCdn", { comment: "MyCdn app", ...origin }, opts);
        },
        "not waiting for the deploy": {
          create: (Cdn, opts) => {
            new Cdn("MyCdn", { ...origin, wait: false }, opts);
          },
          check: () =>
            expect(resource("MyCdnWaiter").options.ignoreChanges).toEqual([
              "*",
            ]),
        },
        "a domain on Route 53": {
          create: (Cdn, opts) => {
            new Cdn("MyCdn", { ...origin, domain: "example.com" }, opts);
          },
          check: () => {
            expect(names()).toContain("MyCdnSslCertificate");
            expect(names()).toContain("MyCdnAAAARecordExamplecom");
          },
        },
        // Each adapter names its records, and the certificate's, as 4.x
        // did. One that isn't Route 53 also lets Amazon issue the
        // certificate, with CAA records, and finds the zone another way.
        "a domain on Cloudflare": {
          create: (Cdn, opts) => {
            new Cdn(
              "MyCdn",
              {
                ...origin,
                domain: {
                  name: "app.example.com",
                  aliases: ["*.app.example.com"],
                  redirects: ["www.example.com"],
                  dns: cloudflare.dns(),
                },
              },
              opts,
            );
          },
          check: () => {
            expect(names()).toContain("MyCdnCNAMERecordAppexamplecom");
            expect(names()).toContain("MyCdnSslCNAMERecordAppexamplecom");
            expect(names()).toContain("MyCdnSslCAAapp.example.comRecord");
          },
          changed: (way) =>
            way === "with another provider"
              ? [
                  [
                    "MyCdnRedirectCloudfrontFunctionRequest",
                    ["options.provider"],
                  ],
                ]
              : [],
        },
        "a domain on Cloudflare in a zone it's given": {
          create: (Cdn, opts) => {
            new Cdn(
              "MyCdn",
              {
                ...origin,
                domain: {
                  name: "app.example.com",
                  dns: cloudflare.dns({ zone: "zone-1" }),
                },
              },
              opts,
            );
          },
          check: () =>
            expect(names()).toContain("MyCdnSslCNAMERecordAppexamplecom"),
        },
        "a domain on Vercel": {
          create: (Cdn, opts) => {
            new Cdn(
              "MyCdn",
              {
                ...origin,
                domain: {
                  name: "example.com",
                  aliases: ["app.example.com"],
                  dns: vercel.dns({ domain: "example.com" }),
                },
              },
              opts,
            );
          },
          check: () => {
            expect(names()).toContain("MyCdnALIASRecordExamplecom");
            expect(names()).toContain("MyCdnCNAMERecordAppexamplecom");
            expect(names()).toContain("MyCdnSslCaaRecord");
          },
        },
        "a domain with aliases that share a record's name": {
          create: (Cdn, opts) => {
            new Cdn(
              "MyCdn",
              {
                ...origin,
                domain: {
                  name: "*.example.com",
                  aliases: ["example.com", "app.example.com"],
                },
              },
              opts,
            );
          },
          check: () => {
            expect(names()).toContain("MyCdnARecordExamplecom");
            expect(names()).toContain("MyCdn1ARecordExamplecom");
            expect(names()).toContain("MyCdnARecordAppexamplecom");
          },
        },
        "a domain with redirects": {
          create: (Cdn, opts) => {
            new Cdn(
              "MyCdn",
              {
                ...origin,
                domain: { name: "example.com", redirects: ["www.example.com"] },
              },
              opts,
            );
          },
          check: () => expect(names()).toContain("MyCdnRedirect"),
          // 4.x created the redirect's function with the app's provider,
          // whatever the redirect's was. V5 gives it the redirect's, which
          // AWS's provider takes without replacing it
          changed: (way) =>
            way === "with another provider"
              ? [
                  [
                    "MyCdnRedirectCloudfrontFunctionRequest",
                    ["options.provider"],
                  ],
                ]
              : [],
        },
        "a domain with a certificate of its own": {
          create: (Cdn, opts) => {
            new Cdn(
              "MyCdn",
              {
                ...origin,
                domain: { name: "example.com", dns: false, cert: CERT_ARN },
              },
              opts,
            );
          },
          check: () => {
            expect(names()).not.toContain("MyCdnSsl");
            expect(
              resource("MyCdnDistribution").inputs.viewerCertificate
                .acmCertificateArn,
            ).toBe(CERT_ARN);
          },
        },
        "tags, a WAF and a transform": (Cdn, opts) => {
          new Cdn(
            "MyCdn",
            {
              ...origin,
              tags: { team: "web" },
              webAclArn: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/a",
              transform: {
                distribution: (args: any) => {
                  args.priceClass = "PriceClass_100";
                },
              },
            },
            opts,
          );
        },
        get: {
          create: (Cdn, opts) => {
            Cdn.get("MyCdn", "E2IDLMESRN6V62", opts);
          },
          check: () => expect(names()).not.toContain("MyCdnWaiter"),
        },
      },
    });
  });

  it("has no domain when it's given an empty one, as 4.x did", async () => {
    new Cdn("MyCdn", { ...origin, domain: "" });
    await pulumi.settle();
    expect(names()).not.toContain("MyCdnSsl");
    expect(resource("MyCdnDistribution").inputs.aliases).toEqual([]);
  });

  it("says the domain has to be a plain value", () => {
    expect(
      () =>
        new Cdn("MyCdn", { ...origin, domain: output("example.com") as any }),
    ).toThrow(/"domain" of the "MyCdn" CDN has to be a plain value/);
    expect(
      () =>
        new Cdn("MyCdn", {
          ...origin,
          domain: { name: output("example.com") as any },
        }),
    ).toThrow(/domain "name" of the "MyCdn" CDN .* named after it/);
    expect(
      () =>
        new Cdn("MyCdn", {
          ...origin,
          domain: { name: "example.com", redirects: [output("www") as any] },
        }),
    ).toThrow(/domain "redirects" of the "MyCdn" CDN has to be a plain value/);
    expect(
      () => new Cdn("MyCdn", { ...origin, wait: output(false) as any }),
    ).toThrow(/"wait" of the "MyCdn" CDN has to be a plain value/);
  });

  it("gives the distribution itself, and its URL once it's deployed", async () => {
    const cdn = new Cdn("MyCdn", { ...origin, domain: "example.com" });
    await pulumi.settle();

    const aws = await import("@pulumi/aws");
    expect(cdn.nodes.distribution).toBeInstanceOf(aws.cloudfront.Distribution);
    expect(await valueOf(cdn.url)).toBe(
      "https://mycdndistribution.cloudfront.net",
    );
    expect(await valueOf(cdn.domainUrl)).toBe("https://example.com");
  });

  it("reads the domain of a distribution it's given", async () => {
    const cdn = Cdn.get("MyCdn", "E2IDLMESRN6V62");
    await pulumi.settle();

    expect(await valueOf(cdn.url)).toBe(
      "https://d111111abcdef8.cloudfront.net",
    );
    expect(await valueOf(cdn.domainUrl)).toBe("https://shared.example.com");
  });

  it("uses a distribution it's given the way it is", async () => {
    expect(
      () =>
        new Cdn("MyCdn", {
          existing: { distribution: "E2IDLMESRN6V62" },
          origins: [],
          defaultCacheBehavior: {} as any,
          wait: false,
        }),
    ).toThrow(
      /The "MyCdn" CDN is given an existing "distribution", which it uses the way it is\. Remove "origins", "defaultCacheBehavior", "wait" from its args\./,
    );
  });

  // A `$transform` for every CDN runs on one from `get` too, and isn't meant
  // for it
  it("leaves what a $transform sets on one from get", async () => {
    const { $transform } = await import("../../../src/components/component");
    $transform(Cdn, (args, _opts, name) => {
      if (name === "Shared") args!.wait = false;
    });
    Cdn.get("Shared", "E2IDLMESRN6V62");
    await pulumi.settle();
    expect(
      pulumi.resources.find((r) => r.name === "SharedDistribution")?.kind,
    ).toBe("read");
  });
});
