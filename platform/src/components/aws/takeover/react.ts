import { takeover } from "../../takeover";
import { React } from "../v5/react";
import { ssrSiteTakeover } from "./ssr-site";

takeover(React, ssrSiteTakeover("React", "when its code changes"));
