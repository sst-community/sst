import { Resource } from "sst";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

// Path-style addressing works with both AWS and the local emulator.
const s3 = new S3Client({ forcePathStyle: true });
const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});
export async function handler() {
  await s3.send(
    new PutObjectCommand({
      Bucket: Resource.Files.name,
      Key: "hello.txt",
      Body: "hello from local SST",
    }),
  );
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.Records.name,
      Item: { id: { S: "request" }, message: { S: "hello from local SST" } },
    }),
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: Resource.Jobs.url,
      MessageBody: "hello from local SST",
    }),
  );
  const object = await s3.send(
    new GetObjectCommand({ Bucket: Resource.Files.name, Key: "hello.txt" }),
  );
  return {
    statusCode: 200,
    body: JSON.stringify({ message: await object.Body!.transformToString() }),
  };
}
