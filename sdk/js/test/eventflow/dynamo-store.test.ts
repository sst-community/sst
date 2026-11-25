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
// A limit's leases, and its line: an item for each tenant in it.
const limitItem = (leases: Record<string, string>) => ({
  pk: { S: "C#x" },
  sk: { S: "-" },
  active: { N: String(Object.keys(leases).length) },
  leases: { M: Object.fromEntries(Object.entries(leases).map(([k, v]) => [k, { S: v }])) },
  tenants: { M: {} },
});
const noLine = () => Response.json({ Items: [] });
const waiter = { leaseId: "W", limits: [limit], tenant: "b", callbackId: "cb", runId: "r", at: 1, expiresAt: Date.now() + 1e5 };

describe("DynamoDB errors", () => {
  it("count a cancelled transaction as a condition failure only when a condition cancelled it", () => {
    const cancelled = (...reasons: string[]) =>
      new AwsError("dynamodb", "TransactWriteItems", 400, "TransactionCanceledException", "", reasons);
    expect(isConditionFailure(cancelled("None", "ConditionalCheckFailed"))).toBe(true);
    expect(isConditionFailure(cancelled("None", "TransactionConflict"))).toBe(false);
    expect(isConditionFailure(cancelled("ValidationError"))).toBe(false);
    expect(isTransient(cancelled("ConditionalCheckFailed", "TransactionConflict"))).toBe(true);
    expect(isTransient(cancelled("ThrottlingError"))).toBe(true);
    expect(isTransient(cancelled("ValidationError"))).toBe(false);
  });

  it("are tried again when a write conflicts, so a step joins the line", async () => {
    calls.length = 0;
    const item = limitItem({ other: `${Date.now() + 60_000}|o1|a` });
    respond = (action, body, n) => {
      if (action === "GetItem") return Response.json({ Item: item });
      if (action === "PutItem" && n === 1) return err(400, "TransactionConflictException");
      if (action === "PutItem" || action === "UpdateItem") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.enqueue(waiter)).toBe("queued");
    expect(calls.filter((c) => c.action === "PutItem")).toHaveLength(2);
    // Its count is on its tenant's item in the line, not the leases'.
    expect(calls.filter((c) => c.action === "UpdateItem").map((c) => c.body.Key.sk.S)).toEqual(["w#b"]);
  });

  it("are tried again in renew and release", async () => {
    calls.length = 0;
    const item = limitItem({ W: `${Date.now() + 60_000}|o1|b` });
    respond = (action, body, n) => {
      if (action === "GetItem") return Response.json({ Item: item });
      if (action === "UpdateItem" && n % 2 === 1) return err(400, "ThrottlingException");
      if (action === "UpdateItem") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.renew([limit], "W", 60_000, true)).toBe(true);
    await store.release([limit], "W", "b");
  });

  it("rejoins the line when its entry is gone and it holds nothing", async () => {
    // Its old callback timed out as it was granted, so the grant was given back.
    calls.length = 0;
    const item = limitItem({ other: `${Date.now() + 60_000}|o1|a` });
    respond = (action, body, n) => {
      if (action === "GetItem") return Response.json({ Item: item });
      if (action === "PutItem" && n === 1) return err(400, "ConditionalCheckFailedException");
      if (action === "UpdateItem" && !body.Key.sk.S.startsWith("w#")) return err(400, "ConditionalCheckFailedException");
      if (action === "PutItem" || action === "UpdateItem") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.enqueue(waiter)).toBe("queued");
    expect(calls.filter((c) => c.action === "PutItem")).toHaveLength(2);
  });

  it("doesn't take a tenant that just joined for a stale one, when its entry isn't seen yet", async () => {
    // A count can be seen for a moment without its entry.
    calls.length = 0;
    const item = limitItem({});
    respond = (action, body) => {
      if (action === "GetItem") return Response.json({ Item: item });
      if (action === "Query")
        return Response.json({
          Items: body.ExpressionAttributeValues[":w"] ? [{ sk: { S: "w#b" }, n: { N: "1" }, at: { N: String(Date.now()) } }] : [],
        });
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.dispatch(limit, async () => true)).toBe(0);
    expect(calls.filter((c) => c.action === "UpdateItem" || c.action === "DeleteItem")).toHaveLength(0);
  });

  it("never asks DynamoDB for a transaction", async () => {
    calls.length = 0;
    const item = limitItem({});
    respond = (action, body) => {
      if (action === "Query") return noLine();
      if (action === "GetItem") return Response.json({ Item: item });
      if (action === "UpdateItem") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.acquire([limit, { item: "C#y", limit: 2 }], "L", "a", 60_000)).toBe("granted");
    expect(calls.some((c) => c.action === "TransactWriteItems")).toBe(false);
  });
});
