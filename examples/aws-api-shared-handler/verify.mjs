// node verify.mjs; or SST_STAGE=<stage> SST_BIN=<binary> node verify.mjs --migration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const outputs = JSON.parse(readFileSync(".sst/outputs.json", "utf8"));
async function checkHttp(all = false) {
  const indexes = all
    ? Array.from({ length: outputs.count }, (_, i) => i)
    : [0, outputs.count - 1];
  for (const api of ["http", "rest"])
    await Promise.all(
      indexes.map(async (i) => {
        const response = await fetch(
          `${outputs[api].replace(/\/$/, "")}/items-${i}`,
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(response.status, 200, `${api} /items-${i}`);
        assert.equal(await response.text(), "shared handler");
      }),
    );
}
async function checkWebSocket() {
  await new Promise((resolve, reject) => {
    const token = randomUUID();
    const socket = new WebSocket(outputs.ws);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket echo timed out"));
    }, 10000);
    socket.onopen = () => socket.send(token);
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    };
    socket.onmessage = (event) => {
      clearTimeout(timeout);
      socket.close();
      try {
        assert.equal(event.data, token);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
  });
}
await checkHttp(true);
await checkWebSocket();
if (!process.argv.includes("--migration")) {
  console.log(
    `${
      outputs.count * 2
    } HTTP/REST routes and WebSocket connection/echo passed.`,
  );
  process.exit(0);
}
assert.ok(process.env.SST_STAGE, "Set SST_STAGE");
assert.ok(
  outputs.count <= 10,
  "Use ROUTE_COUNT=5 for the legacy-policy migration fixture",
);
function verifyPolicy(phase) {
  const result = JSON.parse(
    execFileSync(
      "aws",
      [
        "lambda",
        "get-policy",
        "--function-name",
        outputs.function,
        "--region",
        outputs.region,
      ],
      { encoding: "utf8" },
    ),
  );
  const statements = JSON.parse(result.Policy).Statement;
  assert.equal(
    statements.length,
    phase === "shared" ? 3 : 2 * outputs.count + 3,
  );
}
verifyPolicy("legacy");
let running = true;
let phase = "legacy";
const requests = [];
const monitor = (async () => {
  while (running) {
    const current = phase;
    try {
      await checkHttp();
      await checkWebSocket();
      requests.push({ phase: current, ok: true });
    } catch (error) {
      requests.push({ phase: current, ok: false, error: String(error) });
    }
    await delay(250);
  }
})();
try {
  for (const next of ["shared", "shared", "legacy", "legacy", "shared"]) {
    phase = next;
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.SST_BIN || "sst",
        ["deploy", "--stage", process.env.SST_STAGE],
        {
          env: {
            ...process.env,
            PERMISSIONS_PHASE: next,
            ROUTE_COUNT: String(outputs.count),
          },
          stdio: "inherit",
        },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`deploy exited ${code}`)),
      );
    });
    verifyPolicy(next);
    await checkHttp(true);
    await checkWebSocket();
  }
} finally {
  running = false;
  await monitor;
  writeFileSync(
    ".sst/migration-requests.json",
    JSON.stringify(requests, null, 2),
  );
}
assert.deepEqual(
  requests.filter((r) => !r.ok),
  [],
  "Requests failed during migration; see .sst/migration-requests.json",
);
console.log(
  `${requests.length} continuous HTTP/REST/WebSocket check rounds passed; all routes passed after each deploy.`,
);
