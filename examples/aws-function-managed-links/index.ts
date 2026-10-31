import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Resource } from "sst";

export async function handler() {
  await new S3Client({}).send(
    new ListObjectsV2Command({ Bucket: Resource.Files.name, MaxKeys: 1 }),
  );
  return {
    statusCode: 200,
    body: JSON.stringify({
      bucket: Resource.Files.name,
      linked: Resource.One.bucket,
    }),
  };
}

export async function migration() {
  await new S3Client({}).send(
    new ListObjectsV2Command({ Bucket: Resource.Files.name, MaxKeys: 1 }),
  );
  return { statusCode: 200, body: Resource.Files.name };
}
