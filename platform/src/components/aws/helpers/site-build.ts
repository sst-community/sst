import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { Input, output } from "@pulumi/pulumi";
import { VisibleError } from "../../error";
import { context } from "../../contract";
import { Link } from "../../link";
import { markUnknowns, unknown } from "../../check";
import { Semaphore } from "../../../util/semaphore";
import { lazy } from "../../../util/lazy";

// How many sites build at once, in a run of the program. 4.x sites keep a
// limit of their own: a failed 4.x build never gives back its turn, and a
// site built here waiting for it would keep the program running.
const siteBuilds = lazy(
  () => new Semaphore(parseInt(process.env.SST_BUILD_CONCURRENCY_SITE || "1")),
);

// The last lines of a failed build's output that its error shows
const TAIL = 50;

// What the CLI passes on for SST's own calls to Cloudflare's API, which a
// site's build has no use for
const CLI_CREDENTIALS = [
  "SST_CLOUDFLARE_API_TOKEN",
  "SST_CLOUDFLARE_API_KEY",
  "SST_CLOUDFLARE_EMAIL",
];

/**
 * Build a site, once in a run of the program, in the program itself.
 *
 * It builds with what it's linked to and its environment: on a deploy, once
 * every value is known, so the site is built with the values it's deployed
 * with. A preview, `sst diff`, doesn't know the values of what's created on
 * the deploy, so it builds without them, to learn what the build makes and
 * what to create for it. A link whose properties aren't known is passed with
 * the ones that are, or with only its type when none are.
 *
 * A deploy that previews first, on a stage with checks or with a policy pack,
 * builds the site twice: in its preview, and again in the deploy.
 *
 * The program waits for the build. Builds take their turn: as many at once as
 * `SST_BUILD_CONCURRENCY_SITE` says, one by default, and as many 4.x sites
 * besides. A failed build fails the program, with the end of its output.
 *
 * @param name The site's name, for messages.
 * @param sitePath The site's folder, from the app's folder.
 * @param command The command that builds it.
 * @returns The site's folder, once it's built.
 */
export async function buildSite(input: {
  name: string;
  sitePath: string;
  command: string;
  environment?: Input<Record<string, Input<string>>>;
  link?: Input<any[]>;
}): Promise<string> {
  const { name, sitePath, command } = input;
  const environment = withoutUnknowns(
    await resolveWithUnknowns(input.environment ?? {}),
  ) as Record<string, string>;
  const links = await linkEnvironment(input.link);

  const limit = siteBuilds();
  await limit.acquire(name);
  try {
    await run(name, command, path.resolve(context().paths.root, sitePath), {
      SST: "1",
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !CLI_CREDENTIALS.includes(key),
        ),
      ),
      ...environment,
      ...links,
    });
  } finally {
    limit.release();
  }
  return sitePath;
}

/**
 * The command that builds a site whose framework has no command of its own:
 * its `build` script, run by the package manager whose lockfile is in the
 * site's folder or the app's, as SST 4's sites pick it.
 *
 * @param sitePath The site's folder, from the app's folder.
 */
export function defaultBuildCommand(sitePath: string) {
  const root = context().paths.root;
  const site = path.resolve(root, sitePath);
  const packageJson = path.join(site, "package.json");
  if (!fs.existsSync(packageJson))
    throw new VisibleError(`No package.json found at "${sitePath}".`);
  const pkg = JSON.parse(fs.readFileSync(packageJson, "utf-8"));
  if (!pkg.scripts?.build)
    throw new VisibleError(
      `No "build" script found within package.json in "${sitePath}".`,
    );
  const has = (...lockfiles: string[]) =>
    lockfiles.some(
      (file) =>
        fs.existsSync(path.join(site, file)) ||
        fs.existsSync(path.join(root, file)),
    );
  if (has("yarn.lock")) return "yarn run build";
  if (has("pnpm-lock.yaml")) return "pnpm run build";
  if (has("bun.lockb", "bun.lock")) return "bun run build";
  return "npm run build";
}

/**
 * The text of a site's config file, in whichever of its extensions it has,
 * like `nuxt.config.ts` or `nuxt.config.mjs`; or nothing, without one.
 *
 * @param sitePath The site's folder, from the app's folder or absolute.
 * @param name The file's name without its extension: `nuxt.config`.
 */
export function configText(sitePath: string, name: string) {
  const site = path.resolve(context().paths.root, sitePath);
  for (const ext of [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"]) {
    const file = path.join(site, name + ext);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf-8");
  }
}

/**
 * A value set in a site's config file, like `base: "/docs/"` in
 * `vite.config.ts`: what's in the quotes after the key, in whichever of the
 * file's extensions it has. Nothing, without the file or the key.
 *
 * It's read from the text, so a value that's worked out, like one from a
 * variable, isn't found.
 *
 * @param sitePath The site's folder, from the app's folder or absolute.
 * @param name The file's name without its extension: `vite.config`.
 * @param key The key, like `base`. It can be in quotes too.
 */
export function configValue(sitePath: string, name: string, key: string) {
  return configText(sitePath, name)?.match(
    new RegExp(`["']?\\b${key}["']?\\s*:\\s*(["'])(.*?)\\1`),
  )?.[2];
}

/**
 * What's given, resolved, with each value that isn't known yet as `unknown`:
 * in a preview, what a deploy creates.
 */
export async function resolveWithUnknowns(value: unknown) {
  return markUnknowns(await (output(value) as any).promise(true));
}

// `SST_RESOURCE_App`, and an `SST_RESOURCE_<name>` for each link with the
// properties that are known
async function linkEnvironment(links?: Input<any[]>) {
  const { name, stage } = context().app;
  const env: Record<string, string> = {
    SST_RESOURCE_App: JSON.stringify({ name, stage }),
  };
  const given = await resolveWithUnknowns(links ?? []);
  if (given === unknown) return env;
  for (const link of given as unknown[]) {
    if (!link)
      throw new VisibleError(
        "An undefined link was passed into a `link` array.",
      );
    if (!Link.isLinkable(link)) continue;
    // Resolved as it is, so that what isn't known is marked where it is
    const resolved = (await resolveWithUnknowns({
      urn: link.urn,
      definition: link.getSSTLink(),
    })) as {
      urn: string | typeof unknown;
      definition: { properties?: unknown } | typeof unknown;
    };
    const { urn, definition } = resolved;
    if (urn === unknown) continue;
    // With none of its properties known, it's still linked, with its type
    const properties = definition === unknown ? unknown : definition.properties;
    env[`SST_RESOURCE_${urn.split("::").at(-1)}`] = JSON.stringify({
      ...(withoutUnknowns(properties) as Record<string, unknown> | undefined),
      type: linkType(urn.split("::").at(-2)!),
    });
  }
  return env;
}

// The type a link has in `Resource`, as `Link.build` writes it
function linkType(type: string) {
  return type.replaceAll(":", ".");
}

// A value with what isn't known left out: a field, or an item of a list
function withoutUnknowns(value: unknown): unknown {
  if (value === unknown) return undefined;
  if (Array.isArray(value))
    return value.filter((v) => v !== unknown).map(withoutUnknowns);
  if (value && typeof value === "object" && value.constructor === Object)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== unknown)
        .map(([k, v]) => [k, withoutUnknowns(v)]),
    );
  return value;
}

// Runs the command in a shell, in `cwd`. Its output is kept, and the end of
// it is the error when it fails.
function run(
  name: string,
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
) {
  return new Promise<void>((done, fail) => {
    const lines: string[] = [];
    const keep = (chunk: Buffer) => {
      lines.push(...chunk.toString().split("\n"));
      if (lines.length > TAIL * 2) lines.splice(0, lines.length - TAIL);
    };
    // Nothing is typed into the build: one that asks fails, not waits
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) =>
      fail(
        new VisibleError(
          `Failed to build the "${name}" site: ${command}\n${err.message}`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code === 0) return done();
      const tail = lines.join("\n").trim().split("\n").slice(-TAIL).join("\n");
      fail(
        new VisibleError(
          `Failed to build the "${name}" site: \`${command}\` exited with ${code}.\n${tail}`,
        ),
      );
    });
  });
}
