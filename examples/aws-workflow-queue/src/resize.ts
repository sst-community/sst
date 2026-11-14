import type { SQSEvent } from "aws-lambda";
import { workflow } from "sst/aws/workflow";

export const handler = workflow.handler<SQSEvent>(async (event, ctx) => {
  // The batch size is 1, so there's one message.
  const [record] = event.Records;
  const tenant = record.attributes.MessageGroupId;
  const { jobId } = JSON.parse(record.body) as { jobId: string };

  await ctx.step("resize", async ({ logger }) => {
    logger.info({
      message: "Resizing",
      tenant,
      jobId,
      waitedMs: Date.now() - Number(record.attributes.SentTimestamp),
    });
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  });
});
