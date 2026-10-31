import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  appendFile,
  readdir,
  rm,
} from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const cli = process.env.SST_TEST_CLI || "/usr/local/bin/sst";
const endpoint = process.env.SST_FLOCI_ENDPOINT || "http://127.0.0.1:4566";
const app = "/work/app";
const negative = "/work/negative";
const stage = "floci-ci";
function command(program, args, cwd = app) {
  const result = spawnSync(program, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} ${args.join(" ")} failed`);
}
const negativeRuns = {
  resource: 'new aws.ec2.Vpc("Unsupported", {cidrBlock: "10.0.0.0/16"});',
  component: 'new sst.aws.SnsTopic("Unsupported");',
  option:
    'new sst.aws.Function("Unsupported", {handler: "api.handler", vpc: {securityGroups: [], privateSubnets: []}});',
  invoke: "await aws.ec2.getVpcs({});",
};
function negativeConfig(body) {
  return `export default $config({app(){return {name:"floci-negative",home:"aws",removal:"remove",providers:{aws:{version:"7.48.0"}}}},async run(){new sst.aws.Bucket("MustNotBeCreated");${body}}});\n`;
}
// Syntax-check every generated fixture before preparing any external resources.
for (const body of Object.values(negativeRuns))
  new Function(negativeConfig(body).replace("export default ", "return "));
if (process.argv[2] === "prepare") {
  assert.match(
    await readFile(`${app}/sst.config.ts`, "utf8"),
    /    return \{\n      url: fn.url,/,
    "interruption fixture needs the example run output",
  );
  const pkg = JSON.parse(await readFile(`${app}/package.json`, "utf8"));
  pkg.dependencies.sst = "file:/repo/sdk/js";
  await writeFile(`${app}/package.json`, JSON.stringify(pkg));
  await mkdir(negative, { recursive: true });
  for (const file of await readdir(app)) {
    if (file.endsWith(".ts") || file === "package.json")
      await cp(`${app}/${file}`, `${negative}/${file}`);
  }
  await writeFile(
    `${negative}/sst.config.ts`,
    negativeConfig(negativeRuns.resource),
  );
  for (const cwd of [app, negative]) {
    command("bun", ["install"], cwd);
    command(cli, ["install", "--stage", stage], cwd);
  }
  const deps = JSON.parse(
    await readFile("/repo/platform/package.json", "utf8"),
  ).dependencies;
  for (const provider of ["aws", "random"]) {
    command("/work/config/sst/bin/pulumi", [
      "plugin",
      "install",
      "resource",
      provider,
      deps[`@pulumi/${provider}`],
    ]);
  }
  process.exit(0);
}
assert.ok(
  ["verify", "verify-restart"].includes(process.argv[2]),
  "use prepare, verify or verify-restart",
);
// Bound SDK/socket stalls too, not only readiness polling and child shutdown.
setTimeout(() => {
  console.error("Floci integration exceeded its 20 minute deadline");
  process.exit(1);
}, 20 * 60_000).unref();

async function until(label, test, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await test();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}
async function request(url, options = {}) {
  if (options.headers?.Host) {
    // fetch derives Host from the URL; Node HTTP preserves this explicit virtual host.
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        url,
        { ...options, timeout: 20_000 },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () =>
        req.destroy(new Error("function URL request timed out")),
      );
      req.end();
    });
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
}
await until("Floci readiness", async () => {
  const response = await request(`${endpoint}/_floci/init`);
  return response.ok && (await response.json()).completed?.ready;
});
assert.equal(
  (await (await request(`${endpoint}/_floci/health`)).json()).version,
  "2.3.0",
);
// No proxy is installed in this test process. This must fail at the Docker network.
await assert.rejects(
  fetch("https://sts.us-east-1.amazonaws.com", {
    signal: AbortSignal.timeout(5000),
  }),
  "isolated network allowed public AWS access",
);

const require = createRequire(`${app}/.sst/platform/package.json`);
const {
  S3Client,
  ListBucketsCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  SSMClient,
  DescribeParametersCommand,
  GetParameterCommand,
} = require("@aws-sdk/client-ssm");
const {
  LambdaClient,
  ListFunctionsCommand,
} = require("@aws-sdk/client-lambda");
const appRequire = createRequire(`${app}/package.json`);
const { DynamoDBClient, ListTablesCommand, GetItemCommand } = appRequire(
  "@aws-sdk/client-dynamodb",
);
const { SQSClient, ListQueuesCommand } = appRequire("@aws-sdk/client-sqs");
const config = {
  region: "us-east-1",
  endpoint,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
};
const s3 = new S3Client({ ...config, forcePathStyle: true });
const ssm = new SSMClient(config);
const lambda = new LambdaClient(config);
const dynamo = new DynamoDBClient(config);
const sqs = new SQSClient(config);
async function inventory() {
  const [buckets, tables, queues, functions, parameters] = await Promise.all([
    s3.send(new ListBucketsCommand({})),
    dynamo.send(new ListTablesCommand({})),
    sqs.send(new ListQueuesCommand({})),
    lambda.send(new ListFunctionsCommand({})),
    ssm.send(new DescribeParametersCommand({})),
  ]);
  return {
    buckets: (buckets.Buckets || []).map((x) => x.Name).sort(),
    tables: (tables.TableNames || []).sort(),
    queues: (queues.QueueUrls || []).sort(),
    functions: (functions.Functions || []).map((x) => x.FunctionName).sort(),
    parameters: (parameters.Parameters || []).map((x) => x.Name).sort(),
  };
}
async function start(cwd, label) {
  const log = `/work/${label}.log`;
  const child = spawn(
    cli,
    ["dev", "--floci", "--mode=basic", "--stage", stage],
    {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const writes = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
      writes.push(appendFile(log, chunk));
    });
  let exit;
  child.on("error", (error) => {
    exit = error;
  });
  child.on("exit", (code) => {
    exit = code ?? "signal";
  });
  return {
    output: () => output,
    check: () => {
      if (exit !== undefined)
        throw new Error(`sst dev exited (${exit}): ${output.slice(-4000)}`);
    },
    async stop(signal = "SIGINT") {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(5000),
      ]);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await Promise.all(writes);
    },
  };
}
if (process.argv[2] === "verify") {
  const before = await inventory();
  assert.deepEqual(
    before,
    { buckets: [], tables: [], queues: [], functions: [], parameters: [] },
    "CI requires a fresh isolated emulator",
  );
  for (const [kind, body] of Object.entries(negativeRuns)) {
    for (const name of await readdir(`${negative}/.sst`)) {
      if (name.startsWith("floci-preflight") && name.endsWith(".json"))
        await rm(`${negative}/.sst/${name}`);
    }
    await writeFile(`${negative}/sst.config.ts`, negativeConfig(body));
    const dev = await start(negative, `negative-${kind}`);
    try {
      await until(
        `negative ${kind} rejection`,
        () => /No AWS fallback was attempted/.test(dev.output()),
        90_000,
      );
      const reports = (await readdir(`${negative}/.sst`)).filter(
        (name) => name.startsWith("floci-preflight") && name.endsWith(".json"),
      );
      assert.ok(reports.length > 0, "preflight produced no report");
      const report = JSON.parse(
        await readFile(`${negative}/.sst/${reports[0]}`, "utf8"),
      );
      assert.ok(
        report.violations?.length > 0,
        `negative ${kind} did not report a profile violation`,
      );
    } finally {
      await dev.stop();
    }
    assert.deepEqual(
      await inventory(),
      before,
      `negative ${kind} created emulator resources`,
    );
  }
  for (const forbidden of ["deploy", "diff", "refresh"]) {
    const result = spawnSync(cli, [forbidden, "--stage", stage], {
      cwd: app,
      env: process.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Floci is only for sst dev/,
    );
  }
  await rm(`${app}/.sst/outputs.json`, { force: true });
  const dev = await start(app, "positive");
  try {
    const outputs = await until(
      "app outputs",
      async () => {
        dev.check();
        const value = JSON.parse(
          await readFile(`${app}/.sst/outputs.json`, "utf8"),
        );
        return (
          typeof value.url === "string" &&
          value.url.startsWith("http") &&
          value.bucket &&
          value.table &&
          value
        );
      },
      180_000,
    );
    // The function host is virtual; route it over loopback while retaining Host.
    const functionURL = new URL(outputs.url);
    const localURL = new URL(outputs.url);
    localURL.hostname = "127.0.0.1";
    async function invoke() {
      const response = await request(localURL, {
        headers: { Host: functionURL.host },
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    await until("live function response", async () => {
      dev.check();
      return (await invoke()).message === "hello from local SST";
    });
    const object = await s3.send(
      new GetObjectCommand({ Bucket: outputs.bucket, Key: "hello.txt" }),
    );
    assert.equal(await object.Body.transformToString(), "hello from local SST");
    for (const id of ["request", "subscriber"]) {
      await until(`${id} DynamoDB write`, async () => {
        dev.check();
        const item = await dynamo.send(
          new GetItemCommand({
            TableName: outputs.table,
            Key: { id: { S: id } },
          }),
        );
        return item.Item?.message?.S === "hello from local SST";
      });
    }
    const original = await readFile(`${app}/api.ts`, "utf8");
    await writeFile(
      `${app}/api.ts`,
      original.replaceAll("hello from local SST", "hello after reload"),
    );
    await until("live source reload", async () => {
      dev.check();
      return (await invoke()).message === "hello after reload";
    });
    const subscriber = await readFile(`${app}/subscriber.ts`, "utf8");
    await writeFile(
      `${app}/subscriber.ts`,
      subscriber.replace(
        "message: { S: record.body }",
        'message: { S: "subscriber reloaded: " + record.body }',
      ),
    );
    await until("subscriber hot reload", async () => {
      dev.check();
      await invoke();
      const item = await dynamo.send(
        new GetItemCommand({
          TableName: outputs.table,
          Key: { id: { S: "subscriber" } },
        }),
      );
      return (
        item.Item?.message?.S === "subscriber reloaded: hello after reload"
      );
    });
    const errorOffset = dev.output().length;
    await writeFile(
      `${app}/api.ts`,
      "export async function handler( { SYNTAX_ERROR\n",
    );
    // Invoke to trigger lazy rebuilds too; compilation failure must be visible.
    void invoke().catch(() => {});
    await until("syntax error diagnostic", () => {
      dev.check();
      return /(?:ERROR|error|Expected|Unexpected)/.test(
        dev.output().slice(errorOffset),
      );
    });
    await writeFile(
      `${app}/api.ts`,
      original.replaceAll("hello from local SST", "hello after correction"),
    );
    await until("syntax error correction", async () => {
      dev.check();
      return (await invoke()).message === "hello after correction";
    });
    await writeFile(
      "/work/result.json",
      JSON.stringify(
        {
          outputs,
          resources: await inventory(),
          negativeCases: Object.keys(negativeRuns),
          egressDenied: true,
          liveReload: true,
          subscriberReload: true,
          syntaxRecovery: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "Floci integration passed: preflight, isolation, live function, S3, DynamoDB, SQS subscriber, reload.",
    );
  } finally {
    await dev.stop();
  }

  const identity = await ssm.send(
    new GetParameterCommand({ Name: "/sst/floci/instance" }),
  );
  const saved = JSON.parse(await readFile("/work/result.json", "utf8"));
  saved.identity = identity.Parameter.Value;
  await writeFile("/work/result.json", JSON.stringify(saved, null, 2));

  // Hold an actual update after a resource output resolves, then kill its process
  // group. The gate is test fixture code, never a production fault-injection flag.
  const configPath = `${app}/sst.config.ts`;
  const originalConfig = (await readFile(configPath, "utf8")).replace(
    "      url: fn.url,",
    '      recovery: "completed",\n      url: fn.url,',
  );
  const gate =
    '    if (process.env.SST_FLOCI_PREFLIGHT !== "1") bucket.name.apply(async () => { console.log("INTERRUPTED_UPDATE_READY"); await new Promise(() => {}); });\n';
  const interruptedConfig = originalConfig.replace(
    '    return {\n      recovery: "completed",',
    gate + '    return {\n      recovery: "completed",',
  );
  assert.notEqual(
    interruptedConfig,
    originalConfig,
    "interruption gate was not inserted",
  );
  await writeFile(configPath, interruptedConfig);
  const interrupted = await start(app, "interrupted-update");
  try {
    await until(
      "update interruption gate",
      () => {
        interrupted.check();
        return interrupted.output().includes("INTERRUPTED_UPDATE_READY");
      },
      180_000,
    );
  } finally {
    await interrupted.stop("SIGKILL");
    await writeFile(configPath, originalConfig);
  }
  const retry = await start(app, "interrupted-retry");
  try {
    await until(
      "interrupted update lock",
      () => {
        return (
          retry
            .output()
            .includes(
              `SST_FLOCI_ENDPOINT=${endpoint} sst unlock --stage ${stage}`,
            ) &&
          retry.output().includes("Stop all dev/update processes") &&
          retry.output().includes("never unlock an active update")
        );
      },
      120_000,
    );
  } finally {
    await retry.stop();
  }
  // The first retry must explain how to release the stale lock; unlock must use
  // the Floci endpoint and preserve all state, not reset the emulator.
  command(cli, ["unlock", "--stage", stage]);
  saved.interruptedUpdate = "recovered with sst unlock";
  await writeFile("/work/result.json", JSON.stringify(saved, null, 2));
}

// Returning to Floci must reuse its instance and stage state.
const result = JSON.parse(await readFile("/work/result.json", "utf8"));
if (process.argv[2] === "verify-restart") {
  assert.deepEqual(
    await inventory(),
    result.resources,
    "Docker restart lost resource metadata",
  );
  const object = await s3.send(
    new GetObjectCommand({ Bucket: result.outputs.bucket, Key: "hello.txt" }),
  );
  assert.equal(
    await object.Body.transformToString(),
    "hello after correction",
    "Docker restart lost S3 data",
  );
  const item = await dynamo.send(
    new GetItemCommand({
      TableName: result.outputs.table,
      Key: { id: { S: "subscriber" } },
    }),
  );
  assert.equal(
    item.Item?.message?.S,
    "subscriber reloaded: hello after correction",
    "Docker restart lost DynamoDB data",
  );
}
await rm(`${app}/.sst/outputs.json`, { force: true });
const restarted = await start(
  app,
  process.argv[2] === "verify-restart" ? "docker-restart" : "restart",
);
try {
  await until(
    "return to Floci",
    async () => {
      restarted.check();
      const outputs = JSON.parse(
        await readFile(`${app}/.sst/outputs.json`, "utf8"),
      );
      if (outputs.recovery !== "completed") return false;
      const originalURL = new URL(result.outputs.url);
      const localURL = new URL(originalURL);
      localURL.hostname = "127.0.0.1";
      const response = await request(localURL, {
        headers: { Host: originalURL.host },
      });
      return (
        response.ok &&
        (await response.json()).message === "hello after correction"
      );
    },
    180_000,
  );
  const identityAfter = await ssm.send(
    new GetParameterCommand({ Name: "/sst/floci/instance" }),
  );
  assert.equal(identityAfter.Parameter.Value, result.identity);
  assert.deepEqual(
    await inventory(),
    result.resources,
    "returning to Floci replaced resources",
  );
  const persisted = await s3.send(
    new GetObjectCommand({ Bucket: result.outputs.bucket, Key: "hello.txt" }),
  );
  assert.equal(
    await persisted.Body.transformToString(),
    "hello after correction",
  );
  await until("recovered subscriber", async () => {
    const item = await dynamo.send(
      new GetItemCommand({
        TableName: result.outputs.table,
        Key: { id: { S: "subscriber" } },
      }),
    );
    return (
      item.Item?.message?.S === "subscriber reloaded: hello after correction"
    );
  });
  result.restart = true;
  if (process.argv[2] === "verify-restart") result.dockerRestart = true;
  await writeFile("/work/result.json", JSON.stringify(result, null, 2));
  console.log(
    "Floci restart passed: instance identity, stage state, and live function reused.",
  );
} finally {
  await restarted.stop();
}
