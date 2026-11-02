import { describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

// A new stage's preview: everything is about to be created, so of each
// resource only what it was given is known, and nothing AWS gives back, like a
// certificate's validation records or a distribution's domain name.
const pulumi = mockPulumi({
  preview: true,
  state: (args) =>
    Object.fromEntries(
      [
        "arn",
        "certificateArn",
        "domainName",
        "domainValidationOptions",
        "etag",
        "hostedZoneId",
        "isDone",
        "websiteEndpoint",
      ]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    ),
});

describe("a CDN with a domain in a new stage's preview", () => {
  it("plans every DNS record a deploy creates", async () => {
    await import("../../../src/components/aws/takeover/index");
    const { Cdn } = await import("../../../src/components/aws/v5/cdn");
    new Cdn("Web", {
      origins: [{ originId: "default", domainName: "example.org" }],
      defaultCacheBehavior: {
        targetOriginId: "default",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
      },
      domain: {
        name: "example.com",
        aliases: ["*.example.com", "app.example.com"],
        redirects: ["www.example.com"],
      },
    });
    await pulumi.settle();

    const records = pulumi.resources
      .filter((r) => r.type === "aws:route53/record:Record")
      .map((r) => r.name)
      .sort();
    expect(records).toEqual([
      // What the domains point to: `*.example.com` shares its name with
      // `example.com`, so it has its place in the list added
      "Web1AAAARecordExamplecom",
      "Web1ARecordExamplecom",
      "WebAAAARecordAppexamplecom",
      "WebAAAARecordExamplecom",
      "WebARecordAppexamplecom",
      "WebARecordExamplecom",
      // The redirect's
      "WebRedirectAAAARecordWwwexamplecom",
      "WebRedirectARecordWwwexamplecom",
      // What validates the certificates: one for a domain and its wildcard
      "WebRedirectSslCNAMERecordWwwexamplecom",
      "WebSslCNAMERecordAppexamplecom",
      "WebSslCNAMERecordExamplecom",
    ]);
    // Each validation record's name in DNS is only known once its
    // certificate is created, and it's planned all the same
    const validation = pulumi.resources.find(
      (r) => r.name === "WebSslCNAMERecordExamplecom",
    )!;
    expect(validation.inputs.name).toBe(UNKNOWN);
    // The certificates wait for their records
    for (const name of ["WebSslValidation", "WebRedirectSslValidation"])
      expect(pulumi.resources.map((r) => r.name)).toContain(name);
    // No zone is looked up with a resource
    expect(
      pulumi.resources.filter((r) => r.name.includes("ZoneLookup")),
    ).toEqual([]);
  });
});
