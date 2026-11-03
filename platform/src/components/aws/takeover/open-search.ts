import { takeover } from "../../takeover";
import { OpenSearch } from "../v5/open-search";

// Every part has the name and the place it had in 4.x. With `dev` set, the
// 4.x one created a component for the pane `sst dev` shows, at the top of the
// app, which the V5 one reports in place of it: a move drops it, and there's
// nothing in the cloud behind it.
takeover(OpenSearch, {});
