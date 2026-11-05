import { Input, Output, all, output } from "@pulumi/pulumi";
import { DurationSeconds } from "../../duration";
import { plain } from "../../args";
import { VisibleError } from "../../error";
import type { Router } from "../router";

/** A `Router` component. */
export type AnyRouter = Router;

/**
 * How a site is served through a router: which router, and the domain and path
 * it's served on there. The site sets its own origins, so its route takes
 * nothing else.
 */
export interface SiteRouteArgs {
  /**
   * The `Router` component to serve it through. It has to be a plain value: whether
   * the router signs its requests decides who may call what it routes to.
   *
   * @example
   *
   * Let's say you have a Router component.
   *
   * ```ts title="sst.config.ts"
   * const router = new sst.aws.Router("MyRouter", {
   *   domain: "example.com"
   * });
   * ```
   *
   * Serve it through the router.
   *
   * ```ts
   * router: {
   *   instance: router
   * }
   * ```
   */
  instance: AnyRouter;
  /**
   * Route requests matching a specific domain pattern.
   *
   * @example
   *
   * You can serve your resource from a subdomain. For example, if you want to make
   * it available at `https://dev.example.com`, set the `Router` to match the
   * domain or a wildcard.
   *
   * ```ts {2} title="sst.config.ts"
   * const router = new sst.aws.Router("MyRouter", {
   *   domain: "*.example.com"
   * });
   * ```
   *
   * Then set the domain pattern.
   *
   * ```ts {3}
   * router: {
   *   instance: router,
   *   domain: "dev.example.com"
   * }
   * ```
   *
   * While `dev.example.com` matches `*.example.com`. Something like
   * `docs.dev.example.com` will not match `*.example.com`.
   *
   * :::tip
   * Nested wildcards domain patterns are not supported.
   * :::
   *
   * You'll need to add `*.dev.example.com` as an alias.
   */
  domain?: Input<string>;
  /**
   * Route requests matching a specific path prefix.
   *
   * @default `"/"`
   *
   * @example
   *
   * ```ts {3}
   * router: {
   *   instance: router,
   *   path: "/docs"
   * }
   * ```
   */
  path?: Input<string>;
}

/**
 * How a component is served through a router: its route, and how the router
 * reaches it.
 */
export interface RouteArgs extends SiteRouteArgs {
  /**
   * Rewrite the request path.
   *
   * @example
   *
   * If the route path is `/api/*` and a request comes in for `/api/users/profile`,
   * the request path the destination sees is `/api/users/profile`.
   *
   * If you want to serve the route from the root, you can rewrite the request
   * path to `/users/profile`.
   *
   * ```js
   * router: {
   *   instance: router,
   *   path: "/api",
   *   rewrite: {
   *     regex: "^/api/(.*)$",
   *     to: "/$1"
   *   }
   * }
   * ```
   */
  rewrite?: Input<{
    /**
     * The regex to match the request path.
     */
    regex: Input<string>;
    /**
     * The replacement for the matched path.
     */
    to: Input<string>;
  }>;
  /**
   * The number of seconds that CloudFront waits for a response after routing a
   * request to the destination. Must be between 1 and 60 seconds.
   *
   * When compared to the `connectionTimeout`, this is the total time for the
   * request.
   *
   * @default `"20 seconds"`
   * @example
   * ```js
   * router: {
   *   instance: router,
   *   readTimeout: "60 seconds"
   * }
   * ```
   */
  readTimeout?: Input<DurationSeconds>;
  /**
   * The number of seconds that CloudFront should try to maintain the connection
   * to the destination after receiving the last packet of the response. Must be
   * between 1 and 60 seconds.
   *
   * @default `"5 seconds"`
   * @example
   * ```js
   * router: {
   *   instance: router,
   *   keepAliveTimeout: "10 seconds"
   * }
   * ```
   */
  keepAliveTimeout?: Input<DurationSeconds>;
  /**
   * The number of seconds that CloudFront waits before timing out and closing the
   * connection to the origin. Must be between 1 and 10 seconds.
   *
   * @default `"10 seconds"`
   * @example
   * ```js
   * router: {
   *   instance: router,
   *   connectionTimeout: "3 seconds"
   * }
   * ```
   */
  connectionTimeout?: Input<DurationSeconds>;
  /**
   * The number of times that CloudFront attempts to connect to the origin. Must be
   * between 1 and 3.
   *
   * @default `3`
   * @example
   * ```js
   * router: {
   *   instance: router,
   *   connectionAttempts: 1
   * }
   * ```
   */
  connectionAttempts?: Input<number>;
}

/**
 * What a component served through a router needs to know of it: the route,
 * with where the router keeps its routes and its URL, and whether it signs
 * its requests to the component (`signs`). The router has to be a plain
 * value.
 *
 * A `Router` says whether it signs as a plain value, from its settings, so
 * what depends on it can be created directly, or as an output when it's
 * referenced with `get`: from a tag that's looked up, which a preview knows.
 *
 * @param what The route's `instance`, as the start of the error message when
 * it isn't a plain value: `The "router.instance" of the "Web" Astro site`.
 */
export function routeOf(route: RouteArgs, what = `The router's "instance"`) {
  const { instance, ...rest } = route;
  const router = plain(instance, what);
  const signs: boolean | Output<boolean> = router._signs;
  return {
    /** The path it's served under, like `/docs`, without what the router gives. */
    pathPrefix: output(rest.path).apply(pathPrefixOf),
    route: all([rest, router._hasInlineRoutes]).apply(([route, inline]) => {
      if (inline)
        throw new VisibleError(
          `The router has inline "routes", so nothing can be served through it with "router". Add the router's routes with "route()" and "routeBucket()" instead.`,
        );
      const pathPrefix = pathPrefixOf(route.path);
      return {
        hostPattern: route.domain
          ? route.domain
              .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special regex chars
              .replace(/\*/g, ".*") // Replace * with .*
          : undefined,
        pathPrefix,
        routerDistributionId: router.distributionID,
        routerUrl: router.url.apply(
          (url) =>
            (route.domain ? `https://${route.domain}` : url) +
            (pathPrefix ?? ""),
        ),
        routerKvNamespace: router._kvNamespace!,
        routerKvStoreArn: router._kvStoreArn!,
        routerProtection: router._protection,
        routerDistributionArn: router._distributionArn,
        rewrite: route.rewrite,
        readTimeout: route.readTimeout,
        keepAliveTimeout: route.keepAliveTimeout,
        connectionTimeout: route.connectionTimeout,
        connectionAttempts: route.connectionAttempts,
      };
    }),
    signs,
  };
}

// A route's path as the router matches it: `/docs`, from `docs/` or `/docs`
function pathPrefixOf(path?: string) {
  return path ? "/" + path.replace(/^\//, "").replace(/\/$/, "") : undefined;
}
