import { describe, expect, it } from "vitest";
import { dynamoStore, fromItem, toItem } from "../src/runtime/store/dynamo";

const tables = {
  users: "Users",
  tenants: "Tenants",
  memberships: "Memberships",
  invitations: "Invitations",
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

const invitation = {
  tenantId: "t",
  email: "dan@example.com",
  role: "member",
  invitedBy: "ann",
  expiresAt: "2026-10-25T00:00:00.000Z",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

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

  it("deletes a tenant's memberships and invitations, then the tenant", async () => {
    const { store, sent } = fake((name, input) => {
      if (name !== "Query") return {};
      if (input.TableName === "Invitations")
        return { Items: [toItem({ ...invitation, tenantId: "t" })] };
      return {
        Items: ["ann", "bob"].map((userId) =>
          toItem({
            tenantId: "t",
            userId,
            role: "owner",
            createdAt: "",
            updatedAt: "",
          }),
        ),
      };
    });
    await store.deleteTenant("t");
    expect(sent.map((s) => s.name)).toEqual([
      "Query",
      "Query",
      "BatchWriteItem",
      "BatchWriteItem",
      "DeleteItem",
    ]);
    expect(sent[2].input.RequestItems.Memberships).toHaveLength(2);
    expect(sent[3].input.RequestItems.Invitations).toEqual([
      {
        DeleteRequest: {
          Key: { tenantId: { S: "t" }, email: { S: "dan@example.com" } },
        },
      },
    ]);
  });

  it("pages with a cursor it can read back", async () => {
    const last = {
      id: { S: "ann" },
      listed: { S: "all" },
      sortKey: { S: "ann@example.com #ann" },
    };
    const { store, sent } = fake((name) =>
      name === "Query"
        ? { Items: [last], LastEvaluatedKey: last }
        : { Responses: { Users: [toItem(user)] } },
    );
    const page = await store.listUsers({ limit: 1 });
    expect(page.cursor).toBeTypeOf("string");
    await store.listUsers({ cursor: page.cursor });
    expect(sent[2].input.ExclusiveStartKey).toEqual(last);
    await expect(store.listUsers({ cursor: "%%%" })).rejects.toMatchObject({
      name: "InvalidCursor",
    });
  });

  it("lists users in order from the sorted index, then reads them", async () => {
    const keys = ["bob", "gone", "ann"].map((id) => ({
      id: { S: id },
      listed: { S: "all" },
      sortKey: { S: `${id}@example.com #${id}` },
    }));
    const { store, sent } = fake((name, input) =>
      name === "Query"
        ? { Items: keys }
        : {
            // In any order, and not one deleted since
            Responses: {
              Users: input.RequestItems.Users.Keys.filter(
                (k: any) => k.id.S !== "gone",
              )
                .reverse()
                .map((k: any) =>
                  toItem({ ...user, id: k.id.S, listed: "all", sortKey: "x" }),
                ),
            },
          },
    );
    const page = await store.listUsers({ search: " Ann", limit: 3 });
    expect(sent[0].input).toMatchObject({
      IndexName: "sorted",
      KeyConditionExpression:
        "#listed = :listed AND begins_with(#sortKey, :prefix)",
      ExpressionAttributeValues: {
        ":listed": { S: "all" },
        ":prefix": { S: "ann" },
      },
      Limit: 3,
    });
    // In the index's order, without what only the index reads
    expect(page.items.map((u) => u.id)).toEqual(["bob", "ann"]);
    expect(page.items[0]).not.toHaveProperty("sortKey");
    expect(page.items[0]).not.toHaveProperty("listed");
  });

  it("keeps the sort key in step with an email or a name", async () => {
    const { store, sent } = fake((name) =>
      name === "UpdateItem" ? { Attributes: toItem(user) } : {},
    );
    await store.createUser(user);
    expect(sent[0].input.Item).toMatchObject({
      listed: { S: "all" },
      sortKey: { S: "ann@example.com #ann" },
    });

    await store.updateUser("ann", { email: "ann@new.example.com" });
    expect(
      Object.values(sent[1].input.ExpressionAttributeValues),
    ).toContainEqual({ S: "ann@new.example.com #ann" });
    await store.updateUser("ann", { email: null });
    expect(
      Object.values(sent[2].input.ExpressionAttributeValues),
    ).toContainEqual({ S: "~ #ann" });
    // Not when the email isn't changed
    await store.updateUser("ann", { name: "Ann" });
    expect(sent[3].input.ExpressionAttributeNames).not.toHaveProperty("#f1");

    await store.updateTenant("t", { name: "Acme Labs" });
    expect(
      Object.values(sent[4].input.ExpressionAttributeValues),
    ).toContainEqual({ S: "acme labs #t" });
  });

  it("reads a tenant's members with a role from the local index, consistently", async () => {
    const { store, sent } = fake(() => ({ Items: [] }));
    await store.membersWithRole("t", "owner", { limit: 2 });
    expect(sent[0].input).toMatchObject({
      TableName: "Memberships",
      IndexName: "byRole",
      KeyConditionExpression: "#tenantId = :tenantId AND #role = :role",
      ConsistentRead: true,
      Limit: 2,
    });
  });

  it("lists a tenant's members a page at a time, consistently", async () => {
    const { store, sent } = fake(() => ({ Items: [] }));
    await store.listMembers("t", { limit: 10 });
    expect(sent[0].input).toMatchObject({
      TableName: "Memberships",
      KeyConditionExpression: "#tenantId = :tenantId",
      ConsistentRead: true,
      Limit: 10,
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

  it("keeps an invitation with when it expires for the TTL, and reads it back without it", async () => {
    const { store, sent } = fake((name) =>
      name === "GetItem"
        ? { Item: sent[0].input.Item }
        : name === "Query"
          ? { Items: [sent[0].input.Item] }
          : {},
    );
    await store.putInvitation(invitation);
    expect(sent[0].input).toMatchObject({ TableName: "Invitations" });
    // Seconds since 1970
    expect(sent[0].input.Item.expires).toEqual({ N: "1792886400" });

    expect(await store.getInvitation("t", "Dan@Example.com")).toEqual(
      invitation,
    );
    expect(sent[1].input.Key).toEqual({
      tenantId: { S: "t" },
      email: { S: "dan@example.com" },
    });
    expect(await store.findInvitations("Dan@Example.com")).toEqual([
      invitation,
    ]);
    expect(sent[2].input).toMatchObject({
      IndexName: "byEmail",
      ExpressionAttributeValues: { ":email": { S: "dan@example.com" } },
    });
  });

  it("takes up an invitation in one transaction, only once", async () => {
    const membership = {
      tenantId: "t",
      userId: "dan",
      role: "member",
      createdAt: "",
      updatedAt: "",
    };
    const { store, sent } = fake();
    expect(await store.acceptInvitation(invitation, membership)).toBe(true);
    const [remove, put] = sent[0].input.TransactItems;
    expect(remove.Delete).toMatchObject({
      TableName: "Invitations",
      ConditionExpression: "attribute_exists(#email)",
    });
    expect(put.Put).toMatchObject({
      TableName: "Memberships",
      ConditionExpression: "attribute_not_exists(#userId)",
    });

    // Taken up already, or they're a member
    const taken = fake(() =>
      error("TransactionCanceledException", {
        CancellationReasons: [
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
        ],
      }),
    );
    expect(await taken.store.acceptInvitation(invitation, membership)).toBe(
      false,
    );
    const failing = fake(() => error("ProvisionedThroughputExceededException"));
    await expect(
      failing.store.acceptInvitation(invitation, membership),
    ).rejects.toThrow();
  });
});
