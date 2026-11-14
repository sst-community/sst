package eject

// buildModule is sst-ejected-build.ts, which builds a Node.js function in
// the program, for a function to be switched to from the last build SST
// made. It's a file of its own so that the module needs esbuild only once a
// function is switched.
const buildModule = `// Written by sst eject: a build of a Node.js function with esbuild, to
// switch a function to from the last build SST made. It needs esbuild:
//
//   npm install --save-dev esbuild
//
// It's yours to change from here.
import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { buildSync } from "esbuild";

/**
 * Bundles a handler, like "functions/api.handler", into one ES module, for
 * a function's code and handler:
 *
 *   new aws.lambda.Function("ApiFunction", {
 *     ...nodeBuild("functions/api.handler"),
 *     runtime: "nodejs24.x",
 *     role: role.arn,
 *   });
 *
 * Each run of the program builds it again, in .sst-ejected/, and a function
 * is updated when what's built changes.
 */
export function nodeBuild(
  handler: string,
  options: { external?: string[]; target?: string } = {},
) {
  const dot = handler.lastIndexOf(".");
  if (dot < 1) throw new Error(` + "`" + `The handler ${handler} names no function, like "functions/api.handler".` + "`" + `);
  const file = handler.slice(0, dot);
  const entry = [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"]
    .map((extension) => file + extension)
    .find((candidate) => fs.existsSync(candidate));
  if (!entry) throw new Error(` + "`" + `There's no file for the handler ${handler}.` + "`" + `);
  const out = path.join(".sst-ejected", file.replace(/[^A-Za-z0-9_-]+/g, "-"));
  fs.rmSync(out, { recursive: true, force: true });
  buildSync({
    entryPoints: [entry],
    outfile: path.join(out, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: options.target ?? "node22",
    external: options.external,
    // What CommonJS packages in the bundle need of Node.js
    banner: {
      js: [
        ` + "`" + `import { createRequire as topLevelCreateRequire } from "module";` + "`" + `,
        ` + "`" + `const require = topLevelCreateRequire(import.meta.url);` + "`" + `,
      ].join("\n"),
    },
    logLevel: "warning",
  });
  return {
    code: new pulumi.asset.FileArchive(out),
    handler: ` + "`" + `index.${handler.slice(dot + 1)}` + "`" + `,
  };
}
`
