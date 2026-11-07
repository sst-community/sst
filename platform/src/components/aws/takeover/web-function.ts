import { takeover } from "../../takeover";
import { WebFunction } from "../web-function";

// Nothing moved. The map says the 4.x form has this 5.0 form, so a stage
// switches it with `sst migrate`, and a new stage refuses the 4.x one.
//
// Every part has the name and the place it had in 4.x: the code's zip and the
// bucket's versioning keep theirs with `named()`. In `sst dev`, the 4.x one
// created a component for the pane `sst dev` shows, which SST 5's reports in
// place of it: a move drops it, and there's nothing in the cloud behind it.
takeover(WebFunction, {});
