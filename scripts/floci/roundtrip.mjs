// Deliberately opt-in: this runner creates real AWS resources and retains them.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { get as httpGet, Agent as HttpAgent } from "node:http";
import { get as httpsGet, Agent as HttpsAgent } from "node:https";

const exec = promisify(execFile);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function options(env) {
  for (const key of ["SST_TEST_AWS_PROFILE", "SST_TEST_STAGE", "SST_TEST_CLI"])
    if (!env[key]?.trim())
      throw new Error(
        `${key} must be explicitly set; no test work was started`,
      );
  if (!/^[a-zA-Z0-9-]+$/.test(env.SST_TEST_STAGE))
    throw new Error(
      "SST_TEST_STAGE must contain only letters, digits and hyphens",
    );
  if (!path.isAbsolute(env.SST_TEST_CLI))
    throw new Error("SST_TEST_CLI must be an absolute path to the built CLI");
  const endpoint = env.SST_TEST_FLOCI_ENDPOINT;
  if (endpoint) {
    const u = new URL(endpoint);
    if (
      u.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new Error(
        "SST_TEST_FLOCI_ENDPOINT must be an HTTP loopback endpoint",
      );
  }
  return {
    profile: env.SST_TEST_AWS_PROFILE,
    stage: env.SST_TEST_STAGE,
    cli: env.SST_TEST_CLI,
    endpoint,
  };
}

export function targetEnvironment(base, target, opts) {
  assert(["aws", "floci"].includes(target), "unknown target");
  const env = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) =>
        !/^(AWS_|SST_AWS_|SST_FLOCI|SST_TEST_)/i.test(key) &&
        !/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY)$/i.test(
          key,
        ),
    ),
  );
  if (target === "aws")
    Object.assign(env, {
      AWS_PROFILE: opts.profile,
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    });
  else if (opts.endpoint) env.SST_FLOCI_ENDPOINT = opts.endpoint;
  return env;
}

export function classifyURL(value) {
  const url = new URL(value);
  if (
    url.protocol === "https:" &&
    /^[a-z0-9-]+\.lambda-url\.us-east-1\.on\.aws$/.test(url.hostname)
  )
    return "aws";
  if (
    ["http:", "https:"].includes(url.protocol) &&
    (url.hostname === "localhost.floci.io" ||
      url.hostname.endsWith(".localhost.floci.io") ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    return "floci";
  throw new Error(`Refusing unrecognized function URL target: ${url.origin}`);
}

// Explicit agents keep a parent Floci shell's dead proxy out of URL checks.
export function invokeURL(url, signal) {
  const secure = new URL(url).protocol === "https:";
  const agent = secure
    ? new HttpsAgent({ proxyEnv: {} })
    : new HttpAgent({ proxyEnv: {} });
  return new Promise((resolve, reject) => {
    const request = (secure ? httpsGet : httpGet)(
      url,
      { agent, signal },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1_000_000)
            response.destroy(new Error("Function response exceeds 1 MB"));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, 200);
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.on("close", () => agent.destroy());
  });
}

async function until(check, timeout = 120_000, signal) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      return await check();
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
    await delay(1000);
  }
  throw new Error(`Timed out: ${last?.message}`, { cause: last });
}

async function stop(child) {
  if (!child.pid) return;
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve));
  // Each dev session owns its process group, including its local workers.
  try {
    process.kill(-child.pid, "SIGINT");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await Promise.race([exited, delay(10_000)]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await exited;
}

// Await each phase, including its process cleanup, before starting the next.
export async function runPhases(run) {
  for (const [index, [target, mode]] of [
    ["floci", "dev"],
    ["aws", "dev"],
    ["aws", "deploy"],
    ["floci", "dev"],
  ].entries())
    await run({ index, target, mode });
}

export async function deployFresh(directory, deploy) {
  const file = path.join(directory, ".sst/outputs.json");
  await rm(file, { force: true });
  await deploy(); // A failed deploy must never fall through to verification.
  const outputs = JSON.parse(await readFile(file, "utf8"));
  assert.equal(classifyURL(outputs.url), "aws");
  return outputs;
}

export function assertPackagedFunction(config) {
  assert.match(
    config.Runtime || "",
    /^nodejs\d+\.x$/,
    "expected packaged Node.js runtime",
  );
  assert.equal(config.State, "Active");
  assert.equal(config.LastUpdateStatus, "Successful");
  for (const key of Object.keys(config.Environment?.Variables || {}))
    assert(
      !/^(SST_APPSYNC|SST_FLOCI|SST_FUNCTION_ID)/.test(key),
      `live bridge environment remains: ${key}`,
    );
}

export async function main(base = process.env) {
  const opts = options(base); // Validate every opt-in before filesystem or process work.
  await access(opts.cli, constants.X_OK);
  await exec("aws", ["--version"]);
  const directory = await mkdtemp(path.join(tmpdir(), "sst-floci-roundtrip-"));
  console.log(`Retaining app, logs and results at ${directory}`);
  for (const file of ["sst.config.ts", "api.ts", "subscriber.ts"])
    await copyFile(
      path.join(root, "examples/aws-floci", file),
      path.join(directory, file),
    );
  // Add an inspection output without changing the resources or application behavior.
  const configFile = path.join(directory, "sst.config.ts");
  const config = await readFile(configFile, "utf8");
  assert(config.includes("url: fn.url,"), "example function output changed");
  await writeFile(
    configFile,
    config.replace("url: fn.url,", "url: fn.url, functionName: fn.name,"),
  );
  const pkg = JSON.parse(
    await readFile(path.join(root, "examples/aws-floci/package.json"), "utf8"),
  );
  pkg.dependencies.sst = `file:${path.join(root, "sdk/js")}`;
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  await exec("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: directory,
    env: targetEnvironment(base, "aws", opts),
    timeout: 300_000,
  });
  const original = await readFile(path.join(directory, "api.ts"), "utf8");
  assert(
    original.includes("hello from local SST"),
    "example message changed; update roundtrip fixture",
  );
  const originalSubscriber = await readFile(
    path.join(directory, "subscriber.ts"),
    "utf8",
  );
  assert(
    originalSubscriber.includes("record.body"),
    "subscriber changed; update roundtrip fixture",
  );
  const results = [];
  let active;
  const abort = new AbortController();
  const interrupt = () => {
    abort.abort(new Error("Round trip interrupted"));
    if (active) void stop(active);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await runPhases(async ({ index, target, mode }) => {
      abort.signal.throwIfAborted();
      const label = `${index + 1}-${target}-${mode}`;
      const env = targetEnvironment(base, target, opts);
      const initialMessage = `roundtrip ${label} initial ${Date.now()}`;
      await writeFile(
        path.join(directory, "api.ts"),
        original.replaceAll("hello from local SST", initialMessage),
      );
      await writeFile(
        path.join(directory, "subscriber.ts"),
        originalSubscriber,
      );
      // A previous target's outputs must never count as this session being ready.
      await rm(path.join(directory, ".sst/outputs.json"), { force: true });
      const log = await open(path.join(directory, `${label}.log`), "w");
      const args = [
        mode,
        ...(mode === "dev" ? ["--mode=basic"] : []),
        "--stage",
        opts.stage,
        ...(target === "floci" ? ["--floci"] : []),
      ];
      console.log(`Starting ${label}: ${opts.cli} ${args.join(" ")}`);
      let deployedOutputs;
      if (mode === "dev")
        active = spawn(opts.cli, args, {
          cwd: directory,
          env,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        });
      let startError;
      active?.on("error", (error) => {
        startError = error;
      });
      const child = active;
      const checkRunning = () => {
        abort.signal.throwIfAborted();
        if (startError) throw Object.assign(startError, { fatal: true });
        if (child && (child.exitCode !== null || child.signalCode !== null))
          throw Object.assign(
            new Error(`${label} exited; inspect ${label}.log`),
            { fatal: true },
          );
      };
      try {
        if (mode === "deploy") {
          assert.equal(
            active,
            undefined,
            "dev process must stop before deployment",
          );
          deployedOutputs = await deployFresh(directory, async () => {
            try {
              const result = await exec(opts.cli, args, {
                cwd: directory,
                env,
                timeout: 600_000,
                signal: abort.signal,
                maxBuffer: 20 * 1024 * 1024,
              });
              await log.write(result.stdout + result.stderr);
            } catch (error) {
              await log.write((error.stdout || "") + (error.stderr || ""));
              throw error;
            }
          });
        }
        const outputs =
          deployedOutputs ||
          (await until(
            async () => {
              checkRunning();
              const outputs = JSON.parse(
                await readFile(
                  path.join(directory, ".sst/outputs.json"),
                  "utf8",
                ),
              );
              for (const key of ["url", "bucket", "table", "queue"])
                assert(outputs[key], `missing output ${key}`);
              assert.equal(
                classifyURL(outputs.url),
                target,
                "outputs belong to the wrong target",
              );
              return outputs;
            },
            600_000,
            abort.signal,
          ));
        const awsEnv =
          target === "aws"
            ? env
            : {
                ...env,
                AWS_ACCESS_KEY_ID: "test",
                AWS_SECRET_ACCESS_KEY: "test",
                AWS_REGION: "us-east-1",
                AWS_EC2_METADATA_DISABLED: "true",
                AWS_CONFIG_FILE: "/dev/null",
                AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
              };
        const aws = async (...args) => {
          checkRunning();
          const { stdout } = await exec(
            "aws",
            [
              "--region",
              "us-east-1",
              "--output",
              "json",
              "--no-cli-pager",
              ...(target === "floci"
                ? ["--endpoint-url", opts.endpoint || "http://127.0.0.1:4566"]
                : ["--profile", opts.profile]),
              ...args,
            ],
            {
              cwd: directory,
              env: awsEnv,
              timeout: 30_000,
              signal: abort.signal,
            },
          );
          return JSON.parse(stdout || "{}");
        };
        const identity =
          target === "floci"
            ? (
                await aws(
                  "ssm",
                  "get-parameter",
                  "--name",
                  "/sst/floci/instance",
                )
              ).Parameter.Value
            : (await aws("sts", "get-caller-identity")).Account;
        const verify = async (message, subscriberMessage = message) => {
          await aws(
            "dynamodb",
            "delete-item",
            "--table-name",
            outputs.table,
            "--key",
            JSON.stringify({ id: { S: "subscriber" } }),
          );
          await until(
            async () => {
              checkRunning();
              const response = await invokeURL(
                outputs.url,
                AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
              );
              assert.equal(response.message, message);
            },
            120_000,
            abort.signal,
          );
          const objectFile = path.join(directory, `${label}-s3.txt`);
          await aws(
            "s3api",
            "get-object",
            "--bucket",
            outputs.bucket,
            "--key",
            "hello.txt",
            objectFile,
          );
          assert.equal(await readFile(objectFile, "utf8"), message);
          for (const id of ["request", "subscriber"])
            await until(
              async () => {
                const row = await aws(
                  "dynamodb",
                  "get-item",
                  "--consistent-read",
                  "--table-name",
                  outputs.table,
                  "--key",
                  JSON.stringify({ id: { S: id } }),
                );
                const expected =
                  id === "subscriber" ? subscriberMessage : message;
                if (
                  id === "subscriber" &&
                  subscriberMessage !== message &&
                  row.Item?.message?.S !== expected
                ) {
                  // A message can reach the old worker while its rebuild is in
                  // progress. Send a fresh invocation until the new worker runs.
                  const response = await invokeURL(
                    outputs.url,
                    AbortSignal.any([
                      abort.signal,
                      AbortSignal.timeout(30_000),
                    ]),
                  );
                  assert.equal(response.message, message);
                }
                assert.equal(
                  row.Item?.message?.S,
                  expected,
                  `${id} did not process the current invocation`,
                );
              },
              120_000,
              abort.signal,
            );
        };
        if (mode === "deploy") {
          assertPackagedFunction(
            await aws(
              "lambda",
              "get-function-configuration",
              "--function-name",
              outputs.functionName,
            ),
          );
        }
        await verify(initialMessage);
        if (mode === "dev") {
          const reloaded = `roundtrip ${label} ${Date.now()}`;
          await writeFile(
            path.join(directory, "api.ts"),
            original.replaceAll("hello from local SST", reloaded),
          );
          await verify(reloaded);
          const subscriberPrefix = `subscriber reloaded ${label} ${Date.now()}: `;
          await writeFile(
            path.join(directory, "subscriber.ts"),
            originalSubscriber.replaceAll(
              "record.body",
              `${JSON.stringify(subscriberPrefix)} + record.body`,
            ),
          );
          await verify(reloaded, subscriberPrefix + reloaded);
        }
        const result = {
          target,
          mode,
          identity,
          outputs,
          hotReload: mode === "dev",
          subscriberHotReload: mode === "dev",
          packagedFunction: mode === "deploy",
        };
        if (index === 3) {
          assert.equal(
            identity,
            results[0].identity,
            "Floci instance identity changed across cloud dev and deploy",
          );
          assert.deepEqual(
            outputs,
            results[0].outputs,
            "Floci resource IDs changed across cloud dev and deploy",
          );
        }
        results.push(result);
        await writeFile(
          path.join(directory, "results.json"),
          JSON.stringify(results, null, 2),
        );
        console.log(
          `${label}: function URL, S3, DynamoDB and queue subscriber passed; ${
            mode === "dev"
              ? "API and subscriber hot reload"
              : "packaged Lambda execution"
          } verified`,
        );
      } finally {
        if (child) await stop(child);
        active = undefined;
        await log.close();
      }
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  console.log(
    `Round trip passed. Resources retained; results: ${directory}/results.json`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
