import { takeover } from "../../takeover";
import { SolidStart } from "../v5/solid-start";
import { ssrSiteTakeover } from "./ssr-site";

takeover(SolidStart, ssrSiteTakeover("SolidStart", "when its code changes"));
