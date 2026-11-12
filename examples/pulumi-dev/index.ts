// First, before the program makes anything: under `sst dev` it runs what
// sst.dev.yaml names, and outside it, it does nothing
import { dev } from "sst/pulumi";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const config = new pulumi.Config();

// A bucket the API may read, and one it may not
const reports = new aws.s3.Bucket("Reports", { forceDestroy: true });
const archive = new aws.s3.Bucket("Archive", { forceDestroy: true });

const readReports = pulumi.jsonStringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: ["s3:ListBucket"], Resource: [reports.arn] }],
});

// The API's role. In `sst dev` its code runs on this machine with this role's
// credentials, so what it can't do in AWS, it can't do here either.
const role = new aws.iam.Role("ApiRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});
new aws.iam.RolePolicyAttachment("ApiLogs", {
  role: role.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});
new aws.iam.RolePolicy("ApiReports", { role: role.id, policy: readReports });

// Postgres in a container on this machine in `sst dev`, from the Postgres dev
// command, and in the cloud otherwise
const database = dev
  ? {
      host: pulumi.output("localhost"),
      port: pulumi.output("5432"),
      user: pulumi.output("postgres"),
      password: pulumi.secret("password"),
      name: pulumi.output("postgres"),
    }
  : createDatabase();

// In `sst dev` it runs from its source on this machine, as sst.dev.yaml says
const api = new aws.lambda.Function("Api", {
  runtime: "nodejs22.x",
  role: role.arn,
  // `npm run build` bundles functions/api.ts here
  code: new pulumi.asset.FileArchive("./dist/api"),
  handler: "index.handler",
  timeout: 20,
  environment: {
    variables: {
      REPORTS_BUCKET: reports.bucket,
      ARCHIVE_BUCKET: archive.bucket,
      DB_HOST: database.host,
      DB_PORT: database.port,
      DB_USER: database.user,
      DB_PASSWORD: database.password,
      DB_NAME: database.name,
      GREETING: config.requireSecret("greeting"),
    },
  },
});
const url = new aws.lambda.FunctionUrl("ApiUrl", {
  functionName: api.name,
  authorizationType: "NONE",
  cors: { allowOrigins: ["*"] },
});
new aws.lambda.Permission("ApiUrlAccess", {
  action: "lambda:InvokeFunctionUrl",
  function: api.name,
  principal: "*",
  functionUrlAuthType: "NONE",
});
new aws.lambda.Permission("ApiUrlInvoke", {
  action: "lambda:InvokeFunction",
  function: api.name,
  principal: "*",
  invokedViaFunctionUrl: true,
});

// A report job's role. In `sst dev` the Report dev command runs as it, so
// the account may take it there.
const reporter = new aws.iam.Role("Reporter", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs-tasks.amazonaws.com" }),
});
new aws.iam.RolePolicy("ReporterReports", { role: reporter.id, policy: readReports });

// The frontend's files in a bucket, and in `sst dev` its dev server instead,
// from the Web dev command
if (!dev) deploySite(url.functionUrl);

// What sst.dev.yaml's dev commands take of the stack
export const apiUrl = url.functionUrl;
export const reportsBucket = reports.bucket;
export const archiveBucket = archive.bucket;

function createDatabase() {
  const password = config.requireSecret("dbPassword");
  const db = new aws.rds.Instance("Database", {
    // RDS takes lowercase identifiers only
    identifierPrefix: "app-",
    engine: "postgres",
    engineVersion: "17",
    instanceClass: "db.t4g.micro",
    allocatedStorage: 20,
    dbName: "app",
    username: "app",
    password,
    skipFinalSnapshot: true,
  });
  return {
    host: db.address,
    port: db.port.apply(String),
    user: db.username,
    password,
    name: db.dbName.apply((name) => name ?? "app"),
  };
}

function deploySite(apiUrl: pulumi.Output<string>) {
  const site = new aws.s3.Bucket("Site", { forceDestroy: true });
  new aws.s3.BucketObjectv2("SiteIndex", {
    bucket: site.bucket,
    key: "index.html",
    source: new pulumi.asset.FileAsset("web/index.html"),
    contentType: "text/html",
  });
  new aws.s3.BucketObjectv2("SiteConfig", {
    bucket: site.bucket,
    key: "config.js",
    content: pulumi.interpolate`window.API_URL = ${apiUrl.apply((u) => JSON.stringify(u))};`,
    contentType: "text/javascript",
  });
}
