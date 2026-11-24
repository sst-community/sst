import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

// Timings for the measurements, one item per import.
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function record(test: string, importId: string, fields: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = Object.entries(fields).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  await db.send(
    new UpdateCommand({
      TableName: Resource.Results.name,
      Key: { test, importId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function results(test: string) {
  const items: Record<string, any>[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: Resource.Results.name,
        KeyConditionExpression: "test = :t",
        ExpressionAttributeValues: { ":t": test },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}
