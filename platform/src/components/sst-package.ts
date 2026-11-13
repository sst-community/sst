import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { lazy } from "../util/lazy";

/** The `sst` package these components were installed with. */
export interface SstPackage {
  /** Its folder. */
  dir: string;
  /** Its name, which may be scoped: `@sst-community/sst`. */
  name: string;
  version: string;
}

/**
 * The `sst` package this file is in, under a program Pulumi runs on its own,
 * found by its `package.json`, which has the `sst` command. Under SST's CLI,
 * the components are in the app's `.sst/platform`, which isn't the package,
 * and in this repo's tests there's none.
 */
export const sstPackage = lazy((): SstPackage | undefined => {
  for (
    let dir = path.dirname(fileURLToPath(import.meta.url));
    ;
    dir = path.dirname(dir)
  ) {
    const file = path.join(dir, "package.json");
    const pkg = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : undefined;
    if (pkg?.bin?.sst) return { dir, name: pkg.name, version: pkg.version };
    if (path.dirname(dir) === dir) return undefined;
  }
});
