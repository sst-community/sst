import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import { glob } from "glob";
import { VisibleError } from "../../error";
import { rpc } from "../../rpc/rpc";

/** What building a function gives: where its code is, and how it's called. */
export interface FunctionBundle {
  /** The handler, as Lambda takes it: `index.handler`. */
  handler: string;
  /** The directory the built code is in. */
  bundle: string;
  /** Source maps the build wrote into the bundle. They aren't deployed with the code. */
  sourcemaps?: string[];
}

/** A file added to a function's code: its path in the bundle, and what's in it. */
export interface FunctionFile {
  name: string;
  content: string;
}

/**
 * Build a function's code with the CLI.
 *
 * @param input What the CLI's `Runtime.Build` takes.
 * @param postbuild The function's `hook.postbuild`, run on the built directory.
 */
export async function buildBundle(
  input: Record<string, unknown>,
  postbuild?: (dir: string) => Promise<void>,
): Promise<FunctionBundle> {
  const result = await rpc.call<{
    handler: string;
    out: string;
    errors: string[];
    sourcemaps: string[];
  }>("Runtime.Build", input);
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  if (postbuild) await postbuild(result.out);
  return {
    handler: result.handler,
    bundle: result.out,
    sourcemaps: result.sourcemaps,
  };
}

/**
 * The stub that's deployed in place of a function in `sst dev`. It passes
 * each invocation to the function running on the user's machine.
 *
 * @param durable A durable function needs the Node.js stub.
 */
export function devBridgeBundle(durable: boolean): FunctionBundle {
  return durable
    ? {
        handler: "index.handler",
        bundle: path.join($cli.paths.platform, "dist", "nodejs-bridge"),
      }
    : {
        handler: "bootstrap",
        bundle: path.join($cli.paths.platform, "dist", "bridge"),
      };
}

/**
 * Wrap a Node.js handler in a file that runs the function's `injections`
 * before it. Returns the handler to deploy and the file to add to the code.
 * Without injections that's the handler as it is, and no file.
 *
 * @param name The function's name, for the error message.
 */
export function injectHandler(
  name: string,
  input: {
    bundle: string;
    handler: string;
    injections: string[];
    streaming: boolean;
  },
): { handler: string; wrapper?: FunctionFile } {
  const { bundle, handler, injections, streaming } = input;
  if (injections.length === 0) return { handler };

  const parsed = path.posix.parse(handler);
  const dir = parsed.dir;
  const file = parsed.name;
  const fn = parsed.ext.replace(/^\./, "");

  const ext = [".js", ".mjs", ".cjs"].find((ext) =>
    fs.existsSync(path.join(bundle, dir, file + ext)),
  );
  if (!ext)
    throw new VisibleError(
      `Could not find handler file "${handler}" for function "${name}"`,
    );

  // An injection that starts with "outer:" goes outside of the handler
  const outer = injections
    .filter((item) => item.startsWith("outer:"))
    .map((item) => item.substring("outer:".length));
  const inner = injections.filter((item) => !item.startsWith("outer:"));

  return {
    handler: path.posix.join(dir, "server-index.handler"),
    wrapper: {
      name: path.posix.join(dir, "server-index.mjs"),
      content: streaming
        ? [
            ...outer,
            `export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {`,
            ...inner,
            `  const { ${fn}: rawHandler} = await import("./${file}${ext}");`,
            `  return rawHandler(event, responseStream, context);`,
            `});`,
          ].join("\n")
        : [
            ...outer,
            `export const handler = async (event, context) => {`,
            ...inner,
            `  const { ${fn}: rawHandler} = await import("./${file}${ext}");`,
            `  return rawHandler(event, context);`,
            `};`,
          ].join("\n"),
    },
  };
}

/**
 * Zip a function's code. The same code always gives the same zip, so its
 * hash only changes when the code does.
 *
 * Pulumi can't zip the symlinks that pnpm puts in `node_modules`, so the zip
 * is made here.
 *
 * @returns Where the zip is, and the hash of its contents.
 */
export async function zipCode(input: {
  /** Where to write the zip. */
  to: string;
  /** The directory with the built code. */
  bundle: string;
  /** Files and directories to add from outside the bundle. */
  copyFiles?: { from: string; to: string; isDir: boolean }[];
  /** Source maps in the bundle, which are left out. */
  sourcemaps?: string[];
  /** A file to add. */
  wrapper?: FunctionFile;
}) {
  const { to, bundle, copyFiles = [], sourcemaps, wrapper } = input;
  await fs.promises.mkdir(path.dirname(to), { recursive: true });

  await new Promise(async (resolve, reject) => {
    const ws = fs.createWriteStream(to);
    const archive = archiver("zip", {
      // Ensure deterministic zip file hashes
      // https://github.com/archiverjs/node-archiver/issues/397#issuecomment-554327338
      statConcurrency: 1,
    });
    archive.on("warning", reject);
    archive.on("error", reject);
    // archive has been finalized and the output file descriptor has closed, resolve promise
    // this has to be done before calling `finalize` since the events may fire immediately after.
    // see https://www.npmjs.com/package/archiver
    ws.once("close", () => resolve(to));
    archive.pipe(ws);

    const files = [];
    for (const item of [{ from: bundle, to: ".", isDir: true }, ...copyFiles]) {
      if (!item.isDir) files.push({ from: item.from, to: item.to });
      const found = await glob("**", {
        cwd: item.from,
        dot: true,
        ignore: sourcemaps?.map((item) => path.relative(bundle, item)) || [],
      });
      files.push(
        ...found.map((file) => ({
          from: path.join(item.from, file),
          to: path.join(item.to, file),
        })),
      );
    }
    files.sort((a, b) => a.to.localeCompare(b.to));
    for (const file of files)
      archive.file(file.from, { name: file.to, date: new Date(0) });

    if (wrapper)
      archive.append(wrapper.content, { name: wrapper.name, date: new Date(0) });

    await archive.finalize();
  });

  const hash = crypto
    .createHash("sha256")
    .update(await fs.promises.readFile(to))
    .digest("hex");
  return { path: to, hash };
}
