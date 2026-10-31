// Run after deployment: node verify.mjs
// Exercise migration too: SST_STAGE=<stage> SST_BIN=<sst binary> node verify.mjs --migration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const outputs = JSON.parse(readFileSync(".sst/outputs.json", "utf8"));
const requests = [];
let phase = "baseline";
async function checkEndpoints() {
  for (const name of ["url", "migrationUrl"]) {
    const response = await fetch(outputs[name], {
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `${name}: ${body}`);
    if (name === "url") {
      const data = JSON.parse(body);
      assert.equal(data.bucket, data.linked);
      assert.equal(data.bucket, outputs.bucket);
    } else assert.equal(body, outputs.bucket);
  }
}
await checkEndpoints();
if (!process.argv.includes("--migration")) {
  console.log(
    "Both endpoints returned 200 after accessing S3; Resource bindings match.",
  );
  process.exit(0);
}
assert.ok(process.env.SST_STAGE, "Set SST_STAGE to the deployed example stage");
const binary = process.env.SST_BIN || "sst";
async function deploy(next) {
  phase = next;
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ["deploy", "--stage", process.env.SST_STAGE], {
      env: { ...process.env, PERMISSIONS_PHASE: next },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`deploy exited ${code}`)),
    );
  });
}
function verifyPolicies(next) {
  const aws = (...args) =>
    JSON.parse(execFileSync("aws", ["iam", ...args], { encoding: "utf8" }));
  const args = ["--role-name", outputs.migrationRole];
  const inline = aws("list-role-policies", ...args).PolicyNames;
  const managed = aws(
    "list-attached-role-policies",
    ...args,
  ).AttachedPolicies.filter((p) => !p.PolicyArn.includes(":aws:policy/"));
  assert.equal(inline.length, 1);
  const policy = aws(
    "get-role-policy",
    ...args,
    "--policy-name",
    "inline",
  ).PolicyDocument;
  assert.equal(policy.Statement.length, next === "managed" ? 1 : 2);
  assert.equal(managed.length, next === "inline" ? 0 : 1);
}
// Start with PERMISSIONS_PHASE=inline deployed; never perform an unstaged rollback here.
verifyPolicies("inline");
await checkEndpoints();
let running = true;
const monitor = (async () => {
  while (running) {
    const current = phase;
    try {
      await checkEndpoints();
      requests.push({ phase: current, ok: true });
    } catch (error) {
      requests.push({ phase: current, ok: false, error: String(error) });
    }
    await delay(250);
  }
})();
try {
  for (const next of [
    "both",
    "managed",
    "managed",
    "both",
    "inline",
    "inline",
    "both",
    "managed",
  ]) {
    await deploy(next);
    verifyPolicies(next);
    await checkEndpoints();
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
  `${requests.length} endpoint-check pairs passed during migration and rollback.`,
);
