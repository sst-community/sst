// Human in the loop: draft, wait for a person to approve, then act. A waiting run
// costs nothing.
// Inngest: https://www.inngest.com/ai
import { flow, services } from "../client";

export const publishPost = flow.createFunction(
  { id: "publish-post", triggers: { event: "post/drafted" } },
  async ({ event, step }) => {
    const draft = await step.run("draft", () => services.model("draft", event.data.topic));
    const review = await step.waitForEvent("wait-for-review", {
      event: "post/reviewed",
      timeout: "7d",
      if: "async.data.postId == event.data.postId && async.data.approved == true",
    });
    if (!review) return { status: "not approved" };
    await step.run("publish", () => services.slack(`Published: ${draft}`));
    return { status: "published" };
  },
);
