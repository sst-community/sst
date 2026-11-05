import { takeover } from "../../takeover";
import { OpenSearch } from "../open-search";

// Nothing moved: every part has the name and the place it had in 4.x. The map
// says the 4.x form has this 5.0 form, so a stage switches it with `sst
// migrate`, and a new stage refuses the 4.x one.
//
// With `dev` set, the 4.x one created a component for the pane `sst dev`
// shows, at the top of the app, which SST 5's reports in place of it: a
// move drops it, and there's nothing in the cloud behind it.
takeover(OpenSearch, {});
