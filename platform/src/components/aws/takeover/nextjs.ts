import { takeover } from "../../takeover";
import { logicalName } from "../../naming";
import { Nextjs } from "../v5/nextjs";
import { childWithin, sstResource } from "./helpers";

// With `warm`, the 4.x `Nextjs` kept a warmer for each region in a `Cron` of
// its own, inside the site: a function, the rule that runs it, the rule's
// target and the permission to run it. The V5 one keeps them in the site.
const CRON = "sst:aws:Cron";
const warmer = (
  site: Nextjs,
  name: string,
  id: string | undefined,
  child: string,
) => childWithin(CRON, `${name}Warmer${logicalName(id!)}`, child, site);

takeover(Nextjs, {
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
    revalidationSeed:
      "The ISR data is seeded again once. sst.aws.Nextjs seeded it on every deploy; this seeds it when it changes.",
    prewarm:
      "The server is warmed once. sst.aws.Nextjs warmed it on every deploy; this warms it when the site is built.",
  },
});
