import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";
import { globSync } from "glob";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { groups } from "../../src/components/groups";
import { alias } from "../../src/testing/vitest";

const components = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/components",
);

// The providers a file loads when it's imported without a bundler, as a test
// does: every one its files import, used or not
async function providersLoadedBy(file: string) {
  const result = await build({
    entryPoints: [path.join(components, file)],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    treeShaking: false,
    ignoreAnnotations: true,
    metafile: true,
    write: false,
    outdir: "out",
    logLevel: "error",
  });
  const providers = new Set<string>();
  for (const input of Object.values(result.metafile.inputs))
    for (const imported of input.imports) {
      const parts = imported.path.split("/");
      const name = parts.slice(0, 2).join("/");
      if (imported.external && /^@(pulumi|pulumiverse)\//.test(name))
        providers.add(name);
    }
  providers.delete("@pulumi/pulumi");
  return [...providers].sort();
}

describe("SST's components", () => {
  // Before anything here sets them
  it("load without the config's globals", async () => {
    expect(typeof (globalThis as any).$app).toBe("undefined");
    const sst = await import("../../src/components/index");
    expect(typeof sst.aws.Bucket).toBe("function");
    expect(typeof sst.cloudflare.Worker).toBe("function");
    expect(typeof sst.vercel.dns).toBe("function");
  });

  it("are the core and each group, as the sst global", async () => {
    const all = await import("../../src/components/index");
    const core = await import("../../src/components/core");
    expect(Object.keys(all).sort()).toEqual(
      [...Object.keys(core), ...Object.keys(groups)].sort(),
    );
    for (const [name, load] of Object.entries(groups))
      expect((all as any)[name]).toBe(await load());
  });

  it("are each mapped by the vitest alias", () => {
    const resolve = (id: string) => {
      const entry = alias.find((entry) => entry.find.test(id));
      return entry && id.replace(entry.find, entry.replacement);
    };
    expect(resolve("sst/components")).toBe(path.join(components, "core.ts"));
    for (const name of Object.keys(groups))
      expect(resolve(`sst/components/${name}`)).toBe(
        path.join(components, name, "index.ts"),
      );
    expect(resolve("sst/components/other")).toBeUndefined();
  });

  // The types build leaves the `sst` global's module out, so the declarations
  // name SST's types through core, not through the global, which loads every
  // group and its providers (tsconfig.types.json). A file that imported it
  // would bring it back.
  it("never import the sst global's module", () => {
    const index = path.join(components, "index.ts");
    // `../..`, `../index`, `../index.js` and `../index.ts` are all it
    const names = [
      components,
      index,
      index.replace(/\.ts$/, ""),
      index.replace(/\.ts$/, ".js"),
    ];
    const importers: string[] = [];
    for (const file of globSync("**/*.ts", { cwd: path.dirname(components) })) {
      const full = path.join(path.dirname(components), file);
      if (full === index || file === "global-aliases.d.ts") continue;
      const { importedFiles } = ts.preProcessFile(
        fs.readFileSync(full, "utf8"),
        true,
        true,
      );
      for (const { fileName } of importedFiles) {
        if (!fileName.startsWith(".")) continue;
        const target = path.resolve(path.dirname(full), fileName);
        if (names.includes(target))
          importers.push(`${file} imports "${fileName}"`);
      }
    }
    expect(importers).toEqual([]);
  });

  it("share a core that loads no provider", async () => {
    expect(await providersLoadedBy("core.ts")).toEqual([]);
  }, 60_000);

  it("load only their own providers in each group", async () => {
    expect(await providersLoadedBy("vercel/index.ts")).toEqual([
      "@pulumiverse/vercel",
    ]);
    expect(await providersLoadedBy("aws/index.ts")).not.toContain(
      "@pulumi/cloudflare",
    );
    expect(await providersLoadedBy("aws/index.ts")).not.toContain(
      "@pulumiverse/vercel",
    );
  }, 60_000);
});
