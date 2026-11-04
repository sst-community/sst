import fs from "fs";
import path from "path";
import { expect, it } from "vitest";
import { rejectionsOf } from "../../../helpers/rejections";
import { ssrSiteSuite } from "./ssr-site.suite";

const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

// A React Router app, as Cloudflare's Vite plugin builds it
ssrSiteSuite(
  {
    label: "React Router",
    load: async () => ({
      original: (
        await import("../../../../src/components/cloudflare/react-router")
      ).ReactRouter as any,
      v5: (
        await import("../../../../src/components/cloudflare/v5/react-router")
      ).ReactRouter as any,
    }),
    write: (dir) => {
      write(dir, "package.json", JSON.stringify({ name: "web" }));
      write(
        dir,
        "vite.config.ts",
        "export default { plugins: [cloudflare({ configPath: process.env.SST_WRANGLER_PATH })] };",
      );
      write(dir, "workers/app.ts", "export default {};");
      write(dir, "build/server/index.js", "export default {};");
      write(dir, "build/client/index.html", "<html>Home</html>");
    },
    built: { server: "build/server/index.js", assets: "build/client" },
    config: "vite.config.ts",
  },
  {
    tests: ({ pulumi, Site, app, write: writeApp, wrangler }) => {
      it("gives the Vite plugin the app's Worker entry", async () => {
        new (Site())("Web", { path: "web", buildCommand: "true" });
        await pulumi.settle();
        expect(wrangler().main).toBe(
          path.join(app, "web", "workers", "app.ts"),
        );
      });

      it("fails a deploy once when the build has no files to serve", async () => {
        writeApp("noclient/package.json", "{}");
        writeApp(
          "noclient/vite.config.ts",
          "export default { configPath: process.env.SST_WRANGLER_PATH };",
        );
        writeApp("noclient/build/server/index.js", "export default {};");
        const failures = await rejectionsOf(async () => {
          new (Site())("Web", { path: "noclient", buildCommand: "true" });
          await pulumi.settle();
        });
        expect(new Set(failures).size).toBe(1);
        expect((failures[0] as Error).message).toBe(
          `The build of the "Web" React Router site has no files to serve at "${path.join(
            app,
            "noclient",
            "build",
            "client",
          )}".`,
        );
      });
    },
  },
);
