import { takeover } from "../../takeover";
import { Astro } from "../astro";
import { ssrSiteTakeover } from "./ssr-site";

takeover(Astro, ssrSiteTakeover("Astro", "when its code changes"));
