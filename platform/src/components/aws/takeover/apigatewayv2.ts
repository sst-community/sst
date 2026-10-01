import { takeover } from "../../takeover";
import { outputId } from "../../component";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { ApiGatewayV2V5 } from "../apigatewayv2-v5";
import { childOf } from "./helpers";

// `ApiGatewayV2` keeps each route in a component of its own, next to the API.
// There are three kinds, one for each thing a route can send requests to.
// It's named after the route's `name`, or after a hash of the route.
// `ApiGatewayV2V5` keeps a route's resources inside the API, under the
// route's name or the route itself.
const LAMBDA = "sst:aws:ApiGatewayV2LambdaRoute";
const ROUTES = [LAMBDA, "sst:aws:ApiGatewayV2UrlRoute", "sst:aws:ApiGatewayV2PrivateRoute"];
const ROUTE = /^(\$default$|(ANY|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT) \/)/;
const route = (api: string, id = "") => {
  const suffix = ROUTE.test(id) ? hashStringToPrettyString(outputId + id, 6) : id;
  return `${api}Route${logicalName(suffix)}`;
};

// An authorizer was kept the same way, named after the authorizer.
const AUTHORIZER = "sst:aws:ApiGatewayV2Authorizer";
const authorizer = (api: string, id = "") =>
  `${api}Authorizer${logicalName(id)}`;

takeover(ApiGatewayV2V5, {
  from: "sst:aws:ApiGatewayV2",
  moved: {
    logGroup: "accessLog",
    certificate: "ssl",
    handler: (_, { name, id }) => childOf(LAMBDA, route(name, id), "Handler"),
    permission: (_, { name, id }) =>
      childOf(LAMBDA, route(name, id), "Permissions"),
    integration: (_, { name, id }) =>
      ROUTES.map((type) => childOf(type, route(name, id), "Integration")),
    route: (_, { name, id }) =>
      ROUTES.map((type) => childOf(type, route(name, id), "Route")),
    authorizer: (_, { name, id }) =>
      childOf(AUTHORIZER, authorizer(name, id), "Authorizer"),
    authorizerFunction: (_, { name, id }) =>
      childOf(AUTHORIZER, authorizer(name, id), "Handler"),
    authorizerPermission: (_, { name, id }) =>
      childOf(AUTHORIZER, authorizer(name, id), "Permission"),
  },
});
