import crypto from "crypto";
import fs from "fs";

/**
 * The SHA-256 of each file, from its bytes, reading a few files at a time.
 *
 * A site's files can be more than fits in memory together, so they aren't
 * all read at once. And they're hashed as bytes, not as text: a file that
 * isn't text, like an image, read as UTF-8 hashes the same after a change to
 * bytes that aren't valid UTF-8, and wouldn't be uploaded again.
 *
 * @param sources The files' paths.
 * @param at How many files are read at once.
 * @returns Each file's hash, in the order of `sources`.
 */
export async function hashFiles(sources: string[], at = 16): Promise<string[]> {
  const hashes: string[] = new Array(sources.length);
  let next = 0;
  const reader = async () => {
    while (next < sources.length) {
      const i = next++;
      hashes[i] = await hashFile(sources[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(at, sources.length) }, reader),
  );
  return hashes;
}

// A file's SHA-256, read in chunks, so a large one isn't held in memory
function hashFile(source: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(source)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
