import { takeover } from "../../takeover";
import { StaticSite } from "../static-site";

// SST 4's `StaticSiteV2` created its Worker inside the site, as `<Name>Router`,
// which the part is named, so nothing moved. The command that built the site
// goes: it has nothing in Cloudflare behind it.
//
// SST 4's first, deprecated `StaticSite` has the same type, so the CLI takes
// this map for it too, but it isn't what this replaces: it kept the site's
// files in a KV namespace, with a Worker of its own. A stage that has one
// moves it to `StaticSiteV2` with SST 4 before it moves, or
// `sst migrate --check` refuses the switch, which would delete the namespace.
// A `$transform` for it reaches this one too, by the same type.
takeover(StaticSite, {});
