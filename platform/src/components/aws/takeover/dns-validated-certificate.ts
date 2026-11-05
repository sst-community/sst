import { sstResource, takeover } from "../../takeover";
import { logicalName } from "../../naming";
import { DnsValidatedCertificate } from "../dns-validated-certificate";

// 4.x named a validation record after its name in DNS, which only the
// certificate knows, once it's created: `<certificate>CNAMERecord<name>`. The
// V5 certificate names it after the domain it validates, which a preview
// knows. Its old name comes from the certificate, which a move keeps.
//
// 4.x also looked up each record's hosted zone with a resource, which the V5
// one does with a function of SST's provider. Those leave the state: `sst
// migrate` releases them, as nothing in the cloud is behind them.
//
// On a Cloudflare or a Vercel domain, the CAA records Amazon needs to issue
// the certificate were SST's own dynamic resources, which add their kind to
// their name. The ones in their place take the records that are there.
takeover(DnsValidatedCertificate, {
  delegated: (certificate, { name, componentName }) => {
    for (const record of certificate._validationRecords) {
      const prefix = `${componentName}CNAMERecord`;
      if (name !== `${prefix}${logicalName(record.key)}`) continue;
      return {
        name: record.name.apply(
          (dnsName) => `${prefix}${logicalName(dnsName)}`,
        ),
      };
    }
  },
  delegatedReleased: (_, { name, type }) => {
    if (type === "sst:cloudflare:DnsRecord")
      return sstResource("cloudflare.DnsRecord", { name });
    if (type === "sst:vercel:DnsRecord")
      return sstResource("vercel.DnsRecord", { name });
  },
});
