// Gives the imports in the platform's declarations (dist/types) their `.js`,
// so that they resolve under `moduleResolution: "NodeNext"` as well as
// `bundler`, and a package's repo can use either. TypeScript writes an import
// as the source has it: a relative one without an extension, and one of a
// provider's types as a path inside it, like `@pulumi/aws/ec2/securityGroup`.
//
// Then it checks what a package reads, `sst/components`, its groups and
// `sst/testing`, under NodeNext and without `skipLibCheck`, so a change that
// would break either fails the build. Run by scripts/build, once the
// declarations are written.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = path.join(root, "dist/types");

// What a package imports (sdk/js/package.json's exports)
const entries = [
  "components/core.d.ts",
  "components/aws/index.d.ts",
  "components/cloudflare/index.d.ts",
  "components/vercel/index.d.ts",
  "testing/index.d.ts",
];

let changed = 0;
for (const file of declarations(types)) {
  const text = fs.readFileSync(file, "utf8");
  const edits = [];
  for (const literal of specifiers(file, text)) {
    const next = withExtension(literal.text, file);
    if (next !== literal.text)
      edits.push({ start: literal.getStart() + 1, end: literal.end - 1, next });
  }
  if (edits.length === 0) continue;
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.next + out.slice(edit.end);
  fs.writeFileSync(file, out);
  changed++;
}
console.log(`Gave the imports in ${changed} declarations their extension`);

check();

function* declarations(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* declarations(full);
    else if (entry.name.endsWith(".d.ts")) yield full;
  }
}

// The module names a declaration imports, as written: not the code in its
// doc comments, and not the modules it augments
function specifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier);
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      found.push(node.argument.literal);
    else if (
      ts.isExternalModuleReference(node) &&
      ts.isStringLiteral(node.expression)
    )
      found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function withExtension(specifier, from) {
  if (/\.(js|mjs|cjs|json)$/.test(specifier)) return specifier;
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(from), specifier);
    if (fs.existsSync(target + ".d.ts")) return specifier + ".js";
    if (fs.existsSync(path.join(target, "index.d.ts")))
      return specifier.replace(/\/?$/, "/index.js");
    throw new Error(
      `${from} imports "${specifier}", which isn't in dist/types`,
    );
  }
  // A path inside a package. One with an `exports` map says what its paths
  // are; for one without, NodeNext wants the file.
  const parts = specifier.split("/");
  const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const inside = specifier.slice(name.length);
  if (!inside || specifier.startsWith("node:")) return specifier;
  const dir = packageDir(name);
  if (!dir)
    throw new Error(`${from} imports "${specifier}", which isn't installed`);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
  if (pkg.exports) return specifier;
  if (fs.existsSync(path.join(dir, inside + ".d.ts"))) return specifier + ".js";
  if (fs.existsSync(path.join(dir, inside, "index.d.ts")))
    return specifier + "/index.js";
  throw new Error(`${from} imports "${specifier}", which has no declarations`);
}

// Where a package is installed, as Node finds it from the platform
function packageDir(name) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === path.dirname(dir)) return undefined;
  }
}

function check() {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: ["node"],
    typeRoots: [path.join(packageDir("@types/node"), "..")],
  };
  const program = ts.createProgram(
    entries.map((entry) => path.join(types, entry)),
    options,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) return;
  console.error(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
  console.error(
    `The platform's declarations have ${diagnostics.length} errors under NodeNext`,
  );
  process.exit(1);
}
