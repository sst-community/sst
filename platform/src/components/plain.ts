import { runtime } from "@pulumi/pulumi";
import { underCore } from "./context";
import { Link } from "./link";

// The setup of a run of a program Pulumi runs on its own, in place of SST's
// entry (platform/src/auto/run.ts), which only SST's CLI runs: the link
// records, which `sst dev` reads for a dev command's links, and the check of
// the components' names. `sst/components` and each group import it, so it's
// done as the components load: Pulumi loads the program inside its stack,
// before the program makes anything. Loaded where no stack runs, as a test
// does before its mock, nothing is set up. An Automation API program loaded
// outside the stack it runs in isn't set up either.
if (!underCore() && runtime.getStackResource()) Link.reset();
