import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, expect, it } from "vitest";
import { hashFiles } from "../../src/components/aws/helpers/file-hashes";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-file-hashes-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, content: Buffer | string) => {
  fs.writeFileSync(path.join(dir, name), content);
  return path.join(dir, name);
};
const sha256 = (content: Buffer | string) =>
  crypto.createHash("sha256").update(content).digest("hex");

it("hashes a file that isn't text by its bytes", async () => {
  // Read as UTF-8, both are one replacement character, so a site's image
  // changed this way hashed the same and wasn't uploaded again
  const before = write("before.png", Buffer.from([0x89, 0xff, 0x00]));
  const after = write("after.png", Buffer.from([0x89, 0xfe, 0x00]));
  expect(fs.readFileSync(before, "utf-8")).toBe(
    fs.readFileSync(after, "utf-8"),
  );
  const [a, b] = await hashFiles([before, after]);
  expect(a).not.toBe(b);
  expect(a).toBe(sha256(fs.readFileSync(before)));
});

it("hashes text as it did, as its UTF-8", async () => {
  const page = write("index.html", "<html>Héllo</html>");
  expect(await hashFiles([page])).toEqual([sha256("<html>Héllo</html>")]);
});

it("gives each file's hash in the order they're given, a few at a time", async () => {
  const files = Array.from({ length: 50 }, (_, i) =>
    write(`page${i}.html`, `page ${i}`.repeat(i * 1000 + 1)),
  );
  expect(await hashFiles(files, 4)).toEqual(
    files.map((file) => sha256(fs.readFileSync(file))),
  );
  expect(await hashFiles([])).toEqual([]);
});

it("fails on a file that's missing", async () => {
  await expect(hashFiles([path.join(dir, "missing")])).rejects.toThrow(
    /ENOENT/,
  );
});
