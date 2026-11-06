// Opt-in compatibility probe, not an SST deployment target.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import {
  LocalWorkspace,
  PulumiCommand,
} from "@pulumi/pulumi/automation/index.js";
import { AwsClient } from "aws4fetch";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const port = process.env.FLOCI_SPIKE_PORT ?? "4566";
assert(
  /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535,
  "Invalid local port",
);
const workDir = path.join(root, `.sst/floci-spike-${port}`);
const endpoint = `http://127.0.0.1:${port}`;
const region = "us-east-1";
const mode = process.argv[2] ?? "test";
assert(
  ["test", "destroy"].includes(mode),
  "Usage: node scripts/floci/spike.mjs [test|destroy]",
);
const ready = await fetch(`${endpoint}/_floci/init`).then((r) => r.json());
assert.equal(ready.completed?.ready, true, "Floci must be ready");

// Scrub inherited credential/endpoint overrides before spawning Pulumi.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("AWS_") || /^(HTTPS?|ALL|NO)_PROXY$/i.test(key))
    delete process.env[key];
}
Object.assign(process.env, {
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_REGION: region,
  AWS_DEFAULT_REGION: region,
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  AWS_ENDPOINT_URL: endpoint,
  HTTPS_PROXY: "http://127.0.0.1:1",
  HTTP_PROXY: "http://127.0.0.1:1",
  NO_PROXY: "127.0.0.1,localhost,host.docker.internal,.localhost.floci.io",
  NODE_USE_ENV_PROXY: "1",
  PULUMI_CONFIG_PASSPHRASE: "floci-spike-only",
});
// Node reads proxy settings at startup, not when process.env is changed later.
if (!process.execArgv.includes("--use-env-proxy")) {
  const child = spawnSync(
    process.execPath,
    ["--use-env-proxy", ...process.argv.slice(1)],
    {
      env: process.env,
      stdio: "inherit",
    },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
await assert.rejects(
  fetch("https://sts.us-east-1.amazonaws.com", {
    signal: AbortSignal.timeout(3000),
  }),
  (error) => error.cause?.code === "ECONNREFUSED",
  "unmapped HTTPS must hit the dead proxy",
);
await mkdir(path.join(workDir, "state"), { recursive: true });
const sstHome =
  process.platform === "darwin"
    ? path.join(homedir(), "Library/Application Support/sst")
    : path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
        "sst",
      );
const command = await PulumiCommand.get({
  root: process.env.SST_PULUMI_ROOT ?? sstHome,
});
const dependencies = JSON.parse(
  await readFile(path.join(root, "platform/package.json")),
).dependencies;
assert.equal(
  command.version?.toString(),
  dependencies["@pulumi/pulumi"],
  "Use the repository's pinned Pulumi CLI via SST_PULUMI_ROOT",
);
const version = dependencies["@pulumi/aws"];
const events = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url === "/events") events.push(JSON.parse(body));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ transport: "host-http", echo: body }));
});
await new Promise((resolve) => server.listen(13579, "0.0.0.0", resolve));

const signed = new AwsClient({
  accessKeyId: "test",
  secretAccessKey: "test",
  region,
});
async function request(service, pathname, init = {}) {
  const response = await signed.fetch(`${endpoint}${pathname}`, {
    ...init,
    aws: { service, region },
  });
  const text = await response.text();
  assert(response.ok, `${service} ${response.status}: ${text}`);
  return text;
}
let revision = "one";
const program = async () => {
  const provider = new aws.Provider(
    "floci",
    {
      region,
      accessKey: "test",
      secretKey: "test",
      skipCredentialsValidation: true,
      skipMetadataApiCheck: true,
      skipRequestingAccountId: true,
      s3UsePathStyle: true,
      endpoints: [
        Object.fromEntries(
          [
            "s3",
            "dynamodb",
            "sqs",
            "lambda",
            "iam",
            "sts",
            "ssm",
            "ecr",
            "kms",
            "cloudwatch",
            "cloudwatchlogs",
          ].map((s) => [s, endpoint]),
        ),
      ],
    },
    { version },
  );
  const opts = { provider, version };
  const bucket = new aws.s3.BucketV2(
    "bucket",
    { forceDestroy: true, tags: { revision } },
    opts,
  );
  const table = new aws.dynamodb.Table(
    "table",
    {
      billingMode: "PAY_PER_REQUEST",
      hashKey: "id",
      attributes: [{ name: "id", type: "S" }],
      tags: { revision },
    },
    opts,
  );
  const queue = new aws.sqs.Queue(
    "queue",
    { visibilityTimeoutSeconds: 60, tags: { revision } },
    opts,
  );
  const role = new aws.iam.Role(
    "role",
    {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    },
    opts,
  );
  const policy = new aws.iam.RolePolicy(
    "policy",
    {
      role: role.id,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: pulumi.interpolate`${bucket.arn}/*`,
          },
          {
            Effect: "Allow",
            Action: ["dynamodb:GetItem"],
            Resource: table.arn,
          },
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ],
            Resource: queue.arn,
          },
        ],
      }),
    },
    opts,
  );
  const fn = new aws.lambda.Function(
    "function",
    {
      role: role.arn,
      runtime: "nodejs22.x",
      handler: "index.handler",
      timeout: 20,
      environment: {
        variables: {
          BUCKET: bucket.bucket,
          TABLE: table.name,
          REVISION: revision,
        },
      },
      code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
exports.handler = async (event) => {
  const callback = 'http://host.docker.internal:13579';
  if (event.Records) {
    const r = await fetch(callback + '/events', {method:'POST',body:JSON.stringify(event)});
    if (!r.ok) throw new Error('host callback failed');
    return {};
  }
  const {S3Client, GetObjectCommand} = require('@aws-sdk/client-s3');
  const {DynamoDBClient, GetItemCommand} = require('@aws-sdk/client-dynamodb');
  const config = {region:'us-east-1',endpoint:'http://localhost.floci.io:${port}',credentials:{accessKeyId:'test',secretAccessKey:'test'}};
  const object = await new S3Client({...config,forcePathStyle:true}).send(new GetObjectCommand({Bucket:process.env.BUCKET,Key:'hello.txt'}));
  const item = await new DynamoDBClient(config).send(new GetItemCommand({TableName:process.env.TABLE,Key:{id:{S:'hello'}}}));
  const host = await fetch(callback).then(r=>r.json());
  return {statusCode:200,body:JSON.stringify({object:await object.Body.transformToString(),item:item.Item.value.S,revision:process.env.REVISION,host})};
};`),
      }),
    },
    { ...opts, dependsOn: [policy] },
  );
  const url = new aws.lambda.FunctionUrl(
    "url",
    { functionName: fn.name, authorizationType: "NONE" },
    opts,
  );
  new aws.lambda.Permission(
    "url-permission",
    {
      action: "lambda:InvokeFunctionUrl",
      function: fn.name,
      principal: "*",
      functionUrlAuthType: "NONE",
    },
    opts,
  );
  new aws.lambda.EventSourceMapping(
    "subscriber",
    { eventSourceArn: queue.arn, functionName: fn.name, batchSize: 1 },
    opts,
  );
  return {
    bucket: bucket.bucket,
    table: table.name,
    queue: queue.url,
    function: fn.name,
    url: url.functionUrl,
  };
};

try {
  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName: "local", projectName: "sst-floci-spike", program },
    {
      workDir,
      pulumiHome: sstHome,
      pulumiCommand: command,
      projectSettings: {
        name: "sst-floci-spike",
        runtime: "nodejs",
        backend: { url: `file://${workDir}/state` },
      },
      envVars: { PULUMI_CONFIG_PASSPHRASE: "floci-spike-only" },
    },
  );
  if (mode === "destroy") {
    await stack.destroy({ onOutput: console.log });
  } else {
    await stack.up({ onOutput: console.log });
    const second = await stack.up({ onOutput: console.log });
    assert(
      Object.entries(second.summary.resourceChanges).every(
        ([op, n]) => op === "same" || n === 0,
      ),
      "second up must be empty",
    );
    await stack.refresh({ onOutput: console.log });
    const preview = await stack.preview({ onOutput: console.log });
    assert(
      Object.entries(preview.changeSummary).every(
        ([op, n]) => op === "same" || n === 0,
      ),
      "refresh must not introduce drift",
    );
    revision = "two";
    await stack.up({ onOutput: console.log });
    const out = await stack.outputs();
    await request("s3", `/${out.bucket.value}/hello.txt`, {
      method: "PUT",
      body: "hello from S3",
    });
    await request("dynamodb", "/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "DynamoDB_20120810.PutItem",
      },
      body: JSON.stringify({
        TableName: out.table.value,
        Item: { id: { S: "hello" }, value: { S: "hello from Dynamo" } },
      }),
    });
    const invocation = JSON.parse(
      await request(
        "lambda",
        `/2015-03-31/functions/${out.function.value}/invocations`,
        { method: "POST", body: "{}" },
      ),
    );
    assert.equal(
      invocation.statusCode,
      200,
      `Lambda invocation failed: ${JSON.stringify(invocation)}`,
    );
    const result = JSON.parse(invocation.body);
    assert.equal(result.object, "hello from S3");
    assert.equal(result.item, "hello from Dynamo");
    assert.equal(result.revision, "two");
    assert.equal(result.host.transport, "host-http");
    // Function URLs use Floci's wildcard hostname. Restrict what we will fetch.
    const url = new URL(out.url.value);
    assert(
      url.hostname.endsWith(".localhost.floci.io"),
      `Unexpected function URL: ${url}`,
    );
    assert.equal(url.protocol, "http:");
    assert.equal(url.port, port);
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, await response.text());
    await request("sqs", "/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonSQS.SendMessage",
      },
      body: JSON.stringify({
        QueueUrl: out.queue.value,
        MessageBody: "hello from SQS",
      }),
    });
    for (let i = 0; i < 30 && !events.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 1000));
    assert(
      events.some((e) => e.Records?.some((r) => r.body === "hello from SQS")),
      "SQS subscriber must reach the host transport",
    );
    await writeFile(
      path.join(workDir, "result.json"),
      JSON.stringify(
        {
          providerVersion: version,
          secondUpdate: second.summary.resourceChanges,
          afterRefresh: preview.changeSummary,
          outputs: out,
          invocation: result,
          queueDelivered: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS: create, empty second up, refresh, update, Lambda/S3/Dynamo, function URL, SQS and container-to-host HTTP",
    );
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
