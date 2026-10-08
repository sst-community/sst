import { describe, beforeAll, beforeEach, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
global.$util = pulumi;

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs): {
      id: string;
      state: any;
    } {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: `${args.name}_id`,
        state: {
          ...args.inputs,
          id: `${args.name}_id`,
          arn: `arn:aws:apigateway:us-east-1::/apis/${args.name}`,
          apiEndpoint: `wss://${args.name}.execute-api.us-east-1.amazonaws.com`,
          executionArn: `arn:aws:execute-api:us-east-1:123456789012:${args.name}`,
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

const AUTHORIZER_TYPE = "aws:apigatewayv2/authorizer:Authorizer";
const ROUTE_TYPE = "aws:apigatewayv2/route:Route";
const FUNCTION_ARN = "arn:aws:lambda:us-east-1:123456789012:function:fn";
const jwt = {
  issuer: "https://accounts.google.com",
  audiences: ["client-id"],
};

// Only the resources of the API named `prefix`, so a test can't see another
// test's resources that are still being registered.
function find(type: string, prefix: string) {
  return createdResources.filter(
    (r) => r.type === type && r.name.startsWith(prefix),
  );
}

async function settle() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("ApiGatewayWebSocket auth", function () {
  let ApiGatewayWebSocket: typeof import("./../../src/components/aws/apigateway-websocket").ApiGatewayWebSocket;
  let ApiGatewayV2: typeof import("./../../src/components/aws/apigatewayv2").ApiGatewayV2;

  beforeAll(async function () {
    ApiGatewayWebSocket = (
      await import("./../../src/components/aws/apigateway-websocket")
    ).ApiGatewayWebSocket;
    ApiGatewayV2 = (await import("./../../src/components/aws/apigatewayv2"))
      .ApiGatewayV2;
  });

  beforeEach(function () {
    createdResources = [];
  });

  it("stops a JWT authorizer before deploying", () => {
    const api = new ApiGatewayWebSocket("JwtAuthorizer");
    expect(() => api.addAuthorizer("Jwt", { jwt })).toThrow(
      'The Jwt authorizer uses "jwt", but API Gateway only supports JWT authorizers on HTTP APIs.',
    );
  });

  it("creates a Lambda authorizer as a REQUEST authorizer", async () => {
    const api = new ApiGatewayWebSocket("LambdaAuthorizer");
    api.addAuthorizer("Lambda", {
      lambda: {
        function: FUNCTION_ARN,
        identitySources: ["route.request.querystring.token"],
      },
    });
    await settle();

    const authorizers = find(AUTHORIZER_TYPE, "LambdaAuthorizer");
    expect(authorizers).toHaveLength(1);
    expect(authorizers[0].inputs.authorizerType).toBe("REQUEST");
    expect(authorizers[0].inputs.identitySources).toEqual([
      "route.request.querystring.token",
    ]);
    expect(authorizers[0].inputs.jwtConfiguration).toBeUndefined();
  });

  it("stops a $connect route with JWT auth before deploying", () => {
    const api = new ApiGatewayWebSocket("JwtRoute");
    expect(() =>
      api.route("$connect", FUNCTION_ARN, {
        auth: { jwt: { authorizer: pulumi.output("authorizer-id") } },
      }),
    ).toThrow(
      'The $connect route uses "auth.jwt", but API Gateway only supports JWT auth on HTTP APIs.',
    );
  });

  it("stops a $connect route with JWT auth given as an output", async () => {
    const api = new ApiGatewayWebSocket("JwtRouteOutput");
    const route = api.route("$connect", FUNCTION_ARN, {
      auth: pulumi.output({ jwt: { authorizer: "authorizer-id" } }),
    });

    // The error is thrown inside an apply, so the route output rejects. Handle
    // the promises Pulumi derives from it too, or they're reported as unhandled.
    const out = route.nodes.route as any;
    out.isKnown.catch(() => {});
    out.isSecret.catch(() => {});
    out.allResources?.().catch(() => {});
    await expect(out.promise()).rejects.toThrow(
      'The $connect route uses "auth.jwt", but API Gateway only supports JWT auth on HTTP APIs.',
    );
  });

  it("gives a $connect route with Lambda auth the CUSTOM type", async () => {
    const api = new ApiGatewayWebSocket("LambdaRoute");
    api.route("$connect", FUNCTION_ARN, {
      auth: { lambda: "authorizer-id" },
    });
    await settle();

    const routes = find(ROUTE_TYPE, "LambdaRoute");
    expect(routes).toHaveLength(1);
    expect(routes[0].inputs.authorizationType).toBe("CUSTOM");
    expect(routes[0].inputs.authorizerId).toBe("authorizer-id");
  });

  it("keeps Lambda auth when a route also has JWT auth, as before", async () => {
    const api = new ApiGatewayWebSocket("LambdaAndJwtRoute");
    api.route("$connect", FUNCTION_ARN, {
      auth: {
        lambda: "authorizer-id",
        jwt: { authorizer: "unused" },
      },
    });
    await settle();

    const routes = find(ROUTE_TYPE, "LambdaAndJwtRoute");
    expect(routes).toHaveLength(1);
    expect(routes[0].inputs.authorizationType).toBe("CUSTOM");
  });

  it("still creates a JWT authorizer on an HTTP API", async () => {
    const api = new ApiGatewayV2("HttpJwt");
    api.addAuthorizer({ name: "Jwt", jwt });
    await settle();

    const authorizers = find(AUTHORIZER_TYPE, "HttpJwt");
    expect(authorizers).toHaveLength(1);
    expect(authorizers[0].inputs.authorizerType).toBe("JWT");
    expect(authorizers[0].inputs.jwtConfiguration).toEqual({
      audiences: ["client-id"],
      issuer: "https://accounts.google.com",
    });
  });
});
