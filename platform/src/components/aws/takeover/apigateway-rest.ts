import { interpolate } from "@pulumi/pulumi";
import { takeover } from "../../takeover";
import { outputId } from "../../component";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { ApiGatewayRest } from "../v5/apigateway-rest";
import { ApiGatewayRestUsagePlan } from "../v5/apigateway-rest-usage-plan";
import { ApiGatewayRestApiKey } from "../v5/apigateway-rest-api-key";
import { childOf } from "./helpers";

// The 4.x `ApiGatewayV1` keeps each route in a component of its own, at the
// top of the app: named after the route's `name`, or a hash of its method
// and path, and of one type for a route to a function and another for a
// route to an integration. The V5 one keeps a route's resources inside the
// API, under its name or the route itself, and says which it was.
const LAMBDA_ROUTE = "sst:aws:ApiGatewayV1LambdaRoute";
const INTEGRATION_ROUTE = "sst:aws:ApiGatewayV1IntegrationRoute";
const route = (
  api: ApiGatewayRest,
  name: string,
  id: string | undefined,
  child: string,
) => {
  const given = api.routeOf(id!);
  if (!given) return undefined;
  const suffix = given.named
    ? logicalName(id!)
    : logicalName(
        hashStringToPrettyString(outputId + given.method + given.path, 6),
      );
  return childOf(
    given.kind === "lambda" ? LAMBDA_ROUTE : INTEGRATION_ROUTE,
    `${name}Route${suffix}`,
    child,
  );
};

// An authorizer was kept the same way, named after a logical name of the
// authorizer's name
const AUTHORIZER = "sst:aws:ApiGatewayV1Authorizer";
const authorizer = (name: string, id: string | undefined, child: string) =>
  childOf(AUTHORIZER, `${name}Authorizer${logicalName(id!)}`, child);

// What CORS added to a path was named after the id of the path's resource in
// AWS, which a move keeps
const cors = (
  api: ApiGatewayRest,
  name: string,
  id: string | undefined,
  kind: string,
) => {
  const resourceId = api.resourceIdOf(id!);
  return resourceId && { name: interpolate`${name}${kind}${resourceId}` };
};

takeover(ApiGatewayRest, {
  moved: {
    logGroup: "accessLog",
    certificate: "ssl",
    handler: (api, { name, id }) => route(api, name, id, "Handler"),
    permission: (api, { name, id }) => route(api, name, id, "Permissions"),
    method: (api, { name, id }) => route(api, name, id, "Method"),
    integration: (api, { name, id }) => route(api, name, id, "Integration"),
    authorizer: (_, { name, id }) => authorizer(name, id, "Authorizer"),
    authorizerFunction: (_, { name, id }) => authorizer(name, id, "Handler"),
    authorizerPermission: (_, { name, id }) =>
      authorizer(name, id, "Permission"),
    corsMethod: (api, { name, id }) => cors(api, name, id, "CorsMethod"),
    corsMethodResponse: (api, { name, id }) =>
      cors(api, name, id, "CorsMethodResponse"),
    corsIntegration: (api, { name, id }) =>
      cors(api, name, id, "CorsIntegration"),
    corsIntegrationResponse: (api, { name, id }) =>
      cors(api, name, id, "CorsIntegrationResponse"),
    corsResponse: (_, { name, id }) => ({ name: `${name}Cors${id}Response` }),
  },
  replaced: {
    // Its triggers are keyed by each route's URN, which the move changes
    deployment:
      "The API is deployed again, once, with the same routes. Its stage moves to the new deployment.",
  },
});

// Each usage plan and API key is a component of its own, at the top of the
// app, as in 4.x. Nothing moved. The maps say the 4.x forms have these 5.0
// forms, so a stage switches them with `sst migrate`, and a new stage refuses
// the 4.x ones.
takeover(ApiGatewayRestUsagePlan, {});
takeover(ApiGatewayRestApiKey, {});
