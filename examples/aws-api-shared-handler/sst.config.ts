/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return { name: "aws-api-shared-handler", home: "aws", removal: "remove" };
  },
  async run() {
    const phase = process.env.PERMISSIONS_PHASE ?? "shared";
    if (!["legacy", "shared"].includes(phase))
      throw new Error("PERMISSIONS_PHASE must be legacy or shared");
    const count = Number(process.env.ROUTE_COUNT ?? 60);
    if (!Number.isInteger(count) || count < 1)
      throw new Error("ROUTE_COUNT must be a positive integer");
    const fn = new sst.aws.Function("Backend", { handler: "index.handler" });
    const http = new sst.aws.ApiGatewayV2("Http");
    const rest = new sst.aws.ApiGatewayV1("Rest");
    const ws = new sst.aws.ApiGatewayWebSocket("WebSocket");
    // Each named handler owns one grant; route dependencies order the handover.
    const httpHandler =
      phase === "legacy" ? undefined : http.addHandler("Backend", fn.arn);
    const restHandler =
      phase === "legacy" ? undefined : rest.addHandler("Backend", fn.arn);
    const wsHandler =
      phase === "legacy" ? undefined : ws.addHandler("Backend", fn.arn);
    for (let i = 0; i < count; i++) {
      http.route(`GET /items-${i}`, phase === "shared" ? httpHandler! : fn.arn);
      rest.route(`GET /items-${i}`, phase === "shared" ? restHandler! : fn.arn);
    }
    rest.deploy();
    ws.route("$connect", phase === "shared" ? wsHandler! : fn.arn);
    ws.route("$disconnect", phase === "shared" ? wsHandler! : fn.arn);
    const message = ws.route(
      "$default",
      phase === "shared" ? wsHandler! : fn.arn,
      {
        transform: { route: { routeResponseSelectionExpression: "$default" } },
      },
    );
    // Return the Lambda's echo so verification exercises invocation, not just connection setup.
    new aws.apigatewayv2.RouteResponse("MessageResponse", {
      apiId: ws.nodes.api.id,
      routeId: message.nodes.route.id,
      routeResponseKey: "$default",
    });
    return {
      http: http.url,
      rest: rest.url,
      ws: ws.url,
      function: fn.name,
      region: fn.arn.apply((arn) => arn.split(":")[3]),
      count,
    };
  },
});
