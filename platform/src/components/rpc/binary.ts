import fs from "fs";
import http from "http";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import { rpc } from "./rpc";
import { context, underCore } from "../context";
import { VisibleError } from "../error";
import { sstPackage } from "../sst-package";
import { lazy } from "../../util/lazy";

/**
 * Calls what only SST's binary does, like building a function.
 *
 * Under SST's CLI, and under `sst dev` for a Pulumi program, the CLI serves
 * it, at `SST_SERVER`. A program Pulumi runs on its own has no CLI, so the
 * first call starts the `sst` binary that the `sst` package installed, which
 * serves the builds alone, until the program exits. Nothing of it goes in the
 * state.
 */
export async function callBinary<T = any>(
  method: string,
  args: unknown,
): Promise<T> {
  if (underCore() || process.env.SST_SERVER) return rpc.call<T>(method, args);
  return post<T>(await buildServer(), method, args);
}

// The binary's `build-server` prints its address, then serves until its
// input closes, which it does when this process exits, however it exits
const buildServer = lazy(
  () =>
    new Promise<string>((resolve, reject) => {
      const { root, work, platform } = context().paths;
      // Its log, where SST's CLI keeps a Pulumi project's
      const log = path.join(work, "log", "build-server.log");
      fs.mkdirSync(path.dirname(log), { recursive: true });
      const child = spawn(binary(), ["build-server"], {
        cwd: root,
        // The platform's files a build reads, like a Worker's unenv config,
        // which are in the package
        env: {
          ...process.env,
          SST_SKIP_LOCAL: "true",
          SST_LOG: log,
          SST_PLATFORM_DIR: platform,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let errors = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        const end = out.indexOf("\n");
        if (end < 0) return;
        resolve(out.slice(0, end).trim());
        // It doesn't keep the program running
        child.unref();
        for (const stream of [child.stdin, child.stdout, child.stderr])
          (stream as unknown as { unref?: () => void }).unref?.();
      });
      child.stderr.on("data", (chunk: string) => {
        errors = (errors + chunk).slice(-4000);
      });
      child.on("error", (error) =>
        reject(
          new VisibleError(
            `Could not start SST's binary to build the program's functions: ${error.message}`,
          ),
        ),
      );
      child.on("exit", (code) =>
        reject(
          new VisibleError(
            `SST's binary stopped before it could build the program's functions (exit code ${code}).`,
            errors.trim(),
          ),
        ),
      );
      process.on("exit", () => child.kill());
    }),
);

// The binary is in a package named after the `sst` package, which may be
// scoped, as bin/sst.mjs finds it
function binary(): string {
  if (process.env.SST_BIN_PATH) return process.env.SST_BIN_PATH;
  const pkg = sstPackage();
  if (!pkg)
    throw new VisibleError(
      `SST's components build functions with SST's binary, and they aren't in the "sst" package that has it. Set SST_BIN_PATH to an sst binary.`,
    );
  const name = `${pkg.name}-${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "sst.exe" : "sst";
  try {
    return createRequire(path.join(pkg.dir, "package.json")).resolve(
      `${name}/bin/${exe}`,
    );
  } catch {
    throw new VisibleError(
      `SST's components build functions with SST's binary, and the "${name}" package that has it isn't installed. Install it, or set SST_BIN_PATH to an sst binary.`,
    );
  }
}

// A call to the build server, as rpc.call makes one to SST_SERVER
function post<T>(server: string, method: string, args: unknown) {
  const url = new URL(server + "/rpc");
  const body = JSON.stringify({ jsonrpc: "1.0", method, params: [args] });
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200)
            return reject(new Error(`Failed to call ${method}: ${data}`));
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(json.error));
            resolve(json.result);
          } catch (error: any) {
            reject(new Error(`Failed to parse JSON: ${error.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(0);
    req.end(body);
  });
}
