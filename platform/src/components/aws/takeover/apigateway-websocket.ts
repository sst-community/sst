import { takeover } from "../../takeover";
import { outputId } from "../../component";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { ApiGatewayWebSocket } from "../apigateway-websocket";
import { childOf } from "./helpers";

// The 4.x `ApiGatewayWebSocket` keeps each route in a component of its own,
// next to the API: named after the route's `name`, after the route itself for
// `$connect`, `$disconnect` and `$default`, or after a hash of any other
// route. SST 5's keeps a route's resources inside the API, under its name
// or the route itself, and says which it was.
const ROUTE = "sst:aws:ApiGatewayWebSocketRoute";
const PREDEFINED = ["$connect", "$disconnect", "$default"];
const oldRoute = (api: ApiGatewayWebSocket, name: string, id = "") =>
  `${name}Route${logicalName(
    api.routeIsNamed(id) || PREDEFINED.includes(id)
      ? id
      : hashStringToPrettyString(outputId + id, 6),
  )}`;
const route = (
  api: ApiGatewayWebSocket,
  name: string,
  id: string | undefined,
  child: string,
) => childOf(ROUTE, oldRoute(api, name, id), child);

// An authorizer was kept the same way, named after the authorizer's name as
// it was given: the HTTP API's made a logical name of it, this one didn't.
const AUTHORIZER = "sst:aws:ApiGatewayV2Authorizer";
const authorizer = (api: string, id = "") => `${api}Authorizer${id}`;

takeover(ApiGatewayWebSocket, {
  moved: {
    logGroup: "accessLog",
    certificate: "ssl",
    handler: (api, { name, id }) => route(api, name, id, "Handler"),
    permission: (api, { name, id }) => route(api, name, id, "Permissions"),
    integration: (api, { name, id }) => route(api, name, id, "Integration"),
    route: (api, { name, id }) => route(api, name, id, "Route"),
    authorizer: (_, { name, id }) =>
      childOf(AUTHORIZER, authorizer(name, id), "Authorizer"),
    authorizerFunction: (_, { name, id }) =>
      childOf(AUTHORIZER, authorizer(name, id), "Handler"),
    authorizerPermission: (_, { name, id }) =>
      childOf(AUTHORIZER, authorizer(name, id), "Permission"),
  },
});
