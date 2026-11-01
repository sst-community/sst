import { Input, Output } from "@pulumi/pulumi";
import { DurationSeconds } from "../../duration";
import { Router as OriginalRouter, normalizeRouteArgs } from "../router";

/**
 * A `Router` a V5 component can be served through. There's no V5 `Router`
 * yet, so it's the 4.x one; a V5 one joins it here.
 */
export type AnyRouter = OriginalRouter;

export interface RouteArgs {
  /**
   * The `Router` component to use for routing requests.
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
   * You can attach it to the Router, instead of creating a standalone CloudFront
   * distribution.
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
 * What a component served through a router needs to know of it: where its
 * routes are kept, its URL, and whether it signs its requests to the
 * component (`signs`). Whether it signs comes from the router's settings, so
 * a preview knows it.
 */
export function routeOf(route: RouteArgs) {
  const normalized = normalizeRouteArgs(route)!;
  return {
    route: normalized,
    signs: normalized.routerProtection.apply(
      (p) => p?.mode === "oac" || p?.mode === "oac-with-edge-signing",
    ) as Output<boolean>,
  };
}
