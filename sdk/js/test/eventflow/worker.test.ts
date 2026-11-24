import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExecutionStatus, LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { Cluster, sdk, settle, waitFor, finishRuns } from "./harness.ts";

const { NonRetriableError, RetryAfterError } = sdk;

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await finishRuns();
  await LocalDurableTestRunner.teardownTestEnvironment();
});

describe("runs", () => {
  it("routes an event to its function and runs the steps", async () => {
    const calls: string[] = [];
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "hello", triggers: { event: "app/hello" } }, async ({ event, step }) => {
        const greeting = await step.run("greet", () => {
          calls.push("greet");
          return `hi ${event.data.name}`;
        });
        await step.sleep("pause", "1h");
        return step.run("shout", () => greeting.toUpperCase());
      }),
    ]);

    const { ids } = await cluster.flow.send({ name: "app/hello", data: { name: "ada" } });
    expect(ids).toHaveLength(1);
    await cluster.drain();

    const run = cluster.runOf("hello");
    const result = await run.result;
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(result.getResult()).toBe("HI ADA");
    expect(calls).toEqual(["greet"]);
    expect(run.runner.getOperation("pause").getWaitDetails()?.waitSeconds).toBe(3600);
  });

  it("retries a step, and stops on a NonRetriableError", async () => {
    let flaky = 0;
    let fatal = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "flaky", retries: 3, triggers: { event: "go" } }, async ({ step }) =>
        step.run("call-api", () => {
          if (++flaky < 3) throw new Error("503");
          return "ok";
        }),
      ),
      flow.createFunction({ id: "fatal", triggers: { event: "go" } }, async ({ step }) =>
        step.run("call-api", () => {
          fatal++;
          throw new NonRetriableError("bad request");
        }),
      ),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();

    const ok = await cluster.runOf("flaky").result;
    expect(ok.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(flaky).toBe(3);

    const failed = await cluster.runOf("fatal").result;
    expect(failed.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(fatal).toBe(1);
  });

  it("fails the run once a step uses up its retries", async () => {
    let attempts = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "exhaust", retries: 2, triggers: { event: "go" } }, async ({ step }) =>
        step.run("call-api", () => {
          attempts++;
          throw new Error("down");
        }),
      ),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    const result = await cluster.runOf("exhaust").result;
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(attempts).toBe(3);
    expect(result.getError().errorMessage).toContain("down");
  });

  it("waits as long as a RetryAfterError says", async () => {
    let attempts = 0;
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "later", triggers: { event: "go" } }, async ({ step }) =>
        step.run("call-api", () => {
          if (++attempts === 1) throw new RetryAfterError("rate limited", "90s");
          return attempts;
        }),
      ),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    const result = await cluster.runOf("later").result;
    expect(result.getResult()).toBe(2);
  });

  it("runs onFailure after the run fails", async () => {
    const seen: any[] = [];
    const cluster = new Cluster((flow) => [
      flow.createFunction(
        {
          id: "with-failure",
          retries: 0,
          triggers: { event: "go" },
          onFailure: async ({ error, event, step }: any) => {
            await step.run("notify", () => seen.push({ message: error.message, name: event.name, original: event.data.event.name }));
          },
        },
        async ({ step }) => step.run("boom", () => { throw new Error("kaput"); }),
      ),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    const result = await cluster.runOf("with-failure").result;
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(seen).toEqual([{ message: "kaput", name: "inngest/function.failed", original: "go" }]);
  });

  it("gives repeated step IDs the suffixes Inngest does", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "loop", triggers: { event: "go" } }, async ({ step }) => {
        for (let i = 0; i < 3; i++) await step.run("item", () => i);
      }),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    const run = cluster.runOf("loop");
    await run.result;
    expect(run.runner.getOperation("item:2").getStepDetails()?.result).toBe(2);
  });

  it("runs steps started together", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "parallel", triggers: { event: "go" } }, async ({ step }) => {
        const [a, b] = await Promise.all([step.run("a", () => 1), step.run("b", () => 2)]);
        return a + b;
      }),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    expect((await cluster.runOf("parallel").result).getResult()).toBe(3);
  });

  it("throws when a run reads `attempt`", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "attempt", triggers: { event: "go" } }, async (ctx: any) => ctx.attempt),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    const result = await cluster.runOf("attempt").result;
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(result.getError().errorMessage).toContain("attempt");
  });
});

describe("limits", () => {
  it("fails a sleep longer than a run can last, with what to change", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "far", triggers: { event: "go" } }, async ({ step }) => {
        await step.sleepUntil("later", "2099-01-01T00:00:00Z");
      }),
    ]);
    await cluster.flow.send({ name: "go" });
    await cluster.drain();
    const result = await cluster.runOf("far").result;
    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(result.getError().errorMessage).toContain("timeout.execution");
  });
});

describe("sendEvent and invoke", () => {
  it("sends events from a step, with IDs from the run", async () => {
    const cluster = new Cluster((flow) => [
      flow.createFunction({ id: "parent", triggers: { event: "order/placed" } }, async ({ step }) =>
        step.sendEvent("fan-out", [{ name: "order/ship", data: { n: 1 } }]),
      ),
      flow.createFunction({ id: "ship", triggers: { event: "order/ship" } }, async ({ event }) => event.data.n),
    ]);
    await cluster.flow.send({ name: "order/placed", tenant: "acme" });
    await cluster.drain();
    await cluster.runOf("parent").result;
    await cluster.drain();
    const ship = cluster.runOf("ship");
    expect((await ship.result).getResult()).toBe(1);
    // The tenant carries over.
    expect(ship.payload.event.tenant).toBe("acme");
  });

});
