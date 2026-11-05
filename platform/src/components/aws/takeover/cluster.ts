import { takeover } from "../../takeover";
import { Cluster } from "../cluster";

// Nothing moved. The map says the 4.x form has this 5.0 form, so a stage
// switches it with `sst migrate`, and a new stage refuses the 4.x one.
takeover(Cluster, {});
