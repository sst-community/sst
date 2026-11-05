import { takeover } from "../../takeover";
import { SolidStart } from "../solid-start";
import { ssrSiteTakeover } from "./ssr-site";

takeover(SolidStart, ssrSiteTakeover("SolidStart", "when its code changes"));
