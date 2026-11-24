// A chain of model calls: each call is a step, so a failure in the third doesn't
// pay for the first two again. Each tenant is limited, so one can't use up the
// model's rate limit.
// Inngest: https://www.inngest.com/ai
//
// Inngest's step.ai.infer isn't supported. Call the model in a step.run.
import { flow, services } from "../client";

export const summarizeDocument = flow.createFunction(
  {
    id: "summarize-document",
    triggers: { event: "document/uploaded" },
    retries: 5,
    concurrency: [{ limit: 2, key: "event.tenant" }, { limit: 10 }],
    throttle: { limit: 60, period: "1m" },
  },
  async ({ event, step }) => {
    const text = await step.run("extract", () => services.model("extract", event.data.url));
    // Two calls at once.
    const [summary, labels] = await Promise.all([
      step.run("summarize", () => services.model("summarize", text)),
      step.run("classify", () => services.model("classify", text)),
    ]);
    await step.run("save", () => ({ summary, labels }));
    return { summary, labels };
  },
);
