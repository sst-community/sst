import { describe, expect, it, mock } from "bun:test";

// DynamoStore against a fake DynamoDB endpoint, for the errors a real table gives
// under load: conflicts and throttles are tried again, and only a condition that
// wasn't met counts as one.

const calls: { action: string; body: any }[] = [];
let respond: (action: string, body: any, n: number) => Response;
const actual = await import("../../src/aws/client.ts");
mock.module("../../src/aws/client.ts", () => ({
  ...actual,
  awsFetch: async (_s: string, _p: string, init: RequestInit) => {
    const action = String((init.headers as any)["X-Amz-Target"]).split(".").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ action, body });
    return respond(action, body, calls.filter((c) => c.action === action).length);
  },
}));
const { DynamoStore } = await import("../../src/aws/eventflow/store.ts");
const { AwsError, isConditionFailure, isTransient } = await import("../../src/aws/eventflow/aws.ts");

const err = (status: number, type: string, extra: any = {}) =>
  new Response(JSON.stringify({ __type: `com.amazonaws.dynamodb.v20120810#${type}`, message: type, ...extra }), { status });
const limit = { item: "C#x", limit: 1 };
const item = (leases: Record<string, string>) => ({
  pk: { S: "C#x" },
  sk: { S: "-" },
  active: { N: String(Object.keys(leases).length) },
  queued: { N: "0" },
  leases: { M: Object.fromEntries(Object.entries(leases).map(([k, v]) => [k, { S: v }])) },
  tenants: { M: {} },
  waiting: { M: {} },
});

describe("DynamoDB errors", () => {
  it("count a cancelled transaction as a condition failure only when a condition cancelled it", () => {
    const cancelled = (...reasons: string[]) => new AwsError("dynamodb", "TransactWriteItems", 400, "TransactionCanceledException", "", reasons);
    expect(isConditionFailure(cancelled("None", "ConditionalCheckFailed"))).toBe(true);
    expect(isConditionFailure(cancelled("None", "TransactionConflict"))).toBe(false);
    expect(isConditionFailure(cancelled("ValidationError"))).toBe(false);
    expect(isTransient(cancelled("ConditionalCheckFailed", "TransactionConflict"))).toBe(true);
    expect(isTransient(cancelled("ThrottlingError"))).toBe(true);
    expect(isTransient(cancelled("ValidationError"))).toBe(false);
  });

  it("read the reasons from the message when the body has no list", async () => {
    respond = () =>
      err(400, "TransactionCanceledException", { message: "Transaction cancelled, please refer cancellation reasons for specific reasons [None, ValidationError]" });
    const store = new DynamoStore("t");
    await expect(store.acquire([limit], "W", "a", 60_000)).rejects.toThrow(/TransactionCanceled/);
  });

  it("are tried again when a transaction conflicts, so a step joins the line", async () => {
    calls.length = 0;
    respond = (action, _body, n) => {
      if (action === "GetItem") return Response.json({ Item: item({ other: `${Date.now() + 60_000}|a` }) });
      if (action === "TransactWriteItems" && n === 1)
        return err(400, "TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] });
      if (action === "TransactWriteItems") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    const result = await store.enqueue({ leaseId: "W", limits: [limit], tenant: "b", callbackId: "cb", runId: "r", at: 1, expiresAt: Date.now() + 1e5 });
    expect(result).toBe("queued");
    expect(calls.filter((c) => c.action === "TransactWriteItems")).toHaveLength(2);
  });

  it("are tried again in renew and release", async () => {
    calls.length = 0;
    respond = (action, _body, n) => {
      if (action === "GetItem") return Response.json({ Item: item({ W: `${Date.now() + 60_000}|b` }) });
      if (action === "UpdateItem" && n % 2 === 1) return err(400, "ThrottlingException");
      if (action === "UpdateItem") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.renew([limit], "W", 60_000)).toBe(true);
    await store.release([limit], "W", "b");
  });

  it("rejoins the line when its entry is gone and it holds nothing", async () => {
    // Its old callback timed out as it was granted, so the grant was given back.
    calls.length = 0;
    respond = (action, _body, n) => {
      if (action === "GetItem") return Response.json({ Item: item({ other: `${Date.now() + 60_000}|a` }) });
      if (action === "TransactWriteItems" && n === 1)
        return err(400, "TransactionCanceledException", { CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] });
      if (action === "UpdateItem") return err(400, "ConditionalCheckFailedException");
      if (action === "TransactWriteItems") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    const result = await store.enqueue({ leaseId: "W", limits: [limit], tenant: "b", callbackId: "cb", runId: "r", at: 1, expiresAt: Date.now() + 1e5 });
    expect(result).toBe("queued");
    expect(calls.filter((c) => c.action === "TransactWriteItems")).toHaveLength(2);
  });

  it("doesn't take a tenant that just joined for a stale one, when its entry isn't seen yet", async () => {
    // A read can see the count of a transaction that's going on before its entry.
    calls.length = 0;
    respond = (action) => {
      if (action === "GetItem")
        return Response.json({
          Item: { ...item({}), queued: { N: "1" }, waiting: { M: { b: { N: "1" } } }, waitingAt: { M: { b: { N: String(Date.now()) } } } },
        });
      if (action === "Query") return Response.json({ Items: [] });
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.dispatch(limit, async () => true)).toBe(0);
    expect(calls.filter((c) => c.action === "UpdateItem")).toHaveLength(0);
  });
});
