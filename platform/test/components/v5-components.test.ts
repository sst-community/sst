import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

mockPulumi();

// Every V5 component: a file in `aws/v5/`, named like the file of the
// component it replaces. Its docs page and sidebar entry are found there too.
// What's still written by hand for each one is checked here.
const dir = new URL("../../src/components/aws/v5/", import.meta.url);
const files = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts");

describe("V5 components", () => {
  let takeoverOf: typeof import("../../src/components/takeover").takeoverOf;

  beforeAll(async () => {
    ({ takeoverOf } = await import("../../src/components/takeover"));
    await import("../../src/components/aws/takeover/index");
  });

  it("are found", () => {
    expect(files).toContain("queue.ts");
  });

  it("are exported as sst.aws.v5", () => {
    const index = fs.readFileSync(new URL("../index.ts", dir), "utf8");
    expect(index).toContain(`export * as v5 from "./v5/index.js";`);
  });

  describe.each(files)("%s", (file) => {
    const name = file.slice(0, -3);
    let component: any;

    beforeAll(async () => {
      const module = await import(`../../src/components/aws/v5/${name}.ts`);
      component = Object.values(module).find(
        (value: any) => typeof value?.__pulumiType === "string",
      );
    });

    // A deployed component becomes the V5 one when the name is kept, because
    // the two have the same type. The class is named the same, and so is the
    // file.
    it("has the name and type of the component it replaces", async () => {
      expect(component.__pulumiType).toBe(`sst:aws:${component.name}`);
      const original = await import(`../../src/components/aws/${name}.ts`);
      expect(
        original[component.name]?.__pulumiType,
        `aws/${file} has to export the ${component.name} this one replaces`,
      ).toBe(component.__pulumiType);
    });

    // A part that has another name, or another place, than it had in the
    // component it replaces is in a map in `aws/takeover/`, imported from its
    // `index.ts`.
    it("has its takeover map loaded, when it has one", () => {
      if (!fs.existsSync(new URL(`../takeover/${file}`, dir))) return;
      expect(
        takeoverOf(component),
        `Import aws/takeover/${file} from aws/takeover/index.ts`,
      ).toBeDefined();
    });

    it("is exported from sst.aws.v5", () => {
      const index = fs.readFileSync(new URL("index.ts", dir), "utf8");
      const line = `export * from "./${file.slice(0, -3)}";`;
      expect(index, `Add \`${line}\` to aws/v5/index.ts`).toContain(line);
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
        (found) => found !== component.__pulumiType,
      );
      expect(otherTypes).toEqual([]);
      expect(code).not.toMatch(/takeover|\baliases\s*:/);
    });
  });
});
