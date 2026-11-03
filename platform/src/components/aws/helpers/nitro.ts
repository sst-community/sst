import fs from "fs";
import path from "path";
import { VisibleError } from "../../error";

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
