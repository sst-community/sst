import { takeover } from "../../takeover";
import { TanStackStart } from "../v5/tan-stack-start";
import { ssrSiteTakeover } from "./ssr-site";

takeover(
  TanStackStart,
  ssrSiteTakeover("TanStackStart", "when its code changes"),
);
