import { runtime } from "@pulumi/pulumi";

export function lazy<T>(callback: () => T) {
  let loaded = false;
  let result: T;

  return () => {
    if (!loaded) {
      loaded = true;
      result = callback();
    }
    return result;
  };
}

const resets = new Set<() => void>();

// The stack the last run made, which a run Pulumi starts again in the same
// process, as the Automation API runs an inline program, makes anew
let stack: unknown;

/**
 * A value made once in a run of the program, the first time it's asked for,
 * and made again in the next run: what a run's components share, like a
 * resource the app creates once. `newRun()` starts the next run, and so does
 * a new stack of Pulumi's in the same process.
 */
export function perRun<T>(callback: () => T) {
  let loaded = false;
  let result: T | undefined;
  resets.add(() => {
    loaded = false;
    result = undefined;
  });

  return () => {
    const current = runtime.getStackResource();
    if (current !== undefined && current !== stack) {
      if (stack !== undefined) newRun();
      stack = current;
    }
    if (!loaded) {
      loaded = true;
      result = callback();
    }
    return result as T;
  };
}

/**
 * Starts a new run of the program: each value from `perRun()` is made again
 * the next time it's asked for. The CLI runs the program once in each
 * process; tests run it many times in one.
 */
export function newRun() {
  for (const reset of resets) reset();
}
