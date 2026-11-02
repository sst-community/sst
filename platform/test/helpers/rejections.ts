/**
 * Runs `run` with the test runner's handler for unhandled rejections set
 * aside, and gives back each rejection it caused. A failure in a deploy fails
 * whatever waits on it, which Pulumi reports once, by identity, and the test
 * runner would report each time.
 */
export async function rejectionsOf(run: () => Promise<unknown>) {
  const failures: unknown[] = [];
  const collect = (error: unknown) => failures.push(error);
  const runner = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", collect);
  try {
    await run();
  } finally {
    // A rejection is reported once the turn it's made in is over
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", collect);
    for (const listener of runner) process.on("unhandledRejection", listener);
  }
  return failures;
}
