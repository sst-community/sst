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
 * It writes an app with one S3 bucket and binds a stage to the target. Then it
 * deploys, runs `sst shell` and removes the stage with fake AWS credentials,
 * a profile and credential files of the developer's planted around the CLI,
 * and a proxy in front of it that records where it's asked to go. It checks
 * that:
 *
 * - the program and `sst shell` get the target's credentials and region, and
 *   nothing that was planted;
 * - the program can reach nothing but this machine: the core's fence refuses
 *   anything else;
 * - the bucket is created in the target, through its endpoint, and removed;
 * - the stage's state is kept in the target's home, not the app's;
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
    fixture(app, stage, target, marker),
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
  const buckets = async () => {
    const res = await s3.fetch(`${target.endpoint.replace(/\/$/, "")}/`);
    return res.text();
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
        listed.includes(`<Name>${outputs.bucket}</Name>`),
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

      const remove = await run(["remove", "--stage", stage], plantedEnv);
      removed = remove.code === 0;
      check("removes", removed, remove.tail);
      check(
        "the bucket is removed from the target",
        !(await buckets()).includes(`<Name>${outputs.bucket}</Name>`),
      );
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
function fixture(app: string, stage: string, target: Target, marker: string) {
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
    return {
      bucket: bucket.bucket,
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
