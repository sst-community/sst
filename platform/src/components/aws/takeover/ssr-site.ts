import { Resource } from "@pulumi/pulumi";
import type { Takeover } from "../../takeover";
import { logicalName } from "../../naming";
import type { SsrSiteParts } from "../helpers/ssr-site";
import { childWithin, sstResource } from "./helpers";

// With `warm`, a 4.x site kept a warmer for each region in a `Cron` of its
// own, inside the site: a function, the rule that runs it, the rule's target
// and the permission to run it. A 5.0 site keeps them in the site.
const CRON = "sst:aws:Cron";
const warmer = (
  site: Resource,
  name: string,
  id: string | undefined,
  child: string,
) => childWithin(CRON, `${name}Warmer${logicalName(id!)}`, child, site);

/**
 * What every site with a server takes over from its 4.x form, which SST 4's
 * `SsrSite` created the same way for each framework. A site's own map adds
 * what's its own.
 *
 * @param label The component's name: `Astro`, for `sst.aws.Astro`.
 * @param warmedWhen When the 5.0 site warms its server again, with `warm`.
 */
export function ssrSiteTakeover(
  label: string,
  warmedWhen: string,
): Takeover<SsrSiteParts, Resource> {
  return {
    moved: {
      warmer: (site, { name, id }) => warmer(site, name, id, "Handler"),
      warmerRule: (site, { name, id }) => warmer(site, name, id, "Rule"),
      warmerTarget: (site, { name, id }) => warmer(site, name, id, "Target"),
      warmerPermission: (site, { name, id }) =>
        warmer(site, name, id, "Permission"),
    },
    // The site's files and its entries in the key-value store were SST's own
    // dynamic resources
    released: {
      assetFiles: (_, { name }) =>
        sstResource("BucketFiles", { name: `${name}AssetFiles` }),
      kvKeys: (_, { name }) => sstResource("KvKeys", { name: `${name}KvKeys` }),
    },
    replaced: {
      prewarm: `The server is warmed once. sst.aws.${label} warmed it on every deploy; this warms it ${warmedWhen}.`,
    },
  };
}
