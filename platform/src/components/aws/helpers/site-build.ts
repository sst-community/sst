import path from "path";
import { spawn } from "child_process";
import { Input, output } from "@pulumi/pulumi";
import { VisibleError } from "../../error";
import { context } from "../../contract";
import { Link } from "../../link";
import { markUnknowns, unknown } from "../../check";
import { Semaphore } from "../../../util/semaphore";
import { lazy } from "../../../util/lazy";

// How many sites build at once, in a run of the program
const limiter = lazy(
  () => new Semaphore(parseInt(process.env.SST_BUILD_CONCURRENCY_SITE || "1")),
);

// The last lines of a failed build's output that its error shows
const TAIL = 50;

/**
 * Build a site, once in a run of the program, in the program itself.
 *
 * It builds with what it's linked to and its environment: on a deploy, once
 * every value is known, so the site is built with the values it's deployed
 * with. A preview, `sst diff`, doesn't know the values of what's created on
 * the deploy, so it builds without them, to learn what the build makes and
 * what to create for it. A link whose properties aren't known is passed with
 * the ones that are.
 *
 * The program waits for the build. Builds take their turn: as many at once as
 * `SST_BUILD_CONCURRENCY_SITE` says, one by default. A failed build fails the
 * program, with the end of its output.
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
    await resolve(input.environment ?? {}),
  ) as Record<string, string>;
  const links = await linkEnvironment(input.link);

  const limit = limiter();
  await limit.acquire(name);
  try {
    await run(name, command, path.resolve(context().paths.root, sitePath), {
      SST: "1",
      ...process.env,
      ...environment,
      ...links,
    });
  } finally {
    limit.release();
  }
  return sitePath;
}

// `SST_RESOURCE_App`, and an `SST_RESOURCE_<name>` for each link with the
// properties that are known
async function linkEnvironment(links?: Input<any[]>) {
  const env: Record<string, string> = {
    SST_RESOURCE_App: JSON.stringify({
      name: $app.name,
      stage: $app.stage,
    }),
  };
  const given = await resolve(links ?? []);
  if (given === unknown) return env;
  for (const link of given as unknown[]) {
    if (!link)
      throw new VisibleError(
        "An undefined link was passed into a `link` array.",
      );
    if (!Link.isLinkable(link)) continue;
    // Resolved as it is, so that what isn't known is marked where it is
    const resolved = (await resolve({
      urn: link.urn,
      definition: link.getSSTLink(),
    })) as {
      urn: string | typeof unknown;
      definition: { properties?: unknown } | typeof unknown;
    };
    const { urn, definition } = resolved;
    if (urn === unknown || definition === unknown) continue;
    const properties = definition.properties;
    if (properties === unknown) continue;
    env[`SST_RESOURCE_${urn.split("::").at(-1)}`] = JSON.stringify({
      ...(withoutUnknowns(properties) as Record<string, unknown>),
      type: linkType(urn.split("::").at(-2)!),
    });
  }
  return env;
}

// The type a link has in `Resource`, as `Link.build` writes it
function linkType(type: string) {
  return type.replaceAll(":", ".");
}

// What's given, resolved, with each value that isn't known yet as `unknown`
async function resolve(value: unknown) {
  return markUnknowns(await (output(value) as any).promise(true));
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
    const child = spawn(command, { cwd, env, shell: true });
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
