import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const handler = async () => {
  const binaryPath = join(__dirname, "bootstrap");

  try {
    // The bridge's output goes to the function's own, so it reaches the log
    // group. Kept in memory, as execFile does, it never would, and the bridge
    // is stopped once it passes execFile's 1 MB limit.
    await new Promise((resolve, reject) => {
      const child = spawn(binaryPath, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) return resolve();
        reject(new Error(`bootstrap exited with ${signal ?? `code ${code}`}`));
      });
    });
  } catch (err) {
    console.error(err);
    throw err;
  }
};
