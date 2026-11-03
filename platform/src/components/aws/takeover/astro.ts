import { takeover } from "../../takeover";
import { Astro } from "../v5/astro";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Astro, ssrSiteTakeover("Astro", "when its code changes"));
