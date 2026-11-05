import { takeover } from "../../takeover";
import { RateLimit } from "../rate-limit";

// It creates nothing in Cloudflare. The map says the 4.x form has this 5.0
// form, so a stage switches it with `sst migrate`, and a new stage refuses
// the 4.x one.
takeover(RateLimit, {});
