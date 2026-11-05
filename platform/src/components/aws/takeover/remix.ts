import { takeover } from "../../takeover";
import { Remix } from "../remix";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Remix, ssrSiteTakeover("Remix", "when its code changes"));
