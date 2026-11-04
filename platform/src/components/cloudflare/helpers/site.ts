import { type Input, type Output, output } from "@pulumi/pulumi";
import type { NamedPart, PartsBuilder } from "../../parts-component";
import { type PartTransform, mergeArgs, transformPart } from "../../transform";
import { notAnExistingPart } from "../../args";
import { type DevReport, context } from "../../contract";
import {
  type SiteDevArgs,
  URL_UNAVAILABLE,
  refreshing,
} from "../../aws/helpers/site";
import type { Worker, WorkerArgs } from "../v5/worker";

// What every Cloudflare site shares, with a server or without: the sites
// with a server (`ssr-site.ts`) and the `StaticSite`. Each is served by a
// Worker with static assets, its `server`.

/** The parts of a site a Worker serves. */
export type WorkerSiteParts = { server: NamedPart<typeof Worker> };

/** What a site's build gives the Worker that serves it. */
export interface WorkerSiteBuild {
  /** The Worker's code, from the app's folder, when the build makes it. */
  handler?: string;
  /** The folder of files the Worker serves, from the app's folder. */
  assets: string;
}

/** A site, as `workerSite()` builds it. */
export interface WorkerSite {
  /** The site, in messages: `the "Web" Astro site`. */
  owner: string;
  /** Its `dev`, a plain value. */
  dev: false | SiteDevArgs | undefined;
  /**
   * The Worker's args, but for what the build gives it. The Worker always
   * has its URL, and isn't run in `sst dev`: the site is.
   */
  server: Omit<WorkerArgs, "handler" | "assets" | "url" | "dev"> & {
    handler?: Input<string>;
  };
  /** How the Worker serves the files, besides where they are. */
  assets?: {
    htmlHandling?: Input<
      | "auto-trailing-slash"
      | "force-trailing-slash"
      | "drop-trailing-slash"
      | "none"
    >;
    notFoundHandling?: Input<"404-page" | "single-page-application" | "none">;
  };
  /**
   * What `sst dev` runs in place of the site. It's given the Worker's args as
   * the site's `transform.server` makes them, which it calls only when it
   * needs them: the transform's function form is called then.
   */
  devReport(server: () => WorkerArgs): DevReport;
  /**
   * Builds the site, given the Worker's args as the site's `transform.server`
   * made them. It says where the Worker's code and files are.
   */
  build(server: WorkerArgs): Promise<WorkerSiteBuild>;
}

/**
 * A site served by a Worker with static assets: what every Cloudflare site
 * creates. In `sst dev` the site runs on your machine instead, and isn't
 * deployed.
 *
 * The site is built in the program, and its build only says what the Worker
 * is given: where its code and files are. It decides no part, so the Worker
 * is created directly, with what the build gives as outputs, and a preview
 * plans it. `sst refresh` doesn't build the site: the Worker, made from the
 * build, isn't registered then, and stays as it is.
 *
 * @param builder The site's `this.builder()`.
 * @param args The site's args, for its `transform` and `existing`.
 */
export function workerSite(
  builder: PartsBuilder<WorkerSiteParts>,
  name: string,
  args: { transform?: { server?: unknown }; existing?: object },
  site: WorkerSite,
): { url: Output<string | undefined> } {
  const transform = args.transform?.server as
    | PartTransform<WorkerArgs>
    | undefined;
  const fixed = { url: true, dev: false };

  if (context().dev && site.dev !== false) {
    builder.runsLocally();
    builder.report({
      // The Worker isn't created, so its transform is applied here, once
      dev: site.devReport(() => {
        const handle = builder.component.partHandle("server");
        return transformPart(
          transform,
          handle.name,
          { ...site.server, ...fixed, handler: "", assets: { directory: "" } },
          {},
        )[1];
      }),
    });
    return { url: output(site.dev?.url ?? URL_UNAVAILABLE) };
  }

  notAnExistingPart(
    args.existing,
    "server",
    site.owner,
    "A site creates the Worker that serves it, from its build.",
  );

  if (refreshing()) return { url: output(undefined) };

  // The build starts once the Worker's args are what its transform makes them
  let transformed!: (server: WorkerArgs) => void;
  const built = new Promise<WorkerArgs>((resolve) => {
    transformed = resolve;
  }).then(site.build);
  const server: WorkerArgs = {
    ...site.server,
    ...fixed,
    handler:
      site.server.handler ??
      output(built).apply((build) => {
        if (!build.handler)
          throw new Error(`The build of ${site.owner} gave no Worker code.`);
        return build.handler;
      }),
    assets: {
      ...site.assets,
      directory: output(built).apply((build) => build.assets),
    },
  };
  const worker = builder.part("server", server);
  // The function form of the transform changed `server` in place. The object
  // form is merged into a copy, as the part merged it.
  transformed(
    typeof transform === "function"
      ? server
      : mergeArgs<WorkerArgs>(server, transform),
  );

  builder.report({ hint: worker.url });
  return { url: worker.url };
}
