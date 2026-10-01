import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

mockPulumi();

// Every V5 component: a `*-v5.ts` file next to the component it replaces
const dir = new URL("../../src/components/aws/", import.meta.url);
const files = fs.readdirSync(dir).filter((file) => file.endsWith("-v5.ts"));

describe("V5 components", () => {
  let takeoverOf: typeof import("../../src/components/takeover").takeoverOf;

  beforeAll(async () => {
    ({ takeoverOf } = await import("../../src/components/takeover"));
    await import("../../src/components/aws/takeover/index");
  });

  it("are found", () => {
    expect(files).toContain("queue-v5.ts");
  });

  describe.each(files)("%s", (file) => {
    let type: string;

    beforeAll(async () => {
      const module = await import(
        `../../src/components/aws/${file.slice(0, -3)}.ts`
      );
      const component: any = Object.values(module).find(
        (value: any) => typeof value?.__pulumiType === "string",
      );
      type = component.__pulumiType;
    });

    // Switching to the V5 component has to keep what's deployed, so each one
    // needs a map in `aws/takeover/`, imported from its `index.ts`.
    it("takes over from the component it replaces", () => {
      expect(type).toMatch(/V5$/);
      expect(takeoverOf(type)?.from).toBe(type.slice(0, -2));
    });

    it("is exported from sst.aws", () => {
      const index = fs.readFileSync(new URL("index.ts", dir), "utf8");
      expect(index).toContain(`export * from "./${file.slice(0, -3)}.js";`);
    });

    // What came before belongs in the takeover map. The component's code
    // names no other component's type and sets no aliases. (`aliases` as an
    // arg of the component, like Cognito's sign-in aliases, is fine.)
    it("leaves what came before to its takeover map", () => {
      const code = fs
        .readFileSync(new URL(file, dir), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      const otherTypes = (code.match(/sst:\w+:[A-Z]\w+/g) ?? []).filter(
        (found) => found !== type,
      );
      expect(otherTypes).toEqual([]);
      expect(code).not.toMatch(/takeover|\baliases\s*:/);
    });
  });
});
