import { takeover } from "../../takeover";
import { Router } from "../v5/router";
import { childOf } from "./helpers";

// The 4.x `Router` keeps each route of `route()` and `routeBucket()` in a
// component of its own, at the top of the app, named after the router and the
// pattern. The V5 one keeps them inside the router. A route's entries are
// SST's own provider resources, which add their type to their name.
const URL_ROUTE = "sst:aws:RouterUrlRoute";
const BUCKET_ROUTE = "sst:aws:RouterBucketRoute";
const route = (router: string, pattern?: string) => `${router}Route${pattern}`;

takeover(Router, {
  moved: {
    routeKey: (_, { name, id }) =>
      [URL_ROUTE, BUCKET_ROUTE].map((type) =>
        childOf(type, route(name, id), "RouteKey.sst.aws.KvKeys"),
      ),
    routesUpdate: (_, { name, id }) =>
      [URL_ROUTE, BUCKET_ROUTE].map((type) =>
        childOf(type, route(name, id), "RoutesUpdate.sst.aws.KvRoutesUpdate"),
      ),
  },
});
