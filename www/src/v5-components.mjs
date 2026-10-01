import fs from "node:fs";

// The V5 components are found by their file name: `<name>-v5.ts` next to the
// component it replaces. The docs generator and the sidebar both read this
// list, so a new one gets its page and its sidebar entry without being added
// to either.
const dir = new URL("../../platform/src/components/aws/", import.meta.url);

/**
 * The name of every V5 component's file, without its extension.
 * @returns {string[]}
 */
export function v5Components() {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith("-v5.ts"))
    .map((file) => file.slice(0, -".ts".length))
    .sort();
}
