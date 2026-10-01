import fs from "node:fs";

// The V5 components are the files in `aws/v5/`, each named like the file of
// the component it replaces. The docs generator and the sidebar both read
// this list, so a new one gets its page and its sidebar entry without being
// added to either.
const dir = new URL("../../platform/src/components/aws/v5/", import.meta.url);

/**
 * Every V5 component's file, without its extension: `v5/queue`.
 * @returns {string[]}
 */
export function v5Components() {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts")
    .map((file) => `v5/${file.slice(0, -".ts".length)}`)
    .sort();
}
