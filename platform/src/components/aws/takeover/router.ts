import { sstResource, takeover } from "../../takeover";
import { Router } from "../router";
import { childOf } from "./helpers";

// The 4.x `Router` keeps each route of `route()` and `routeBucket()` in a
// component of its own, at the top of the app, named after the router and the
// pattern. SST 5's keeps them inside the router. A route's entries in the
// store and its line in the router's list were SST's own dynamic resources,
// which add their kind to their name: the ones that take their place write
// them again, and 4.x's are released.
const URL_ROUTE = "sst:aws:RouterUrlRoute";
const BUCKET_ROUTE = "sst:aws:RouterBucketRoute";
const route = (router: string, pattern?: string) => `${router}Route${pattern}`;

takeover(Router, {
  released: {
    routeKey: (_, { name, id }) =>
      [URL_ROUTE, BUCKET_ROUTE].map((type) =>
        sstResource("aws.KvKeys", childOf(type, route(name, id), "RouteKey")),
      ),
    routesUpdate: (_, { name, id }) =>
      [URL_ROUTE, BUCKET_ROUTE].map((type) =>
        sstResource(
          "aws.KvRoutesUpdate",
          childOf(type, route(name, id), "RoutesUpdate"),
        ),
      ),
  },
});
