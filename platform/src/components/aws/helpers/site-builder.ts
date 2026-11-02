import { output, CustomResourceOptions } from "@pulumi/pulumi";
import { local } from "@pulumi/command";
import { siteBuilds } from "./site-build.js";

export function siteBuilder(
  name: string,
  args: local.CommandArgs,
  opts?: CustomResourceOptions,
) {
  // Wait for all arg values to be resolved before acquiring the semaphore.
  return output(args).apply(async (args) => {
    // Shared with the sites built in the program, so they take turns
    const limiter = siteBuilds();
    await limiter.acquire(name);

    let waitOn;

    const command = new local.Command(name, args, opts);
    waitOn = command.urn;

    // When running `sst diff` or `sst refresh`, `local.Command`'s `create` and `update` are not called.
    // So we also run `local.runOutput` to get the output of the command.
    if ($cli.command === "diff" || $cli.command === "refresh") {
      waitOn = local.runOutput(
        {
          command: args.create!,
          dir: args.dir,
          environment: args.environment,
        },
        opts,
      ).stdout;
    }

    return waitOn.apply(() => {
      limiter.release();
      return command;
    });
  });
}
