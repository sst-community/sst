/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "aws-web-function",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
      providers: { aws: { region: "us-east-1" } },
    };
  },
  async run() {
    const api = new sst.aws.WebFunction("Api", {
      entrypoint: "src/server.ts",
      environment: { GREETING: "Hello from a Lambda Web Function" },
      timeout: "30 seconds",
      maxConcurrencyPerEnvironment: 64,
      url: { authorization: "none" },
      dev: {
        command: "npm run dev",
        url: "http://127.0.0.1:3000",
        directory: ".",
      },
    });
    return { url: api.url, arn: api.arn, endpointArn: api.endpointArn };
  },
});
