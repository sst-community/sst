import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, Builder } from "@sveltejs/kit";
const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default function (): Adapter {
  return {
    name: "svelte-kit-sst",
    async adapt(builder: Builder) {
      const out = path.join(".svelte-kit", "svelte-kit-sst");
      const clientDir = path.join(out, "client");
      const serverDir = path.join(out, "server");
      const prerenderedDir = path.join(out, "prerendered");

      // Cleanup output folder
      fs.rmSync(out, { force: true, recursive: true });
      fs.mkdirSync(clientDir, { recursive: true });
      fs.mkdirSync(prerenderedDir, { recursive: true });

      // Create static output
      builder.log.minor("Copying assets...");
      builder.writeClient(clientDir);
      const prerenderedFiles = builder.writePrerendered(prerenderedDir);

      // Create Lambda function. Both branches leave a `server.js` in the server
      // folder that exports `server`, which is all the Lambda handler imports.
      builder.log.minor("Generating server function...");
      if (typeof builder.generateServerInstance === "function") {
        // SvelteKit 3 writes the server instance next to its own server output.
        // Generate it there, then copy everything over.
        const kitServerDir = builder.getServerDirectory();
        builder.generateServerInstance(path.join(kitServerDir, "server.js"));
        builder.copy(kitServerDir, serverDir);
      } else {
        // SvelteKit 2 has no `generateServerInstance`. Copy the server output
        // and build the instance from the `Server` class and manifest it wrote.
        builder.writeServer(serverDir);
        fs.writeFileSync(
          path.join(serverDir, "server.js"),
          [
            `import { Server } from "./index.js";`,
            `import { manifest } from "./manifest.js";`,
            `export const server = new Server(manifest);`,
            ``,
          ].join("\n")
        );
      }
      // copy over handler files in server handler folder
      builder.copy(
        path.join(__dirname, "handler"),
        path.join(serverDir, "lambda-handler")
      );
      // save a list of files in server handler folder
      fs.writeFileSync(
        path.join(serverDir, "lambda-handler", "prerendered-file-list.js"),
        `export default ${JSON.stringify(prerenderedFiles)}`
      );
    },

    supports: {
      // The function only contains the server code and prerendered pages. The
      // client assets are served from S3, so `read` can't open them.
      read: ({ route }) => {
        throw new Error(
          `svelte-kit-sst doesn't support \`read\` from '$app/server' (used by ${route.id}). ` +
            "Client assets are served from S3 and aren't included in the Lambda function."
        );
      },
      // Wrapping the entrypoint for instrumentation isn't implemented yet.
      instrumentation: () => false,
    },
  };
}
