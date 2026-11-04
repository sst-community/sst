import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { AwsClient } from "aws4fetch";
import type { Target } from "../components/target";

/** What {@link targetSuite} is given besides the target. */
export interface TargetSuiteOptions {
  /**
   * The `sst` CLI to run.
   * @default `"sst"`, from the `PATH`, which `npm test` gives
   * `node_modules/.bin`
   */
  cli?: string;
  /**
   * How long each command may take, in milliseconds.
   * @default `600000`
   */
  timeout?: number;
  /** Keeps the fixture app's folder, for a look after a failure. */
  keep?: boolean;
  /**
   * Whether the target runs Lambda functions. The suite then also runs
   * `sst dev`, and checks what a function it runs on this machine gets.
   * @default `true`
   */
  functions?: boolean;
}

/** One of the suite's checks, and what it found. */
export interface TargetSuiteCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Checks a target against what SST promises on a target's stage, with the
 * `sst` CLI, on this machine. A package that exports a {@link Target} runs it
 * in its own CI. It needs Docker when the target has a container.
 *
 * It writes an app with an S3 bucket and a function, and binds a stage to the
 * target. Then it deploys, runs `sst shell` and `sst dev`, and removes the
 * stage with fake AWS credentials,
 * a profile and credential files of the developer's planted around the CLI,
 * and a proxy in front of it that records where it's asked to go. It checks
 * that:
 *
 * - the program, `sst shell`, and a function `sst dev` runs on this machine
 *   get the target's credentials and region, and nothing that was planted;
 * - the program can reach nothing but this machine: the core's fence refuses
 *   anything else;
 * - the bucket is created in the target, through its endpoint, and removed;
 * - the stage's state is kept in the target's home, not the app's;
 * - with nothing deployed on it, its container is stopped, and
 *   `sst target stop` stops it, unless another command is running on the
 *   target;
 * - nothing is sent to AWS through the proxy the CLI was given.
 *
 * It throws with every check that failed, and returns them all.
 *
 * @example
 * ```ts title="test/target.test.ts"
 * import { test } from "vitest";
 * import { targetSuite } from "sst/testing";
 * import { emulator } from "../src/target";
 *
 * test("passes SST's target suite", () => targetSuite(emulator), 900_000);
 * ```
 */
export async function targetSuite(
  target: Target,
  options: TargetSuiteOptions = {},
): Promise<TargetSuiteCheck[]> {
  const cli = options.cli ?? "sst";
  const functions = options.functions ?? true;
  const timeout = options.timeout ?? 600_000;
  const id = Math.random().toString(36).slice(2, 8);
  const app = `target-suite-${id}`;
  const stage = "suite";
  const marker = `SUITEPLANTED${id.toUpperCase()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-target-suite-"));
  const planted = path.join(dir, "planted", marker);
  const checks: TargetSuiteCheck[] = [];
  let removed = false;
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, detail });

  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(
    path.join(planted, "credentials"),
    `[default]\naws_access_key_id = AKIA${marker}\naws_secret_access_key = ${marker}\n`,
  );
  fs.writeFileSync(path.join(planted, "token"), marker);
  fs.writeFileSync(
    path.join(planted, "config"),
    `[default]\nregion = ${marker.toLowerCase()}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "app", "sst.config.ts"),
    fixture(app, stage, target, marker, functions),
  );

  fs.writeFileSync(
    path.join(dir, "app", "report.ts"),
    `export const handler = async () => ({\n` +
      `  ...(${REPORT})(process.env, ${JSON.stringify(marker)}),\n` +
      `  here: process.cwd(),\n` +
      `});\n`,
  );
  fs.writeFileSync(
    path.join(dir, "shell.mjs"),
    `console.log("SUITE" + JSON.stringify((${REPORT})(process.env, ${JSON.stringify(
      marker,
    )})));\n`,
  );

  const proxy = await recordingProxy();
  // The developer's AWS settings, each with the marker in it, so the suite
  // can tell if one gets through
  const plantedEnv = {
    AWS_ACCESS_KEY_ID: `AKIA${marker}`,
    AWS_SECRET_ACCESS_KEY: marker,
    AWS_SESSION_TOKEN: marker,
    AWS_SECURITY_TOKEN: marker,
    AWS_PROFILE: marker.toLowerCase(),
    AWS_REGION: marker.toLowerCase(),
    AWS_DEFAULT_REGION: marker.toLowerCase(),
    AWS_ENDPOINT_URL: `https://${marker.toLowerCase()}.invalid`,
    AWS_ENDPOINT_URL_S3: `https://${marker.toLowerCase()}.invalid`,
    AWS_ROLE_ARN: `arn:aws:iam::123456789012:role/${marker}`,
    AWS_WEB_IDENTITY_TOKEN_FILE: path.join(planted, "token"),
    AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:9/${marker}`,
    AWS_SHARED_CREDENTIALS_FILE: path.join(planted, "credentials"),
    AWS_CONFIG_FILE: path.join(planted, "config"),
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    NO_PROXY: "",
    no_proxy: "",
  };
  const run = (args: string[], env: Record<string, string> = {}) =>
    command(cli, args, path.join(dir, "app"), env, timeout);
  const s3 = new AwsClient({
    accessKeyId: target.credentials.accessKeyId,
    secretAccessKey: target.credentials.secretAccessKey,
    region: target.region,
    service: "s3",
  });
  // The target's buckets, or nothing if it doesn't answer
  const buckets = async () => {
    try {
      const res = await s3.fetch(`${target.endpoint.replace(/\/$/, "")}/`);
      return await res.text();
    } catch {
      return undefined;
    }
  };

  try {
    // Installs the platform and the plugins, and starts the target, with
    // what the machine has, so what follows downloads nothing
    const install = await run(["install"]);
    const diff =
      install.code === 0 ? await run(["diff", "--stage", stage]) : install;
    check("installs, and previews the stage", diff.code === 0, diff.tail);
    const deploy =
      diff.code === 0
        ? await run(["deploy", "--stage", stage], plantedEnv)
        : undefined;
    if (deploy) check("deploys", deploy.code === 0, deploy.tail);
    if (deploy?.code === 0) {
      const outputs = JSON.parse(
        fs.readFileSync(path.join(dir, "app", ".sst", "outputs.json"), "utf8"),
      );
      const program = JSON.parse(outputs.program);
      envChecks("the program", program, target, check);
      check(
        "the program can reach nothing but this machine",
        program.internet === "fenced",
        program.internet,
      );
      const listed = await buckets();
      check(
        "the bucket is in the target",
        !!listed?.includes(`<Name>${outputs.bucket}</Name>`),
        outputs.bucket,
      );
      const state = path.join(
        targetHome(target.name),
        "state",
        "app",
        app,
        `${stage}.json`,
      );
      check("the state is in the target's home", fs.existsSync(state), state);

      const shell = await run(
        [
          "shell",
          "--stage",
          stage,
          "--",
          process.execPath,
          path.join(dir, "shell.mjs"),
        ],
        plantedEnv,
      );
      const line = shell.output
        .split("\n")
        .find((line) => line.startsWith("SUITE{"));
      check("runs sst shell", shell.code === 0 && !!line, shell.tail);
      if (line)
        envChecks("sst shell", JSON.parse(line.slice(5)), target, check);

      if (functions) {
        const dev = background(
          cli,
          ["dev", "--mode=basic", "--stage", stage],
          path.join(dir, "app"),
          plantedEnv,
        );
        try {
          // What sst dev says once its deploy is done
          const ready = await dev.until(/✓\s+Complete|✕\s+Failed/, timeout);
          check(
            "runs sst dev",
            /Complete/.test(ready),
            [dev.tail(), "sst dev's log:", logTail(path.join(dir, "app"))].join(
              "\n",
            ),
          );
          if (/Complete/.test(ready)) {
            const answer = await invoke(target, outputs.function);
            check(
              "a function in sst dev runs on this machine",
              !!answer && answer.here !== "/var/task",
              JSON.stringify(answer),
            );
            if (answer)
              envChecks("a function in sst dev", answer, target, check);
          }
        } finally {
          await dev.stop();
        }
      }

      const remove = await run(["remove", "--stage", stage], plantedEnv);
      removed = remove.code === 0;
      check("removes", removed, remove.tail);

      // With nothing deployed on it, the CLI stops the target's container.
      // Another stage on it, like the developer's own, keeps it running.
      if (target.container && removed && (await running(target.name)) === false)
        check(
          "stops the target's container once nothing on it is deployed",
          true,
        );
      // A command on the stage starts it again
      if ((await buckets()) === undefined)
        await run(["diff", "--stage", stage]);
      const after = await buckets();
      check(
        "the bucket is removed from the target",
        after !== undefined &&
          !after.includes(`<Name>${outputs.bucket}</Name>`),
        after === undefined ? "The target doesn't answer" : outputs.bucket,
      );
      // It leaves the container running while another command runs on the
      // target, like another app's deploy, which it would stop under it
      if (target.container) {
        const stop = await run(["target", "stop", "--stage", stage]);
        if (!stop.output.includes("Another command is running"))
          check(
            "sst target stop stops its container",
            stop.code === 0 && (await running(target.name)) === false,
            stop.tail,
          );
      }
    }

    const aws = proxy.hosts.filter((host) =>
      /(^|\.)amazonaws\.com(\.cn)?(:\d+)?$/.test(host),
    );
    check("sends nothing to AWS", aws.length === 0, aws.join(", "));
  } finally {
    await proxy.close();
    // What the suite left: its stage, if a check stopped it, its app's state
    // in the target's home, and its folder. The state is kept if the stage
    // couldn't be removed, so a later `sst remove` can.
    if (!removed) {
      const remove = await run(["remove", "--stage", stage]).catch((error) => ({
        code: 1,
        tail: String(error),
      }));
      removed = remove.code === 0;
      if (!removed)
        check("removes what it deployed, to clean up", false, remove.tail);
    }
    const state = path.join(targetHome(target.name), "state");
    if (removed)
      for (const kind of fs.existsSync(state) ? fs.readdirSync(state) : [])
        fs.rmSync(path.join(state, kind, app), {
          recursive: true,
          force: true,
        });
    if (!options.keep) fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length)
    throw new Error(
      [
        `The target "${target.name}" failed ${failed.length} of the suite's ${checks.length} checks:`,
        ...checks.map(
          (c) =>
            `${c.ok ? "✓" : "✗"} ${c.name}${
              !c.ok && c.detail ? `\n${indent(c.detail)}` : ""
            }`,
        ),
      ].join("\n"),
    );
  return checks;
}

// The app: one bucket, and what the program sees, as outputs
function fixture(
  app: string,
  stage: string,
  target: Target,
  marker: string,
  functions: boolean,
) {
  return `/// <reference path="./.sst/platform/config.d.ts" />
const target = ${JSON.stringify(target, null, 2)};

export default $config({
  app() {
    return {
      name: ${JSON.stringify(app)},
      home: "aws",
      removal: "remove",
      providers: { aws: {} },
      targets: { ${JSON.stringify(stage)}: target },
    };
  },
  async run() {
    // The core's fence refuses it at 127.0.0.1:1. Any other failure, like no
    // network, proves nothing.
    let internet = "reached";
    try {
      await fetch("https://example.com", { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      const cause = error?.cause;
      internet =
        cause?.code === "ECONNREFUSED" && cause?.port === 1
          ? "fenced"
          : \`failed: \${cause?.code ?? error?.name ?? error}\`;
    }
    const bucket = new aws.s3.Bucket("Suite", { forceDestroy: true });
    const report = ${functions}
      ? new sst.aws.v5.Function("Report", { handler: "report.handler" })
      : undefined;
    return {
      bucket: bucket.bucket,
      function: report?.name,
      program: JSON.stringify({
        ...(${REPORT})(process.env, ${JSON.stringify(marker)}),
        internet,
      }),
    };
  },
});
`;
}

// What a process's environment has of AWS's settings: the variables with
// the marker in them, and the ones the target sets. As source, which the
// fixture's program and `sst shell`'s script run.
const REPORT = `(env, marker) => ({
  planted: Object.keys(env).filter((key) =>
    String(env[key] ?? "").toUpperCase().includes(marker),
  ),
  accessKeyId: env.AWS_ACCESS_KEY_ID ?? null,
  region: env.AWS_REGION ?? null,
  profile: env.AWS_PROFILE ?? null,
  sessionToken: env.AWS_SESSION_TOKEN ? "set" : null,
})`;

interface Seen {
  planted: string[];
  accessKeyId: string | null;
  region: string | null;
  profile: string | null;
  sessionToken: string | null;
}

function envChecks(
  who: string,
  seen: Seen,
  target: Target,
  check: (name: string, ok: boolean, detail?: string) => void,
) {
  check(
    `${who} has nothing of the developer's`,
    seen.planted.length === 0 &&
      seen.profile === null &&
      seen.sessionToken === null,
    JSON.stringify(seen),
  );
  check(
    `${who} has the target's credentials and region`,
    seen.accessKeyId === target.credentials.accessKeyId &&
      seen.region === target.region,
    JSON.stringify(seen),
  );
}

// Where the CLI keeps a target's state: `sst/target/<name>` in the user's
// config folder, as Go's os.UserConfigDir finds it
function targetHome(name: string) {
  const home = os.homedir();
  const config =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA!
        : process.env.XDG_CONFIG_HOME &&
            path.isAbsolute(process.env.XDG_CONFIG_HOME)
          ? process.env.XDG_CONFIG_HOME
          : path.join(home, ".config");
  return path.join(config, "sst", "target", name);
}

function command(
  cli: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeout: number,
) {
  return new Promise<{ code: number; output: string; tail: string }>(
    (resolve, reject) => {
      // On Windows, `sst` from npm is a `.cmd`, which only a shell runs
      const windows = process.platform === "win32";
      const child = spawn(
        cli,
        windows ? args.map((arg) => JSON.stringify(arg)) : args,
        {
          cwd,
          env: { ...process.env, ...env, SST_PRINT_LOGS: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          shell: windows,
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      // Stopped as Ctrl-C would, then for good if it doesn't
      let kill: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        child.kill("SIGINT");
        kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
      }, timeout);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(kill);
        const tail = output.trim().split("\n").slice(-40).join("\n");
        resolve({ code: code ?? 1, output, tail });
      });
    },
  );
}

// The end of the CLI's own log, for what a command didn't say
function logTail(app: string) {
  try {
    return fs
      .readFileSync(path.join(app, ".sst", "log", "sst.log"), "utf8")
      .trim()
      .split("\n")
      .slice(-30)
      .join("\n");
  } catch {
    return "(none)";
  }
}

// Whether the target's container is running, or undefined if Docker can't
// say
function running(name: string) {
  return new Promise<boolean | undefined>((resolve) => {
    const child = spawn(
      "docker",
      [
        "container",
        "inspect",
        "--format",
        "{{.State.Running}}",
        `sst-target-${name}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) =>
      resolve(code === 0 ? out.trim() === "true" : undefined),
    );
  });
}

// Invokes a function in the target until it answers what a worker reports,
// which it does once `sst dev` has it connected
async function invoke(target: Target, name: string) {
  const lambda = new AwsClient({
    accessKeyId: target.credentials.accessKeyId,
    secretAccessKey: target.credentials.secretAccessKey,
    region: target.region,
    service: "lambda",
  });
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    try {
      const res = await lambda.fetch(
        `${target.endpoint.replace(
          /\/$/,
          "",
        )}/2015-03-31/functions/${name}/invocations`,
        { method: "POST", body: "{}" },
      );
      const answer = (await res.json()) as { planted?: unknown };
      if (res.ok && Array.isArray(answer?.planted))
        return answer as Seen & { here: string };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return undefined;
}

// A command that runs until it's stopped, like `sst dev`
function background(
  cli: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const windows = process.platform === "win32";
  const child = spawn(
    cli,
    windows ? args.map((arg) => JSON.stringify(arg)) : args,
    {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: windows,
    },
  );
  let output = "";
  let exited = false;
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  // On exit, not on close: a process it started may still hold its output
  const closed = new Promise<void>((resolve) =>
    child.on("exit", () => {
      exited = true;
      resolve();
    }),
  );
  return {
    tail: () => output.trim().split("\n").slice(-40).join("\n"),
    // What it printed once it says what's looked for, or exits, or the time
    // is up
    async until(pattern: RegExp, timeout: number) {
      const end = Date.now() + timeout;
      while (!pattern.test(output) && !exited && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 500));
      return output.match(pattern)?.[0] ?? "";
    },
    // As Ctrl-C would, then for good if it doesn't stop
    async stop() {
      if (exited) return;
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      await closed;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

// A proxy that records each host it's asked for, and passes HTTPS through,
// so the CLI's downloads still work
async function recordingProxy() {
  const hosts: string[] = [];
  const server = http.createServer((req, res) => {
    hosts.push(req.headers.host ?? req.url ?? "");
    res.writeHead(502).end();
  });
  server.on("connect", (req, socket, head) => {
    const [host, port] = (req.url ?? "").split(":");
    hosts.push(req.url ?? "");
    const upstream = net.connect(Number(port) || 443, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hosts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function indent(text: string) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
