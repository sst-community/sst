#!/usr/bin/env bun

import { $ } from "bun";
import fs from "fs/promises";
import path from "path";

import metafile from "../../../dist/metadata.json";
import artifacts from "../../../dist/artifacts.json";
import pkg from "../package.json";
const nextPkg = JSON.parse(JSON.stringify(pkg));
// Publish under the fork's npm name (pkg/global/distribution.go). The workspace
// package stays "sst" so bun.lockb matches upstream's.
nextPkg.name = "@sst-community/sst";
nextPkg.version = metafile.version;
// The oldest Node.js SST supports, MinNodeMajor in pkg/project/node.go, so a
// package manager warns at install on an older one. Yarn 1 refuses to install.
nextPkg.engines = { node: ">=22" };
nextPkg.optionalDependencies = nextPkg.optionalDependencies || {};
const snapshot = nextPkg.version.includes("0.0.0");
if (snapshot) {
  console.log("snapshot mode");
}

console.log("publishing", nextPkg.version);

await fs.rmdir("dist", { recursive: true }).catch(() => {});
await $`bun run build`;

const cpus = {
  arm64: "arm64",
  amd64: "x64",
  "386": "x86",
};

const tmp = `tmp`;
const binaryPackages = [] as { dir: string; name: string }[];
for (const artifact of artifacts) {
  if (artifact.type !== "Binary") continue;
  const os = artifact.goos === "windows" ? "win32" : artifact.goos;
  const cpu = cpus[artifact.goarch as keyof typeof cpus];
  if (!os || !cpu)
    throw new Error(`Invalid artifact: ${JSON.stringify(artifact)}`);
  const name = `${nextPkg.name}-${os}-${cpu}`;
  const dir = path.join(tmp, name);
  const binary = path.basename(artifact.path);
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  await fs.cp(
    path.join("../../", artifact.path),
    path.join(dir, "bin", binary),
  );
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: nextPkg.version,
        license: nextPkg.license,
        repository: nextPkg.repository,
        os: [os],
        cpu: [cpu],
      },
      null,
      2,
    ),
  );
  nextPkg.optionalDependencies[name] = nextPkg.version;
  binaryPackages.push({ dir, name });
}

// On a re-run of a release that failed partway, some platform packages may
// already be on npm, which won't take a version twice. Only "no such version"
// counts as missing: a lookup that fails for another reason stops the release.
async function published(name: string, version: string) {
  const result = await $`npm view ${name}@${version} version`.nothrow().quiet();
  if (result.exitCode === 0) return true;
  if (result.stderr.toString().includes("E404")) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${result.stderr}`);
}

const tag = snapshot ? "snapshot" : "latest";
try {
  for (const { dir, name } of binaryPackages) {
    if (await published(name, nextPkg.version)) {
      console.log(`${name}@${nextPkg.version} is already on npm`);
      continue;
    }
    await $`cd ${dir} && npm publish --access public --tag ${tag}`;
  }
  console.log(nextPkg);
  await Bun.write("package.json", JSON.stringify(nextPkg, null, 2));
  await fs.cp("../../README.md", "README.md");
  await $`npm publish --access public --tag ${tag}`;
} finally {
  await Bun.write("package.json", JSON.stringify(pkg, null, 2));
  await fs.rmdir(tmp, { recursive: true });
}
