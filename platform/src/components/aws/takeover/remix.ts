import { takeover } from "../../takeover";
import { Remix } from "../v5/remix";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Remix, ssrSiteTakeover("Remix", "when its code changes"));
