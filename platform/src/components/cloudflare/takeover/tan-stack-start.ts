import { takeover } from "../../takeover";
import { TanStackStart } from "../v5/tan-stack-start";

// SST 4 created the site's Worker inside it, as `<Name>Worker`, which the
// part is named, so nothing moved. The command that built the site goes: it
// has nothing in Cloudflare behind it.
takeover(TanStackStart, {});
