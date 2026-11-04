import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// The app, with a site in it whose package manager the tests change
const app = fs.mkdtempSync(path.join(os.tmpdir(), "sst-site-build-"));
const site = path.join(app, "web");
fs.mkdirSync(site);
const writePackage = (scripts: Record<string, string> | undefined) =>
  fs.writeFileSync(
    path.join(site, "package.json"),
    JSON.stringify({ name: "web", ...(scripts && { scripts }) }),
  );

mockPulumi({ root: app });

describe("Building a site", () => {
  let helpers: typeof import("../../../src/components/aws/helpers/site-build");

  beforeAll(async () => {
    helpers = await import("../../../src/components/aws/helpers/site-build");
  });

  afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

  it("fails with the end of a build's output", async () => {
    await expect(
      helpers.buildSite({
        name: "Web",
        sitePath: site,
        command: "echo first; echo the reason >&2; exit 3",
      }),
    ).rejects.toThrow(
      /`echo first; echo the reason >&2; exit 3` exited with 3\.\n[\s\S]*the reason/,
    );
  });

  it("leaves out what the CLI passes for SST's own calls to Cloudflare", async () => {
    const was = process.env.SST_CLOUDFLARE_API_TOKEN;
    process.env.SST_CLOUDFLARE_API_TOKEN = "not-for-the-build";
    process.env.SST_TEST_KEPT = "kept";
    try {
      await helpers.buildSite({
        name: "Web",
        sitePath: site,
        command: "env > build-env.txt",
      });
    } finally {
      if (was === undefined) delete process.env.SST_CLOUDFLARE_API_TOKEN;
      else process.env.SST_CLOUDFLARE_API_TOKEN = was;
      delete process.env.SST_TEST_KEPT;
    }
    const env = fs.readFileSync(path.join(site, "build-env.txt"), "utf8");
    expect(env).toContain("SST_TEST_KEPT=kept");
    expect(env).not.toContain("SST_CLOUDFLARE_API_TOKEN");
  });

  describe("without a command of its own", () => {
    const lockfiles = ["yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];
    const clear = () => {
      for (const dir of [app, site])
        for (const file of lockfiles)
          fs.rmSync(path.join(dir, file), { force: true });
    };

    it("runs the build script with npm", () => {
      clear();
      writePackage({ build: "astro build" });
      expect(helpers.defaultBuildCommand("web")).toBe("npm run build");
    });

    it("runs it with the package manager whose lockfile is in the site or the app", () => {
      writePackage({ build: "astro build" });
      const cases: [string, string, string][] = [
        [site, "yarn.lock", "yarn run build"],
        [app, "pnpm-lock.yaml", "pnpm run build"],
        [site, "bun.lockb", "bun run build"],
        [app, "bun.lock", "bun run build"],
      ];
      for (const [dir, file, command] of cases) {
        clear();
        fs.writeFileSync(path.join(dir, file), "");
        expect(helpers.defaultBuildCommand("web"), file).toBe(command);
      }
      clear();
    });

    it("needs a package.json with a build script", () => {
      writePackage(undefined);
      expect(() => helpers.defaultBuildCommand("web")).toThrow(
        'No "build" script found within package.json in "web".',
      );
      expect(() => helpers.defaultBuildCommand("missing")).toThrow(
        'No package.json found at "missing".',
      );
    });
  });

  describe("reading a value from a config", () => {
    const write = (file: string, text: string) =>
      fs.writeFileSync(path.join(site, file), text);
    afterAll(() => {
      for (const file of ["vite.config.ts", "nuxt.config.mjs"])
        fs.rmSync(path.join(site, file), { force: true });
    });

    it("reads what's in the quotes after the key, in any extension", () => {
      write(
        "vite.config.ts",
        `export default { base: "/docs/", plugins: [], other: "x" };`,
      );
      expect(helpers.configValue("web", "vite.config", "base")).toBe("/docs/");
      write("nuxt.config.mjs", `export default { app: { baseURL: '/docs' } };`);
      expect(helpers.configValue("web", "nuxt.config", "baseURL")).toBe(
        "/docs",
      );
    });

    it("takes the key in quotes, and not inside another key", () => {
      write("vite.config.ts", `export default { "base": '/docs/' };`);
      expect(helpers.configValue("web", "vite.config", "base")).toBe("/docs/");
      write(
        "vite.config.ts",
        `export default { database: "/x", basename: "/y" };`,
      );
      expect(helpers.configValue("web", "vite.config", "base")).toBeUndefined();
      expect(helpers.configValue("web", "missing.config", "base")).toBe(
        undefined,
      );
    });
  });
});
