// When the source of a generated docs page last changed, from git. The
// component, reference and example pages are generated at build time and
// aren't in git, so Starlight can't date them; their date is that of the file
// or folder they're generated from. One `git log` reads every date, the first
// time one is asked for.
import { spawnSync } from "node:child_process";

const SOURCES = ["platform/src", "cmd/sst/main.go", "examples"];

let dates: Map<string, Date> | undefined;

function load() {
  const found = new Map<string, Date>();
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).stdout?.trim();
  if (!root) return found;

  const log = spawnSync(
    "git",
    ["log", "--format=t:%ct", "--name-only", "--", ...SOURCES],
    { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (log.error || log.status !== 0) return found;

  // Newest commit first, so the first date seen for a path is its latest.
  let date = new Date(0);
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith("t:")) {
      date = new Date(Number(line.slice(2)) * 1000);
      continue;
    }
    if (!line) continue;
    // A folder, such as an example, is as new as its newest file.
    const parts = line.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (!found.has(path)) found.set(path, date);
    }
  }
  return found;
}

// The date `source` last changed, a path from the repo root, or undefined
// when git has no history for it.
export function sourceDate(source: string): Date | undefined {
  dates ??= load();
  return dates.get(source);
}
