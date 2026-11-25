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
// A limit's two items: its leases, at "-", and its line, at "w".
const limitItems = (leases: Record<string, string>, line: Record<string, any> = {}) => (body: any) =>
  body.Key.sk.S === "w"
    ? { pk: { S: "C#x" }, sk: { S: "w" }, queued: { N: "0" }, waiting: { M: {} }, waitingAt: { M: {} }, ...line }
    : {
        pk: { S: "C#x" },
        sk: { S: "-" },
        active: { N: String(Object.keys(leases).length) },
        leases: { M: Object.fromEntries(Object.entries(leases).map(([k, v]) => [k, { S: v }])) },
        tenants: { M: {} },
      };
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
    const items = limitItems({ other: `${Date.now() + 60_000}|a` });
    respond = (action, body, n) => {
      if (action === "GetItem") return Response.json({ Item: items(body) });
      if (action === "PutItem" && n === 1) return err(400, "TransactionConflictException");
      if (action === "PutItem" || action === "UpdateItem") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.enqueue(waiter)).toBe("queued");
    expect(calls.filter((c) => c.action === "PutItem")).toHaveLength(2);
    // Its count is on the line's item, not the leases'.
    expect(calls.filter((c) => c.action === "UpdateItem").map((c) => c.body.Key.sk.S)).toEqual(["w"]);
  });

  it("are tried again in renew and release", async () => {
    calls.length = 0;
    const items = limitItems({ W: `${Date.now() + 60_000}|b` });
    respond = (action, body, n) => {
      if (action === "GetItem") return Response.json({ Item: items(body) });
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
    const items = limitItems({ other: `${Date.now() + 60_000}|a` });
    respond = (action, body, n) => {
      if (action === "GetItem") return Response.json({ Item: items(body) });
      if (action === "PutItem" && n === 1) return err(400, "ConditionalCheckFailedException");
      if (action === "UpdateItem" && body.Key.sk.S !== "w") return err(400, "ConditionalCheckFailedException");
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
    const items = limitItems({}, { queued: { N: "1" }, waiting: { M: { b: { N: "1" } } }, waitingAt: { M: { b: { N: String(Date.now()) } } } });
    respond = (action, body) => {
      if (action === "GetItem") return Response.json({ Item: items(body) });
      if (action === "Query") return Response.json({ Items: [] });
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.dispatch(limit, async () => true)).toBe(0);
    expect(calls.filter((c) => c.action === "UpdateItem")).toHaveLength(0);
  });

  it("never asks DynamoDB for a transaction", async () => {
    calls.length = 0;
    const items = limitItems({});
    respond = (action, body) => {
      if (action === "GetItem") return Response.json({ Item: items(body) });
      if (action === "UpdateItem") return Response.json({});
      throw new Error(action);
    };
    const store = new DynamoStore("t");
    expect(await store.acquire([limit, { item: "C#y", limit: 2 }], "L", "a", 60_000)).toBe("granted");
    expect(calls.some((c) => c.action === "TransactWriteItems")).toBe(false);
  });
});
