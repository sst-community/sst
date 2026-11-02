import { takeover } from "../../takeover";
import { Router } from "../v5/router";
import { childOf, sstResource } from "./helpers";

// The 4.x `Router` keeps each route of `route()` and `routeBucket()` in a
// component of its own, at the top of the app, named after the router and the
// pattern. The V5 one keeps them inside the router. A route's entries are
// SST's own provider resources, which add their type to their name. Its
// entries in the store take the place of 4.x's, which are released; its line
// in the router's list is still the same kind of resource, and moves.
const URL_ROUTE = "sst:aws:RouterUrlRoute";
const BUCKET_ROUTE = "sst:aws:RouterBucketRoute";
const route = (router: string, pattern?: string) => `${router}Route${pattern}`;

takeover(Router, {
  moved: {
    routesUpdate: (_, { name, id }) =>
      [URL_ROUTE, BUCKET_ROUTE].map((type) =>
        childOf(type, route(name, id), "RoutesUpdate.sst.aws.KvRoutesUpdate"),
      ),
  },
  released: {
    routeKey: (_, { name, id }) =>
      [URL_ROUTE, BUCKET_ROUTE].map((type) =>
        sstResource("KvKeys", childOf(type, route(name, id), "RouteKey")),
      ),
  },
});
