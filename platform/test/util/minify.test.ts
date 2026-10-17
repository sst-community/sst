import { describe, expect, it } from "vitest";
import { minifyBody } from "../../src/util/minify";

describe("minifyBody", () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  it("minifies statements that return and await at their top level", async () => {
    const source = `
      // a comment
      const value = await read();
      if (!value) return null;
      return value;
    `;
    const code = minifyBody`
      // a comment
      const value = await read();
      if (!value) return null;
      return value;
    `;
    // it still does what the source does
    const run = new AsyncFunction("read", code);
    expect(await run(async () => "found")).toBe("found");
    expect(await run(async () => "")).toBe(null);
    // and is smaller, without the comment or the indentation
    expect(code.length).toBeLessThan(source.length);
    expect(code).not.toContain("a comment");
    expect(code).not.toMatch(/\n\s/);
  });

  it("splices values in", () => {
    const namespace = "ab12";
    const code = minifyBody`return "${namespace}:routes";`;
    expect(new Function(code)()).toBe("ab12:routes");
  });

  // `\u` and `\x` without hex digits, and octal escapes, have no cooked value
  // and would land in the code as the text "undefined".
  it("throws on an escape the template can't read", () => {
    expect(() => minifyBody`return "\unicode";`).toThrow(/invalid escape/);
  });

  // Reads like the `interpolate` template the code used to live in: one
  // backslash in the output for two in the source. String.raw would keep two,
  // and /\\./ would stop matching a dot.
  it("reads escapes the way an ordinary template literal does", () => {
    const code = minifyBody`return "a.b".replace(/\\./g, "\\\\.");`;
    expect(new Function(code)()).toBe("a\\.b");
  });
});
