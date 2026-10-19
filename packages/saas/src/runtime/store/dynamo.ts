import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type QueryCommandInput,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type {
  Invitation,
  Membership,
  Page,
  PageArgs,
  Store,
  Tenant,
  User,
} from "./types";

type Item = Record<string, AttributeValue>;

export interface DynamoStoreArgs {
  /** The names of the four tables. */
  tables: {
    users: string;
    tenants: string;
    memberships: string;
    invitations: string;
  };
  /** The client to use. One is created for the region the code runs in. */
  client?: DynamoDBClient;
}

/** The index on the users table, and the one on the invitations table, by email. */
export const EMAIL_INDEX = "byEmail";
/** The index on the memberships table, by user. */
export const USER_INDEX = "byUser";
/**
 * The invitations table's TTL attribute: when an invitation expires, in
 * seconds since 1970, so that DynamoDB removes it.
 */
export const TTL_ATTRIBUTE = "expires";

/**
 * A store on four DynamoDB tables:
 *
 * - users, keyed by `id`, with an index on `email`
 * - tenants, keyed by `id`
 * - memberships, keyed by `tenantId` and `userId`, with an index on
 *   `userId` and `tenantId`
 * - invitations, keyed by `tenantId` and `email`, with an index on `email`
 *   and `tenantId`, and a TTL on `expires`
 */
export function dynamoStore(args: DynamoStoreArgs): Store {
  const { tables } = args;
  let client = args.client;
  const db = () => (client ??= new DynamoDBClient({}));

  return {
    async getUser(id) {
      return get<User>(tables.users, { id: { S: id } });
    },
    async getUsers(ids) {
      return batchGet<User>(
        tables.users,
        ids.map((id) => ({ id: { S: id } })),
      );
    },
    async findUserByEmail(email) {
      const result = await db().send(
        new QueryCommand({
          TableName: tables.users,
          IndexName: EMAIL_INDEX,
          KeyConditionExpression: "#email = :email",
          ExpressionAttributeNames: { "#email": "email" },
          ExpressionAttributeValues: { ":email": { S: email.toLowerCase() } },
          Limit: 1,
        }),
      );
      const item = result.Items?.[0];
      return item && (fromItem(item) as User);
    },
    async createUser(user, personal) {
      const putUser = {
        TableName: tables.users,
        Item: toItem(user),
        ConditionExpression: "attribute_not_exists(#id)",
        ExpressionAttributeNames: { "#id": "id" },
      };
      try {
        if (!personal) {
          await db().send(new PutItemCommand(putUser));
          return true;
        }
        await db().send(
          new TransactWriteItemsCommand({
            TransactItems: [
              { Put: putUser },
              { Put: newTenant(personal.tenant) },
              {
                Put: {
                  TableName: tables.memberships,
                  Item: toItem(personal.membership),
                },
              },
            ],
          }),
        );
        return true;
      } catch (error: any) {
        if (error?.name === "ConditionalCheckFailedException") return false;
        // Only the user's own condition means they're there already
        if (
          error?.name === "TransactionCanceledException" &&
          error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
        )
          return false;
        throw error;
      }
    },
    async updateUser(id, patch) {
      return update<User>(tables.users, { id: { S: id } }, patch);
    },
    async listUsers(page) {
      return scan<User>(tables.users, page);
    },

    async getTenant(id) {
      return get<Tenant>(tables.tenants, { id: { S: id } });
    },
    async getTenants(ids) {
      return batchGet<Tenant>(
        tables.tenants,
        ids.map((id) => ({ id: { S: id } })),
      );
    },
    async createTenant(tenant, owner) {
      await db().send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: newTenant(tenant) },
            { Put: { TableName: tables.memberships, Item: toItem(owner) } },
          ],
        }),
      );
    },
    async updateTenant(id, patch) {
      return update<Tenant>(tables.tenants, { id: { S: id } }, patch);
    },
    async deleteTenant(id) {
      const [members, invitations] = await Promise.all([
        this.listMembers(id),
        this.listInvitations(id),
      ]);
      await batchWrite(
        tables.memberships,
        members.map((membership) => ({
          DeleteRequest: {
            Key: {
              tenantId: { S: membership.tenantId },
              userId: { S: membership.userId },
            },
          },
        })),
      );
      await batchWrite(
        tables.invitations,
        invitations.map((invitation) => ({
          DeleteRequest: { Key: invitationKey(invitation) },
        })),
      );
      await db().send(
        new DeleteItemCommand({
          TableName: tables.tenants,
          Key: { id: { S: id } },
        }),
      );
    },
    async listTenants(page) {
      return scan<Tenant>(tables.tenants, page);
    },

    async getMembership(tenantId, userId) {
      return get<Membership>(tables.memberships, {
        tenantId: { S: tenantId },
        userId: { S: userId },
      });
    },
    async listMembers(tenantId) {
      return query<Membership>({
        TableName: tables.memberships,
        KeyConditionExpression: "#tenantId = :tenantId",
        ExpressionAttributeNames: { "#tenantId": "tenantId" },
        ExpressionAttributeValues: { ":tenantId": { S: tenantId } },
        ConsistentRead: true,
      });
    },
    async listMemberships(userId) {
      // An index is only read eventually consistent
      return query<Membership>({
        TableName: tables.memberships,
        IndexName: USER_INDEX,
        KeyConditionExpression: "#userId = :userId",
        ExpressionAttributeNames: { "#userId": "userId" },
        ExpressionAttributeValues: { ":userId": { S: userId } },
      });
    },
    async putMembership(membership) {
      await db().send(
        new PutItemCommand({
          TableName: tables.memberships,
          Item: toItem(membership),
        }),
      );
    },
    async deleteMembership(tenantId, userId) {
      await db().send(
        new DeleteItemCommand({
          TableName: tables.memberships,
          Key: { tenantId: { S: tenantId }, userId: { S: userId } },
        }),
      );
    },

    async getInvitation(tenantId, email) {
      const item = await get<Record<string, unknown>>(
        tables.invitations,
        invitationKey({ tenantId, email }),
      );
      return item && invitationOf(item);
    },
    async listInvitations(tenantId) {
      const items = await query<Record<string, unknown>>({
        TableName: tables.invitations,
        KeyConditionExpression: "#tenantId = :tenantId",
        ExpressionAttributeNames: { "#tenantId": "tenantId" },
        ExpressionAttributeValues: { ":tenantId": { S: tenantId } },
        ConsistentRead: true,
      });
      return items.map(invitationOf);
    },
    async findInvitations(email) {
      // An index is only read eventually consistent
      const items = await query<Record<string, unknown>>({
        TableName: tables.invitations,
        IndexName: EMAIL_INDEX,
        KeyConditionExpression: "#email = :email",
        ExpressionAttributeNames: { "#email": "email" },
        ExpressionAttributeValues: { ":email": { S: email.toLowerCase() } },
      });
      return items.map(invitationOf);
    },
    async putInvitation(invitation) {
      await db().send(
        new PutItemCommand({
          TableName: tables.invitations,
          Item: toItem({
            ...invitation,
            [TTL_ATTRIBUTE]: Math.floor(
              new Date(invitation.expiresAt).getTime() / 1000,
            ),
          }),
        }),
      );
    },
    async deleteInvitation(tenantId, email) {
      await db().send(
        new DeleteItemCommand({
          TableName: tables.invitations,
          Key: invitationKey({ tenantId, email }),
        }),
      );
    },
    async acceptInvitation(invitation, membership) {
      try {
        await db().send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tables.invitations,
                  Key: invitationKey(invitation),
                  ConditionExpression: "attribute_exists(#email)",
                  ExpressionAttributeNames: { "#email": "email" },
                },
              },
              {
                Put: {
                  TableName: tables.memberships,
                  Item: toItem(membership),
                  ConditionExpression: "attribute_not_exists(#userId)",
                  ExpressionAttributeNames: { "#userId": "userId" },
                },
              },
            ],
          }),
        );
        return true;
      } catch (error: any) {
        if (
          error?.name === "TransactionCanceledException" &&
          error.CancellationReasons?.some(
            (reason: any) => reason?.Code === "ConditionalCheckFailed",
          )
        )
          return false;
        throw error;
      }
    },
  };

  function invitationKey(invitation: { tenantId: string; email: string }) {
    return {
      tenantId: { S: invitation.tenantId },
      email: { S: invitation.email.toLowerCase() },
    };
  }

  // The record, without the attribute only DynamoDB reads
  function invitationOf(item: Record<string, unknown>) {
    const { [TTL_ATTRIBUTE]: _, ...invitation } = item;
    return invitation as unknown as Invitation;
  }

  function newTenant(tenant: Tenant) {
    return {
      TableName: tables.tenants,
      Item: toItem(tenant),
      ConditionExpression: "attribute_not_exists(#id)",
      ExpressionAttributeNames: { "#id": "id" },
    };
  }

  async function get<T>(table: string, key: Item) {
    const result = await db().send(
      new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }),
    );
    return result.Item && (fromItem(result.Item) as T);
  }

  async function batchGet<T>(table: string, keys: Item[]) {
    const unique = [
      ...new Map(keys.map((key) => [JSON.stringify(key), key])).values(),
    ];
    const found: T[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      let pending: Item[] = unique.slice(i, i + 100);
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt > 0) await backoff(attempt);
        const result = await db().send(
          new BatchGetItemCommand({
            RequestItems: { [table]: { Keys: pending, ConsistentRead: true } },
          }),
        );
        for (const item of result.Responses?.[table] ?? [])
          found.push(fromItem(item) as T);
        pending = result.UnprocessedKeys?.[table]?.Keys ?? [];
      }
    }
    return found;
  }

  async function batchWrite(table: string, requests: WriteRequest[]) {
    for (let i = 0; i < requests.length; i += 25) {
      let pending = requests.slice(i, i + 25);
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt > 0) await backoff(attempt);
        const result = await db().send(
          new BatchWriteItemCommand({ RequestItems: { [table]: pending } }),
        );
        pending = result.UnprocessedItems?.[table] ?? [];
      }
    }
  }

  async function query<T>(input: QueryCommandInput) {
    const items: T[] = [];
    let start: Item | undefined;
    do {
      const result = await db().send(
        new QueryCommand({ ...input, ExclusiveStartKey: start }),
      );
      for (const item of result.Items ?? []) items.push(fromItem(item) as T);
      start = result.LastEvaluatedKey;
    } while (start);
    return items;
  }

  async function scan<T>(table: string, page: PageArgs = {}): Promise<Page<T>> {
    const result = await db().send(
      new ScanCommand({
        TableName: table,
        Limit: page.limit ?? 50,
        ExclusiveStartKey: page.cursor ? decodeCursor(page.cursor) : undefined,
      }),
    );
    return {
      items: (result.Items ?? []).map((item) => fromItem(item) as T),
      cursor: result.LastEvaluatedKey && encodeCursor(result.LastEvaluatedKey),
    };
  }

  // Sets each field of the patch, removes those set to `null`, and returns
  // the record as changed. Nothing when there's no such record.
  async function update<T>(
    table: string,
    key: Item,
    patch: Record<string, unknown>,
  ) {
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Item = { ":updatedAt": { S: new Date().toISOString() } };
    const set = ["#updatedAt = :updatedAt"];
    const remove: string[] = [];
    const exists: string[] = [];
    for (const [i, field] of Object.keys(key).entries()) {
      names[`#k${i}`] = field;
      exists.push(`attribute_exists(#k${i})`);
    }
    for (const [i, [field, value]] of Object.entries(patch).entries()) {
      if (value === undefined) continue;
      names[`#f${i}`] = field;
      if (value === null) remove.push(`#f${i}`);
      else {
        set.push(`#f${i} = :v${i}`);
        values[`:v${i}`] = toAttribute(value)!;
      }
    }
    try {
      const result = await db().send(
        new UpdateItemCommand({
          TableName: table,
          Key: key,
          UpdateExpression:
            `SET ${set.join(", ")}` +
            (remove.length > 0 ? ` REMOVE ${remove.join(", ")}` : ""),
          ConditionExpression: exists.join(" AND "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return result.Attributes && (fromItem(result.Attributes) as T);
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") return undefined;
      throw error;
    }
  }
}

function backoff(attempt: number) {
  const ms = Math.min(1000, 50 * 2 ** attempt) * (0.5 + Math.random() / 2);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeCursor(key: Item) {
  return Buffer.from(JSON.stringify(fromItem(key))).toString("base64url");
}

function decodeCursor(cursor: string) {
  try {
    return toItem(JSON.parse(Buffer.from(cursor, "base64url").toString()));
  } catch {
    throw Object.assign(new Error("The cursor isn't one this API returned."), {
      name: "InvalidCursor",
    });
  }
}

// The few kinds of value the records hold, written the way DynamoDB takes
// them. `@aws-sdk/util-dynamodb` does the same, as another dependency.
export function toItem(record: object): Item {
  const item: Item = {};
  for (const [field, value] of Object.entries(record)) {
    const attribute = toAttribute(value);
    if (attribute) item[field] = attribute;
  }
  return item;
}

function toAttribute(value: unknown): AttributeValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value))
    return { L: value.map((v) => toAttribute(v) ?? { NULL: true }) };
  if (typeof value === "object") return { M: toItem(value) };
  throw new Error(`A ${typeof value} can't be stored.`);
}

export function fromItem(item: Item): Record<string, any> {
  const record: Record<string, any> = {};
  for (const [field, attribute] of Object.entries(item))
    record[field] = fromAttribute(attribute);
  return record;
}

function fromAttribute(attribute: AttributeValue): unknown {
  if (attribute.S !== undefined) return attribute.S;
  if (attribute.N !== undefined) return Number(attribute.N);
  if (attribute.BOOL !== undefined) return attribute.BOOL;
  if (attribute.NULL) return null;
  if (attribute.L) return attribute.L.map(fromAttribute);
  if (attribute.M) return fromItem(attribute.M);
  if (attribute.SS) return attribute.SS;
  if (attribute.NS) return attribute.NS.map(Number);
  return undefined;
}
