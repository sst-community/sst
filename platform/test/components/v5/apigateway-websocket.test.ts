import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { outputId } from "../../../src/components/component";
import {
  hashStringToPrettyString,
  logicalName,
} from "../../../src/components/naming";

const API = "aws:apigatewayv2/api:Api";
const ROUTE = "aws:apigatewayv2/route:Route";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-function";

const pulumi = mockPulumi({
  state: (args) => {
    // The account already has API Gateway's role for writing logs
    if (args.type === "aws:apigateway/account:Account")
      return {
        cloudwatchRoleArn: "arn:aws:iam::123456789012:role/apigw-logs",
      };
    if (args.type === API)
      return {
        apiEndpoint: "wss://abc123.execute-api.us-east-1.amazonaws.com",
        executionArn: "arn:aws:execute-api:us-east-1:123456789012:abc123",
      };
    if (args.type === "aws:apigatewayv2/domainName:DomainName")
      return {
        domainNameConfiguration: {
          ...args.inputs.domainNameConfiguration,
          targetDomainName: "d-abc.execute-api.us-east-1.amazonaws.com",
          hostedZoneId: "Z1UJRXOUMOOFQ8",
        },
      };
    // What API Gateway invokes a function at, as AWS gives it: the path of
    // the function's ARN, which 4.x wrote out by hand
    if (args.type === "aws:lambda/function:Function")
      return {
        invokeArn: `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:mock:us-east-1:123456789012:${args.name}/invocations`,
      };
    return {};
  },
});

// What 4.x kept in the state and the V5 one doesn't: each route's and
// authorizer's component, with nothing in the cloud behind it. A route was
// named after its name, a predefined route, or a hash of the route.
const routeWrapper = (api: string, suffix: string) =>
  `sst:aws:ApiGatewayWebSocketRoute::${api}Route${suffix}`;
const hashed = (route: string) =>
  logicalName(hashStringToPrettyString(outputId + route, 6));
const authorizerWrapper = (api: string, name: string) =>
  `sst:aws:ApiGatewayV2Authorizer::${api}Authorizer${name}`;

type ApiClass =
  | typeof import("../../fixtures/v4/components/aws/apigateway-websocket").ApiGatewayWebSocket
  | typeof import("../../../src/components/aws/apigateway-websocket").ApiGatewayWebSocket;

describe("ApiGatewayWebSocket", () => {
  let Original: typeof import("../../fixtures/v4/components/aws/apigateway-websocket").ApiGatewayWebSocket;
  let ApiGatewayWebSocket: typeof import("../../../src/components/aws/apigateway-websocket").ApiGatewayWebSocket;
  let Function: typeof import("../../../src/components/aws/function").Function;

  beforeAll(async () => {
    Original = (
      await import("../../fixtures/v4/components/aws/apigateway-websocket")
    ).ApiGatewayWebSocket;
    ApiGatewayWebSocket = (
      await import("../../../src/components/aws/apigateway-websocket")
    ).ApiGatewayWebSocket;
    Function = (await import("../../../src/components/aws/function")).Function;
    await import("../../../src/components/aws/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);

  describe("takes over a deployed ApiGatewayWebSocket", () => {
    pulumi.takeoverCases<ApiClass, ApiClass>({
      original: () => Original,
      v5: () => ApiGatewayWebSocket,
      // The 4.x API's route functions depend on the API. Nothing needs that:
      // what joins a function to the API, its integration and its
      // permission, depends on both and is removed before either.
      needlessOrder: /Function before (MyApi|Other)Api$/,
      cases: {
        "with nothing set": {
          create: (Api, opts) => {
            new Api("MyApi", {}, opts);
          },
          check: () => expect(resource("MyApiApi").type).toBe(API),
        },
        "with the predefined routes, a custom one and a named one": {
          create: (Api, opts) => {
            const api = new Api("MyApi", {}, opts);
            api.route("$connect", "src/connect.handler");
            api.route("$disconnect", "src/disconnect.handler");
            api.route("$default", {
              handler: "src/default.handler",
              memory: "512 MB",
            });
            api.route("sendMessage", "src/send.handler");
            api.route("joinRoom", FUNCTION_ARN, { name: "Join" });
          },
          unclaimed: [
            routeWrapper("MyApi", "Connect"),
            routeWrapper("MyApi", "Disconnect"),
            routeWrapper("MyApi", "Default"),
            routeWrapper("MyApi", hashed("sendMessage")),
            routeWrapper("MyApi", "Join"),
          ],
          check: () =>
            expect(
              pulumi.resources.filter((r) => r.type === ROUTE),
            ).toHaveLength(5),
        },
        // 4.x took an authorizer's name first. The V5 one takes it in the
        // args, and keeps the authorizer by it
        "with a Lambda authorizer on $connect, and IAM on another API": {
          original: (opts) => {
            const api = new Original("MyApi", {}, opts);
            const authorizer = api.addAuthorizer("MyAuthorizer", {
              lambda: {
                function: "src/authorizer.handler",
                identitySources: ["route.request.querystring.token"],
              },
            });
            api.route("$connect", "src/connect.handler", {
              auth: { lambda: authorizer.id },
            });
            new Original("Other", {}, opts).route(
              "$connect",
              "src/connect.handler",
              { auth: { iam: true } },
            );
          },
          v5: (opts) => {
            const api = new ApiGatewayWebSocket("MyApi", {}, opts);
            const authorizer = api.addAuthorizer({
              name: "MyAuthorizer",
              lambda: {
                function: "src/authorizer.handler",
                identitySources: ["route.request.querystring.token"],
              },
            });
            api.route("$connect", "src/connect.handler", {
              auth: { lambda: authorizer.id },
            });
            new ApiGatewayWebSocket("Other", {}, opts).route(
              "$connect",
              "src/connect.handler",
              { auth: { iam: true } },
            );
          },
          unclaimed: [
            authorizerWrapper("MyApi", "MyAuthorizer"),
            routeWrapper("MyApi", "Connect"),
            routeWrapper("Other", "Connect"),
          ],
        },
        // 4.x named an authorizer's component after the name as given
        "with an authorizer whose name isn't a logical name": {
          original: (opts) => {
            const api = new Original("MyApi", {}, opts);
            const authorizer = api.addAuthorizer("my-auth", {
              lambda: { function: "src/authorizer.handler" },
            });
            api.route("$connect", "src/connect.handler", {
              auth: { lambda: authorizer.id },
            });
          },
          v5: (opts) => {
            const api = new ApiGatewayWebSocket("MyApi", {}, opts);
            const authorizer = api.addAuthorizer({
              name: "my-auth",
              lambda: { function: "src/authorizer.handler" },
            });
            api.route("$connect", "src/connect.handler", {
              auth: { lambda: authorizer.id },
            });
          },
          unclaimed: [
            authorizerWrapper("MyApi", "my-auth"),
            routeWrapper("MyApi", "Connect"),
          ],
        },
        // A route called `default` is hashed, and `$default` isn't: each
        // keeps its own
        "with $default beside a default action": {
          create: (Api, opts) => {
            const api = new Api("MyApi", {}, opts);
            api.route("$default", "src/default.handler");
            api.route("default", "src/action.handler");
          },
          unclaimed: [
            routeWrapper("MyApi", "Default"),
            routeWrapper("MyApi", hashed("default")),
          ],
        },
        // 4.x took a domain name it didn't create as `domain.nameId`
        "with a domain name it didn't create": {
          original: (opts) =>
            new Original(
              "MyApi",
              { domain: { nameId: "ws.example.com", path: "v1" } },
              opts,
            ),
          v5: (opts) =>
            new ApiGatewayWebSocket(
              "MyApi",
              {
                domain: { path: "v1" },
                existing: { domainName: "ws.example.com" },
              },
              opts,
            ),
        },
        // 4.x took the routes' functions' transform in `transform.route`
        "with the routes' functions transformed": {
          original: (opts) => {
            const api = new Original(
              "MyApi",
              { transform: { route: { handler: { memory: "512 MB" } } } },
              opts,
            );
            api.route("sendMessage", "src/send.handler");
            return api;
          },
          v5: (opts) =>
            new ApiGatewayWebSocket(
              "MyApi",
              { transform: { handler: { memory: "512 MB" } } },
              opts,
            ).route("sendMessage", "src/send.handler"),
          unclaimed: [routeWrapper("MyApi", hashed("sendMessage"))],
        },
        "with a domain and a path, and access logs kept a week": (
          Api,
          opts,
        ) => {
          new Api(
            "MyApi",
            {
              domain: { name: "ws.example.com", path: "v1" },
              accessLog: { retention: "1 week" },
            },
            opts,
          );
        },
        // 4.x took the access log's transform as `accessLog`, and each
        // route's own transform. The V5 one takes the API's, which every
        // route's goes through.
        "with its resources transformed": {
          original: (opts) => {
            const api = new Original(
              "MyApi",
              {
                transform: {
                  api: { description: "Chat" },
                  stage: (args: any) => {
                    args.defaultRouteSettings = { throttlingRateLimit: 10 };
                  },
                  accessLog: { retentionInDays: 3 },
                },
              },
              opts,
            );
            api.route("sendMessage", "src/send.handler", {
              transform: { route: { operationName: "Send" } },
            });
            return api;
          },
          v5: (opts) =>
            new ApiGatewayWebSocket(
              "MyApi",
              {
                transform: {
                  api: { description: "Chat" },
                  stage: (args: any) => {
                    args.defaultRouteSettings = { throttlingRateLimit: 10 };
                  },
                  logGroup: { retentionInDays: 3 },
                  route: { operationName: "Send" },
                },
              },
              opts,
            ).route("sendMessage", "src/send.handler"),
          unclaimed: [routeWrapper("MyApi", hashed("sendMessage"))],
        },
      },
    });
  });

  // SST 4 gave the routes only a provider passed to the component itself, so
  // one it took from a parent didn't reach them. The 5.0 ones have the
  // component's, so a switch replaces them, as "Switch from" says.
  it("replaces the routes of one that takes its provider from a parent", async () => {
    const { ComponentResource } = await import("@pulumi/pulumi");
    const { Provider } = await import("@pulumi/aws");
    const inParent = (C: any) => {
      const parent = new ComponentResource(
        "test:index:Parent",
        "Parent",
        {},
        {
          providers: { aws: new Provider("East", { region: "us-east-1" }) },
        },
      );
      new C("MyApi", {}, { parent }).route("$connect", "src/connect.handler");
    };
    const result = await pulumi.takesOver(
      () => inParent(Original),
      () => inParent(ApiGatewayWebSocket),
    );
    const replaced = result.changed
      .filter((c) => c.fields.includes("options.provider"))
      .map((c) => c.name);
    expect(replaced).toContain("MyApiRouteConnectRoute");
    expect(replaced).toContain("MyApiRouteConnectHandlerLogGroup");
  });

  it("serves at its stage, and manages connections at its HTTPS endpoint", async () => {
    const api = new ApiGatewayWebSocket("MyApi");
    await pulumi.settle();
    expect(await pulumi.resolve(api.url)).toBe(
      "wss://abc123.execute-api.us-east-1.amazonaws.com/$default",
    );
    expect(await pulumi.resolve(api.managementEndpoint)).toBe(
      "https://abc123.execute-api.us-east-1.amazonaws.com/$default",
    );
    expect(api.nodes.domainName).toBeUndefined();
  });

  it("keeps each route's resources inside the API, by its name or the route", async () => {
    const api = new ApiGatewayWebSocket("MyApi");
    api.route("$connect", "src/connect.handler");
    api.route("sendMessage", "src/send.handler");
    api.route("joinRoom", "src/join.handler", { name: "Join" });
    await pulumi.settle();
    expect(Object.keys(api.nodes.route).sort()).toEqual([
      "$connect",
      "Join",
      "sendMessage",
    ]);
    expect(names()).toContain("MyApiRouteSendMessage");
    // A route that isn't a name only of letters and numbers is told apart
    // from one that is with a hash: `$connect` from `connect`
    expect(names().some((n) => /^MyApiHandlerConnect\w+$/.test(n))).toBe(true);
  });

  // SST 4 took the authorizer's name first; the HTTP and REST APIs take it in
  // the args, and so does this one now
  it("turns down an authorizer's name given first, with the call to write", async () => {
    const api = new ApiGatewayWebSocket("MyApi");
    expect(() =>
      // @ts-expect-error
      api.addAuthorizer("MyAuthorizer", {
        lambda: { function: "src/authorizer.handler" },
      }),
    ).toThrow(
      'An authorizer of the "MyApi" API is given its name in its args, like the HTTP and REST APIs\' authorizers: api.addAuthorizer({ name: "MyAuthorizer", lambda: { function: "src/authorizer.handler" } }).',
    );
    const authorizer = api.addAuthorizer({
      name: "MyAuthorizer",
      lambda: { function: "src/authorizer.handler" },
    });
    expect(api.nodes.authorizer.MyAuthorizer).toBe(authorizer);
    expect(() =>
      api.addAuthorizer({
        name: "MyAuthorizer",
        lambda: { function: "src/other.handler" },
      }),
    ).toThrow(/"MyApi" already has an authorizer named "MyAuthorizer"/);
    await pulumi.settle();
    expect(names()).toEqual(
      expect.arrayContaining([
        "MyApiAuthorizerMyAuthorizer",
        "MyApiAuthorizerFunctionMyAuthorizer",
        "MyApiAuthorizerPermissionMyAuthorizer",
      ]),
    );
  });

  it("turns down what API Gateway doesn't take on a WebSocket API", () => {
    const api = new ApiGatewayWebSocket("MyApi");
    expect(() =>
      api.addAuthorizer({
        name: "Jwt",
        // @ts-expect-error
        jwt: { issuer: "https://issuer", audiences: ["a"] },
        lambda: { function: "src/authorizer.handler" },
      }),
    ).toThrow(
      /"jwt" isn't an option for the "Jwt" authorizer of the "MyApi" API/,
    );
    expect(() =>
      api.addAuthorizer({
        name: "Payload",
        lambda: {
          function: "src/authorizer.handler",
          // @ts-expect-error
          payload: "2.0",
        },
      }),
    ).toThrow(
      /"payload" isn't an option for the "lambda" of the "Payload" authorizer of the "MyApi" API/,
    );
    expect(() =>
      // @ts-expect-error
      api.addAuthorizer({ name: "None" }),
    ).toThrow(
      /The "None" authorizer of the "MyApi" API has no "lambda". A WebSocket API's authorizer is a Lambda authorizer/,
    );
    expect(() =>
      api.route("$connect", "src/connect.handler", {
        // @ts-expect-error
        auth: { jwt: { authorizer: "abc" } },
      }),
    ).toThrow(
      /The "\$connect" route of the "MyApi" API uses "auth.jwt", but API Gateway only supports JWT auth on HTTP APIs/,
    );
    expect(
      () =>
        new ApiGatewayWebSocket("Other", {
          // @ts-expect-error
          transform: { route: { handler: { memory: "1 GB" } } },
        }),
    ).toThrow(
      /"transform.route.handler" isn't an option for the "Other" API. "transform.route" changes each route's API Gateway route/,
    );
    // SST 4's transform of the access log, refused before the component
    // turns it down as a part it doesn't have
    expect(
      () =>
        new ApiGatewayWebSocket("Logs", {
          // @ts-expect-error
          transform: { accessLog: { retentionInDays: 3 } },
        }),
    ).toThrow(
      /"transform.accessLog" isn't an option for the "Logs" API. Transform the access log in "transform.logGroup"/,
    );
    expect(
      () =>
        new ApiGatewayWebSocket("Existing", {
          accessLog: { retention: "1 week" },
          existing: { logGroup: "/aws/vendedlogs/apis/mine" },
        }),
    ).toThrow(/is given an existing "logGroup", which it uses the way it is/);
    expect(
      () =>
        new ApiGatewayWebSocket("Certificate", {
          existing: { certificate: {} as any },
        }),
    ).toThrow(
      /"existing.certificate" isn't an option for the "Certificate" API/,
    );
    expect(
      () =>
        new ApiGatewayWebSocket("Third", {
          // @ts-expect-error
          domain: output("ws.example.com"),
        }),
    ).toThrow(/"domain"/);
  });

  it("invokes a route's function at its invoke ARN, and maps its domain to its stage", async () => {
    const api = new ApiGatewayWebSocket("MyApi", {
      domain: "ws.example.com",
    }).route("sendMessage", FUNCTION_ARN);
    await pulumi.settle();
    expect(
      await pulumi.resolve(api.nodes.integration.sendMessage.integrationUri),
    ).toBe(
      `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${FUNCTION_ARN}/invocations`,
    );
    expect(pulumi.dependsOn("MyApiDomainMapping", "MyApiStage")).toBe(true);
  });

  it("can be linked by a function, which may manage connections", async () => {
    const api = new ApiGatewayWebSocket("MyApi");
    new Function("Api", { handler: "src/api.handler", link: [api] });
    await pulumi.settle();
    const policy = JSON.stringify(
      await pulumi.resolve(resource("ApiRole").inputs.inlinePolicies),
    );
    expect(policy).toContain("execute-api:ManageConnections");
    expect(policy).toContain("@connections");
  });
});
