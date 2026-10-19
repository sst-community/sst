import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Each entry of the package, built, as Node loads it without a bundler. Node
// resolves a relative import only with its extension, which tsc doesn't add,
// so an import without `.js` fails here, not in an app.
const root = new URL("..", import.meta.url);
const { name, exports } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
const entries = Object.keys(exports).filter(
  (entry) => entry !== "./package.json",
);

describe("the built package", () => {
  it.each(entries)("loads %s in Node", (entry) => {
    const specifier = entry === "." ? name : `${name}/${entry.slice(2)}`;
    const loaded = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(
          specifier,
        )}); console.log(Object.keys(m).length);`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(Number(loaded.trim())).toBeGreaterThan(0);
  });
});
