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
  const client = new S3Client({});
  const results = await Promise.allSettled(
    [Resource.Files.name, Resource.SecondaryFiles.name].map((Bucket) =>
      client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 })),
    ),
  );
  const denied = process.env.EXPECT_DENIED === "1";
  for (const result of results) {
    if (denied) {
      if (
        result.status !== "rejected" ||
        result.reason?.$metadata?.httpStatusCode !== 403
      )
        throw new Error(
          "Expected S3 access to be denied after revoking grants",
        );
    } else if (result.status === "rejected") throw result.reason;
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      bucket: Resource.Files.name,
      secondary: Resource.SecondaryFiles.name,
      ...(denied ? { denied: true } : {}),
    }),
  };
}
