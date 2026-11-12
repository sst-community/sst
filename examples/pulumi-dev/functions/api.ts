import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import postgres from "postgres";

// Change it while `sst dev` runs: the next call answers with the new one
const VERSION = "1";

const s3 = new S3Client({});
const sql = postgres({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 1,
});

export async function handler(event: { rawPath?: string }) {
  switch (event.rawPath) {
    case "/version":
      return { version: VERSION, greeting: process.env.GREETING };
    // Who the code runs as: the function's role, in AWS and in `sst dev`
    case "/whoami":
      return (await new STSClient({}).send(new GetCallerIdentityCommand({}))).Arn;
    case "/reports":
      return read(process.env.REPORTS_BUCKET!);
    case "/archive":
      return read(process.env.ARCHIVE_BUCKET!);
    case "/visits": {
      await sql`create table if not exists visits (at timestamptz default now())`;
      await sql`insert into visits default values`;
      const [{ count }] = await sql`select count(*)::int as count from visits`;
      return { visits: count };
    }
  }
  return { statusCode: 404, body: "Not found" };
}

async function read(bucket: string) {
  try {
    await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    return { bucket, read: true };
  } catch (error: any) {
    return { bucket, read: false, error: error.name };
  }
}
