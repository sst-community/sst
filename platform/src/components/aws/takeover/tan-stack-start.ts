import { takeover } from "../../takeover";
import { TanStackStart } from "../tan-stack-start";
import { ssrSiteTakeover } from "./ssr-site";

takeover(
  TanStackStart,
  ssrSiteTakeover("TanStackStart", "when its code changes"),
);
