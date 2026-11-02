/**
 * Run `create`, and return the messages of the errors thrown inside an
 * `apply`. Those come up as unhandled rejections, which the mock fails the run
 * on, so this collects them in its place while it runs.
 *
 * ```ts
 * const errors = await applyErrors(() => queue.subscribe(output("src/handler.handler")), pulumi.settle);
 * ```
 */
export async function applyErrors(
  create: () => unknown,
  settle: () => Promise<unknown>,
) {
  const errors: unknown[] = [];
  const listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (error) => errors.push(error));
  try {
    create();
    await settle();
    // Rejections are reported a tick after the promise settles
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of listeners) process.on("unhandledRejection", listener);
  }
  return errors.map((error) => String((error as Error)?.message ?? error));
}
