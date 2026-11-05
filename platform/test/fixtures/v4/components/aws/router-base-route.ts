import { Input, jsonStringify } from "@pulumi/pulumi";
import { Component } from "../../../../../src/components/component";
import { KvRoutesUpdate } from "./providers/kv-routes-update";
import { KvKeys } from "./providers/kv-keys";
import {
  kvNamespace as buildKvNamespace,
  parsePattern,
} from "../../../../../src/components/aws/router-code";

export { buildKvNamespace, parsePattern };

export interface RouterBaseRouteArgs {
  /**
   * The KV Namespace to use.
   */
  routerNamespace: Input<string>;
  /**
   * The KV Store to use.
   */
  store: Input<string>;
  /**
   * The pattern to match.
   */
  pattern: Input<string>;
}

export function createKvRouteData(
  name: string,
  args: RouterBaseRouteArgs,
  parent: Component,
  routeNs: string,
  data: any,
) {
  new KvKeys(
    `${name}RouteKey`,
    {
      store: args.store,
      namespace: routeNs,
      entries: {
        metadata: jsonStringify(data),
      },
      purge: false,
    },
    { parent },
  );
}

export function updateKvRoutes(
  name: string,
  args: RouterBaseRouteArgs,
  parent: Component,
  routeType: "url" | "bucket" | "site",
  routeNs: string,
  pattern: {
    host: string;
    path: string;
  },
) {
  return new KvRoutesUpdate(
    `${name}RoutesUpdate`,
    {
      store: args.store,
      namespace: args.routerNamespace,
      key: "routes",
      entry: [routeType, routeNs, pattern.host, pattern.path].join(","),
    },
    { parent },
  );
}
