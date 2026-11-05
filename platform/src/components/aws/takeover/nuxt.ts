import { takeover } from "../../takeover";
import { Nuxt } from "../nuxt";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Nuxt, ssrSiteTakeover("Nuxt", "when its code changes"));
