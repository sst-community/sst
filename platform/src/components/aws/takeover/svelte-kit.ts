import { takeover } from "../../takeover";
import { SvelteKit } from "../svelte-kit";
import { ssrSiteTakeover } from "./ssr-site";

takeover(SvelteKit, ssrSiteTakeover("SvelteKit", "when its code changes"));
