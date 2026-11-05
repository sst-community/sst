import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

mockPulumi();

// Every one of SST 5's components: a file in its provider's folder, like
// `aws/`, named like the file of SST 4's component it replaces, which is
// frozen in the fixtures. Its docs page and sidebar entry are found there too.
// What's still written by hand for each one is checked here.
const GROUPS = ["aws", "cloudflare"] as const;
type Group = (typeof GROUPS)[number];
const dirOf = (group: Group) =>
  new URL(`../../src/components/${group}/`, import.meta.url);
const fixturesOf = (group: Group) =>
  new URL(`../fixtures/v4/components/${group}/`, import.meta.url);
const filesOf = (group: Group) =>
  fs
    .readdirSync(dirOf(group))
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        file !== "index.ts" &&
        /^export class \w+ extends component\(/m.test(
          fs.readFileSync(new URL(file, dirOf(group)), "utf8"),
        ),
    );
type Dir = ReturnType<typeof dirOf>;
const files = GROUPS.flatMap((group) =>
  filesOf(group).map((file) => [group, file] as const),
);

// The V5 components the maintainer gave a clearer name than SST 4's, by the
// name of the SST 4 component each replaces. Each keeps that one's type.
const RENAMED: Record<Group, Record<string, string>> = {
  aws: {
    Cron: "CronV2",
    ApiGatewayRest: "ApiGatewayV1",
    ApiGatewayRestApiKey: "ApiGatewayV1ApiKey",
    ApiGatewayRestUsagePlan: "ApiGatewayV1UsagePlan",
    ApiGatewayHttp: "ApiGatewayV2",
  },
  cloudflare: {
    StaticSite: "StaticSiteV2",
  },
};

// The types SST 4 spelled otherwise than its components' names, which a
// deployed one keeps: the `Cdn`'s in capitals, TanStack Start's with a small
// "s", and the certificate's for what it is
const TYPE_NAMES: Record<Group, Record<string, string>> = {
  aws: {
    Cdn: "CDN",
    DnsValidatedCertificate: "Certificate",
    TanStackStart: "TanstackStart",
  },
  // SST 4's `StaticSiteV2` has the type of the first `StaticSite`, which 5.0
  // leaves out
  cloudflare: {
    StaticSite: "StaticSite",
  },
};

describe("SST 5's components", () => {
  let takeoverOf: typeof import("../../src/components/takeover").takeoverOf;

  beforeAll(async () => {
    ({ takeoverOf } = await import("../../src/components/takeover"));
    for (const group of GROUPS)
      await import(`../../src/components/${group}/takeover/index.ts`);
  });

  it("are found", () => {
    expect(filesOf("aws")).toContain("queue.ts");
    expect(filesOf("cloudflare")).toContain("worker.ts");
  });

  describe.each(files)("%s/%s", (group, file) => {
    const name = file.slice(0, -3);
    const dir = dirOf(group);
    let component: any;

    beforeAll(async () => {
      const module = await import(`../../src/components/${group}/${name}.ts`);
      component = Object.values(module).find(
        (value: any) => typeof value?.__pulumiType === "string",
      );
    });

    // A deployed component becomes the V5 one when the name is kept, because
    // the two have the same type. The class is named the same, and so is the
    // file, unless it's one of the names the maintainer chose to make clearer,
    // which keep their type: `Cron` replaces `CronV2` as `sst:aws:CronV2`.
    it("has the name and type of the component it replaces", async () => {
      const originalName = RENAMED[group][component.name] ?? component.name;
      const typeName = TYPE_NAMES[group][component.name] ?? originalName;
      expect(component.__pulumiType).toBe(`sst:${group}:${typeName}`);
      // SST 4's file that declares the type: the one of the same name, when
      // it does, as a `.v1` beside it may declare it too
      const old = fixturesOf(group);
      const declaring = fs
        .readdirSync(old)
        .filter((f) => f.endsWith(".ts"))
        .filter((f) =>
          new RegExp(`\\b(?:__)?pulumiType = "${component.__pulumiType}"`).test(
            fs.readFileSync(new URL(f, old), "utf8"),
          ),
        );
      // Two 4.x components can have one type, as Cloudflare's `StaticSiteV2`
      // has its first `StaticSite`'s: then it's the file of the one this
      // replaces
      const replaced = declaring.filter((f) =>
        new RegExp(`\\bclass ${originalName}\\b`).test(
          fs.readFileSync(new URL(f, old), "utf8"),
        ),
      );
      const candidates = replaced.length ? replaced : declaring;
      const originalFile = candidates.includes(file) ? file : candidates[0];
      expect(
        originalFile,
        `No 4.x file in ${group}/ declares ${component.__pulumiType}`,
      ).toBeDefined();
      const original = await import(
        `../fixtures/v4/components/${group}/${originalFile}`
      );
      expect(
        original[originalName]?.__pulumiType,
        `${group}/${originalFile} has to export the ${originalName} this one replaces`,
      ).toBe(component.__pulumiType);
      if (originalName === component.name)
        expect(originalFile, "The file is named as the original's").toBe(file);
    });

    // A part that has another name, or another place, than it had in the
    // component it replaces is in a map in its provider's `takeover/`,
    // imported from its `index.ts`.
    // The map is how the CLI knows a type's 4.x form has this 5.0 form:
    // without one, a new stage takes the 4.x form, and a plain deploy can
    // switch it, where only `sst migrate` releases what a switch releases.
    it("has a takeover map, even an empty one", () => {
      expect(
        takeoverOf(component),
        `Add ${group}/takeover/${file}, with "takeover(${component.name}, {})" when nothing moved, and import it from ${group}/takeover/index.ts`,
      ).toBeDefined();
    });

    it("has its takeover map loaded, when it has one", () => {
      if (!fs.existsSync(new URL(`takeover/${file}`, dir))) return;
      expect(
        takeoverOf(component),
        `Import ${group}/takeover/${file} from ${group}/takeover/index.ts`,
      ).toBeDefined();
    });

    it(`is exported from sst.${group}`, () => {
      const index = fs.readFileSync(new URL("index.ts", dir), "utf8");
      const line = `export * from "./${file.slice(0, -3)}";`;
      expect(index, `Add \`${line}\` to ${group}/index.ts`).toContain(line);
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

// SST 4's components are frozen in the fixtures, for the takeover suites and
// the recorded states, and nowhere else: the platform has none of them, and
// reaches none.
describe("the platform", () => {
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? files(`${dir}/${entry.name}`)
          : /\.(ts|mts|js|mjs)$/.test(entry.name)
            ? [`${dir}/${entry.name}`]
            : [],
      );
  const src = fileURLToPath(new URL("../../src", import.meta.url));

  // SST's own, like `Secret` and `Linkable`, are outside the providers' folders
  it("has none of SST 4's components", () => {
    const providers = ["aws", "cloudflare", "vercel", "experimental"];
    expect(
      providers
        .flatMap((group) => files(`${src}/components/${group}`))
        .filter((file) =>
          /\bclass \w+ extends Component\b/.test(fs.readFileSync(file, "utf8")),
        ),
    ).toEqual([]);
  });

  it("imports nothing from the tests", () => {
    expect(
      files(src).filter((file) =>
        /(?:\bfrom|\bimport\(?)\s*["'][^"']*(?:\/test\/|fixtures\/v4)/.test(
          fs.readFileSync(file, "utf8"),
        ),
      ),
    ).toEqual([]);
  });
});

// The CLI bundles a config with esbuild, and this package says its files have
// no side effects. A file that's imported for what it does, not for what it
// exports, is then left out of the bundle: the takeover maps are such files,
// and without them a switch deletes and recreates everything that moved. No
// test under the mock can see that, because nothing is bundled there.
describe("a config the CLI builds", () => {
  it("has every takeover map in it", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
      stdin: {
        contents: `import * as sst from "./src/components/index.ts"; globalThis.sst = sst;`,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "ts",
      },
      // As in `pkg/js/js.go`
      bundle: true,
      format: "esm",
      platform: "node",
      mainFields: ["module", "main"],
      external: [
        "@pulumi/*",
        "undici",
        "@pulumiverse/*",
        "@sst-provider/*",
        "@aws-sdk/*",
        "esbuild",
        "archiver",
        "glob",
        "vite",
      ],
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const [output] = Object.values(result.metafile.outputs);
    const bundled = Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => path);

    for (const group of GROUPS) {
      const maps = fs
        .readdirSync(new URL("takeover/", dirOf(group)))
        .filter((file) => !["index.ts", "helpers.ts"].includes(file));
      expect(maps.length).toBeGreaterThan(0);
      for (const map of maps)
        expect(
          bundled,
          `${group}/takeover/${map} isn't in a built config. "sideEffects" in package.json has to list the takeover maps.`,
        ).toContain(`src/components/${group}/takeover/${map}`);
    }
  });
});
