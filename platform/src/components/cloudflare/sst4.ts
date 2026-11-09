import { leftOutComponent, renamedComponent } from "../sst4";

// SST 4's components that SST 5 doesn't have under the same name. Each fails
// with what to write, where it would fail with "is not a constructor".

/** @deprecated SST 4's name: it's `sst.cloudflare.StaticSite` in SST 5. */
export const StaticSiteV2 = renamedComponent(
  "sst.cloudflare.StaticSiteV2",
  "sst.cloudflare.StaticSite",
);

/** @deprecated SST 4's, which SST 5 doesn't have. */
export const Auth = leftOutComponent(
  "sst.cloudflare.Auth",
  "A stage deployed with it removes it with SST 4 first, or stays on SST 4.",
);

/** @deprecated SST 4's experimental Cloudflare components. */
export const x = {
  /** @deprecated SST 4's name: it's `sst.cloudflare.Astro` in SST 5. */
  Astro: renamedComponent("sst.cloudflare.x.Astro", "sst.cloudflare.Astro"),
  /** @deprecated SST 4's name: it's `sst.cloudflare.StaticSite` in SST 5. */
  StaticSite: renamedComponent(
    "sst.cloudflare.x.StaticSite",
    "sst.cloudflare.StaticSite",
  ),
  /** @deprecated SST 4's, which SST 5 doesn't have. */
  SolidStart: leftOutComponent(
    "sst.cloudflare.x.SolidStart",
    "A stage deployed with it removes it with SST 4 first, or stays on SST 4.",
  ),
};
