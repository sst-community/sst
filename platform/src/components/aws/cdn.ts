import {
  ComponentResourceOptions,
  Input,
  Output,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { cloudfront } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../parts-component";
import type { Prettify } from "../component";
import { plain, usedAsItIs, getArgs } from "../args";
import { logicalName } from "../naming";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { HttpsRedirect } from "./https-redirect";
import { DistributionDeploymentWaiter } from "./resources/distribution-deployment-waiter";
import { useProvider } from "./helpers/provider";
import { type DomainArgs, domainOf } from "./helpers/domain";

const parts = {
  /**
   * The Amazon CloudFront distribution.
   */
  distribution: cloudfront.Distribution,
  /**
   * What waits for the distribution to be deployed: when it's created, and with
   * `wait: true` after each change too. With `wait: false` it doesn't wait. Not created
   * for a distribution that's passed in `existing`.
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

export interface CdnDomainArgs extends DomainArgs {
  /**
   * Alternate domains to be used. Visitors to the alternate domains will be redirected to the
   * main `name`. A plain list: each one has DNS records of its own.
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
   * on this alias domain. A plain list: each one has DNS records of its own, and is on the
   * certificate.
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
   * CloudFront takes its certificate from the `us-east-1` region. The one that's created
   * for you is created there, and one you pass in has to be there too.
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
   * completing the deployment of the app. What uses its URL doesn't wait for it: to
   * have something wait, give it `dependsOn: [cdn.nodes.waiter]`. It has to be a plain
   * value.
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
  const { name, dns, cert } = domainOf(domain, owner);
  const given: CdnDomainArgs =
    typeof domain === "string" ? { name: domain } : domain;
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
  return { name, aliases, redirects, dns, cert };
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
 * #### Switch from SST 4's `sst.aws.Cdn`
 *
 * The components that create a `Cdn` create this one once they're switched. The
 * distribution, its certificate, its DNS records and its redirect are kept. What waits
 * for the distribution to deploy is a resource of a new type, which the `sst` binary
 * serves: `sst migrate` takes SST 4's out of the state, and the new one waits once. A
 * few things are written differently:
 *
 * - `domain`, with its `name`, `aliases` and `redirects`, and `wait` have to be plain
 *   values, not outputs.
 * - `nodes.distribution` is the distribution itself. In SST 4's `Cdn` it was an output
 *   of it.
 * - `transform` also takes the `waiter`, the `certificate` and the `redirect`.
 * - `domain.dns` is an adapter SST 5's components use, like SST 4's `dns()`,
 *   SST 4's `dns()` or `sst.vercel.dns()`. An object written by hand for
 *   SST 4's adapters doesn't work.
 * - The DNS records that validate the certificate are named after the domains they
 *   validate, and a domain's hosted zone is found without a resource: SST 4's
 *   `HostedZoneLookup` and `ZoneLookup` leave the state.
 * - A CDN with `domain.redirects`, created with a provider of its own, gives its
 *   redirect's CloudFront function that provider, and keeps it: SST 4 created it with
 *   the app's provider.
 */
export class Cdn extends component("sst:aws:CDN", parts) {
  private readonly _domainUrl: Output<string | undefined>;

  constructor(name: string, args: CdnArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const existing = this.existingPart("distribution");
    if (existing) {
      // A distribution that's deployed is used the way it is
      usedAsItIs(
        args,
        [
          "comment",
          "origins",
          "originGroups",
          "defaultCacheBehavior",
          "orderedCacheBehaviors",
          "defaultRootObject",
          "customErrorResponses",
          "domain",
          "wait",
          "tags",
          "webAclArn",
        ],
        "distribution",
        `the "${name}" CDN`,
      );
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
    // the distribution after it's created isn't waited for. The deploy waits
    // for it at its end; what reads the distribution doesn't, as in SST 4,
    // whose waiter was created inside an `apply`, so reading it waited for
    // nothing. Something that needs it deployed depends on the waiter.
    this.part(
      "waiter",
      {
        distributionId: distribution.id,
        etag: distribution.etag,
        wait: wait ?? true,
      },
      { ignoreChanges: wait ? undefined : ["*"] },
    );
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
        domain.dns!.alias(
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
    return interpolate`https://${this.nodes.distribution.domainName}`;
  }

  /**
   * If the custom domain is enabled, this is the URL of the distribution with the
   * custom domain.
   */
  public get domainUrl() {
    return this._domainUrl;
  }

  /**
   * Reference an existing CDN with the given distribution ID: one that's deployed, like
   * one another stage created. Its distribution is used as it is. A `Router` that's
   * referenced with its own `get` is served through one, which is how a router is
   * shared across stages.
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
      getArgs({ existing: { distribution: distributionID } }) as CdnArgs,
      opts,
    );
  }
}
