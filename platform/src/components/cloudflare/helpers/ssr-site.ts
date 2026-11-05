import path from "path";
import { type Input, type Output, output } from "@pulumi/pulumi";
import { type PartsBuilder, named } from "../../parts-component";
import { plain } from "../../args";
import { context } from "../../contract";
import {
  BUILD_READS_IT,
  type SiteDevArgs,
  siteDev,
  sitePathOf,
} from "../../aws/helpers/site";
import {
  buildSite,
  defaultBuildCommand,
  knownLinks,
  resolveWithUnknowns,
  withoutUnknowns,
} from "../../aws/helpers/site-build";
import { DEFAULT_ACCOUNT_ID } from "../account-id";
import { Worker, type WorkerArgs, checkDomain } from "../worker";
import {
  DEFAULT_COMPATIBILITY_DATE,
  DEFAULT_COMPATIBILITY_FLAGS,
  normalizeCompatibility,
} from "./compatibility";
import {
  type WranglerLink,
  createWranglerConfig,
  writeWranglerConfig,
} from "./wrangler";
import { type WorkerSiteParts, workerSite } from "./site";

// What every Cloudflare site with a server shares: the `Astro`, the
// `ReactRouter` and the `TanStackStart`. Each is built by its framework with
// Cloudflare's adapter, which reads the Wrangler config SST writes for it.

export const ssrSiteParts = () => ({
  /**
   * The Worker that renders the site and serves its files.
   */
  server: named(Worker, "Worker"),
});

export type SsrSiteParts = ReturnType<typeof ssrSiteParts>;

/** The args every site with a server takes, in the same words. */
export interface SsrSiteArgs {
  /**
   * Configure Cloudflare compatibility for the site. It's set on the Worker
   * that renders it, and in the Wrangler config its build and `sst dev` read.
   *
   * @example
   * ```js
   * {
   *   compatibility: {
   *     date: "2025-09-01",
   *     flags: ["nodejs_compat"]
   *   }
   * }
   * ```
   */
  compatibility?: WorkerArgs["compatibility"];
  /**
   * The Cloudflare account ID to use for this site and its Worker.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
}

/**
 * What each site takes in its own words: its docs name its framework. The
 * base reads them as they're written there.
 */
export interface SiteOwnArgs {
  dev?: false | SiteDevArgs;
  path?: string;
  link?: any[];
  environment?: Input<Record<string, Input<string>>>;
  domain?: WorkerArgs["domain"];
  buildCommand?: string;
}

/** Where a framework's build put what the Worker serves. */
export interface SsrSitePlan {
  /** The Worker's code, from the site's folder. */
  server: string;
  /** The folder of files it serves, from the site's folder. */
  assets: string;
}

/** What a framework gives the base: how its site is checked and read. */
export interface SsrFramework {
  /** The framework, in messages: `Astro`, for `the "Web" Astro site`. */
  label: string;
  /**
   * Checks the site's folder, in `sst dev` too, like that its config gives
   * Cloudflare's adapter SST's Wrangler config.
   *
   * @param site The site's folder, on this machine.
   * @param owner The site, in messages: `the "Web" Astro site`.
   */
  check(site: string, owner: string): void;
  /**
   * What the framework adds to SST's Wrangler config, like its Worker's
   * entry.
   *
   * @param site The site's folder, on this machine.
   */
  wrangler?(site: string): Record<string, unknown>;
  /**
   * Reads the build: where the Worker's code and files are.
   *
   * @param site The site's folder, on this machine, once it's built.
   * @param owner The site, in messages: `the "Web" Astro site`.
   */
  load(site: string, owner: string): Promise<SsrSitePlan>;
}

/**
 * Build a site with a server: what every framework's site creates. It writes
 * a Wrangler config for the site, with its compatibility, what it's linked
 * to and its environment, and gives its path to the build and to `sst dev` as
 * `SST_WRANGLER_PATH`, which the framework's config passes to Cloudflare's
 * adapter. Then the framework reads the build, and the site's Worker serves
 * what it made.
 *
 * ```ts
 * this.siteUrl = ssrSite(this.builder(), name, args, astro).url;
 * ```
 */
export function ssrSite(
  builder: PartsBuilder<SsrSiteParts>,
  name: string,
  args: SsrSiteArgs &
    SiteOwnArgs & { transform?: { server?: unknown }; existing?: object },
  framework: SsrFramework,
): { url: Output<string | undefined> } {
  const owner = `the "${name}" ${framework.label} site`;
  const option = (arg: string) => `The "${arg}" of ${owner}`;
  const sitePath = sitePathOf(args.path, owner);
  const site = path.resolve(context().paths.root, sitePath);
  const dev = plain(args.dev, option("dev"));
  const link = plain(
    args.link,
    option("link"),
    "A link to something in AWS gives the site's Worker an IAM user, so the list has to be known before the user is created.",
  );
  const domain = checkDomain(args.domain, owner);
  const buildCommand = plain(
    args.buildCommand,
    option("buildCommand"),
    BUILD_READS_IT,
  );
  framework.check(site, owner);

  return workerSite(
    builder as unknown as PartsBuilder<WorkerSiteParts>,
    name,
    args,
    {
      owner,
      dev,
      server: {
        environment: args.environment,
        link,
        accountId: args.accountId,
        domain,
        compatibility: args.compatibility,
      },
      devReport: (server) => ({
        ...siteDev(dev || undefined, sitePath),
        environment: args.environment,
        link,
        cloudflare: { path: output(writeWrangler(server())) },
      }),
      build: async (server) => {
        const wranglerPath = await writeWrangler(server);
        await buildSite({
          name,
          sitePath,
          command: buildCommand ?? defaultBuildCommand(sitePath),
          environment: {
            ...(await knownEnvironment()),
            SST_WRANGLER_PATH: wranglerPath,
          },
          link,
        });
        const plan = await framework.load(site, owner);
        return {
          handler: path.join(sitePath, plan.server),
          assets: path.join(sitePath, plan.assets),
        };
      },
    },
  );

  // The site's environment, with what isn't known yet left out: in a
  // preview, what a deploy creates
  async function knownEnvironment() {
    return withoutUnknowns(
      await resolveWithUnknowns(args.environment ?? {}),
    ) as Record<string, string> | undefined;
  }

  // The Wrangler config the site's build and `sst dev` read, written where
  // SST 4 wrote it. Its path, once it's written.
  async function writeWrangler(server: WorkerArgs) {
    const { name: appName, stage } = context().app;
    const compatibility = withoutUnknowns(
      await resolveWithUnknowns(normalizeCompatibility(server)),
    ) as { date?: string; flags?: string[] } | undefined;
    const accountId = withoutUnknowns(
      await resolveWithUnknowns(args.accountId ?? DEFAULT_ACCOUNT_ID),
    ) as string | undefined;
    const config = createWranglerConfig({
      appName,
      appStage: stage,
      name,
      frameworkConfig: framework.wrangler?.(site),
      compatibility: {
        date: compatibility?.date ?? DEFAULT_COMPATIBILITY_DATE,
        flags: compatibility?.flags ?? DEFAULT_COMPATIBILITY_FLAGS,
      },
      environment: await knownEnvironment(),
      links: await wranglerLinks(),
      accountId,
    });
    return writeWranglerConfig({
      workDir: context().paths.work,
      stage,
      name,
      config,
    });
  }

  // What each link gives the Wrangler config: a binding, or its properties.
  // The build is given the same links, the same way.
  async function wranglerLinks(): Promise<WranglerLink[]> {
    return (await knownLinks(link)).map(({ name, include, properties }) => ({
      name,
      include: include as WranglerLink["include"],
      properties,
    }));
  }
}
