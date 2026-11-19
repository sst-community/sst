import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Resource } from "sst";

const s3 = new S3Client({});
const sqs = new SQSClient({});

export async function handler() {
  for (const Bucket of [Resource.Uploads.name, Resource.Files.name])
    await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 }));
  await sqs.send(
    new SendMessageCommand({ QueueUrl: Resource.Jobs.url, MessageBody: "ok" }),
  );
  return { statusCode: 200, body: "ok" };
}
