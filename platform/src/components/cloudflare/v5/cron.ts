import { type ComponentResourceOptions, output } from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import { type ComponentArgs, component, named } from "../../parts-component";
import type { Input } from "../../input";
import { notAnExistingPart, notAnOption } from "../../args";
import { DEFAULT_ACCOUNT_ID } from "../account-id";
import { workerArgsOf } from "../helpers/worker-part";
import { Worker, type WorkerArgs } from "./worker";

const parts = () => ({
  /**
   * The Worker that runs on the schedules. Its script is named after it,
   * `MyCronJobHandlerScript`.
   */
  worker: named(Worker, "Handler"),
  /**
   * The Cloudflare Worker Cron Trigger that runs the Worker on the schedules.
   */
  trigger: cf.WorkersCronTrigger,
});

export interface CronArgs extends ComponentArgs<typeof parts> {
  /**
   * The worker that'll be executed when the cron job runs: the path to its
   * handler, or the Worker's args.
   *
   * It decides how the Worker is created, so it's a plain value, not an
   * output. What's in the Worker's args can be an output.
   *
   * @example
   *
   * ```ts
   * {
   *   worker: "src/cron.ts"
   * }
   * ```
   *
   * You can pass in the full worker props.
   *
   * ```ts
   * {
   *   worker: {
   *     handler: "src/cron.ts",
   *     link: [bucket]
   *   }
   * }
   * ```
   */
  worker: string | WorkerArgs;
  /**
   * The schedule for the cron job.
   *
   * :::note
   * The cron job continues to run even after you exit `sst dev`.
   * :::
   *
   * @example
   *
   * You can use a [cron expression](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions).
   *
   * ```ts
   * {
   *   schedules: ["* * * * *"]
   *   // schedules: ["*\/30 * * * *"]
   *   // schedules: ["45 * * * *"]
   *   // schedules: ["0 17 * * sun"]
   *   // schedules: ["10 7 * * mon-fri"]
   *   // schedules: ["0 15 1 * *"]
   *   // schedules: ["59 23 LW * *"]
   * }
   * ```
   */
  schedules: Input<string[]>;
  /**
   * The Cloudflare account ID to use for this Cron and its worker.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * The `Cron` component lets you add cron jobs to your app using Cloudflare.
 * It uses [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
 *
 * @example
 * #### Minimal example
 *
 * Create a worker file that exposes a `scheduled` handler:
 *
 * ```ts title="cron.ts"
 * export default {
 *   async scheduled() {
 *     console.log("Running on a schedule");
 *   },
 * };
 * ```
 *
 * Pass in a `schedules` and a `worker` that'll be executed.
 *
 * ```ts title="sst.config.ts"
 * new sst.cloudflare.v5.Cron("MyCronJob", {
 *   worker: "cron.ts",
 *   schedules: ["* * * * *"]
 * });
 * ```
 *
 * #### Customize the worker
 *
 * ```js title="sst.config.ts"
 * new sst.cloudflare.v5.Cron("MyCronJob", {
 *   schedules: ["* * * * *"],
 *   worker: {
 *     handler: "cron.ts",
 *     link: [bucket]
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.cloudflare.Cron`
 *
 * Change `sst.cloudflare.Cron` to `sst.cloudflare.v5.Cron` and keep the name.
 * The Worker and the trigger are kept.
 *
 * - `job`, which SST 4 deprecated, is refused: use `worker`.
 * - `worker` is a plain value, not an output: whether it's a handler or the
 *   Worker's args decides how the Worker is created. Inside the args, `link`
 *   and `domain` are plain values too, as
 *   [`sst.cloudflare.v5.Worker`](/docs/component/cloudflare/v5/worker) takes
 *   them, and what else is in them can be an output.
 * - The Worker is [`sst.cloudflare.v5.Worker`](/docs/component/cloudflare/v5/worker),
 *   inside the cron job, where SST 4 created it at the top of your app. It
 *   keeps its name. You can change it in `transform.worker` now.
 * - `nodes.worker` is the Worker component, where it was the Worker's script:
 *   the script is `nodes.worker.nodes.worker`. `nodes.trigger` is the trigger,
 *   where it was an output of it.
 * - The trigger is created directly, where SST 4 created it once `schedules`
 *   was known. So a function in `transform.trigger` is given its `schedules`
 *   as an output, where SST 4 gave it a plain array.
 * - The Worker is created with the provider the cron job has. SST 4 created
 *   it with your app's provider, whatever the cron job had, so if your cron
 *   job has a `provider`, or takes one from a parent component or from
 *   `providers`, its Worker is replaced on switch, which
 *   `sst migrate --check` refuses: remove the cron job and deploy before you
 *   switch, then add it back.
 */
export class Cron extends component("sst:cloudflare:Cron", parts) {
  constructor(name: string, args: CronArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const owner = `the "${name}" cron job`;
    notAnOption(args, "job", `Use "worker": "job" was its old name.`, owner);
    notAnExistingPart(
      args.existing,
      "worker",
      owner,
      `Pass the handler or the Worker's args in "worker": the cron job creates the Worker it runs.`,
    );
    notAnExistingPart(
      args.existing,
      "trigger",
      owner,
      `The trigger is the cron job's own: set when it runs with "schedules".`,
    );

    const worker = workerArgsOf(args.worker, `"worker"`, owner);

    const script = this.part("worker", {
      accountId: args.accountId,
      ...worker,
    }).nodes.worker;
    this.part("trigger", {
      accountId: args.accountId ?? DEFAULT_ACCOUNT_ID,
      scriptName: script.scriptName,
      schedules: output(args.schedules).apply((schedules) =>
        schedules.map((cron) => ({ cron })),
      ),
    });
  }
}
