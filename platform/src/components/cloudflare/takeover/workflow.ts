import { takeover } from "../../takeover";
import { Workflow } from "../workflow";

// Nothing moved: the Worker keeps the name the 4.x `Workflow` gave it. The
// map says the 4.x form has this 5.0 form, so a stage switches it with `sst
// migrate`, and a new stage refuses the 4.x one.
takeover(Workflow, {});
