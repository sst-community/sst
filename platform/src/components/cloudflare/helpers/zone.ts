import { type Input, type Output, type Resource, all } from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import { VisibleError } from "../../error";

/**
 * The Cloudflare zone a domain is in: the longest one the domain ends with.
 * It's found with Cloudflare's provider, not with a resource, so a preview
 * finds it too. SST 4 looked it up with a resource, `ZoneLookup`.
 */
export function zoneOf(
  domain: Input<string>,
  accountId: Input<string>,
  parent?: Resource,
): { id: Output<string>; name: Output<string> } {
  const found = all([domain, accountId]).apply(async ([domain, accountId]) => {
    const name = domain.replace(/\.$/, "");
    const labels = name.split(".");
    for (let i = 0; i <= labels.length - 2; i++) {
      const candidate = labels.slice(i).join(".");
      const zones = await cloudflare.getZones(
        { name: candidate, account: { id: accountId } },
        { parent },
      );
      const zone = zones.results.find((z) => z.name === candidate);
      if (zone) return { id: zone.id, name: zone.name };
    }
    throw new VisibleError(`Could not find hosted zone for domain ${name}`);
  });
  return { id: found.id, name: found.name };
}
