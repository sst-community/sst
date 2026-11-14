// The files SST 4's and SST 5's platforms share, byte for byte, as they share
// the engine. Each line has a copy: a change is made on main, and reaches v5
// when main is merged in. So each imports only another of them, or a
// package, and never a file one line has and the other doesn't, or has in
// another form. This test is the same file on both lines too.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const shared = [
  "cpu.ts",
  "dns.ts",
  "duration.ts",
  "error.ts",
  "esbuild.ts",
  "input.ts",
  "path.ts",
  "runtime.ts",
  "size.ts",
];

const components = fileURLToPath(
  new URL("../../src/components/", import.meta.url),
);

describe("the platform files both lines share", () => {
  for (const file of shared) {
    it(`${file} imports only shared files and packages`, () => {
      const source = fs.readFileSync(path.join(components, file), "utf8");
      const imported = [
        ...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g),
      ].map((match) => match[1]);
      for (const specifier of imported) {
        if (!specifier.startsWith(".")) continue;
        const target = path.normalize(specifier).replace(/\.js$/, "") + ".ts";
        expect(shared, `${file} imports ${specifier}`).toContain(target);
      }
    });
  }
});
