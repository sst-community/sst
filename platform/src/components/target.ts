/**
 * Where a stage's cloud calls go when it isn't the real cloud: something on
 * this machine, like an emulator, which the CLI can start in a container. An
 * app names it for a stage in `app()`, as `targets: { local: emulator }`.
 *
 * It's settings, which the CLI checks and carries out. `app()` is read before
 * the platform is loaded, so a target is a plain object of this type, not one
 * a function makes. A package exports one, and imports the type with
 * `import type`.
 *
 * @example
 * ```ts title="index.ts"
 * import type { Target } from "sst/components";
 *
 * export const emulator: Target = {
 *   name: "emulator",
 *   endpoint: "http://127.0.0.1:4566",
 *   region: "us-east-1",
 *   credentials: { accessKeyId: "test", secretAccessKey: "test" },
 *   providers: { aws: { s3UsePathStyle: true } },
 *   container: { image: "example/emulator:1.0.0", ports: [4566] },
 * };
 * ```
 *
 * ```ts title="sst.config.ts"
 * export default $config({
 *   async app(input) {
 *     const { emulator } = await import("emulator-target");
 *     return { name: "my-app", home: "aws", targets: { local: emulator } };
 *   },
 *   async run() {},
 * });
 * ```
 *
 * On the stage, nothing gets the developer's AWS credentials, profile or
 * settings files: the program, `sst shell`, the functions `sst dev` runs and
 * what the CLI starts get the target's. The program can reach nothing but this
 * machine. The stage's state is kept in a home of the target's own, never the
 * one the app names.
 */
export interface Target {
  /**
   * The target's name, in lowercase letters, numbers and dashes. Its container
   * is `sst-target-<name>`, and its stages' state is kept under its name.
   */
  name: string;
  /**
   * Where the providers send their calls, on this machine: `127.0.0.1` or
   * `localhost`.
   *
   * @example
   * ```js
   * {
   *   endpoint: "http://127.0.0.1:4566"
   * }
   * ```
   */
  endpoint: string;
  /**
   * The region the target answers for. It's the region of the stage's
   * providers, whatever the app's settings say.
   */
  region: string;
  /**
   * The credentials the target takes.
   */
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  /**
   * The settings the target gives each provider it takes the place of, over
   * the app's own. Only `aws` for now. Settings that pick credentials, like
   * `profile`, are left out.
   *
   * @example
   * ```js
   * {
   *   providers: {
   *     aws: { s3UsePathStyle: true, skipRequestingAccountId: true }
   *   }
   * }
   * ```
   */
  providers: { aws: Record<string, unknown> };
  /**
   * The container the CLI runs the target in, if it has one. The CLI starts
   * it when a command needs the stage, and replaces it when these settings
   * change, keeping its volumes.
   */
  container?: {
    /** The image, best pinned to a digest. */
    image: string;
    /** The ports it listens on, published on `127.0.0.1` only. */
    ports?: number[];
    /** Its environment variables. */
    env?: Record<string, string>;
    /**
     * The folders in the container that are kept when it's replaced, each as
     * a Docker volume of the target's own, by name.
     *
     * @example
     * ```js
     * {
     *   volumes: { "/app/data": "data" }
     * }
     * ```
     */
    volumes?: Record<string, string>;
    /**
     * Gives the container this machine's Docker socket, so it can start
     * containers of its own, like the functions an emulator runs. The CLI
     * says so when it starts it.
     *
     * @default `false`
     */
    dockerSocket?: boolean;
  };
}
