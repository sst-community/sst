import { takeover } from "../../takeover";
import { Analog } from "../v5/analog";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Analog, ssrSiteTakeover("Analog", "when its code changes"));
