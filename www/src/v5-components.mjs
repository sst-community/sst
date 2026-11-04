import fs from "node:fs";

// The V5 components are the files in a provider's `v5` folder, like
// `aws/v5/`, each named like the file of the component it replaces. The docs
// generator and the sidebar both read this list, so a new one gets its page
// and its sidebar entry without being added to either.

/**
 * Every V5 component's file of a provider, without its extension: `v5/queue`.
 * @param {"aws" | "cloudflare"} [group]
 * @returns {string[]}
 */
export function v5Components(group = "aws") {
  const dir = new URL(
    `../../platform/src/components/${group}/v5/`,
    import.meta.url,
  );
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts")
    .map((file) => `v5/${file.slice(0, -".ts".length)}`)
    .sort();
}
