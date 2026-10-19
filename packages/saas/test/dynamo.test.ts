import { describe, expect, it } from "vitest";
import { dynamoStore, fromItem, toItem } from "../src/runtime/store/dynamo";

const tables = {
  users: "Users",
  tenants: "Tenants",
  memberships: "Memberships",
};

// A client that records each command, and answers with what `reply` returns
function fake(reply: (name: string, input: any) => any = () => ({})) {
  const sent: { name: string; input: any }[] = [];
  const client = {
    async send(command: any) {
      const name = command.constructor.name.replace(/Command$/, "");
      sent.push({ name, input: command.input });
      const result = reply(name, command.input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { sent, store: dynamoStore({ tables, client: client as any }) };
}

const error = (name: string, extra: object = {}) =>
  Object.assign(new Error(name), { name, ...extra });

const user = {
  id: "ann",
  email: "ann@example.com",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

describe("the DynamoDB store", () => {
  it("writes and reads records as DynamoDB items", () => {
    const record = {
      id: "t",
      name: "Acme",
      personal: true,
      seats: 5,
      metadata: { plan: "pro", tags: ["a", null] },
      missing: undefined,
    };
    const item = toItem(record);
    expect(item).toEqual({
      id: { S: "t" },
      name: { S: "Acme" },
      personal: { BOOL: true },
      seats: { N: "5" },
      metadata: {
        M: { plan: { S: "pro" }, tags: { L: [{ S: "a" }, { NULL: true }] } },
      },
    });
    const { missing, ...rest } = record;
    expect(fromItem(item)).toEqual(rest);
  });

  it("creates a user only when there's none", async () => {
    const { store, sent } = fake();
    expect(await store.createUser(user)).toBe(true);
    expect(sent[0]).toMatchObject({
      name: "PutItem",
      input: {
        TableName: "Users",
        ConditionExpression: "attribute_not_exists(#id)",
      },
    });

    const taken = fake(() => error("ConditionalCheckFailedException"));
    expect(await taken.store.createUser(user)).toBe(false);
  });

  it("creates a user with their tenant in one transaction", async () => {
    const tenant = {
      id: "t",
      name: "Mine",
      createdBy: "ann",
      createdAt: "",
      updatedAt: "",
    };
    const membership = {
      tenantId: "t",
      userId: "ann",
      role: "owner",
      createdAt: "",
      updatedAt: "",
    };
    const { store, sent } = fake();
    await store.createUser(user, { tenant, membership });
    expect(sent[0].name).toBe("TransactWriteItems");
    expect(
      sent[0].input.TransactItems.map((i: any) => i.Put.TableName),
    ).toEqual(["Users", "Tenants", "Memberships"]);

    // The user's own condition failing means they're there already
    const there = fake(() =>
      error("TransactionCanceledException", {
        CancellationReasons: [
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
          { Code: "None" },
        ],
      }),
    );
    expect(await there.store.createUser(user, { tenant, membership })).toBe(
      false,
    );

    // Anything else is an error
    const clash = fake(() =>
      error("TransactionCanceledException", {
        CancellationReasons: [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
        ],
      }),
    );
    await expect(
      clash.store.createUser(user, { tenant, membership }),
    ).rejects.toThrow();
  });

  it("sets and removes fields, and finds nothing for a record that isn't there", async () => {
    const { store, sent } = fake(() => ({
      Attributes: toItem({ ...user, name: "Ann" }),
    }));
    const updated = await store.updateUser("ann", {
      name: "Ann",
      activeTenantId: null,
    });
    expect(updated?.name).toBe("Ann");
    const input = sent[0].input;
    expect(input.UpdateExpression).toBe(
      "SET #updatedAt = :updatedAt, #f0 = :v0 REMOVE #f1",
    );
    expect(input.ExpressionAttributeNames).toMatchObject({
      "#f0": "name",
      "#f1": "activeTenantId",
    });
    expect(input.ConditionExpression).toBe("attribute_exists(#k0)");

    const gone = fake(() => error("ConditionalCheckFailedException"));
    expect(
      await gone.store.updateUser("nobody", { name: "X" }),
    ).toBeUndefined();
  });

  it("retries the keys a batch read leaves", async () => {
    let calls = 0;
    const { store } = fake((name, input) => {
      if (name !== "BatchGetItem") return {};
      calls++;
      const keys = input.RequestItems.Users.Keys;
      return calls === 1
        ? {
            Responses: { Users: [toItem({ ...user, id: keys[0].id.S })] },
            UnprocessedKeys: { Users: { Keys: keys.slice(1) } },
          }
        : {
            Responses: {
              Users: keys.map((k: any) => toItem({ ...user, id: k.id.S })),
            },
          };
    });
    const found = await store.getUsers(["a", "b", "a", "c"]);
    expect(found.map((u) => u.id).sort()).toEqual(["a", "b", "c"]);
    expect(calls).toBe(2);
  });

  it("deletes a tenant's memberships, then the tenant", async () => {
    const { store, sent } = fake((name) =>
      name === "Query"
        ? {
            Items: ["ann", "bob"].map((userId) =>
              toItem({
                tenantId: "t",
                userId,
                role: "owner",
                createdAt: "",
                updatedAt: "",
              }),
            ),
          }
        : {},
    );
    await store.deleteTenant("t");
    expect(sent.map((s) => s.name)).toEqual([
      "Query",
      "BatchWriteItem",
      "DeleteItem",
    ]);
    expect(sent[1].input.RequestItems.Memberships).toHaveLength(2);
  });

  it("pages with a cursor it can read back", async () => {
    const { store, sent } = fake(() => ({
      Items: [toItem(user)],
      LastEvaluatedKey: { id: { S: "ann" } },
    }));
    const page = await store.listUsers({ limit: 1 });
    expect(page.cursor).toBeTypeOf("string");
    await store.listUsers({ cursor: page.cursor });
    expect(sent[1].input.ExclusiveStartKey).toEqual({ id: { S: "ann" } });
    await expect(store.listUsers({ cursor: "%%%" })).rejects.toMatchObject({
      name: "InvalidCursor",
    });
  });

  it("finds a user by email through its index, in lowercase", async () => {
    const { store, sent } = fake(() => ({ Items: [toItem(user)] }));
    expect((await store.findUserByEmail("Ann@Example.com"))?.id).toBe("ann");
    expect(sent[0].input).toMatchObject({
      IndexName: "byEmail",
      ExpressionAttributeValues: { ":email": { S: "ann@example.com" } },
    });
  });
});
