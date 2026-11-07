import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  ExecutionStatus,
  LocalDurableTestRunner,
} from "@aws/durable-execution-sdk-js-testing";

// The client tests set `aws.fetch` to answer the request a `workflow` function
// makes. `workflow.ts` calls `awsFetch` from `client.ts`, so that is replaced
// with a function that calls `aws.fetch`. It has to happen before `workflow.ts`
// is imported.
const aws = {
  fetch: (async () => {
    throw new Error("aws.fetch is not set");
  }) as (
    service: string,
    path: string,
    init: RequestInit,
  ) => Promise<Response>,
};
// Spread the real module, so `client` and the other exports stay intact for
// anything else in the process that imports them. Module mocks are global.
const actualClient = await import("../src/aws/client.ts");
mock.module("../src/aws/client.ts", () => ({
  ...actualClient,
  awsFetch: (service: string, path: string, init: RequestInit) =>
    aws.fetch(service, path, init),
}));
const { workflow } = await import("../src/aws/workflow.ts");

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
    status: 200,
    ...init,
  });
}

describe("workflow client", () => {
  const originalFetch = aws.fetch;

  beforeEach(() => {
    aws.fetch = originalFetch;
  });

  afterEach(() => {
    aws.fetch = originalFetch;
  });

  it("starts a workflow execution", async () => {
    aws.fetch = async (service, path, init) => {
      expect(service).toBe("lambda");
      expect(path).toBe(
        "/2015-03-31/functions/my-workflow/invocations?Qualifier=live",
      );
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        "X-Amz-Durable-Execution-Name": "job-123",
        "X-Amz-Invocation-Type": "Event",
      });
      expect(JSON.parse(String(init.body))).toEqual({ hello: "world" });

      return new Response(undefined, {
        status: 202,
        headers: {
          "X-Amz-Durable-Execution-Arn": "arn:workflow:live/job-123",
          "X-Amz-Executed-Version": "12",
        },
      });
    };

    const result = await workflow.start(
      { name: "my-workflow", qualifier: "live" },
      {
        name: "job-123",
        payload: { hello: "world" },
      },
    );

    expect(result).toEqual({
      arn: "arn:workflow:live/job-123",
      statusCode: 202,
      version: "12",
    });
    expect("response" in result).toBe(false);
  });

  it("lists first-page executions", async () => {
    const requests: {
      service: string;
      path: string;
      init: RequestInit;
    }[] = [];

    aws.fetch = async (service, path, init) => {
      requests.push({ service, path, init });
      const url = new URL(`https://example.com${path}`);
      const status = url.searchParams.getAll("Statuses")[0];

      if (status === "FAILED") {
        return jsonResponse({
          DurableExecutions: [
            {
              DurableExecutionArn: "arn:failed-2",
              DurableExecutionName: "failed-2",
              FunctionArn: "arn:function:live",
              Status: "FAILED",
              StartTimestamp: "2026-04-03T00:00:00.000Z",
              EndTimestamp: "2026-04-03T00:05:00.000Z",
            },
            {
              DurableExecutionArn: "arn:failed-1",
              DurableExecutionName: "failed-1",
              FunctionArn: "arn:function:live",
              Status: "FAILED",
              StartTimestamp: "2026-04-02T00:00:00.000Z",
              EndTimestamp: "2026-04-02T00:05:00.000Z",
            },
          ],
          NextMarker: "ignored-page-2",
        });
      }

      throw new Error(`Unexpected request: ${path}`);
    };

    const result = await workflow.list(
      { name: "my-workflow", qualifier: "live" },
      {
        status: "FAILED",
        createdAt: {
          from: new Date("2026-04-01T00:00:00.000Z"),
          to: new Date("2026-04-04T00:00:00.000Z"),
          order: "desc",
        },
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests.map((request) => request.service)).toEqual(["lambda"]);

    const firstUrl = new URL(`https://example.com${requests[0].path}`);
    expect(firstUrl.searchParams.get("Qualifier")).toBe("live");
    expect(firstUrl.searchParams.get("MaxItems")).toBe("1000");
    expect(firstUrl.searchParams.get("StartedAfter")).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(firstUrl.searchParams.get("StartedBefore")).toBe(
      "2026-04-04T00:00:00.000Z",
    );
    expect(firstUrl.searchParams.get("ReverseOrder")).toBe("true");
    expect(firstUrl.searchParams.getAll("Statuses")).toEqual(["FAILED"]);
    expect(requests[0].init.method).toBe("GET");

    expect(firstUrl.searchParams.get("Marker")).toBeNull();

    expect(result.executions.map((execution) => execution.arn)).toEqual([
      "arn:failed-2",
      "arn:failed-1",
    ]);
    expect(result.executions[0]?.status).toBe("FAILED");
    expect(result.executions[0]?.endedAt?.toISOString()).toBe(
      "2026-04-03T00:05:00.000Z",
    );
    expect("response" in result).toBe(false);
  });

  it("rejects multiple statuses", async () => {
    let calls = 0;

    aws.fetch = async () => {
      calls += 1;
      return jsonResponse({ DurableExecutions: [] });
    };

    await expect(
      workflow.list(
        { name: "my-workflow", qualifier: "live" },
        { status: ["RUNNING", "FAILED"] as never },
      ),
    ).rejects.toThrow("workflow.list status must be a single status");

    expect(calls).toBe(0);
  });

  it("describes a workflow execution", async () => {
    aws.fetch = async (service, path, init) => {
      expect(service).toBe("lambda");
      expect(path).toBe(
        "/2025-12-01/durable-executions/arn%3Aworkflow%3Alive%2Fexecution-123",
      );
      expect(init.method).toBe("GET");

      return jsonResponse({
        DurableExecutionArn: "arn:workflow:live/execution-123",
        DurableExecutionName: "execution-123",
        FunctionArn: "arn:function:live",
        Status: "RUNNING",
        StartTimestamp: 1775556000,
        Version: "12",
      });
    };

    const result = await workflow.describe("arn:workflow:live/execution-123");

    expect(result.arn).toBe("arn:workflow:live/execution-123");
    expect(result.name).toBe("execution-123");
    expect(result.status).toBe("RUNNING");
    expect(result.createdAt.toISOString()).toBe("2026-04-07T10:00:00.000Z");
    expect(result.version).toBe("12");
    expect("response" in result).toBe(false);
  });

  it("stops a workflow execution with a normalized error payload", async () => {
    aws.fetch = async (service, path, init) => {
      expect(service).toBe("lambda");
      expect(path).toBe(
        "/2025-12-01/durable-executions/arn%3Aworkflow%3Alive%2Fexecution-123/stop",
      );
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init.body))).toEqual({
        ErrorMessage: "Cancelled by user",
        ErrorType: "Cancelled",
        ErrorData: JSON.stringify({ reason: "user" }),
      });

      return jsonResponse({
        StopTimestamp: "1775559600",
      });
    };

    const result = await workflow.stop("arn:workflow:live/execution-123", {
      error: {
        message: "Cancelled by user",
        type: "Cancelled",
        data: { reason: "user" },
      },
    });

    expect(result).toEqual({
      arn: "arn:workflow:live/execution-123",
      status: "STOPPED",
      stoppedAt: new Date("2026-04-07T11:00:00.000Z"),
    });
    expect("response" in result).toBe(false);
  });

  it("succeeds a workflow callback", async () => {
    aws.fetch = async (service, path, init) => {
      expect(service).toBe("lambda");
      expect(path).toBe(
        "/2025-12-01/durable-execution-callbacks/callback-token/succeed",
      );
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init.body))).toEqual({ ok: true });

      return new Response(undefined, { status: 200 });
    };

    const result = await workflow.succeed("callback-token", {
      payload: { ok: true },
    });

    expect(result).toBeUndefined();
  });

  it("fails a workflow callback", async () => {
    aws.fetch = async (service, path, init) => {
      expect(service).toBe("lambda");
      expect(path).toBe(
        "/2025-12-01/durable-execution-callbacks/callback-token/fail",
      );
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init.body))).toEqual({
        ErrorMessage: "boom",
        ErrorType: "Error",
      });

      return new Response(undefined, { status: 200 });
    };

    const result = await workflow.fail("callback-token", {
      error: "boom",
    });

    expect(result).toBeUndefined();
  });

  it("heartbeats a workflow callback", async () => {
    aws.fetch = async (service, path, init) => {
      expect(service).toBe("lambda");
      expect(path).toBe(
        "/2025-12-01/durable-execution-callbacks/callback-token/heartbeat",
      );
      expect(init.method).toBe("POST");

      return new Response(undefined, { status: 200 });
    };

    const result = await workflow.heartbeat("callback-token");

    expect(result).toBeUndefined();
  });
});

describe("workflow dispatcher", () => {
  const originalFetch = aws.fetch;
  const originalError = console.error;
  const resource = { name: "my-workflow", qualifier: "live" };

  function record(messageId: string, body: string, tenant?: string) {
    return {
      messageId,
      body,
      attributes: tenant ? { MessageGroupId: tenant } : {},
    } as any;
  }

  beforeEach(() => {
    console.error = () => {};
  });

  afterEach(() => {
    aws.fetch = originalFetch;
    console.error = originalError;
  });

  it("starts one named execution per message with the tenant and body", async () => {
    const started: { name: unknown; payload: unknown }[] = [];
    aws.fetch = async (_service, path, init) => {
      expect(path).toBe(
        "/2015-03-31/functions/my-workflow/invocations?Qualifier=live",
      );
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Amz-Invocation-Type"]).toBe("Event");
      started.push({
        name: headers["X-Amz-Durable-Execution-Name"],
        payload: JSON.parse(String(init.body)),
      });
      return new Response(undefined, { status: 202 });
    };

    const handler = workflow.dispatcher<{ jobId: string }>(resource, {
      name: (message) => `job-${message.body.jobId}`,
    });
    const result = await handler({
      Records: [
        record("m1", JSON.stringify({ jobId: "1" }), "tenant-a"),
        record("m2", JSON.stringify({ jobId: "2" }), "tenant-b"),
      ],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(started).toEqual([
      { name: "job-1", payload: { tenant: "tenant-a", body: { jobId: "1" } } },
      { name: "job-2", payload: { tenant: "tenant-b", body: { jobId: "2" } } },
    ]);
  });

  it("sends the same name and payload when a message is delivered again", async () => {
    const started: string[] = [];
    aws.fetch = async (_service, _path, init) => {
      const headers = init.headers as Record<string, string>;
      started.push(`${headers["X-Amz-Durable-Execution-Name"]} ${init.body}`);
      return new Response(undefined, { status: 202 });
    };
    const handler = workflow.dispatcher<{ jobId: string }>(resource, {
      name: (message) => `job-${message.body.jobId}`,
    });
    const message = record("m1", JSON.stringify({ jobId: "1" }), "tenant-a");

    await handler({ Records: [message] });
    await handler({
      Records: [
        {
          ...message,
          attributes: { ...message.attributes, ApproximateReceiveCount: "2" },
        },
      ],
    });

    expect(started).toHaveLength(2);
    expect(started[1]).toBe(started[0]);
  });

  it("returns only the messages it couldn't start", async () => {
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    aws.fetch = async (_service, _path, init) => {
      const headers = init.headers as Record<string, string>;
      if (headers["X-Amz-Durable-Execution-Name"] === "job-2")
        return jsonResponse(
          {
            Type: "User",
            message: "TooManyRequestsException: Rate exceeded",
          },
          { status: 429 },
        );
      return new Response(undefined, { status: 202 });
    };

    const handler = workflow.dispatcher<{ jobId: string }>(resource, {
      name: (message) => {
        if (message.body.jobId === "3") throw new Error("no job ID");
        return `job-${message.body.jobId}`;
      },
    });
    const result = await handler({
      Records: [
        record("m1", JSON.stringify({ jobId: "1" })),
        record("m2", JSON.stringify({ jobId: "2" })),
        record("m3", JSON.stringify({ jobId: "3" })),
      ],
    });

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "m2" }, { itemIdentifier: "m3" }],
    });
    expect(
      JSON.stringify(errors, (_k, v) => (v instanceof Error ? v.message : v)),
    ).toContain('Failed to start workflow \\"job-2\\": 429');
    expect(
      JSON.stringify(errors, (_k, v) => (v instanceof Error ? v.message : v)),
    ).toContain("TooManyRequestsException");
  });

  it("passes a body that isn't JSON as a string, and takes a custom payload", async () => {
    let payload: unknown;
    aws.fetch = async (_service, _path, init) => {
      payload = JSON.parse(String(init.body));
      return new Response(undefined, { status: 202 });
    };

    const handler = workflow.dispatcher<string, { id: string }>(resource, {
      name: (_message, record) => `message-${record.messageId}`,
      payload: (message) => ({ id: message.body }),
    });
    const result = await handler({ Records: [record("m1", "plain text")] });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(payload).toEqual({ id: "plain text" });
  });
});

describe("workflow rollback runner", () => {
  beforeAll(async () => {
    await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  });

  afterAll(async () => {
    await LocalDurableTestRunner.teardownTestEnvironment();
  });

  it("waitUntil wraps a named wait", async () => {
    const fixedNow = 1_700_000_000_000;
    const originalNow = Date.now;
    Date.now = () => fixedNow;

    try {
      const handler = workflow.handler(async (_event, ctx) => {
        await ctx.waitUntil("pause", new Date(fixedNow + 1_500));
      });

      const runner = new LocalDurableTestRunner({ handlerFunction: handler });
      const execution = await runner.run();

      expect(execution.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

      const wait = await runner.getOperation("pause").waitForData();
      expect(wait.getWaitDetails()?.waitSeconds).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not register rollback when run fails", async () => {
    const calls: string[] = [];

    const handler = workflow.handler(async (_event, ctx) => {
      try {
        await ctx.stepWithRollback(
          "step-a",
          {
            run: async () => {
              calls.push("run:step-a");
              throw new Error("boom");
            },
            undo: async () => {
              calls.push("undo:step-a");
            },
          },
          {
            retryStrategy: () => ({ shouldRetry: false }),
          },
        );
      } catch (error) {
        await ctx.rollbackAll(error);
        throw error;
      }
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run();

    expect(execution.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(calls).toEqual(["run:step-a"]);
  });

  it("rebuilds rollback stack after wait replay", async () => {
    const calls: string[] = [];

    const handler = workflow.handler(async (_event, ctx) => {
      try {
        await ctx.stepWithRollback("step-a", {
          run: async () => {
            calls.push("run:step-a");
            return "result-a";
          },
          undo: async (_error, value) => {
            calls.push(`undo:${value}`);
          },
        });

        await ctx.wait("pause", { seconds: 1 });

        await ctx.stepWithRollback("step-b", {
          run: async () => {
            calls.push("run:step-b");
            return "result-b";
          },
          undo: async (_error, value) => {
            calls.push(`undo:${value}`);
          },
        });

        await ctx.step("fail", async () => {
          throw new Error("boom");
        });
      } catch (error) {
        await ctx.rollbackAll(error);
        throw error;
      }
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run();

    expect(execution.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(calls).toEqual([
      "run:step-a",
      "run:step-b",
      "undo:result-b",
      "undo:result-a",
    ]);

    const wait = await runner.getOperation("pause").waitForData();
    expect(wait.getWaitDetails()?.waitSeconds).toBe(1);
    expect(runner.getOperation("Undo 'step-b'").getStatus()).toBeDefined();
    expect(runner.getOperation("Undo 'step-a'").getStatus()).toBeDefined();
  });

  it("inherits step retry config for rollback steps", async () => {
    const calls: string[] = [];
    let undoAttempts = 0;

    const handler = workflow.handler(async (_event, ctx) => {
      try {
        await ctx.stepWithRollback(
          "step-a",
          {
            run: async () => {
              calls.push("run:step-a");
              return "result-a";
            },
            undo: async () => {
              undoAttempts++;
              calls.push(`undo-attempt:${undoAttempts}`);
              if (undoAttempts === 1) {
                throw new Error("retry undo once");
              }
            },
          },
          {
            retryStrategy: (_error, attempt) => ({
              shouldRetry: attempt < 2,
              delay: { seconds: 1 },
            }),
          },
        );

        await ctx.step("fail", async () => {
          throw new Error("boom");
        });
      } catch (error) {
        await ctx.rollbackAll(error);
        throw error;
      }
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run();

    expect(execution.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(calls).toEqual([
      "run:step-a",
      "undo-attempt:1",
      "undo-attempt:2",
    ]);
    expect(runner.getOperation("Undo 'step-a'").getStepDetails()?.attempt).toBe(2);
  });

  it("stops rollback on undo failure", async () => {
    const calls: string[] = [];

    const handler = workflow.handler(async (_event, ctx) => {
      try {
        await ctx.stepWithRollback("step-a", {
          run: async () => {
            calls.push("run:step-a");
            return "result-a";
          },
          undo: async () => {
            calls.push("undo:step-a");
          },
        });

        await ctx.stepWithRollback("step-b", {
          run: async () => {
            calls.push("run:step-b");
            return "result-b";
          },
          undo: async () => {
            calls.push("undo:step-b");
            throw new Error("undo failed");
          },
        });

        await ctx.step("fail", async () => {
          throw new Error("boom");
        });
      } catch (error) {
        await ctx.rollbackAll(error);
        throw error;
      }
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run();

    expect(execution.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(calls.slice(0, 2)).toEqual(["run:step-a", "run:step-b"]);
    expect(calls.slice(2).every((call) => call === "undo:step-b")).toBe(true);
    expect(calls).not.toContain("undo:step-a");
    expect(execution.getError().errorType).toBe("RollbackError");
    expect(execution.getError().errorMessage).toContain("step-b");
  });

  it("allows rollbackAll to be called twice", async () => {
    const calls: string[] = [];

    const handler = workflow.handler(async (_event, ctx) => {
      try {
        await ctx.stepWithRollback("step-a", {
          run: async () => {
            calls.push("run:step-a");
            return "result-a";
          },
          undo: async () => {
            calls.push("undo:step-a");
          },
        });

        await ctx.step("fail", async () => {
          throw new Error("boom");
        });
      } catch (error) {
        await ctx.rollbackAll(error);
        await ctx.rollbackAll(error);
        throw error;
      }
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run();

    expect(execution.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(calls).toEqual(["run:step-a", "undo:step-a"]);
  });
});
