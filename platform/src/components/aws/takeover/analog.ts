import { takeover } from "../../takeover";
import { Analog } from "../analog";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Analog, ssrSiteTakeover("Analog", "when its code changes"));
