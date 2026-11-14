import { runtime } from "@pulumi/pulumi";
import { underCore } from "./context";
import { beforeEachComponent } from "./component";
import { Link } from "./link";

// The setup of a run of a program Pulumi runs on its own, in place of SST's
// entry (platform/src/auto/run.ts), which only SST's CLI runs: the link
// records, which `sst dev` reads for a dev command's links, and the check of
// the components' names. `sst/components` and each group import it.
//
// It's done once for each stack, as the components load: Pulumi loads the
// program inside its stack, before the program makes anything. An Automation
// API program is loaded outside the stack it runs in, and can run in more
// than one: it's done there when the first component is created in a stack,
// so a resource of Pulumi's made linkable that comes before it isn't
// checked. Loaded where no stack runs, as a test does before its mock,
// nothing is set up.
let setUpFor: unknown;

function setUp() {
  if (underCore()) return;
  const stack = runtime.getStackResource();
  if (stack === undefined || stack === setUpFor) return;
  setUpFor = stack;
  Link.reset();
}

setUp();
beforeEachComponent(setUp);
