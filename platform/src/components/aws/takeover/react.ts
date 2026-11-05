import { takeover } from "../../takeover";
import { React } from "../react";
import { ssrSiteTakeover } from "./ssr-site";

takeover(React, ssrSiteTakeover("React", "when its code changes"));
