// Checks the SDK's declarations as an app reads them, once it's built
// (`bun run build`):
//
// - What an app's code imports from `sst` (test/types/app.ts) type-checks
//   without skipLibCheck, under NodeNext and bundler.
// - Every package the declarations import is one `sst` installs, or one an
//   app installs itself to use the module that imports it.
//
// CI runs it (.github/workflows/check.yml).

import fs from "fs";
import path from "path";
import ts from "typescript";
import pkg from "../package.json";

const root = path.resolve(import.meta.dir, "..");

// The packages an app brings itself, for the modules that use them:
// `sst/auth` is built on hono, and `sst/event` validates with zod or valibot
const brought = new Set(["hono", "zod", "valibot"]);

let failed = false;

for (const resolution of [
  ts.ModuleResolutionKind.NodeNext,
  ts.ModuleResolutionKind.Bundler,
]) {
  const program = ts.createProgram([path.join(root, "test/types/app.ts")], {
    target: ts.ScriptTarget.ES2022,
    module:
      resolution === ts.ModuleResolutionKind.NodeNext
        ? ts.ModuleKind.NodeNext
        : ts.ModuleKind.ESNext,
    moduleResolution: resolution,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: ["node"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) continue;
  failed = true;
  console.error(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
}

const installed = new Set(Object.keys(pkg.dependencies));
for (const file of declarations(path.join(root, "dist"))) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node) => {
    let specifier: string | undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifier = node.moduleSpecifier.text;
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifier = node.argument.literal.text;
    if (
      specifier &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("node:")
    ) {
      const name = specifier
        .split("/")
        .slice(0, specifier.startsWith("@") ? 2 : 1)
        .join("/");
      // A package whose types come from DefinitelyTyped
      const types = `@types/${name.replace(/^@(.*)\//, "$1__")}`;
      if (!installed.has(name) && !installed.has(types) && !brought.has(name)) {
        failed = true;
        console.error(
          `${path.relative(
            root,
            file,
          )} imports "${specifier}", which sst doesn't install`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (failed) process.exit(1);
console.log("The SDK's declarations read as an app reads them");

function* declarations(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* declarations(full);
    else if (entry.name.endsWith(".d.ts")) yield full;
  }
}
