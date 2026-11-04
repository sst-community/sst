import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { outputId } from "../../../src/components/component";
import {
  hashStringToPrettyString,
  logicalName,
} from "../../../src/components/naming";

const API = "aws:apigateway/restApi:RestApi";
const METHOD = "aws:apigateway/method:Method";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-function";
const USER_POOL =
  "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc";

const pulumi = mockPulumi({
  state: (args) => {
    // The account already has API Gateway's role for writing logs, but
    // where an API named NoRole reads it
    if (args.type === "aws:apigateway/account:Account")
      return {
        cloudwatchRoleArn: args.name.startsWith("NoRole")
          ? ""
          : "arn:aws:iam::123456789012:role/apigw-logs",
      };
    if (args.type === API)
      return {
        rootResourceId: "root123",
        executionArn: "arn:aws:execute-api:us-east-1:123456789012:abc123",
      };
    if (args.type === "aws:apigateway/domainName:DomainName")
      return {
        cloudfrontDomainName: "d111.cloudfront.net",
        cloudfrontZoneId: "Z2FDTNDATAQYW2",
        regionalDomainName: "d-abc.execute-api.us-east-1.amazonaws.com",
        regionalZoneId: "Z1UJRXOUMOOFQ8",
      };
    return {};
  },
  // The region is the provider's, as AWS answers: the cases' provider of
  // another region is in us-west-2
  call: (args) =>
    args.token === "aws:index/getRegion:getRegion" &&
    String(args.provider ?? "").includes("::West::")
      ? { name: "us-west-2", region: "us-west-2", id: "us-west-2" }
      : undefined,
});

// What 4.x kept in the state and the V5 one doesn't: each route's and
// authorizer's component, with nothing in the cloud behind it. A route was
// named after its name, or a hash of its method and path.
const hashed = (method: string, path: string) =>
  logicalName(hashStringToPrettyString(outputId + method + path, 6));
const lambdaRoute = (api: string, suffix: string) =>
  `sst:aws:ApiGatewayV1LambdaRoute::${api}Route${suffix}`;
const integrationRoute = (api: string, suffix: string) =>
  `sst:aws:ApiGatewayV1IntegrationRoute::${api}Route${suffix}`;
const authorizerWrapper = (api: string, name: string) =>
  `sst:aws:ApiGatewayV1Authorizer::${api}Authorizer${logicalName(name)}`;
// Whenever a route moves, the deployment is made again
const redeployed: [string, string[]][] = [["MyApiDeployment", ["triggers"]]];

type ApiClass =
  | typeof import("../../../src/components/aws/apigatewayv1").ApiGatewayV1
  | typeof import("../../../src/components/aws/v5/apigateway-rest").ApiGatewayRest;

describe("ApiGatewayRest", () => {
  let Original: typeof import("../../../src/components/aws/apigatewayv1").ApiGatewayV1;
  let ApiGatewayRest: typeof import("../../../src/components/aws/v5/apigateway-rest").ApiGatewayRest;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;

  beforeAll(async () => {
    Original = (await import("../../../src/components/aws/apigatewayv1"))
      .ApiGatewayV1;
    ApiGatewayRest = (
      await import("../../../src/components/aws/v5/apigateway-rest")
    ).ApiGatewayRest;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
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

  describe("takes over a deployed ApiGatewayV1", () => {
    pulumi.takeoverCases<ApiClass, ApiClass>({
      original: () => Original,
      v5: () => ApiGatewayRest,
      // A 4.x route's function depends on the API. Nothing needs that: what
      // joins a function to the API, its integration and its permission,
      // depends on both and is removed before either. And a 4.x route took
      // its function's args, with their links, as its own, so its permission
      // waited on what the function links to, which nothing needs either.
      needlessOrder: /Function before MyApiApi$|Permission\w+ before MyBucket/,
      // The deployment's triggers are keyed by what it's made of, which moves
      changed: redeployed,
      cases: {
        "not deployed": {
          create: (Api, opts) => {
            new Api("MyApi", {}, opts);
          },
          changed: [],
          check: () => expect(resource("MyApiApi").type).toBe(API),
        },
        "deployed with nothing in it": (Api, opts) => {
          new Api("MyApi", {}, opts).deploy();
        },
        "with routes to functions, by name and by route, with CORS": {
          create: (Api, opts) => {
            const api = new Api("MyApi", {}, opts);
            api.route("GET /", "src/get.handler");
            api.route("post /notes", {
              handler: "src/post.handler",
              memory: "512 MB",
            });
            api.route("GET /notes/{id}", "src/note.handler");
            api.route("ANY /{proxy+}", FUNCTION_ARN);
            api.route("GET /notes/{id}/files", "src/files.handler", {
              name: "Files",
            });
            api.deploy();
          },
          unclaimed: [
            lambdaRoute("MyApi", hashed("GET", "/")),
            lambdaRoute("MyApi", hashed("POST", "/notes")),
            lambdaRoute("MyApi", hashed("GET", "/notes/{id}")),
            lambdaRoute("MyApi", hashed("ANY", "/{proxy+}")),
            lambdaRoute("MyApi", "Files"),
          ],
          check: () => {
            expect(
              pulumi.resources.filter(
                (r) => r.type === METHOD && r.inputs.httpMethod === "OPTIONS",
              ),
            ).toHaveLength(5);
          },
        },
        "with a route whose function is linked to a bucket": {
          create: async (Api, opts) => {
            const { Bucket } = await import(
              "../../../src/components/aws/v5/bucket"
            );
            const bucket = new Bucket("MyBucket");
            const api = new Api("MyApi", {}, opts);
            api.route("GET /", { handler: "src/get.handler", link: [bucket] });
            api.deploy();
          },
          unclaimed: [lambdaRoute("MyApi", hashed("GET", "/"))],
        },
        // 4.x also took a route's own `streaming`, which the V5 one
        // refuses: the function streams
        "with a streaming route, without CORS": {
          original: (opts) => {
            const api = new Original("MyApi", { cors: false }, opts);
            api.route("GET /stream", {
              handler: "src/stream.handler",
              streaming: true,
            });
            api.route("GET /told", "src/told.handler", { streaming: true });
            api.deploy();
          },
          v5: (opts) => {
            const api = new ApiGatewayRest("MyApi", { cors: false }, opts);
            api.route("GET /stream", {
              handler: "src/stream.handler",
              streaming: true,
            });
            api.route("GET /told", {
              handler: "src/told.handler",
              streaming: true,
            });
            api.deploy();
          },
          unclaimed: [
            lambdaRoute("MyApi", hashed("GET", "/stream")),
            lambdaRoute("MyApi", hashed("GET", "/told")),
          ],
        },
        "with a route to an integration": {
          create: (Api, opts) => {
            const api = new Api("MyApi", {}, opts);
            api.routeIntegration("POST /run", {
              type: "aws",
              uri: "arn:aws:apigateway:us-east-1:states:startExecution",
              integrationHttpMethod: "POST",
              requestTemplates: { "application/json": "{}" },
              passthroughBehavior: "when-no-match",
            });
            api.routeIntegration(
              "GET /mock",
              { type: "mock" },
              { name: "Mocked" },
            );
            api.deploy();
          },
          unclaimed: [
            integrationRoute("MyApi", hashed("POST", "/run")),
            integrationRoute("MyApi", "Mocked"),
          ],
        },
        "with authorizers, auth and API keys on the routes": {
          create: (Api, opts) => {
            const api = new Api("MyApi", {}, opts);
            const token = api.addAuthorizer({
              name: "myToken",
              tokenFunction: "src/token.handler",
              ttl: 60,
            });
            const request = api.addAuthorizer({
              name: "MyRequest",
              requestFunction: { handler: "src/request.handler" },
              identitySource: "method.request.header.Authorization",
            });
            const pool = api.addAuthorizer({
              name: "Pool",
              userPools: [USER_POOL],
            });
            api.route("GET /a", "src/a.handler", {
              auth: { custom: token.id },
            });
            api.route("GET /b", "src/b.handler", {
              auth: { custom: request.id },
              apiKey: true,
            });
            api.route("GET /c", "src/c.handler", {
              auth: { cognito: { authorizer: pool.id, scopes: ["read"] } },
            });
            api.route("GET /d", "src/d.handler", { auth: { iam: true } });
            api.deploy();
          },
          unclaimed: [
            authorizerWrapper("MyApi", "myToken"),
            authorizerWrapper("MyApi", "MyRequest"),
            authorizerWrapper("MyApi", "Pool"),
            lambdaRoute("MyApi", hashed("GET", "/a")),
            lambdaRoute("MyApi", hashed("GET", "/b")),
            lambdaRoute("MyApi", hashed("GET", "/c")),
            lambdaRoute("MyApi", hashed("GET", "/d")),
          ],
        },
        "with a usage plan and an API key": {
          create: (Api, opts) => {
            const api = new Api("MyApi", {}, opts);
            api.route("GET /", "src/get.handler", { apiKey: true });
            api.deploy();
            api
              .addUsagePlan("MyPlan", {
                throttle: { rate: 100, burst: 200 },
                quota: { limit: 1000, period: "month", offset: 0 },
              })
              .addApiKey("MyKey", {
                value: "d41d8cd98f00b204e9800998ecf8427e",
              });
          },
          unclaimed: [lambdaRoute("MyApi", hashed("GET", "/"))],
          check: () => {
            expect(resource("MyPlanUsagePlan").type).toBe(
              "aws:apigateway/usagePlan:UsagePlan",
            );
            expect(resource("MyKeyUsagePlanKey")).toBeDefined();
          },
        },
        "with a domain on an edge endpoint": (Api, opts) => {
          new Api("MyApi", { domain: "api.example.com" }, opts).deploy();
        },
        "with a regional endpoint, a domain with a path, and access logs kept a week":
          (Api, opts) => {
            new Api(
              "MyApi",
              {
                endpoint: { type: "regional" },
                domain: { name: "api.example.com", path: "v1" },
                accessLog: { retention: "1 week" },
              },
              opts,
            ).deploy();
          },
        "with a private endpoint": (Api, opts) => {
          new Api(
            "MyApi",
            {
              endpoint: {
                type: "private",
                vpcEndpointIds: ["vpce-0dccab6fb1e828f36"],
              },
            },
            opts,
          ).deploy();
        },
        // 4.x took a domain name it didn't create as `domain.nameId`
        "with a domain name it didn't create": {
          original: (opts) =>
            new Original(
              "MyApi",
              { domain: { name: "", nameId: "api.example.com", path: "v1" } },
              opts,
            ).deploy(),
          v5: (opts) =>
            new ApiGatewayRest(
              "MyApi",
              {
                domain: { path: "v1" },
                existing: { domainName: "api.example.com" },
              },
              opts,
            ).deploy(),
        },
        // 4.x took the access log's transform as `accessLog`, the routes'
        // functions' as `route.handler`, and each route's own. The V5 one
        // takes the API's, which every route's goes through.
        "with its resources transformed": {
          original: (opts) => {
            const api = new Original(
              "MyApi",
              {
                transform: {
                  api: { description: "Notes" },
                  stage: (args: any) => {
                    args.xrayTracingEnabled = true;
                  },
                  deployment: { description: "Routes" },
                  accessLog: { retentionInDays: 3 },
                  route: { handler: { memory: "512 MB" } },
                },
              },
              opts,
            );
            api.route("GET /", "src/get.handler", {
              transform: {
                method: { operationName: "Get" },
                integration: { timeoutMilliseconds: 5000 },
              },
            });
            api.deploy();
            return api;
          },
          v5: (opts) =>
            new ApiGatewayRest(
              "MyApi",
              {
                transform: {
                  api: { description: "Notes" },
                  stage: (args: any) => {
                    args.xrayTracingEnabled = true;
                  },
                  deployment: { description: "Routes" },
                  logGroup: { retentionInDays: 3 },
                  handler: { memory: "512 MB" },
                  method: { operationName: "Get" },
                  integration: { timeoutMilliseconds: 5000 },
                },
              },
              opts,
            )
              .route("GET /", "src/get.handler")
              .deploy(),
          unclaimed: [lambdaRoute("MyApi", hashed("GET", "/"))],
        },
      },
    });
  });

  it("serves at its stage once deployed, and at its domain's path", async () => {
    const api = new ApiGatewayRest("MyApi");
    expect(api.nodes.stage).toBeUndefined();
    api.deploy();
    await pulumi.settle();
    expect(await pulumi.resolve(api.url)).toBe(
      "https://MyApiApi_id.execute-api.us-east-1.amazonaws.com/test/",
    );
    expect(api.nodes.domainName).toBeUndefined();

    pulumi.reset();
    const withDomain = new ApiGatewayRest("MyApi", {
      domain: { name: "api.example.com", path: "v1" },
    }).deploy();
    await pulumi.settle();
    expect(await pulumi.resolve(withDomain.url)).toBe(
      "https://api.example.com/v1/",
    );
  });

  it("keeps each route inside the API, by its name or the route, and each path's resource by SST 4's hash", async () => {
    const api = new ApiGatewayRest("MyApi");
    api.route("get /notes/{id}", "src/get.handler");
    api.route("POST /notes", "src/post.handler", { name: "Create" });
    api.routeIntegration("GET /mock", { type: "mock" });
    api.deploy();
    await pulumi.settle();
    expect(Object.keys(api.nodes.method).sort()).toEqual([
      "Create",
      "GET /mock",
      "GET /notes/{id}",
    ]);
    expect(Object.keys(api.nodes.handler).sort()).toEqual([
      "Create",
      "GET /notes/{id}",
    ]);
    // SST 4 hashed the text an output joins as, and the path
    const hash = (path: string) =>
      logicalName(hashStringToPrettyString([output("")].join("") + path, 6));
    expect(Object.keys(api.nodes.resource).sort()).toEqual(
      [hash("/notes"), hash("/notes/{id}"), hash("/mock")].sort(),
    );
    // CORS on each path with a route, not on the paths between
    expect(Object.keys(api.nodes.corsMethod).sort()).toEqual([
      "/mock",
      "/notes",
      "/notes/{id}",
    ]);
    expect(Object.keys(api.nodes.corsResponse)).toEqual(["4XX", "5XX"]);
    expect(names()).toContain("MyApiHandlerCreate");
  });

  it("makes an edge API's certificate in us-east-1, with its own provider elsewhere", async () => {
    new ApiGatewayRest("MyApi", { domain: "api.example.com" }).deploy();
    await pulumi.settle();
    const providerOf = (name: string) => JSON.stringify(resource(name).options);
    expect(providerOf("MyApiCertificate")).not.toContain("AwsProvider.sst");

    pulumi.reset();
    const { Provider } = await import("@pulumi/aws");
    new ApiGatewayRest(
      "MyApi",
      { domain: "api.example.com" },
      { provider: new Provider("West", { region: "us-west-2" }) },
    ).deploy();
    await pulumi.settle();
    expect(providerOf("MyApiCertificate")).toContain(
      "AwsProvider.sst.us-east-1",
    );

    // An API with a provider of its own in us-east-1 makes it with that one
    pulumi.reset();
    new ApiGatewayRest(
      "MyApi",
      { domain: "api.example.com" },
      { provider: new Provider("East", { region: "us-east-1" }) },
    ).deploy();
    await pulumi.settle();
    expect(providerOf("MyApiCertificate")).not.toContain("AwsProvider.sst");
  });

  it("turns down a route after deploy(), a second deploy(), and a usage plan before it", () => {
    const api = new ApiGatewayRest("MyApi");
    expect(() => api.addUsagePlan("Plan", {})).toThrow(
      /The "Plan" usage plan is added to the "MyApi" API before "deploy\(\)"/,
    );
    api.route("GET /", "src/get.handler");
    expect(() => api.route("GET /", "src/other.handler")).toThrow(
      /already has a route/,
    );
    api.deploy();
    expect(() => api.route("GET /late", "src/late.handler")).toThrow(
      /after "deploy\(\)"/,
    );
    expect(() => api.deploy()).toThrow(/already deployed/);
  });

  it("turns down SST 4's transforms, with what to write", () => {
    expect(
      () =>
        new ApiGatewayRest("A", {
          // @ts-expect-error
          transform: { route: { handler: { memory: "1 GB" } } },
        }),
    ).toThrow(
      /"transform.route" isn't an option for the "A" API. To change the routes' functions, use "transform.handler".*"transform.method"/,
    );
    expect(
      () =>
        // @ts-expect-error
        new ApiGatewayRest("B", { transform: { accessLog: {} } }),
    ).toThrow(
      /"transform.accessLog" isn't an option for the "B" API. Transform the access log in "transform.logGroup"/,
    );
    const api = new ApiGatewayRest("C");
    expect(() =>
      api.route("GET /", "src/get.handler", {
        // @ts-expect-error
        transform: { method: {} },
      }),
    ).toThrow(/"transform"/);
    expect(() =>
      api.addAuthorizer({
        name: "Auth",
        tokenFunction: "src/auth.handler",
        // @ts-expect-error
        transform: { authorizer: {} },
      }),
    ).toThrow(/"transform"/);
  });

  it("turns down a route's own streaming: its function streams", async () => {
    const api = new ApiGatewayRest("MyApi");
    expect(() =>
      api.route("GET /", "src/get.handler", { streaming: true } as any),
    ).toThrow(
      /"streaming" isn't an option for the "GET \/" route of the "MyApi" API. Set "streaming: true" on the route's function/,
    );
    expect(() =>
      api.routeIntegration("GET /mock", { type: "mock" }, {
        streaming: true,
      } as any),
    ).toThrow(/Only a route to a function streams/);
    api.route("GET /stream", {
      handler: "src/stream.handler",
      streaming: true,
    });
    api.route("GET /buffered", "src/buffered.handler");
    api.deploy();
    await pulumi.settle();
    expect(
      await pulumi.resolve([
        api.nodes.integration["GET /stream"].responseTransferMode,
        api.nodes.integration["GET /buffered"].responseTransferMode,
      ]),
    ).toEqual(["STREAM", "BUFFERED"]);
  });

  it("reports its URL when deploy() is called after the config waits for something", async () => {
    const api = new ApiGatewayRest("MyApi");
    api.route("GET /", "src/get.handler");
    await new Promise((resolve) => setTimeout(resolve, 50));
    api.deploy();
    await pulumi.settle();
    expect(await pulumi.resolve(pulumi.reportOf("MyApi")?.hint)).toBe(
      "https://MyApiApi_id.execute-api.us-east-1.amazonaws.com/test/",
    );

    // One that's never deployed reports nothing, as SST 4's
    pulumi.reset();
    new ApiGatewayRest("Idle");
    await pulumi.settle();
    expect(pulumi.reportOf("Idle")).toBeUndefined();
  });

  it("sets up API Gateway's account with the API's provider, when it has no role", async () => {
    const { Provider } = await import("@pulumi/aws");
    const west = new Provider("West", { region: "us-west-2" });
    class Parent extends (await import("@pulumi/pulumi")).ComponentResource {
      constructor(name: string) {
        super("test:Parent", name, {}, { providers: [west] });
      }
    }
    new ApiGatewayRest("NoRoleApi", {}, { parent: new Parent("Parent") });
    await pulumi.settle();
    const accounts = pulumi.resources.filter(
      (r) => r.type === "aws:apigateway/account:Account",
    );
    expect(accounts.map((r) => [r.name, r.kind])).toEqual([
      ["NoRoleApiAPIGatewayAccount", "read"],
      ["NoRoleApiAPIGatewayAccountSetup", "register"],
    ]);
    for (const account of accounts)
      expect(JSON.stringify(account.options)).toContain("::West::");
    expect(resource("NoRoleApiAPIGatewayAccountSetup").options).toMatchObject({
      retainOnDelete: true,
    });
    expect(resource("APIGatewayPushToCloudWatchLogsRole")).toBeDefined();
    // The API waits for it
    expect(
      pulumi.dependsOn("NoRoleApiApi", "NoRoleApiAPIGatewayAccountSetup"),
    ).toBe(true);

    // With a role, nothing is set up
    pulumi.reset();
    new ApiGatewayRest("MyApi");
    await pulumi.settle();
    expect(names()).not.toContain("MyApiAPIGatewayAccountSetup");
  });

  it("turns down an existing resource it wouldn't use", async () => {
    expect(
      () =>
        new ApiGatewayRest("Logs", {
          accessLog: { retention: "1 week" },
          existing: { logGroup: "/aws/vendedlogs/apis/mine" },
        }),
    ).toThrow(
      /The "Logs" API is given an existing "logGroup", which it uses the way it is. Remove "accessLog"/,
    );
    expect(
      () =>
        new ApiGatewayRest("Certificate", {
          existing: { certificate: {} as any },
        }),
    ).toThrow(
      /"existing.certificate" isn't an option for the "Certificate" API/,
    );
    expect(
      () =>
        new ApiGatewayRest("Named", {
          domain: { name: "api.example.com" },
          existing: { domainName: "api.example.com" },
        }),
    ).toThrow(/is given an existing "domainName", so it doesn't create one/);
    await pulumi.settle();
  });

  it("turns down what decides what's created given as an output", () => {
    for (const [arg, value] of [
      ["domain", output("api.example.com")],
      ["endpoint", output({ type: "regional" })],
      ["cors", output(false)],
    ] as const)
      expect(
        () => new ApiGatewayRest(`Api${arg}`, { [arg]: value } as any),
        arg,
      ).toThrow(new RegExp(`"${arg}"`));
    expect(
      () => new ApiGatewayRest("Private", { endpoint: { type: "private" } }),
    ).toThrow(/needs the IDs of its VPC endpoints/);
  });

  it("turns down an authorizer with none of its kinds, or two", () => {
    const api = new ApiGatewayRest("MyApi");
    expect(() => api.addAuthorizer({ name: "None" })).toThrow(
      /The "None" authorizer of the "MyApi" API is given none of "requestFunction", "tokenFunction" and "userPools"/,
    );
    expect(() =>
      api.addAuthorizer({
        name: "Both",
        tokenFunction: "src/a.handler",
        userPools: [USER_POOL],
      }),
    ).toThrow(/is given more than one of/);
  });

  it("can be linked by a function, as can an API key", async () => {
    const api = new ApiGatewayRest("MyApi");
    api.route("GET /", "src/get.handler", { apiKey: true });
    api.deploy();
    const key = api.addUsagePlan("MyPlan", {}).addApiKey("MyKey", {
      value: "secret-value-123",
    });
    new Function("Api", { handler: "src/api.handler", link: [api, key] });
    await pulumi.settle();
    expect(names()).toContain("ApiFunction");
    expect(await pulumi.resolve(api.link().properties.url)).toContain(
      "execute-api",
    );
    expect(await pulumi.resolve(key.link().properties.value)).toBe(
      "secret-value-123",
    );
  });
});
