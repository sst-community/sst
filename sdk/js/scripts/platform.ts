// Copies SST's components into the package, for the repo of a component
// package. It installs `sst` as a dev dependency, and compiles and tests
// against `sst/components`, its groups like `sst/components/aws`, and
// `sst/testing`. An app's deploy doesn't use them: the CLI bundles the copy
// in the app's `.sst/platform`. The package has the source, the same compiled
// to JavaScript, which plain Node and any test runner load, and the types,
// which TypeScript reads. The platform's types have to be built first
// (platform/scripts/build).
//
// Returns the packages SST's components load as they run, at the platform's
// versions, for the published package's dependencies. Pulumi and the
// providers aren't among them: a package's repo installs the ones it uses.
// The providers each group of components loads go in the platform's
// package.json instead, for `sst/testing`, which gives a test the groups
// whose providers are installed.

import fs from "fs/promises";
import { $ } from "bun";
import { build } from "esbuild";
import platformPkg from "../../../platform/package.json";
import { groups } from "../../../platform/src/components/groups";
import pkg from "../package.json";

// The packages src/runtime/worker/unenv.mjs imports
const workerBuildDependencies = ["unenv", "@cloudflare/unenv-preset"];

// What the package exports, from the platform's source
const entries = [
  "components/core.ts",
  ...Object.keys(groups).map((name) => `components/${name}/index.ts`),
  "testing/index.ts",
];

export async function copyPlatform() {
  await fs.rm("platform", { recursive: true, force: true });
  await fs.cp("../../platform/src", "platform/src", { recursive: true });
  await fs.cp("../../platform/dist/types", "platform/types", {
    recursive: true,
  });
  await copyDeployFiles();
  // Which of the platform's files a bundler keeps when nothing imports from
  // them. Without it, the package's own `sideEffects: false` would apply. The
  // compiled JavaScript has the takeovers inside its chunks, so all of it.
  await Bun.write(
    "platform/package.json",
    JSON.stringify(
      {
        type: "module",
        sideEffects: [...platformPkg.sideEffects, "./js/**/*.js"],
      },
      null,
      2,
    ) + "\n",
  );

  // What the exports import, as a bundler sees it
  const result = await build({
    entryPoints: entries.map((entry) => `platform/src/${entry}`),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    write: false,
    outdir: "out",
    logLevel: "error",
  });
  const dependencies: Record<string, string> = {};
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external) continue;
      const name = packageName(imported.path);
      // A package's repo installs Pulumi and the providers it uses
      if (name === "@pulumi/pulumi" || isProvider(name)) continue;
      // Node's own modules aren't the platform's dependencies, and neither
      // is what a component loads from the app, like vite
      const version = (platformPkg.dependencies as Record<string, string>)[
        name
      ];
      if (version) dependencies[name] = version;
    }
  }
  // What SST's binary runs from the package's platform folder as it builds a
  // Worker: its unenv config (src/runtime/worker/unenv.mjs, which
  // pkg/runtime/worker runs), which nothing here imports
  for (const name of workerBuildDependencies) {
    const version = (platformPkg.dependencies as Record<string, string>)[name];
    if (!version)
      throw new Error(`The platform's package.json doesn't have ${name}`);
    dependencies[name] = version;
  }

  // Written after the analysis, which reads this file's `sideEffects`
  const platform = await Bun.file("platform/package.json").json();
  platform.groups = await groupProviders();
  await Bun.write(
    "platform/package.json",
    JSON.stringify(platform, null, 2) + "\n",
  );

  await compilePlatform();
  return dependencies;
}

// What the components read from the platform's folder as they deploy
// (`context().paths.platform`), which a program Pulumi runs on its own finds in
// the package, as SST's CLI finds them in the app's `.sst/platform`. The
// stubs `sst dev` deploys stay with the CLI: nothing runs such a program in
// `sst dev`, and they're 13 MB each.
const deployFiles = [
  "dist/oac-edge-signer",
  "dist/ssr-warmer",
  "functions/cf-static-site-router-worker-experimental",
  "functions/empty-function",
  "functions/react-server",
  "functions/remix-server",
];
const devFiles = ["dist/bridge", "dist/nodejs-bridge"];

async function copyDeployFiles() {
  // Every folder a component names under the platform's folder is one of
  // the two, so a new one can't be left out of the package unnoticed
  const named = new Set<string>();
  for await (const file of new Bun.Glob("**/*.ts").scan(
    "../../platform/src/components",
  )) {
    const code = await Bun.file(`../../platform/src/components/${file}`).text();
    for (const match of code.matchAll(
      /paths\.platform,\s*"(dist|functions)",\s*"([^"]+)"/g,
    ))
      named.add(`${match[1]}/${match[2]}`);
  }
  const unknown = [...named].filter(
    (dir) => !deployFiles.includes(dir) && !devFiles.includes(dir),
  );
  if (unknown.length > 0)
    throw new Error(
      `The components read ${unknown.join(", ")} from the platform's folder: add each to deployFiles or devFiles in scripts/platform.ts`,
    );
  for (const dir of deployFiles)
    await fs.cp(`../../platform/${dir}`, `platform/${dir}`, {
      recursive: true,
    });
}

// The exports compiled to JavaScript that plain Node loads: it won't strip
// types from a file in node_modules. One build of every entry, split, so they
// share one copy of each module, and a class from `sst/components/aws` is the
// same one `sst/testing` gives a test as `sst.aws`. The source maps point at
// the source the package has too.
async function compilePlatform() {
  await build({
    entryPoints: entries.map((entry) => `platform/src/${entry}`),
    outbase: "platform/src",
    outdir: "platform/js",
    entryNames: "[dir]/[name]",
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    packages: "external",
    sourcemap: "linked",
    sourcesContent: false,
    tsconfig: "../../platform/tsconfig.json",
    logLevel: "error",
  });
  // Each export loads with plain Node, Pulumi and the providers from this
  // repo's node_modules
  for (const entry of entries) {
    const file = `./platform/js/${entry.replace(/\.ts$/, ".js")}`;
    const code = `await import(${JSON.stringify(file)})`;
    await $`node --input-type=module -e ${code}`.quiet();
  }
}

// The providers each group of components loads when it's imported without a
// bundler, as a test does: every one its files import, used or not
async function groupProviders() {
  const result: Record<string, string[]> = {};
  for (const name of Object.keys(groups)) {
    if (!(`./components/${name}` in pkg.exports))
      throw new Error(`package.json doesn't export ./components/${name}`);
    const built = await build({
      entryPoints: [`platform/src/components/${name}/index.ts`],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      treeShaking: false,
      ignoreAnnotations: true,
      metafile: true,
      write: false,
      outdir: "out",
      logLevel: "error",
    });
    const providers = new Set<string>();
    for (const input of Object.values(built.metafile.inputs))
      for (const imported of input.imports) {
        const dependency = packageName(imported.path);
        if (imported.external && isProvider(dependency))
          providers.add(dependency);
      }
    result[name] = [...providers].sort();
  }
  return result;
}

function packageName(path: string) {
  const parts = path.split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Pulumi's providers. Pulumi itself a package's repo always installs.
function isProvider(name: string) {
  return (
    /^(@pulumi|@pulumiverse|@sst-provider)\//.test(name) &&
    name !== "@pulumi/pulumi"
  );
}

// Run on its own, it packs the package with SST's components for a dev build
// of SST, into the folder it's given, as a release would publish it. A
// component package's repo installs the tarball with
// `npm install -D <tarball>`. A tarball, not a link to this folder: through a
// link, the components would load Pulumi and the providers from this repo's
// node_modules instead of the package repo's.
if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error("Usage: bun ./scripts/platform.ts <folder>");
  const original = await Bun.file("package.json").text();
  const pkg = JSON.parse(original);
  Object.assign((pkg.dependencies ??= {}), await copyPlatform());
  try {
    await Bun.write("package.json", JSON.stringify(pkg, null, 2));
    await $`npm pack --pack-destination ${dir}`;
  } finally {
    await Bun.write("package.json", original);
  }
}
