import assert from "node:assert/strict";

const port = process.env.FLOCI_SPIKE_PORT ?? "4566";
const ready = await fetch(`http://localhost.floci.io:${port}/_floci/init`, {
  signal: AbortSignal.timeout(3000),
}).then((r) => r.json());
assert.equal(ready.completed.ready, true);
await assert.rejects(
  fetch("https://sts.us-east-1.amazonaws.com", {
    signal: AbortSignal.timeout(3000),
  }),
);
console.log(
  "PASS: Floci reachable; external HTTPS blocked by internal Docker network",
);
