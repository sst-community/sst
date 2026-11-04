import fs from "fs";
import path from "path";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import type { SiteBuild } from "./ssr-site";

/**
 * A site that Nitro built with its "aws-lambda" preset, as a Nuxt, SolidStart,
 * TanStack Start or Analog app is: its client's files are served from S3, and
 * its server is Nitro's Lambda handler.
 *
 * ```ts
 * load: (builtPath) =>
 *   nitroSite(builtPath, {
 *     framework: "Nuxt",
 *     howToSet: [...],
 *     description: "Server handler for Nuxt",
 *     base: (outputPath) => configValue(outputPath, "nuxt.config", "baseURL"),
 *   }),
 * ```
 *
 * @param builtPath The site's folder as it's built, from the app's folder.
 */
export function nitroSite(
  builtPath: string,
  site: {
    /** The framework, in messages: `Nuxt`. */
    framework: string;
    /** Where Nitro builds to, in the site's folder. @default `".output"` */
    output?: string;
    /** The lines that say where the app sets Nitro's preset. */
    howToSet: string[] | ((outputPath: string) => string[]);
    /** The server function's description. */
    description: string;
    /** The site's base path, read from its folder on this machine. */
    base(outputPath: string): string | undefined;
    /**
     * Folders of the client's files whose paths are the server's, like
     * `_server`: they're removed, so their requests go to the server and not
     * to S3.
     */
    serverPaths?: string[];
    /** Whether prerendered routes can be in the same folder as server ones. */
    hasStaticRoutes?: boolean;
  },
): SiteBuild {
  const outputPath = path.resolve(context().paths.root, builtPath);
  const output = site.output ?? ".output";
  const nitro = readNitro(
    path.join(outputPath, output),
    site.framework,
    typeof site.howToSet === "function"
      ? site.howToSet(outputPath)
      : site.howToSet,
  );
  for (const dir of site.serverPaths ?? [])
    fs.rmSync(path.join(outputPath, output, "public", dir), {
      recursive: true,
      force: true,
    });

  return {
    sitePath: builtPath,
    outputPath,
    serves: true,
    plan: {
      base: site.base(outputPath),
      assets: [
        {
          from: path.join(output, "public"),
          to: "",
          cached: true,
        },
      ],
      ...(site.hasStaticRoutes && { hasStaticRoutes: true }),
    },
    server: {
      description: site.description,
      handler: "index.handler",
      bundle: path.join(builtPath, output, "server"),
      streaming: nitro.streaming,
    },
  };
}

/**
 * What Nitro says about a build in its `nitro.json`: whether its server
 * streams. A build without Nitro's "aws-lambda" preset has no Lambda handler,
 * so it's refused, saying where to set the preset.
 *
 * @param outputDir The folder Nitro built to, like the site's `.output`.
 * @param framework The framework, in messages: `Nuxt`.
 * @param howToSet The lines that say where the framework sets the preset.
 */
export function readNitro(
  outputDir: string,
  framework: string,
  howToSet: string[],
): { streaming: boolean } {
  const file = path.join(outputDir, "nitro.json");
  if (!fs.existsSync(file))
    throw new VisibleError(
      `No Nitro build found at "${file}". Build your ${framework} app with Nitro's "aws-lambda" preset.`,
    );
  const nitro = JSON.parse(fs.readFileSync(file, "utf-8"));
  // Nitro takes the preset's name in either spelling
  if (String(nitro.preset).replace(/_/g, "-") !== "aws-lambda")
    throw new VisibleError(
      [
        `No AWS-Lambda preset detected for ${framework}.`,
        "",
        ...howToSet,
        "",
        `Detected preset: "${nitro.preset ?? "undefined"}"`,
      ].join("\n"),
    );
  return { streaming: nitro.config?.awsLambda?.streaming === true };
}
