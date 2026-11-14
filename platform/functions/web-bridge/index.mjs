// The entrypoint of a web function that's live in sst dev. A web function runs
// Node.js, so this starts the Go bridge, which listens on
// AWS_LAMBDA_HTTP_ENDPOINT and sends the requests to sst dev.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packaged = join(dirname(fileURLToPath(import.meta.url)), "bootstrap");

function start(binary) {
  // The bridge's output goes to the function's own, so it reaches the log group.
  const child = spawn(binary, { stdio: "inherit" });
  child.on("error", (err) => {
    // a package that lost the binary's mode can't run it in place
    if (err.code === "EACCES" && binary === packaged) {
      const copy = "/tmp/sst-web-bridge";
      copyFileSync(packaged, copy);
      chmodSync(copy, 0o755);
      return start(copy);
    }
    console.error(err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    console.error(`bridge exited with ${signal ?? `code ${code}`}`);
    process.exit(code ?? 1);
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => child.kill(signal));
}

start(packaged);
