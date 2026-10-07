import type { AstroIntegration } from "astro";
import { BuildMeta, IntegrationConfig } from "./lib/build-meta.js";
import ASTRO_PACKAGE from "astro/package.json" with { type: "json" };
import { debug } from "./lib/logger.js";

const PACKAGE_NAME = "@sst-community/astro-sst";
const [astroMajorVersion, astroMinorVersion] = ASTRO_PACKAGE.version
  .split(".")
  .map((part) => parseInt(part));

export default function createIntegration(
  entrypointParameters: Partial<IntegrationConfig> = {}
): AstroIntegration {
  debug("astroVersion", ASTRO_PACKAGE.version);

  if (astroMajorVersion < 5) {
    throw new Error(
      `${PACKAGE_NAME} requires Astro 5 or newer. Please upgrade your Astro app. Alternatively, use v2 of upstream's adapter by pinning to \`astro-sst@two\`.`
    );
  }
  // Before 5.6, Astro can't be given the 404 page, so it fetches it over the
  // network from the site, and a failed fetch fails the request.
  if (astroMajorVersion === 5 && astroMinorVersion < 6) {
    throw new Error(
      `${PACKAGE_NAME} requires Astro 5.6 or newer, and this app has Astro ${ASTRO_PACKAGE.version}. Please upgrade Astro: 5.6 and later 5.x versions are minor updates.`
    );
  }

  const integrationConfig: IntegrationConfig = {
    responseMode:
      entrypointParameters.responseMode === "stream" ? "stream" : "buffer",
  };

  return {
    name: PACKAGE_NAME,
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        if (
          config.output !== "static" &&
          config.image.service.entrypoint.endsWith("sharp") &&
          config.image.remotePatterns.length === 0 &&
          config.image.domains.length === 0 &&
          typeof config.site === "string"
        ) {
          const siteUrl = new URL(config.site);
          updateConfig({
            image: {
              remotePatterns: [
                {
                  protocol: siteUrl.protocol,
                  hostname: siteUrl.hostname,
                  port: siteUrl.port,
                  pathname: `${config.build.assets}/**`,
                },
              ],
            },
          });
        }

        // Enable sourcemaps for SSR builds.
        updateConfig({
          vite: {
            build: {
              sourcemap: config.vite.build?.sourcemap ?? true,
            },
          },
        });

        BuildMeta.setIntegrationConfig(integrationConfig);
      },
      "astro:routes:resolved": ({ routes }) => {
        BuildMeta.setRoutes(routes);
      },
      "astro:config:done": ({ config, setAdapter, buildOutput }) => {
        BuildMeta.setAstroConfig(config);
        BuildMeta.setBuildOutput(buildOutput);
        // Entrypoints are given as URLs rather than package paths, so they
        // resolve whether the app installs this package by its name or under
        // the `astro-sst` alias that `sst init` writes.
        const entrypoint =
          astroMajorVersion >= 6
            ? ({
                // Astro 6 and later bundle the entrypoint as the server entry
                // and let it create the app, so each response mode has one.
                entrypointResolution: "auto",
                serverEntrypoint: new URL(
                  `./entrypoint/${integrationConfig.responseMode}.js`,
                  import.meta.url
                ),
              } as const)
            : {
                serverEntrypoint: new URL(
                  "./entrypoint/astro5.js",
                  import.meta.url
                ),
                args: integrationConfig,
                exports: ["handler"],
              };
        setAdapter({
          name: PACKAGE_NAME,
          ...entrypoint,
          adapterFeatures: {
            buildOutput: buildOutput,
          },
          supportedAstroFeatures: {
            hybridOutput: "stable",
            staticOutput: "stable",
            serverOutput: "stable",
            sharpImageService: "stable",
          },
        });
      },

      "astro:build:done": async () => {
        await BuildMeta.handlePrerendered404InSsr();
        await BuildMeta.writeToFile();
      },
    },
  };
}
