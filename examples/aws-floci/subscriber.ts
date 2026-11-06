import { Resource } from "sst";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({});
export async function handler(event: { Records: { body: string }[] }) {
  for (const record of event.Records) {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.Records.name,
        Item: { id: { S: "subscriber" }, message: { S: record.body } },
      }),
    );
    console.log("Processed", record.body);
  }
}
