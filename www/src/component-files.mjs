import fs from "node:fs";

// SST 5's components are the files in a provider's folder, like `aws/`, that
// declare one with `component()`. The docs generator and the sidebar both
// read this list, so a new one gets its page and its sidebar entry without
// being added to either.

/**
 * Every component's file of a provider, without its extension: `queue`.
 * @param {"aws" | "cloudflare"} [group]
 * @returns {string[]}
 */
export function componentFiles(group = "aws") {
  const dir = new URL(
    `../../platform/src/components/${group}/`,
    import.meta.url,
  );
  return fs
    .readdirSync(dir)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        file !== "index.ts" &&
        /^export class \w+ extends component\(/m.test(
          fs.readFileSync(new URL(file, dir), "utf8"),
        ),
    )
    .map((file) => file.slice(0, -".ts".length))
    .sort();
}

/**
 * The components a provider has for other components to use, which the
 * sidebar lists under "Internal".
 */
export const internal = {
  aws: [
    "alb",
    "cdn",
    "dns-validated-certificate",
    "https-redirect",
    "cognito-user-pool-client",
    "apigateway-rest-api-key",
    "apigateway-rest-usage-plan",
  ],
  cloudflare: [],
};
