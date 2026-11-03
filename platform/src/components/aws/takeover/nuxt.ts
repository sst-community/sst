import { takeover } from "../../takeover";
import { Nuxt } from "../v5/nuxt";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Nuxt, ssrSiteTakeover("Nuxt", "when its code changes"));
