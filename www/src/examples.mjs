import fs from "node:fs";

// The example apps, each a folder of `examples/` with an `sst.config.ts`
// (`examples/component-package` is a package to copy, not an app). The docs
// have an Examples page, and link to it from the header and the sidebar,
// only when there's one: SST 5's examples come back one at a time.

/** @returns {string[]} */
export function exampleDirs() {
  const dir = new URL("../../examples/", import.meta.url);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(new URL(`${name}/sst.config.ts`, dir)))
    .sort();
}

export const hasExamples = exampleDirs().length > 0;
