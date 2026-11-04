import { takeover } from "../../takeover";
import { ReactRouter } from "../v5/react-router";

// SST 4 created the site's Worker inside it, as `<Name>Worker`, which the
// part is named, so nothing moved. The command that built the site goes: it
// has nothing in Cloudflare behind it.
takeover(ReactRouter, {});
