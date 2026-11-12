// A report job, run by `sst dev` as the Reporter role
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const identity = await new STSClient({}).send(new GetCallerIdentityCommand({}));
console.log("running as", identity.Arn);

const s3 = new S3Client({});
for (const bucket of [process.env.REPORTS_BUCKET, process.env.ARCHIVE_BUCKET]) {
  try {
    await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    console.log(bucket, "read");
  } catch (error) {
    console.log(bucket, "refused:", error.name);
  }
}
