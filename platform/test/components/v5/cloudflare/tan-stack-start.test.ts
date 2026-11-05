import fs from "fs";
import path from "path";
import { expect, it } from "vitest";
import { rejectionsOf } from "../../../helpers/rejections";
import { ssrSiteSuite } from "./ssr-site.suite";

const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};
const config =
  "export default { plugins: [cloudflare({ configPath: process.env.SST_WRANGLER_PATH })] };";

// A TanStack Start app, as Cloudflare's Vite plugin builds it: a Worker and a
// Wrangler config that says where it is
ssrSiteSuite(
  {
    label: "TanStack Start",
    load: async () => ({
      original: (
        await import(
          "../../../fixtures/v4/components/cloudflare/tan-stack-start"
        )
      ).TanStackStart as any,
      v5: (
        await import("../../../../src/components/cloudflare/tan-stack-start")
      ).TanStackStart as any,
    }),
    write: (dir) => {
      write(dir, "package.json", JSON.stringify({ name: "web" }));
      write(dir, "vite.config.ts", config);
      write(
        dir,
        "dist/server/wrangler.json",
        JSON.stringify({ main: "index.js" }),
      );
      write(dir, "dist/server/index.js", "export default {};");
      write(dir, "dist/client/index.html", "<html>Home</html>");
    },
    built: { server: "dist/server/index.js", assets: "dist/client" },
    config: "vite.config.ts",
  },
  {
    // The other two ways its build can be laid out
    cases: ({ app }) => {
      writeLayouts(app);
      return {
        "a build without a Wrangler config": {
          create: (Site, opts) =>
            new Site("Web", { path: "plain", buildCommand: "true" }, opts),
        },
        "a build with Nitro's Cloudflare preset": {
          create: (Site, opts) =>
            new Site("Web", { path: "nitro", buildCommand: "true" }, opts),
        },
      };
    },
    tests: ({ pulumi, Site, app, resource, wrangler, write: writeApp }) => {
      it("gives the Vite plugin TanStack Start's Worker entry", async () => {
        new (Site())("Web", { path: "web", buildCommand: "true" });
        await pulumi.settle();
        expect(wrangler().main).toBe("@tanstack/react-start/server-entry");
      });

      it("serves each way its build can be laid out", async () => {
        writeLayouts(app);
        new (Site())("Plain", { path: "plain", buildCommand: "true" });
        new (Site())("Nitro", { path: "nitro", buildCommand: "true" });
        await pulumi.settle();
        expect(pulumi.reportOf("PlainWorker")).toMatchObject({
          function: { handler: "plain/dist/server/index.mjs" },
        });
        expect(resource("PlainWorkerScript").inputs.assets.directory).toBe(
          path.join(app, "plain", "dist", "client"),
        );
        expect(pulumi.reportOf("NitroWorker")).toMatchObject({
          function: { handler: "nitro/.output/server/index.mjs" },
        });
        expect(resource("NitroWorkerScript").inputs.assets.directory).toBe(
          path.join(app, "nitro", ".output", "public"),
        );
      });

      it("fails a deploy once when its Wrangler config has no Worker", async () => {
        writeApp("nomain/package.json", "{}");
        writeApp("nomain/vite.config.ts", config);
        writeApp("nomain/dist/server/wrangler.json", "{}");
        const failures = await rejectionsOf(async () => {
          new (Site())("Web", { path: "nomain", buildCommand: "true" });
          await pulumi.settle();
        });
        expect(new Set(failures).size).toBe(1);
        expect((failures[0] as Error).message).toBe(
          `The build of the "Web" TanStack Start site has no Worker: "${path.join(
            app,
            "nomain",
            "dist",
            "server",
            "wrangler.json",
          )}" has no \`main\`.`,
        );
      });
    },
  },
);

// A build of the Vite plugin without a Wrangler config, and one of Nitro's
// Cloudflare preset
function writeLayouts(app: string) {
  const plain = path.join(app, "plain");
  write(plain, "package.json", "{}");
  write(plain, "vite.config.ts", config);
  write(plain, "dist/server/index.mjs", "export default {};");
  write(plain, "dist/client/index.html", "<html>Home</html>");
  const nitro = path.join(app, "nitro");
  write(nitro, "package.json", "{}");
  write(nitro, "vite.config.ts", config);
  write(nitro, ".output/server/index.mjs", "export default {};");
  write(nitro, ".output/public/index.html", "<html>Home</html>");
}
