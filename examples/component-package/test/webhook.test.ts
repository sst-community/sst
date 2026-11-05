import { expect, test } from "vitest";
import { Function } from "sst/components/aws";
import { mock } from "sst/testing";

// Nothing is deployed, so a resource has only its inputs, an id and an ARN.
// Give the function's URL the address AWS would.
const app = await mock({
  state: (r) =>
    r.type === "aws:lambda/functionUrl:FunctionUrl"
      ? { functionUrl: `https://${r.name}.lambda-url.us-east-1.on.aws/` }
      : {},
});
const { Webhook } = await import("../src/index");

test("puts each delivery on a queue", async () => {
  app.reset();
  new Webhook("Payments", { retention: 86400 });
  await app.settle();

  const queue = app.resources.find((r) => r.type === "aws:sqs/queue:Queue");
  expect(queue?.inputs.messageRetentionSeconds).toBe(86400);

  const receiver = app.resources.find((r) => r.type === "aws:lambda/function:Function");
  expect(receiver?.inputs.environment.variables.QUEUE_URL).toContain("PaymentsQueue");
});

test("runs the handler the package ships", async () => {
  app.reset();
  new Webhook("Payments");
  await app.settle();

  const receiver = app.graph().find((r) => r.type === "sst:aws:Function");
  expect(receiver?.build?.handler).toMatch(/dist\/receiver\.handler$/);
});

test("lets a function that links it read the queue", async () => {
  app.reset();
  const hook = new Webhook("Payments");
  new Function("Worker", { handler: "src/worker.handler", link: [hook] });
  await app.settle();

  const role = app.resources.find((r) => r.name === "WorkerRole");
  expect(JSON.stringify(role?.inputs)).toContain("sqs:ReceiveMessage");

  // What the function reads as `Resource.Payments`
  const worker = app.graph().find((r) => r.name === "Worker");
  expect(worker?.build?.links.Payments).toEqual({
    url: "https://PaymentsReceiverUrl.lambda-url.us-east-1.on.aws/",
    queue: expect.stringContaining("PaymentsQueue"),
    type: "acme.index.Webhook",
  });
});
