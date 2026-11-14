import { workflow } from "sst/aws/workflow";

export const handler = workflow.handler<
  workflow.QueueMessage<{ jobId: string }>
>(async (event, ctx) => {
  await ctx.step("fetch", async ({ logger }) => {
    logger.info({
      message: "Importing",
      tenant: event.tenant,
      jobId: event.body.jobId,
    });
  });

  await ctx.wait("rate-limit", { minutes: 1 });

  await ctx.step("save", async ({ logger }) => {
    logger.info({ message: "Imported", tenant: event.tenant });
  });
});
