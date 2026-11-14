import { ComponentResourceOptions, Input, output } from "@pulumi/pulumi";
import { cloudfront, s3 } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../parts-component";
import { plain } from "../args";
import { VisibleError } from "../error";
import { logicalName, physicalName } from "../naming";
import type { DnsAdapter } from "../dns-adapter";
import { checkAdapter } from "../dns-adapter";
import { CF_BLOCK_CLOUDFRONT_URL_INJECTION } from "./router-code";
import { useProvider } from "./helpers/provider";
import { Bucket } from "./bucket";
import { DnsValidatedCertificate } from "./dns-validated-certificate";

const parts = {
  /**
   * The certificate for the domains it redirects from, in `us-east-1` as CloudFront needs.
   * Created when there's no `cert`.
   */
  certificate: named(optional(DnsValidatedCertificate), "Ssl"),
  /**
   * The bucket whose website redirected every request before the CloudFront function did.
   * It's kept so that a distribution still deploying can reach it. No request reaches it
   * after that.
   */
  bucket: Bucket,
  /**
   * The bucket's website, which redirects every request. It's kept with the bucket.
   */
  bucketWebsite: s3.BucketWebsiteConfiguration,
  /**
   * The CloudFront function that answers every request with the redirect, keeping its path
   * and query string, and turns away a request made to the distribution's own domain.
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
 * - The CloudFront function answers every request with the redirect, and the distribution's
 *   origin is a placeholder it never reaches, as SST 4's redirect does since #265. A stage
 *   moved from an SST 4 that sent the redirect from the bucket's website gets the function's
 *   code and the origin updated in place.
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
    const dns = checkAdapter(
      plain(args.dns, `The "dns" ${of}`, why),
      `The "dns" ${of}`,
    );
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
    // Kept, so edge locations still on the distribution's old origin keep
    // redirecting while it deploys
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
        // The redirect keeps the path and the raw query string
        code: output(args.targetDomain).apply(
          (targetDomain) => `
async function handler(event) {
  ${CF_BLOCK_CLOUDFRONT_URL_INJECTION}
  var request = event.request;
  var query = request.rawQueryString();
  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: {
      location: {
        value: ${JSON.stringify("https://" + targetDomain)} + request.uri
          + (query === undefined ? "" : "?" + query)
      }
    }
  };
}`,
        ),
      },
      { ignoreChanges: ["name"] },
    );

    // The domains the distribution answers to
    const aliases = sourceDomains;
    const distribution = this.part(
      "distribution",
      {
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
            // CloudFront needs an origin, though the function answers every
            // request before it's reached. The sites' HTTPS-only placeholder, so
            // there's no HTTP-only origin, and no origin access control to need
            // a permission for.
            originId: "s3Origin",
            domainName: "placeholder.sst.dev",
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: "https-only",
              originSslProtocols: ["TLSv1.2"],
            },
          },
        ],
      },
      // The website was its origin, and is still reached while it deploys.
      // So it's removed after the distribution, as it was then.
      { dependsOn: [bucketWebsite] },
    );

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
