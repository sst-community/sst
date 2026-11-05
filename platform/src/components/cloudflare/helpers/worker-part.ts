import { plain } from "../../args";
import { VisibleError } from "../../error";
import type { WorkerArgs } from "../worker";

/**
 * The args of a Worker a component creates, from what it's given: the path
 * to the Worker's handler, or the Worker's args. Either is a plain value,
 * since which it is decides how the Worker is created. What's in the args
 * can be an output.
 *
 * ```ts
 * const worker = workerArgsOf(args.worker, `"worker"`, `the "${name}" cron job`);
 * this.part("worker", { accountId: args.accountId, ...worker });
 * ```
 *
 * @param what The arg, in messages: `"worker"`, for `The "worker" of the
 * "MyCron" cron job`.
 * @param owner The component, in messages: `the "MyCron" cron job`.
 */
export function workerArgsOf(
  definition: string | WorkerArgs | undefined,
  what: string,
  owner: string,
): WorkerArgs {
  const given = plain(
    definition,
    `The ${what} of ${owner}`,
    "Whether it's a handler or the Worker's args decides how the Worker is created.",
  );
  if (given === undefined || given === null)
    throw new VisibleError(
      `${owner[0].toUpperCase()}${owner.slice(
        1,
      )} is given no ${what}: pass the path to the Worker's handler, or the Worker's args.`,
    );
  const args = typeof given === "string" ? { handler: given } : given;
  if (!args.handler)
    throw new VisibleError(
      `The ${what} of ${owner} needs a "handler": pass the path to the Worker's handler, or the Worker's args with one.`,
    );
  return args;
}
