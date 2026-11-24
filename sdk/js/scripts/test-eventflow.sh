#!/bin/sh
# Each test file of EventFlow in its own process: the durable test runner's clock is
# shared, and a run left over from one file mustn't move it on in the next.
set -e
cd "$(dirname "$0")/.."
status=0
for file in test/eventflow/*.test.ts; do
  bun test --timeout 30000 "$file" || status=1
done
exit $status
