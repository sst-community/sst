import { output } from "@pulumi/pulumi";
import type { DevReport } from "../../contract";
import type { Input } from "../../input";

/**
 * What `sst dev` runs for a database or a cache that's on the user's machine
 * in place of the one SST deploys: a pane that stays open and says what the
 * local server has to be set up with. Its title is the component's name.
 */
export function localServerPane(message: Input<string>): DevReport {
  return {
    command: "sst print-and-not-quit",
    environment: { SST_DEV_COMMAND_MESSAGE: message },
  };
}

/**
 * A password as the pane shows it, with an empty one shown as
 * "[no password]", in grey.
 */
export function shownPassword(password: Input<string>) {
  return output(password).apply(
    (password) => password || "\x1b[38;5;8m[no password]\x1b[0m",
  );
}
