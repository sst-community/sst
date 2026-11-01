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

/**
 * A value made once in a run of the program, the first time it's asked for,
 * and made again in the next run: what a run's components share, like a
 * resource the app creates once. `newRun()` starts the next run.
 */
export function perRun<T>(callback: () => T) {
  let loaded = false;
  let result: T | undefined;
  resets.add(() => {
    loaded = false;
    result = undefined;
  });

  return () => {
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
