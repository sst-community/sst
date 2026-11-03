import { takeover } from "../../takeover";
import { MicroVm } from "../v5/microvm";

// Every part has the name and the place it had in 4.x. In `sst dev`, the 4.x
// one created a component for the pane `sst dev` shows, which the V5 one
// reports in place of it: a move drops it, and there's nothing in the cloud
// behind it.
takeover(MicroVm, {});
