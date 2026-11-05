import { takeover } from "../../takeover";
import { Nextjs } from "../nextjs";
import { ssrSiteTakeover } from "./ssr-site";

const site = ssrSiteTakeover("Nextjs", "when the site is built");

takeover(Nextjs, {
  ...site,
  replaced: {
    ...site.replaced,
    revalidationSeed:
      "The ISR data is seeded again once. sst.aws.Nextjs seeded it on every deploy; this seeds it when it changes.",
  },
});
