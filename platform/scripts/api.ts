// The API reports: what a package builds on, as API Extractor reads it from
// the platform's types, one report for each entry point of the `sst`
// package, in api/. Within 5.x it only changes in ways that don't break a
// package (MAINTAINING.md, "The public API (v5)").
//
//   bun run api          checks the reports, and fails on a change they don't have
//   bun run api:update   writes them
//
// Both build the types first (scripts/build-types).

import fs from "node:fs";
import path from "node:path";
import { $ } from "bun";
import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
  type IConfigFile,
} from "@microsoft/api-extractor";
import { groups } from "../src/components/groups";

const update = process.argv.includes("--update");
const root = path.resolve(import.meta.dir, "..");
const reports = path.join(root, "api");

// Each entry point, by what a package imports, and its types. The `sst`
// package exports the same (sdk/js/scripts/platform.ts).
const entries: Record<string, string> = {
  "sst/components": "components/core",
  ...Object.fromEntries(
    Object.keys(groups).map((group) => [
      `sst/components/${group}`,
      `components/${group}/index`,
    ]),
  ),
  "sst/testing": "testing/index",
};
const fileName = (entry: string) => entry.replaceAll("/", "-");

await $`bash ${path.join(root, "scripts/build-types")}`;
fs.mkdirSync(reports, { recursive: true });

let failed = false;
for (const [entry, types] of Object.entries(entries)) {
  const mainEntryPointFilePath = path.join(root, "dist/types", `${types}.d.ts`);
  const configObject: IConfigFile = {
    projectFolder: root,
    mainEntryPointFilePath,
    compiler: {
      overrideTsconfig: {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
          lib: ["ES2023"],
          types: ["node"],
          strict: true,
          skipLibCheck: true,
        },
        files: [
          mainEntryPointFilePath,
          path.join(root, "dist/types/global.d.ts"),
        ],
      },
    },
    apiReport: {
      enabled: true,
      reportFileName: fileName(entry),
      reportFolder: reports,
      reportTempFolder: path.join(root, "dist/api"),
      // A type the API uses that a package can't import, like a component's
      // parts, is in the report too, so a change to it shows
      includeForgottenExports: true,
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    messages: {
      compilerMessageReporting: {
        default: { logLevel: ExtractorLogLevel.Warning },
      },
      extractorMessageReporting: {
        default: {
          logLevel: ExtractorLogLevel.Warning,
          addToApiReportFile: false,
        },
        // Exported only when a package has to name it: each is more to keep
        "ae-forgotten-export": {
          logLevel: ExtractorLogLevel.None,
          addToApiReportFile: false,
        },
        // Everything exported is the API, tagged or not. `@internal` is what
        // the docs site leaves out, and it's reported too
        "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
        "ae-internal-missing-underscore": {
          logLevel: ExtractorLogLevel.None,
          addToApiReportFile: false,
        },
        // `{@link}` in SST's doc comments is for the docs site
        "ae-unresolved-link": {
          logLevel: ExtractorLogLevel.None,
          addToApiReportFile: false,
        },
        // What's documented is the docs site's to check
        "ae-undocumented": {
          logLevel: ExtractorLogLevel.None,
          addToApiReportFile: false,
        },
      },
      tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
    },
  };
  const config = ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: undefined,
    // Named for the package a report is about
    packageJson: { name: "sst", version: "0.0.0" },
    packageJsonFullPath: path.join(root, "package.json"),
  });
  const result = Extractor.invoke(config, { localBuild: update });
  if (result.apiReportChanged && !update) {
    console.error(
      `The API of ${entry} has changed, and api/${fileName(
        entry,
      )}.api.md doesn't have it. If the change is meant, run \`bun run api:update\` in platform/ and commit the report: within 5.x, removing an export or changing what one accepts waits for a major version.`,
    );
    failed = true;
  } else if (!result.succeeded) {
    console.error(`API Extractor failed for ${entry}.`);
    failed = true;
  } else {
    console.log(`${entry}: ${update ? "written" : "unchanged"}`);
  }
}

// A report for an entry point that's gone
const expected = new Set(
  Object.keys(entries).map((entry) => `${fileName(entry)}.api.md`),
);
for (const file of fs.readdirSync(reports)) {
  if (!file.endsWith(".api.md") || expected.has(file)) continue;
  if (update) {
    fs.rmSync(path.join(reports, file));
    console.log(`api/${file}: removed`);
  } else {
    console.error(
      `api/${file} is for no entry point. Run \`bun run api:update\`.`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
