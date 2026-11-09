import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ComponentResource } from "@pulumi/pulumi";
import { exports, leftOut, renamed } from "../../src/codemod/names";

const components = path.join(__dirname, "../../src/components");

// The component classes a module exports, by name
const classes = (mod: Record<string, unknown>) =>
  Object.entries(mod)
    .filter(
      ([name, value]) =>
        /^[A-Z]/.test(name) &&
        typeof value === "function" &&
        (value as any).prototype instanceof ComponentResource,
    )
    .map(([name]) => name)
    .sort();

// The codemod keeps its own lists, so it doesn't load the platform: these
// check them against what the platform exports
describe("the codemod's names", () => {
  it("list what each group's 5.0 components export, classes and types", () => {
    const files = {
      aws: "aws/index.ts",
      cloudflare: "cloudflare/index.ts",
      x: "experimental/index.ts",
    } as const;
    const program = ts.createProgram(
      Object.values(files).map((f) => path.join(components, f)),
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
    );
    const checker = program.getTypeChecker();
    for (const [group, file] of Object.entries(files)) {
      const mod = checker.getSymbolAtLocation(
        program.getSourceFile(path.join(components, file))!,
      )!;
      const names = checker
        .getExportsOfModule(mod)
        // Not SST 4's names, which say what to write: they're no component
        .filter(
          (s) =>
            !(
              s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s
            ).declarations?.some((d) =>
              d.getSourceFile().fileName.endsWith("/sst4.ts"),
            ),
        )
        .map((s) => s.getName())
        .filter((n) => /^[A-Z]/.test(n))
        .sort();
      expect(
        exports[group as keyof typeof files].slice().sort(),
        group,
      ).toEqual(names);
    }
  }, 60_000);

  it.each([
    [
      "aws",
      () => import("../../src/components/aws"),
      () => import("../fixtures/v4/components/aws"),
    ],
    [
      "cloudflare",
      () => import("../../src/components/cloudflare"),
      () => import("../fixtures/v4/components/cloudflare"),
    ],
    [
      "x",
      () => import("../../src/components/experimental"),
      () => import("../fixtures/v4/components/experimental/dev-command"),
    ],
  ] as const)(
    "give each of SST 4's %s components a 5.0 form or none",
    async (group, five, four) => {
      const fives = classes(await five());
      for (const name of fives) expect(exports[group], name).toContain(name);
      for (const name of classes(await four())) {
        const listed =
          fives.includes(renamed[group][name] ?? name) ||
          name in leftOut[group];
        expect(listed, `SST 4's ${group} ${name}`).toBe(true);
      }
      for (const [from, to] of Object.entries(renamed[group])) {
        if (!from.includes("."))
          expect(classes(await four()), from).toContain(from);
        expect(fives, to).toContain(to);
      }
    },
  );

  it("name a Realtime subscriber as the platform does", async () => {
    const naming = await import("../../src/components/naming");
    const { logicalName, prettyHash } = await import("../../src/codemod/parts");
    for (const value of ["chat/#sub.handler", "a", "", "x".repeat(200)])
      expect(logicalName(prettyHash(value, 6)), value).toBe(
        naming.logicalName(naming.hashStringToPrettyString(value, 6)),
      );
  });

  it("give Cloudflare's experimental names their forms", async () => {
    const x = classes(
      await import("../fixtures/v4/components/cloudflare/experimental"),
    );
    for (const name of x)
      expect(
        `x.${name}` in renamed.cloudflare || `x.${name}` in leftOut.cloudflare,
        name,
      ).toBe(true);
  });
});
