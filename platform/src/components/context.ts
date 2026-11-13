import os from "os";
import path from "path";
import * as pulumi from "@pulumi/pulumi";
import type { Target } from "./target";
import { sstPackage } from "./sst-package";

// The context, in a module of its own that imports none of the components,
// so the base classes and helpers that read it can import it without a cycle.
// `contract.ts` exports it with the rest of the contract.

/**
 * What the core gives the program: the app, the command, and where things are.
 */
export interface Context {
  /** The version of the program contract the core speaks. */
  contract: number;
  /** The app, as `app()` in `sst.config.ts` returned it, with its stage. */
  app: {
    name: string;
    stage: string;
    removal: "remove" | "retain" | "retain-all";
    protect: boolean;
    /**
     * Where the stage's state is kept. `pulumi` is a program Pulumi runs on
     * its own, outside SST's CLI: its state is in the stack's own backend.
     */
    home: "aws" | "cloudflare" | "local" | "pulumi";
    providers: Record<string, any>;
  };
  /** Whether the program runs for `sst dev`, or a command run with `--dev`. */
  dev: boolean;
  /** The command the program runs for, like `deploy`, `diff` or `remove`. */
  command: string;
  /**
   * Whether the stage is moving to new components, in `sst migrate`. Each
   * component reports what its state map says about its parts then.
   */
  move: boolean;
  paths: {
    /** The app's folder, where `sst.config.ts` is. */
    root: string;
    /** The app's `.sst` folder. */
    work: string;
    /** The platform's folder, in `.sst`. */
    platform: string;
    /** SST's folder in the user's home. */
    home: string;
  };
  /**
   * Where the stage's cloud calls go, when it isn't the real cloud: its target
   * in `app()`. A package's check can turn itself on for its own target's
   * stages only.
   */
  target?: Target;
}

/**
 * What the core gives the program. It's a copy, so changing it changes nothing.
 *
 * A program Pulumi runs on its own, outside SST's CLI, has no core, and reads
 * the same from Pulumi: the app is the Pulumi project and the stage is the
 * stack, as they are under SST's CLI, so a component names what it creates
 * the same either way.
 */
export function context(): Context {
  return structuredClone(underCore() ? fromCore() : fromPulumi());
}

/** Whether SST's CLI runs the program, which gives it `$app` and `$cli`. */
export function underCore() {
  return typeof $cli !== "undefined";
}

function fromCore(): Context {
  return {
    contract: $cli.contract ?? 0,
    app: $app as Context["app"],
    dev: $dev,
    command: $cli.command,
    move: $cli.move === true,
    paths: $cli.paths,
    target: ($app as { targets?: Record<string, Target> }).targets?.[
      $app.stage
    ],
  };
}

// No core speaks a version of the contract to a program Pulumi runs, and
// nothing runs it in `sst dev` or moves it. Pulumi runs the program for a
// preview and a deploy; `pulumi refresh` and `pulumi destroy` don't run it.
// The work folder is the one SST's CLI uses for a Pulumi project
// (pkg/pulumidev): `.sst` next to Pulumi.yaml. The platform's files a deploy
// reads are in the `sst` package (sdk/js/scripts/platform.ts); `sst dev`'s
// stubs aren't, as nothing runs the program in `sst dev`.
function fromPulumi(): Context {
  const root = pulumi.getRootDirectory?.() || process.cwd();
  const work = path.join(root, ".sst");
  const pkg = sstPackage();
  return {
    contract: 0,
    app: {
      name: pulumi.getProject(),
      stage: pulumi.getStack(),
      removal: "remove",
      protect: false,
      home: "pulumi",
      providers: {},
    },
    dev: false,
    command: pulumi.runtime.isDryRun() ? "diff" : "deploy",
    move: false,
    paths: {
      root,
      work,
      platform: pkg
        ? path.join(pkg.dir, "platform")
        : path.join(work, "platform"),
      home: path.join(configDir(), "sst"),
    },
  };
}

// Where SST's CLI keeps its own files (pkg/global), as Go's
// os.UserConfigDir finds the user's config folder
function configDir() {
  if (process.platform === "win32")
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}
