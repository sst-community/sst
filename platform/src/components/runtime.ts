import { VisibleError } from "./error";

/**
 * A runtime made of commands, which the CLI runs: one that builds a function,
 * and one that runs it in `sst dev` against the Lambda runtime API, as each
 * language's runtime interface client does in a container. Neither command
 * runs in a shell.
 */
export interface RuntimeSettings {
  /**
   * The Lambda runtime the function is deployed with, like `ruby3.4` or
   * `provided.al2023`.
   */
  lambda: string;
  /**
   * The folder the function's code is in, from the app's folder, where the
   * build command runs. The handler is then as Lambda takes it, from the
   * build's output.
   *
   * @default The handler's folder, with the handler the rest of it:
   * `functions/ruby/app.handler` is `app.handler` in `functions/ruby`.
   */
  dir?: string;
  /**
   * How the function is built.
   */
  build?: {
    /**
     * The command that builds it. It's run in `dir`, with `SST_BUILD` set to
     * `dev` or `deploy`, and `SST_ARCHITECTURE` to `x86_64` or `arm64`.
     *
     * @default Nothing is run, and the output is the code as it is.
     */
    command?: string;
    /**
     * The folder, from `dir`, that holds the function's code once it's
     * built: everything in it but `.sst` and `.git` folders.
     *
     * @default `"."`
     */
    output?: string;
  };
  /**
   * How the function is run in `sst dev`.
   */
  dev: {
    /**
     * The command that runs it. It runs in a folder of the function's own,
     * which holds what's in the build's output, the function's copied files
     * and its links, and is `LAMBDA_TASK_ROOT`. It's given the function's
     * environment, `AWS_LAMBDA_RUNTIME_API` and `_HANDLER` as Lambda sets them,
     * `SST_KEY_FILE` for its links, and the CLI's `PATH` and `HOME`. `$NAME`
     * or `${NAME}`, for a variable it's given, is that variable's value, and
     * `$$` is a `$`.
     *
     * @example
     * ```js
     * {
     *   command: "bundle exec aws_lambda_ric $_HANDLER"
     * }
     * ```
     */
    command: string;
  };
  /**
   * The files that rebuild the function in `sst dev` when they change, as
   * globs from `dir`, where `**` is any number of folders. One that starts
   * with `../` can match files outside it. The build's output is left out
   * when it's a folder of its own; a glob shouldn't match anything else the
   * build writes, or each build starts another.
   */
  watch?: string[];
}

/**
 * A runtime made of commands, from {@link runtime}. It's marked with a key of
 * its own, which is kept when it's passed through an output.
 */
export interface Runtime extends Readonly<RuntimeSettings> {
  readonly __sstRuntime: true;
}

/**
 * Define a runtime made of commands, for a language SST doesn't build in. A
 * function takes it as its `runtime`.
 *
 * @example
 * ```ts title="sst.config.ts"
 * const ruby = sst.runtime({
 *   lambda: "ruby3.4",
 *   build: { command: "bundle install" },
 *   dev: { command: "bundle exec aws_lambda_ric $_HANDLER" },
 *   watch: ["*.rb", "lib/**", "Gemfile.lock"],
 * });
 *
 * new sst.aws.Function("Api", {
 *   runtime: ruby,
 *   handler: "functions/ruby/app.handler",
 * });
 * ```
 */
export function runtime(settings: RuntimeSettings): Runtime {
  if (!settings?.lambda)
    throw new VisibleError(
      `A runtime needs "lambda", the Lambda runtime its functions are deployed with, like "ruby3.4".`,
    );
  if (!settings.dev?.command)
    throw new VisibleError(
      `A runtime needs "dev.command", the command that runs a function in \`sst dev\`.`,
    );
  return Object.freeze({
    ...structuredClone(settings),
    __sstRuntime: true as const,
  });
}

/** Whether a value is a runtime from {@link runtime}. */
export function isRuntime(value: unknown): value is Runtime {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __sstRuntime?: unknown }).__sstRuntime === true
  );
}

/** What the CLI builds and runs a function with, from a runtime. */
export function commandsOf(runtime: Runtime) {
  return {
    ...(runtime.dir ? { dir: runtime.dir } : {}),
    build: {
      ...(runtime.build?.command ? { command: runtime.build.command } : {}),
      ...(runtime.build?.output ? { output: runtime.build.output } : {}),
    },
    dev: { command: runtime.dev.command },
    ...(runtime.watch ? { watch: [...runtime.watch] } : {}),
  };
}
