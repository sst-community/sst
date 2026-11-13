import { underCore } from "./context";
import { sstPackage } from "./sst-package";

/**
 * Where Pulumi downloads the provider SST's own resources run on: this repo's
 * GitHub releases, which have a `pulumi-resource-sst` archive for each
 * platform. The repo is the one `pkg/global/distribution.go` releases from.
 */
export const pluginDownloadURL = "github://api.github.com/sst-community/sst";

/**
 * The options SST's own resources and functions are registered with, for the
 * provider the `sst` binary serves.
 *
 * Under SST's CLI they're as given: Pulumi finds the provider from the CLI's
 * work folder, and a stage's state names no version. Under a program Pulumi
 * runs on its own, they name the `sst` package's version and where its
 * release is, so Pulumi downloads the plugin as it does any third party's,
 * and the state keeps both, for a `pulumi destroy` without SST installed.
 */
export function withPlugin<
  T extends { version?: string; pluginDownloadURL?: string },
>(opts?: T): T | undefined {
  if (underCore()) return opts;
  const pkg = sstPackage();
  if (!pkg) return opts;
  return {
    ...opts,
    version: opts?.version ?? pkg.version,
    pluginDownloadURL: opts?.pluginDownloadURL ?? pluginDownloadURL,
  } as T;
}
