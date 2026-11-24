// A trial's lifecycle: a nudge before it ends, then the end, unless the user
// upgrades first.
// Inngest: https://www.inngest.com/uses/scheduled-jobs
import { flow, services } from "../client";

export const trial = flow.createFunction(
  {
    id: "trial",
    triggers: { event: "user/trial.started" },
    cancelOn: [{ event: "user/upgraded", match: "data.userId" }],
  },
  async ({ event, step }) => {
    await step.sleep("until-reminder", event.data.remindAfter ?? "11d");
    await step.run("nudge", () => services.email(event.data.email, "Your trial ends in 3 days"));
    await step.sleep("until-end", event.data.endAfter ?? "3d");
    await step.run("end-trial", () => services.billing("end-trial", event.data.userId));
  },
);
