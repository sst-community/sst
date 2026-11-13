import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A lookup of a provider's, like `iam.getPolicyDocumentOutput` or
// `getRegionOutput`, takes its provider from its options' `provider` or
// `parent`, not from a component's `providers`, and without either it's the
// stack's default provider. A component given an AWS provider of its own, for
// another region or account, would look up the default's, and a program
// Pulumi runs on its own, whose only AWS provider is its own, fails on the
// first lookup. So each of SST's components gives each lookup options: a
// parent, usually the component, or the provider.
const components = path.join(__dirname, "../../src/components");
const PROVIDERS = /^@pulumi(verse)?\/(aws|cloudflare|vercel)$/;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

// The lookups in a file given no options, as file:line: calls of a get*
// function imported from a provider's package, by name (`getRegionOutput`),
// from a module of it (`iam.getPolicyDocumentOutput`), or from the package
// (`aws.ec2.getVpcOutput`)
function lookupsWithoutOptions(file: string) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = new Set<string>();
  const modules = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !PROVIDERS.test(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      modules.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        (/^get[A-Z]/.test(element.name.text) ? functions : modules).add(
          element.name.text,
        );
  }
  const found: string[] = [];
  const isLookup = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return functions.has(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (!/^get[A-Z]/.test(callee.name.text)) return false;
    // iam.getX or aws.iam.getX
    let base: ts.Expression = callee.expression;
    while (ts.isPropertyAccessExpression(base)) base = base.expression;
    return ts.isIdentifier(base) && modules.has(base.text);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      isLookup(node.expression) &&
      node.arguments.length < 2
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line;
      found.push(
        `${path.relative(components, file)}:${
          line + 1
        } ${node.expression.getText()}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("A component's lookups", () => {
  it("are each given the component's provider", () => {
    const found = sources(components).flatMap(lookupsWithoutOptions);
    expect(found).toEqual([]);
  });

  it("are found by this test", () => {
    // What the test looks for is there to find: SST's components make
    // lookups, and one written without options would be listed
    const file = path.join(components, "aws/function.ts");
    expect(fs.readFileSync(file, "utf8")).toMatch(/getRegionOutput\(/);
    const temp = path.join(
      fs.mkdtempSync(path.join(require("os").tmpdir(), "lookups-")),
      "probe.ts",
    );
    fs.writeFileSync(
      temp,
      [
        `import { iam, getRegionOutput } from "@pulumi/aws";`,
        `import * as aws from "@pulumi/aws";`,
        `iam.getPolicyDocumentOutput({ statements: [] });`,
        `getRegionOutput({});`,
        `aws.ec2.getVpcOutput({ id: "vpc" });`,
        `getRegionOutput({}, { parent: undefined });`,
      ].join("\n"),
    );
    expect(lookupsWithoutOptions(temp).map((f) => f.split(" ")[1])).toEqual([
      "iam.getPolicyDocumentOutput",
      "getRegionOutput",
      "aws.ec2.getVpcOutput",
    ]);
  });
});
