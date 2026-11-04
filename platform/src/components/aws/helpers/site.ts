import fs from "fs";
import path from "path";
import { type Input, output } from "@pulumi/pulumi";
import {
  notAnExistingPart,
  notAnOption,
  plain,
  notAnOptionOf,
} from "../../args";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import { type SiteRouteArgs, routeOf } from "./router";

// What every site shares, with a server or without: the sites with a server
// (`ssr-site.ts`) and the `StaticSite`.

// The placeholder URL of a site in `sst dev`, which isn't deployed
export const URL_UNAVAILABLE = "http://url-unavailable-in-dev.mode";

/** Why an arg the site's build reads has to be a plain value. */
export const BUILD_READS_IT =
  "The site is built with it, and a preview has to know what's built.";

/** A site's `dev`, when it isn't `false`. */
export interface SiteDevArgs {
  url?: Input<string>;
  command?: Input<string>;
  autostart?: Input<boolean>;
  directory?: Input<string>;
  title?: Input<string>;
}

// What a route to a site doesn't take, of what a route takes
const ROUTE_ONLY = [
  "rewrite",
  "readTimeout",
  "keepAliveTimeout",
  "connectionTimeout",
  "connectionAttempts",
] as const;

/**
 * Refuse what SST 4's sites took and a site doesn't: `route` and `cdn`, and
 * a distribution in `existing`, which a site wouldn't serve itself through.
 *
 * @param owner The site, in messages: `the "Web" Astro site`.
 */
export function rejectSst4SiteArgs(args: { existing?: object }, owner: string) {
  notAnOption(
    args,
    "route",
    `Serve the site through a Router with "router": { instance: router, path, domain }.`,
    owner,
  );
  notAnOption(
    args,
    "cdn",
    `Serve the site through a Router with "router".`,
    owner,
  );
  notAnExistingPart(
    args.existing,
    "cdn",
    owner,
    `A site creates its own distribution. To serve it through one that's deployed, serve it through a Router with "router", and reference the router with "sst.aws.v5.Router.get()".`,
  );
}

/**
 * The site's folder, from the app's folder: its `path`, which has to be there.
 * The site is built in it, so it's a plain value.
 */
export function sitePathOf(given: string | undefined, owner: string) {
  const sitePath =
    plain(given, `The "path" of ${owner}`, BUILD_READS_IT) || ".";
  const full = path.resolve(context().paths.root, sitePath);
  if (!fs.existsSync(full))
    throw new VisibleError(
      `There's no folder at "${full}", the "path" of ${owner}.`,
    );
  return sitePath;
}

/**
 * What a site reports for its pane in `sst dev`: the command that starts it,
 * `npm run dev` unless it's given one, run in the site's folder unless it's
 * given another.
 */
export function siteDev(dev: SiteDevArgs | undefined, sitePath: string) {
  return {
    title: dev?.title,
    command: output(dev?.command).apply((c) => c ?? "npm run dev"),
    autostart: dev?.autostart,
    directory: output(dev?.directory).apply((d) => d ?? sitePath),
  };
}

/**
 * Whether the program runs for `sst refresh`, which reads what's deployed and
 * creates nothing. A site isn't built for it: what's made from the build
 * isn't registered, and stays as it is. SST 4 built its sites then, as its
 * program couldn't run without their build.
 */
export function refreshing() {
  return context().command === "refresh";
}

/**
 * The route of a site that's served through a router, checked, or nothing
 * without `router`. Behind a router the site has no distribution of its own,
 * so what would configure one is refused: the args the router has instead, and
 * the parts in `existing` the site would create for it.
 *
 * @param args The site's `router`, its `existing`, and its args that the
 * router has instead, like its `domain` and its `edge`.
 * @param owner The site, in messages: `the "Web" Astro site`.
 * @param distributionParts The parts the site creates for a distribution of
 * its own.
 */
export function siteRouteOf(
  args: {
    router?: SiteRouteArgs;
    existing?: object;
    routerHas: Record<string, unknown>;
  },
  owner: string,
  distributionParts: readonly string[],
) {
  const route = plain(args.router, `The "router" of ${owner}`);
  if (!route) return;

  for (const key of ROUTE_ONLY)
    notAnOptionOf(
      (route as unknown as Record<string, unknown>)[key],
      `router.${key}`,
      `A route to a site takes "instance", "path" and "domain": the site sets up how it's reached.`,
      owner,
    );
  for (const [arg, value] of Object.entries(args.routerHas))
    if (value)
      throw new VisibleError(
        `${capitalized(
          owner,
        )} can't have both "${arg}" and "router". Set "${arg}" on the Router it's served through.`,
      );
  for (const part of distributionParts)
    notAnExistingPart(
      args.existing,
      part,
      owner,
      `It's served through "router", so it has no distribution of its own.`,
    );

  return routeOf(route, `The "router.instance" of ${owner}`);
}

/**
 * The args of a site's entry in the routes of the router it's served through.
 *
 * @param namespace The site's namespace in the key-value store.
 */
export function siteRoutesUpdateArgs(
  route: NonNullable<ReturnType<typeof siteRouteOf>>["route"],
  namespace: string,
) {
  return {
    store: route.routerKvStoreArn,
    namespace: route.routerKvNamespace,
    key: "routes",
    entry: route.apply((route) =>
      ["site", namespace, route.hostPattern, route.pathPrefix].join(","),
    ),
  };
}

/** `the "Web" Astro site` as the start of a sentence. */
export function capitalized(owner: string) {
  return owner[0].toUpperCase() + owner.slice(1);
}
