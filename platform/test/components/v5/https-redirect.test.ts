import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const CERT_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/test";

const pulumi = mockPulumi();

type RedirectResponse = {
  statusCode: number;
  statusDescription: string;
  headers: { location: { value: string } };
};

// The redirect's CloudFront function answers every request, as SST 4's does
// since #265, whose tests these are
describe("HttpsRedirect", () => {
  let code: string;
  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;

  beforeAll(async () => {
    pulumi.reset();
    const { HttpsRedirect } = await import(
      "../../../src/components/aws/https-redirect"
    );
    new HttpsRedirect("Redirect", {
      targetDomain: output(Promise.resolve("www.example.com")),
      sourceDomains: ["example.com", "old.example.com"],
      cert: CERT_ARN,
    });
    await pulumi.settle();
    code = resource("RedirectCloudfrontFunctionRequest").inputs.code;
  });

  function redirect(
    uri: string,
    query?: string,
    host = "example.com",
  ): Promise<RedirectResponse> {
    return vm.runInNewContext(`${code}\nhandler(event)`, {
      event: {
        request: {
          uri,
          headers: { host: { value: host } },
          rawQueryString: () => query,
        },
      },
    });
  }

  it.each([
    ["/", undefined, "https://www.example.com/"],
    ["/products/item", undefined, "https://www.example.com/products/item"],
    [
      "/products",
      "utm_source=newsletter&gclid=abc",
      "https://www.example.com/products?utm_source=newsletter&gclid=abc",
    ],
    [
      "/search",
      "tag=one&tag=two&flag&empty=",
      "https://www.example.com/search?tag=one&tag=two&flag&empty=",
    ],
    [
      "/a%2Fb",
      "q=a%2Bb+c&url=%2Fpath%3Fa%3D1",
      "https://www.example.com/a%2Fb?q=a%2Bb+c&url=%2Fpath%3Fa%3D1",
    ],
    ["/products", "", "https://www.example.com/products?"],
  ])(
    "redirects %s with query %s without altering the URL",
    async (uri, query, location) => {
      expect(await redirect(uri, query)).toEqual({
        statusCode: 301,
        statusDescription: "Moved Permanently",
        headers: { location: { value: location } },
      });
    },
  );

  it("redirects every source domain to the target", async () => {
    const response = await redirect("/products", undefined, "old.example.com");
    expect(response.headers.location.value).toBe(
      "https://www.example.com/products",
    );
  });

  it("keeps requests to the CloudFront hostname forbidden", async () => {
    const response = await redirect("/", undefined, "d123.cloudfront.net");
    expect(response.statusCode).toBe(403);
  });

  it("uses an HTTPS-only placeholder origin and no origin access control", () => {
    const distribution = resource("RedirectDistribution");
    expect(distribution.inputs.aliases).toEqual([
      "example.com",
      "old.example.com",
    ]);
    expect(distribution.inputs.viewerCertificate).toEqual({
      acmCertificateArn: CERT_ARN,
      sslSupportMethod: "sni-only",
    });
    expect(distribution.inputs.origins).toEqual([
      {
        originId: "s3Origin",
        domainName: "placeholder.sst.dev",
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: "https-only",
          originSslProtocols: ["TLSv1.2"],
        },
      },
    ]);
    expect(
      pulumi.resources.filter((r) => r.type.includes("OriginAccessControl")),
    ).toEqual([]);
  });

  it("keeps the bucket's website, for edge locations still on the old origin", () => {
    expect(
      resource("RedirectBucketWebsite").inputs.redirectAllRequestsTo,
    ).toEqual({ hostName: "www.example.com", protocol: "https" });
  });
});
