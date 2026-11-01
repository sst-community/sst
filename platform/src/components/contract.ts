import { type Input, type Inputs, all, output } from "@pulumi/pulumi";
import { Link } from "./link";

/**
 * The program contract: what the core gives the program, and what a component
 * reports to the core. The core reads a report from the state, after a deploy
 * and in commands that don't deploy, like `sst tunnel` and `sst shell`.
 *
 * This is version 1. The core says which version it speaks in the context,
 * and each record says which version it was written in.
 */
export const contractVersion = 1;

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
    home: "aws" | "cloudflare" | "local";
    providers: Record<string, any>;
  };
  /** Whether the program runs for `sst dev`, or a command run with `--dev`. */
  dev: boolean;
  /** The command the program runs for, like `deploy`, `diff` or `remove`. */
  command: string;
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
  /** The version of each component in the state, by its name. */
  versions: Record<string, number>;
}

/** What the core gives the program. It's a copy, so changing it changes nothing. */
export function context(): Context {
  return structuredClone({
    contract: $cli.contract ?? 0,
    app: $app as Context["app"],
    dev: $dev,
    command: $cli.command,
    paths: $cli.paths,
    versions: $cli.state?.version ?? {},
  });
}

/**
 * A function the core builds, and in `sst dev` runs on the user's machine.
 * The function itself tells the core how to build it when it's created; this
 * is how the core finds it again.
 */
export interface FunctionReport {
  /** The handler, as the user gave it. The `sst dev` UI shows it. */
  handler: Input<string>;
  /** A function SST made for its own use, rather than one the app made. */
  internal?: Input<boolean | undefined>;
  /** Whether it runs in `sst dev`. */
  dev?: Input<boolean | undefined>;
}

/** A command `sst dev` runs alongside, in a pane of its own. */
export interface DevReport {
  /** The command. Without one, `sst dev` runs nothing. */
  command?: Input<string | undefined>;
  /** The folder it runs in, from the app's folder. */
  directory?: Input<string | undefined>;
  /** Whether it starts with `sst dev`. Defaults to `true`. */
  autostart?: Input<boolean | undefined>;
  /** The title of its pane. Defaults to the component's name. */
  title?: Input<string | undefined>;
  /** What it's linked to. Their properties are in its environment. */
  link?: Input<any[] | undefined>;
  /** More environment variables. */
  environment?: Input<Record<string, Input<string>> | undefined>;
  /** The AWS role it runs as. */
  aws?: Input<{ role?: Input<string | undefined> } | undefined>;
  /** For a Cloudflare worker: the path `sst dev` serves it on. */
  cloudflare?: Input<{ path: Input<string> } | undefined>;
}

/** A task `sst dev` runs on the user's machine when it's started. */
export interface TaskReport {
  /** The command it runs locally. Without one, it can't run in `sst dev`. */
  command?: Input<string | undefined>;
  /** The folder it runs in, from the app's folder. */
  directory?: Input<string | undefined>;
}

/** A bastion `sst tunnel` connects through. */
export interface TunnelReport {
  ip: Input<string>;
  username: Input<string>;
  privateKey: Input<string>;
  /** The subnets the tunnel reaches. */
  subnets: Input<Input<string>[]>;
}

/** What a component reports to the core. Each item is optional. */
export interface Report {
  function?: Input<FunctionReport>;
  dev?: DevReport;
  task?: Input<TaskReport>;
  tunnel?: Input<TunnelReport>;
  /** A URL the CLI shows when a deploy is done, like the API's. */
  hint?: Input<string | undefined>;
}

/** The items a report can have. */
export const reportItems = ["function", "dev", "task", "tunnel", "hint"];

/** The record the core reads, as a component's `_sst` output. */
export function record(report: Report): Inputs {
  const { dev, ...rest } = report;
  if (!dev) return { contract: contractVersion, ...rest };
  const { link, autostart, ...command } = dev;
  return {
    contract: contractVersion,
    ...rest,
    dev: {
      ...command,
      autostart: output(autostart).apply((a) => a !== false),
      links: all([link]).apply(([links]) =>
        all(Link.build(links ?? [])).apply((built) =>
          built.map((link) => link.name),
        ),
      ),
    },
  };
}

/**
 * The outputs a component registers, with its record added. Pulumi registers
 * a component's outputs once, so the record goes in with them.
 */
export function withRecord(
  outputs: Inputs | undefined,
  report: Report,
): Inputs {
  return { ...outputs, _sst: record(report) };
}
