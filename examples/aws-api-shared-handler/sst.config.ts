/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "aws-api-shared-handler",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const fn = new sst.aws.Function("Backend", { handler: "index.handler" });
    const api = new sst.aws.ApiGatewayV2("MyApi");

    // One invoke permission for every route that uses it.
    const backend = api.addHandler("Backend", fn);
    api.route("GET /items", backend);
    api.route("POST /items", backend);
    api.route("GET /items/{id}", backend);
    api.route("DELETE /items/{id}", backend);

    return { url: api.url, function: fn.name };
  },
});
