import { Resource } from "sst";
import { workflow } from "sst/aws/workflow";

export const handler = workflow.dispatcher<{ jobId: string }>(
  Resource.Import,
  { name: (message) => `import-${message.body.jobId}` },
);
