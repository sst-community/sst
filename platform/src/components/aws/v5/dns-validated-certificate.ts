import { ComponentResourceOptions, Output } from "@pulumi/pulumi";
import { acm } from "@pulumi/aws";
import { type ComponentArgs, component } from "../../parts-component";
import { plain } from "../../args";
import { logicalName } from "../../naming";
import { VisibleError } from "../../error";
import type { DnsAdapter } from "../../dns-adapter";

const parts = {
  /**
   * The ACM certificate.
   */
  certificate: acm.Certificate,
  /**
   * What waits for ACM to validate the certificate, once its DNS records are in.
   */
  validation: acm.CertificateValidation,
};

export interface DnsValidatedCertificateArgs
  extends ComponentArgs<typeof parts> {
  /**
   * The domain the certificate is for. A plain value: it decides the DNS records that
   * validate it.
   */
  domainName: string;
  /**
   * The other domains the certificate is for. Plain values, as `domainName` is.
   */
  alternativeNames?: string[];
  /**
   * What creates the DNS records that validate the certificate.
   */
  dns: DnsAdapter;
}

/**
 * The `DnsValidatedCertificate` component is internally used by other components to create
 * an [ACM certificate](https://docs.aws.amazon.com/acm/latest/userguide/acm-overview.html)
 * for a custom domain, validated with DNS records on the provider that hosts the domain.
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * It creates one validation record for each domain, and one for a domain and its wildcard,
 * as ACM validates both with the same record. The records are named after the domains, so a
 * preview shows them before the certificate exists.
 *
 * ---
 *
 * #### Switch from SST 4's certificate
 *
 * The components that create a certificate create this one once they're switched. The
 * certificate and its DNS records are kept. On a Cloudflare or a Vercel domain, its
 * CAA records are written again by resources of a new type, which the `sst` binary
 * serves, and take the records that are there; `sst migrate` takes SST 4's out of the
 * state. A few things are different:
 *
 * - `domainName`, `alternativeNames` and `dns` have to be plain values, not outputs.
 * - The records are named after the domains they validate, not after their names in DNS.
 * - The hosted zone of a record on Route 53 is found with SST's provider, so SST 4's
 *   `HostedZoneLookup` leaves the state.
 */
export class DnsValidatedCertificate extends component(
  "sst:aws:Certificate",
  parts,
) {
  private readonly records: {
    key: string;
    name: Output<string>;
    value: Output<string>;
  }[];

  constructor(
    name: string,
    args: DnsValidatedCertificateArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const of = `of the "${name}" certificate`;
    const why = "It decides the DNS records that validate it.";
    const domainName = plain(args.domainName, `The "domainName" ${of}`, why);
    const alternativeNames = plain(
      args.alternativeNames ?? [],
      `The "alternativeNames" ${of}`,
      why,
    ).map((alt) => plain(alt, `The "alternativeNames" ${of}`, why));
    const dns = plain(args.dns, `The "dns" ${of}`, why);

    const certificate = this.part("certificate", {
      domainName,
      validationMethod: "DNS",
      subjectAlternativeNames: alternativeNames,
    });

    // ACM validates a domain and its wildcard with one record. Records whose
    // domains make the same name have their place in the list added. What
    // each one is named after is known before anything is created on its
    // behalf, as the map reads it then.
    const domains = [
      ...new Set([domainName, ...alternativeNames].map(withoutWildcard)),
    ];
    const seen = new Set<string>();
    this.records = domains.map((domain, i) => {
      const named = logicalName(domain);
      const key = seen.has(named) ? `${domain}${i}` : domain;
      seen.add(named);
      const option = certificate.domainValidationOptions.apply((options) => {
        // ACM gives domains in lowercase
        const found = options.find(
          (o) =>
            withoutWildcard(o.domainName).toLowerCase() ===
            domain.toLowerCase(),
        );
        if (!found)
          throw new VisibleError(
            `ACM gave the "${name}" certificate no DNS record to validate "${domain}".`,
          );
        return found;
      });
      return {
        key,
        name: option.resourceRecordName,
        value: option.resourceRecordValue,
      };
    });

    // A domain other than Route 53 has to let Amazon issue its certificates
    const caa =
      dns.provider === "aws"
        ? []
        : dns.caa(name, domainName, this.delegateOpts());

    const records = this.records.map((record) =>
      dns.record(
        name,
        {
          type: "CNAME",
          key: record.key,
          name: record.name,
          value: record.value,
        },
        { ...this.delegateOpts(), dependsOn: caa },
      ),
    );

    this.part(
      "validation",
      { certificateArn: certificate.arn },
      { dependsOn: records },
    );
  }

  /**
   * The ARN of the certificate, once it's validated.
   */
  public get arn() {
    return this.nodes.validation.certificateArn;
  }

  /**
   * Each validation record: what it's named after, and its name in DNS.
   * @internal
   */
  public get _validationRecords() {
    return this.records.map(({ key, name }) => ({ key, name }));
  }
}

function withoutWildcard(domain: string) {
  return domain.replace(/^\*\./, "");
}
