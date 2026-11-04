import { ComponentResourceOptions, Input, output } from "@pulumi/pulumi";
import { cloudfront, s3 } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../../parts-component";
import { plain } from "../../args";
import { VisibleError } from "../../error";
import { logicalName, physicalName } from "../../naming";
import type { DnsAdapter } from "../../dns-adapter";
import { CF_BLOCK_CLOUDFRONT_URL_INJECTION } from "../router-code";
import { useProvider } from "../helpers/provider";
import { Bucket } from "./bucket";
import { DnsValidatedCertificate } from "./dns-validated-certificate";

const parts = {
  /**
   * The certificate for the domains it redirects from, in `us-east-1` as CloudFront needs.
   * Created when there's no `cert`.
   */
  certificate: named(optional(DnsValidatedCertificate), "Ssl"),
  /**
   * The bucket whose website sends every request to the target domain.
   */
  bucket: Bucket,
  /**
   * The bucket's website, which redirects every request.
   */
  bucketWebsite: s3.BucketWebsiteConfiguration,
  /**
   * The CloudFront function that turns away a request made to the distribution's own
   * domain.
   */
  requestFunction: named(cloudfront.Function, "CloudfrontFunctionRequest"),
  /**
   * The Amazon CloudFront distribution the domains point to.
   */
  distribution: cloudfront.Distribution,
};

export interface HttpsRedirectArgs extends ComponentArgs<typeof parts> {
  /**
   * The domain to send visitors to.
   */
  targetDomain: Input<string>;
  /**
   * The domains to send visitors from. Plain values: they decide the DNS records.
   */
  sourceDomains: string[];
  /**
   * The ARN of an ACM certificate for the `sourceDomains`, in `us-east-1`. By default, one
   * is created and validated with the `dns`.
   */
  cert?: Input<string>;
  /**
   * What creates the DNS records for the `sourceDomains`. Without it, there has to be a
   * `cert`, and the records are yours to add.
   */
  dns?: DnsAdapter;
}

/**
 * The `HttpsRedirect` component is internally used by other components to send visitors of
 * some domains to another, over HTTPS. It's what a `Cdn`'s `domain.redirects` create.
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * ---
 *
 * #### Switch from SST 4's redirect
 *
 * The components that create a redirect create this one once they're switched. The
 * certificate, the bucket, the distribution and the DNS records are kept. A few things are
 * different:
 *
 * - `sourceDomains` and `dns` have to be plain values, not outputs.
 * - The CloudFront function is inside the redirect. SST 4 created it at the top of the app,
 *   with the app's provider. A redirect with a provider of its own gives it that one, and
 *   keeps it.
 * - `transform` takes each part, and `nodes` has them.
 */
export class HttpsRedirect extends component("sst:aws:HttpsRedirect", parts) {
  constructor(
    name: string,
    args: HttpsRedirectArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const of = `of the "${name}" redirect`;
    const why = "They decide the DNS records that are created.";
    const sourceDomains = plain(
      args.sourceDomains,
      `The "sourceDomains" ${of}`,
      why,
    ).map((domain) => plain(domain, `The "sourceDomains" ${of}`, why));
    const dns = plain(args.dns, `The "dns" ${of}`, why);
    if (!dns && !args.cert)
      throw new VisibleError(
        `The "${name}" redirect has "dns" set to false, so it can't validate a certificate of its own. Pass a validated one in "cert".`,
      );

    const certificateArn =
      args.cert ??
      this.part(
        "certificate",
        {
          domainName: sourceDomains[0],
          alternativeNames: sourceDomains.slice(1),
          dns: dns!,
        },
        // CloudFront only takes certificates from us-east-1
        { provider: useProvider("us-east-1") },
      ).arn;

    const bucket = this.part("bucket", {});
    const bucketWebsite = this.part("bucketWebsite", {
      bucket: bucket.name,
      redirectAllRequestsTo: {
        hostName: args.targetDomain,
        protocol: "https",
      },
    });

    const requestFunction = this.part(
      "requestFunction",
      {
        name: physicalName(64, `${name}CloudfrontFunctionRequest`),
        runtime: "cloudfront-js-2.0",
        code: `
import cf from "cloudfront";
async function handler(event) {
  ${CF_BLOCK_CLOUDFRONT_URL_INJECTION}
  return event.request;
}`,
      },
      { ignoreChanges: ["name"] },
    );

    // The domains the distribution answers to
    const aliases = sourceDomains;
    const distribution = this.part("distribution", {
      enabled: true,
      waitForDeployment: false,
      aliases,
      restrictions: {
        geoRestriction: {
          restrictionType: "none",
        },
      },
      comment: output(args.targetDomain).apply((targetDomain) => {
        const comment = `Redirect to ${targetDomain} from ${sourceDomains.join(
          ", ",
        )}`;
        return comment.length > 128 ? comment.slice(0, 125) + "..." : comment;
      }),
      priceClass: "PriceClass_All",
      viewerCertificate: {
        acmCertificateArn: certificateArn,
        sslSupportMethod: "sni-only",
      },
      defaultCacheBehavior: {
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        targetOriginId: "s3Origin",
        viewerProtocolPolicy: "redirect-to-https",
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
          cookies: { forward: "none" },
          queryString: false,
        },
        functionAssociations: [
          {
            eventType: "viewer-request",
            functionArn: requestFunction.arn,
          },
        ],
      },
      origins: [
        {
          originId: "s3Origin",
          domainName: bucketWebsite.websiteEndpoint,
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "http-only",
            originSslProtocols: ["TLSv1.2"],
          },
        },
      ],
    });

    if (!dns) return;
    // An adapter names a record after its domain, with `*.` left out, so
    // `*.example.com` and `example.com` would have one name. The second one
    // has its place in the list added to its name.
    const seen: string[] = [];
    sourceDomains.forEach((domain, i) => {
      const key = logicalName(domain);
      dns.alias(
        seen.includes(key) ? `${name}${i}` : name,
        {
          name: domain,
          aliasName: distribution.domainName,
          aliasZone: distribution.hostedZoneId,
        },
        this.delegateOpts(),
      );
      seen.push(key);
    });
  }
}
