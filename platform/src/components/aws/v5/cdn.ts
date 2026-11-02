import {
  ComponentResourceOptions,
  Input,
  Output,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { cloudfront } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { plain } from "../../args";
import { logicalName } from "../../naming";
import { DnsValidatedCertificate } from "../dns-validated-certificate";
import { HttpsRedirect } from "../https-redirect";
import { DistributionDeploymentWaiter } from "../providers/distribution-deployment-waiter";
import { type CustomDomainArgs, customDomain } from "../helpers/custom-domain";
import { useProvider } from "../helpers/provider";

const parts = {
  /**
   * The Amazon CloudFront distribution.
   */
  distribution: cloudfront.Distribution,
  /**
   * What waits for the distribution to be deployed, when `wait` is on. Not created for
   * a distribution that's passed in `existing`.
   */
  waiter: optional(DistributionDeploymentWaiter),
  /**
   * The certificate for the custom domain, in `us-east-1` as CloudFront needs. Created
   * when `domain` is set without a `cert`.
   */
  certificate: named(optional(DnsValidatedCertificate), "Ssl"),
  /**
   * What sends visitors of the `domain.redirects` to the main domain. Created when
   * there are any.
   */
  redirect: optional(HttpsRedirect),
};

export interface CdnDomainArgs extends CustomDomainArgs {
  /**
   * Alternate domains to be used. Visitors to the alternate domains will be redirected to the
   * main `name`.
   *
   * :::note
   * Unlike the `aliases` option, this will redirect visitors back to the main `name`.
   * :::
   *
   * @example
   * Use this to create a `www.` version of your domain and redirect visitors to the apex domain.
   * ```js {4}
   * {
   *   domain: {
   *     name: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   */
  redirects?: string[];
  /**
   * Alias domains that should be used. Unlike the `redirect` option, this keeps your visitors
   * on this alias domain.
   *
   * @example
   * So if your users visit `app2.domain.com`, they will stay on `app2.domain.com` in their
   * browser.
   * ```js {4}
   * {
   *   domain: {
   *     name: "app1.domain.com",
   *     aliases: ["app2.domain.com"]
   *   }
   * }
   * ```
   */
  aliases?: string[];
  /**
   * The ARN of an ACM (AWS Certificate Manager) certificate that proves ownership of the
   * domain. By default, a certificate is created and validated automatically.
   *
   * The certificate will be created in the `us-east-1` region as required by AWS CloudFront.
   * If you are creating your own certificate, you must also create it in `us-east-1`.
   *
   * :::tip
   * You need to pass in a `cert` for domains that are not hosted on supported `dns` providers.
   * :::
   *
   * To manually set up a domain on an unsupported provider, you'll need to:
   *
   * 1. [Validate that you own the domain](https://docs.aws.amazon.com/acm/latest/userguide/domain-ownership-validation.html) by creating an ACM certificate. You can either validate it by setting a DNS record or by verifying an email sent to the domain owner.
   * 2. Once validated, set the certificate ARN as the `cert` and set `dns` to `false`.
   * 3. Add the DNS records in your provider to point to the CloudFront distribution URL.
   *
   * @example
   * ```js
   * {
   *   domain: {
   *     name: "domain.com",
   *     dns: false,
   *     cert: "arn:aws:acm:us-east-1:112233445566:certificate/3a958790-8878-4cdc-a396-06d95064cf63"
   *   }
   * }
   * ```
   */
  cert?: Input<string>;
}

export interface CdnArgs extends ComponentArgs<typeof parts> {
  /**
   * A comment to describe the distribution. It cannot be longer than 128 characters.
   */
  comment?: Input<string>;
  /**
   * One or more origins for this distribution.
   */
  origins: cloudfront.DistributionArgs["origins"];
  /**
   * One or more origin groups for this distribution.
   */
  originGroups?: cloudfront.DistributionArgs["originGroups"];
  /**
   * The default cache behavior for this distribution.
   */
  defaultCacheBehavior: cloudfront.DistributionArgs["defaultCacheBehavior"];
  /**
   * An ordered list of cache behaviors for this distribution. Listed in order of precedence. The first cache behavior will have precedence 0.
   */
  orderedCacheBehaviors?: cloudfront.DistributionArgs["orderedCacheBehaviors"];
  /**
   * An object you want CloudFront to return when a user requests the root URL. For example, the `index.html`.
   */
  defaultRootObject?: cloudfront.DistributionArgs["defaultRootObject"];
  /**
   * One or more custom error responses.
   */
  customErrorResponses?: cloudfront.DistributionArgs["customErrorResponses"];
  /**
   * Set a custom domain for your distribution. It has to be a plain value, and so do its
   * `name`, `aliases` and `redirects`: they decide the certificate, the redirect and the
   * DNS records that are created, and what they're named.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and Vercel. For other
   * providers, you'll need to pass in a `cert` that validates domain ownership and add the
   * DNS records.
   *
   * :::tip
   * Built-in support for AWS Route 53, Cloudflare, and Vercel. And manual setup for other
   * providers.
   * :::
   *
   * @example
   *
   * By default this assumes the domain is hosted on Route 53.
   *
   * ```js
   * {
   *   domain: "example.com"
   * }
   * ```
   *
   * For domains hosted on Cloudflare.
   *
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   *
   * Specify a `www.` version of the custom domain.
   *
   * ```js
   * {
   *   domain: {
   *     name: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   */
  domain?: string | Prettify<CdnDomainArgs>;
  /**
   * Whether to wait for the CloudFront distribution to be deployed before
   * completing the deployment of the app. This is necessary if you need to use the
   * distribution URL in other resources. It has to be a plain value.
   * @default `true`
   */
  wait?: boolean;
  /**
   * Tags to apply to the distribution.
   */
  tags?: Input<Record<string, Input<string>>>;
  /**
   * The ARN of a WAF WebACL to associate with the CloudFront distribution.
   *
   * @example
   * ```ts
   * {
   *   webAclArn: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc123"
   * }
   * ```
   */
  webAclArn?: Input<string>;
}

/**
 * A CDN's custom domain, checked: the domain's name, its aliases and its
 * redirects are plain values, since the DNS records are named after them.
 * Undefined when there's no domain. A component that gives its domain to a
 * `Cdn` checks it first, so that a message names that component.
 *
 * @param owner What the domain belongs to, for error messages: `the "MyRouter" Router`.
 * @internal
 */
export function cdnDomain(
  domain: string | CdnDomainArgs | undefined,
  owner: string,
) {
  if (!domain) return;
  const { name, dns, cert } = customDomain(domain, owner);
  const given: Partial<CdnDomainArgs> =
    typeof domain === "string" ? {} : domain;
  const named = "Its DNS records are named after it.";
  const plainList = (list: string[], what: string) => {
    plain(list, what);
    return list.map((item) => plain(item, what, named));
  };
  const aliases = plainList(
    given.aliases ?? [],
    `The domain "aliases" of ${owner}`,
  );
  const redirects = plainList(
    given.redirects ?? [],
    `The domain "redirects" of ${owner}`,
  );
  return {
    name: plain(name, `The domain "name" of ${owner}`, named) as string,
    aliases,
    redirects,
    dns,
    cert,
  };
}

/**
 * The `Cdn` component is internally used by other components to deploy a CDN to AWS. It uses [Amazon CloudFront](https://aws.amazon.com/cloudfront/) and [Amazon Route 53](https://aws.amazon.com/route53/) to manage custom domains.
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * @example
 *
 * You'll find this component exposed in the `transform` of other components. And you can customize the args listed here. For example:
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Router("MyRouter", {
 *   transform: {
 *     cdn: (args) => {
 *       args.wait = false;
 *     }
 *   }
 * });
 * ```
 *
 * ---
 *
 * #### Switch from `sst.aws.Cdn`
 *
 * The components that create a `Cdn` create this one once they're switched. The
 * distribution, its certificate, its DNS records and its redirect are kept. A few things
 * are written differently:
 *
 * - `domain`, with its `name`, `aliases` and `redirects`, and `wait` have to be plain
 *   values, not outputs.
 * - `nodes.distribution` is the distribution itself. In `sst.aws.Cdn` it was an output
 *   that waited for the distribution to be deployed. `url` still waits for it.
 * - `transform` also takes the `waiter`, the `certificate` and the `redirect`.
 */
export class Cdn extends component("sst:aws:CDN", parts) {
  private readonly deployed: Output<unknown>;
  private readonly _domainUrl: Output<string | undefined>;

  constructor(name: string, args: CdnArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const existing = this.existingPart("distribution");
    if (existing) {
      this.deployed = output(true);
      this._domainUrl = existing.aliases.apply((aliases) =>
        aliases?.length ? `https://${aliases[0]}` : undefined,
      );
      return;
    }

    const domain = cdnDomain(args.domain, `the "${name}" CDN`);
    const wait = plain(args.wait, `The "wait" of the "${name}" CDN`);

    const certificateArn = domain
      ? domain.cert ??
        this.part(
          "certificate",
          {
            domainName: domain.name,
            alternativeNames: domain.aliases,
            dns: domain.dns!,
          },
          // CloudFront only takes certificates from us-east-1
          { provider: useProvider("us-east-1") },
        ).arn
      : undefined;

    // The domains the distribution answers to
    const aliases = domain ? [domain.name, ...domain.aliases] : [];
    const distribution = this.part("distribution", {
      comment: args.comment,
      enabled: true,
      origins: args.origins,
      originGroups: args.originGroups,
      defaultCacheBehavior: args.defaultCacheBehavior,
      orderedCacheBehaviors: args.orderedCacheBehaviors,
      defaultRootObject: args.defaultRootObject,
      customErrorResponses: args.customErrorResponses,
      restrictions: {
        geoRestriction: {
          restrictionType: "none",
        },
      },
      aliases,
      viewerCertificate: certificateArn
        ? {
            acmCertificateArn: certificateArn,
            sslSupportMethod: "sni-only",
            minimumProtocolVersion: "TLSv1.2_2021",
          }
        : { cloudfrontDefaultCertificate: true },
      waitForDeployment: false,
      tags: args.tags,
      // CloudFront API confusingly names the WAF ARN field "webAclId"
      webAclId: args.webAclArn,
    });

    // As the 4.x `Cdn` deploys it: unless `wait` is set to `true`, a change to
    // the distribution after it's created isn't waited for.
    const waiter = this.part(
      "waiter",
      {
        distributionId: distribution.id,
        etag: distribution.etag,
        wait: wait ?? true,
      },
      { ignoreChanges: wait ? undefined : ["*"] },
    );
    this.deployed = waiter.isDone;
    this._domainUrl = domain
      ? output(`https://${domain.name}`)
      : output(undefined);

    if (domain?.dns) {
      // The DNS adapters name a record after its domain, with `*.` left out, so
      // `*.example.com` and `example.com` would have one name. The second one
      // has its place in the list added to its name.
      const seen: string[] = [];
      [domain.name, ...domain.aliases].forEach((recordName, i) => {
        const key = logicalName(recordName);
        domain.dns!.createAlias(
          seen.includes(key) ? `${name}${i}` : name,
          {
            name: recordName,
            aliasName: distribution.domainName,
            aliasZone: distribution.hostedZoneId,
          },
          this.delegateOpts(),
        );
        seen.push(key);
      });
    }

    if (domain?.redirects.length)
      this.part("redirect", {
        sourceDomains: domain.redirects,
        targetDomain: domain.name,
        cert: domain.cert,
        dns: domain.dns,
      });
  }

  /**
   * The CloudFront URL of the distribution.
   */
  public get url() {
    return interpolate`https://${this.whenDeployed(
      this.nodes.distribution.domainName,
    )}`;
  }

  /**
   * If the custom domain is enabled, this is the URL of the distribution with the
   * custom domain.
   */
  public get domainUrl() {
    return this._domainUrl;
  }

  /**
   * A value of the distribution, once the distribution is deployed: what a
   * component served through it reads.
   * @internal
   */
  public whenDeployed<T>(value: Input<T>): Output<T> {
    return all([this.deployed, value]).apply(([, value]) => value as T);
  }

  /**
   * Reference an existing CDN with the given distribution ID. This is useful when
   * you create a Router in one stage and want to share it in another. It avoids having to
   * create a new Router in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share Routers across stages.
   * :::
   *
   * @param name The name of the component.
   * @param distributionID The id of the existing CDN distribution.
   * @param opts Resource options.
   */
  public static get(
    name: string,
    distributionID: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Cdn(
      name,
      { existing: { distribution: distributionID } } as CdnArgs,
      opts,
    );
  }
}
