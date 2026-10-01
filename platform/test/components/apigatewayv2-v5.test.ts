import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi({
  // What the 4.x component wraps things in. They have nothing in AWS behind
  // them, and they go when the V5 component takes over.
  wrappers: /^sst:aws:ApiGatewayV2(LambdaRoute|UrlRoute|PrivateRoute|Authorizer)::MyApi/,
  state: (args) => {
    switch (args.type) {
      case "aws:apigatewayv2/api:Api":
        return {
          apiEndpoint: "https://abc123.execute-api.us-east-1.amazonaws.com",
          executionArn: "arn:aws:execute-api:us-east-1:123456789012:abc123",
        };
      case "aws:apigatewayv2/domainName:DomainName":
        return {
          domainName: args.inputs.domainName ?? "api.example.com",
          domainNameConfiguration: {
            ...args.inputs.domainNameConfiguration,
            targetDomainName: "d-abc.execute-api.us-east-1.amazonaws.com",
            hostedZoneId: "Z1UJRXOUMOOFQ8",
          },
        };
      case "aws:acm/certificate:Certificate":
        return {
          domainValidationOptions: [
            {
              resourceRecordType: "CNAME",
              resourceRecordName: "_abc.api.example.com.",
              resourceRecordValue: "_def.acm-validations.aws.",
            },
          ],
        };
      default:
        return {};
    }
  },
});

const FUNCTION_ARN = "arn:aws:lambda:us-east-1:123456789012:function:my-fn";
const CERT_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/abc";
const LOAD_BALANCER_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/lb/1";
const vpc = { securityGroups: ["sg-1"], subnets: ["subnet-1", "subnet-2"] };

describe("ApiGatewayV2V5", () => {
  let ApiGatewayV2: typeof import("../../src/components/aws/apigatewayv2").ApiGatewayV2;
  let ApiGatewayV2V5: typeof import("../../src/components/aws/apigatewayv2-v5").ApiGatewayV2V5;

  beforeAll(async () => {
    ({ ApiGatewayV2 } = await import("../../src/components/aws/apigatewayv2"));
    ({ ApiGatewayV2V5 } = await import(
      "../../src/components/aws/apigatewayv2-v5"
    ));
    await import("../../src/components/aws/takeover/apigatewayv2");
  });

  beforeEach(() => pulumi.reset());

  describe("takes over a deployed ApiGatewayV2", () => {
    it("default API", async () => {
      await pulumi.expectTakeover(
        () => new ApiGatewayV2("MyApi"),
        () => new ApiGatewayV2V5("MyApi"),
      );
    });

    it("cors, access log and transforms", async () => {
      const args = {
        cors: {
          allowOrigins: ["https://example.com"],
          maxAge: "1 day" as const,
        },
        accessLog: { retention: "1 week" as const },
        transform: {
          api: { description: "Orders" },
          stage: (args: any): undefined => {
            args.autoDeploy = false;
          },
          logGroup: { kmsKeyId: "key-1" },
        },
      };
      await pulumi.expectTakeover(
        () => new ApiGatewayV2("MyApi", args),
        () => new ApiGatewayV2V5("MyApi", args),
      );
      await pulumi.expectTakeover(
        () => new ApiGatewayV2("MyApi", { cors: false }),
        () => new ApiGatewayV2V5("MyApi", { cors: false }),
      );
    });

    it("function routes", async () => {
      await pulumi.expectTakeover(
        () => {
          const api = new ApiGatewayV2("MyApi");
          api.route("GET /", "src/get.handler");
          api.route("post /notes/{id}", { handler: "src/post.handler" });
          api.route("$default", FUNCTION_ARN);
          api.route("GET /users/{id}", FUNCTION_ARN, { name: "GetUser" });
        },
        () =>
          new ApiGatewayV2V5("MyApi")
            .route("GET /", "src/get.handler")
            .route("post /notes/{id}", { handler: "src/post.handler" })
            .route("$default", FUNCTION_ARN)
            .route("GET /users/{id}", FUNCTION_ARN, { name: "GetUser" }),
        4,
      );
      // The functions and what they're made of are now inside the API
      expect(
        pulumi.resources
          .filter((r) => r.type === "sst:aws:Function")
          .map((r) => r.parent.split("::").at(-1)),
      ).toEqual(["MyApi", "MyApi"]);
    });

    it("URL and private routes", async () => {
      await pulumi.expectTakeover(
        () => {
          const api = new ApiGatewayV2("MyApi", { vpc });
          api.routeUrl("GET /search", "https://example.com");
          api.routePrivate("ANY /internal/{proxy+}", LOAD_BALANCER_ARN);
        },
        () =>
          new ApiGatewayV2V5("MyApi", { vpc })
            .routeUrl("GET /search", "https://example.com")
            .routePrivate("ANY /internal/{proxy+}", LOAD_BALANCER_ARN),
        2,
      );
    });

    it("authorizers and route auth", async () => {
      const jwt = {
        name: "tokens",
        jwt: { issuer: "https://issuer.com/", audiences: ["api"] },
      };
      const lambda = {
        name: "custom",
        lambda: { function: FUNCTION_ARN, ttl: "1 hour", response: "iam" },
      } as const;
      await pulumi.expectTakeover(
        () => {
          const api = new ApiGatewayV2("MyApi");
          const tokens = api.addAuthorizer(jwt);
          const custom = api.addAuthorizer(lambda);
          api.route("GET /iam", FUNCTION_ARN, { auth: { iam: true } });
          api.route("GET /jwt", FUNCTION_ARN, {
            auth: { jwt: { authorizer: tokens.id, scopes: ["read"] } },
          });
          api.route("GET /custom", FUNCTION_ARN, {
            auth: { lambda: custom.id },
          });
        },
        () => {
          const api = new ApiGatewayV2V5("MyApi");
          const tokens = api.addAuthorizer(jwt);
          const custom = api.addAuthorizer(lambda);
          api.route("GET /iam", FUNCTION_ARN, { auth: { iam: true } });
          api.route("GET /jwt", FUNCTION_ARN, {
            auth: { jwt: { authorizer: tokens.id, scopes: ["read"] } },
          });
          api.route("GET /custom", FUNCTION_ARN, {
            auth: { lambda: custom.id },
          });
        },
        5,
      );
    });

    it("an authorizer function created from a handler", async () => {
      const args = { name: "custom", lambda: { function: "src/auth.handler" } };
      await pulumi.expectTakeover(
        () => new ApiGatewayV2("MyApi").addAuthorizer(args),
        () => new ApiGatewayV2V5("MyApi").addAuthorizer(args),
        1,
      );
    });

    it("a route's transform, set on the API", async () => {
      const integration = { timeoutMilliseconds: 5000 };
      const route = { operationName: "ListNotes" };
      await pulumi.expectTakeover(
        () =>
          new ApiGatewayV2("MyApi").route("GET /notes", FUNCTION_ARN, {
            transform: { integration, route },
          }),
        () =>
          new ApiGatewayV2V5("MyApi", {
            transform: { integration, route },
          }).route("GET /notes", FUNCTION_ARN),
        1,
      );
    });

    it("a custom domain on Route 53", async () => {
      await pulumi.expectTakeover(
        () => new ApiGatewayV2("MyApi", { domain: "api.example.com" }),
        () => new ApiGatewayV2V5("MyApi", { domain: "api.example.com" }),
      );
      // The certificate, its records and the alias records are all there
      const types = pulumi.resources.map((r) => r.type);
      expect(types).toContain("sst:aws:Certificate");
      expect(
        types.filter((type) => type === "aws:route53/record:Record").length,
      ).toBe(3);
    });

    it("a custom domain with its own certificate and a path", async () => {
      const args = {
        domain: {
          name: "api.example.com",
          path: "v1",
          dns: false,
          cert: CERT_ARN,
        },
      } as const;
      await pulumi.expectTakeover(
        () => new ApiGatewayV2("MyApi", args),
        () => new ApiGatewayV2V5("MyApi", args),
      );
    });

    it("a custom domain on Cloudflare or Vercel", async () => {
      const cloudflare = await import("../../src/components/cloudflare/dns");
      const vercel = await import("../../src/components/vercel/dns");
      for (const dns of [
        () => cloudflare.dns({ zone: "zone-1" }),
        () => vercel.dns({ domain: "example.com" }),
      ]) {
        await pulumi.expectTakeover(
          () =>
            new ApiGatewayV2("MyApi", {
              domain: { name: "api.example.com", dns: dns() },
            }),
          () =>
            new ApiGatewayV2V5("MyApi", {
              domain: { name: "api.example.com", dns: dns() },
            }),
        );
      }
    });

    it("a route name that isn't a plain word", async () => {
      await pulumi.expectTakeover(
        () =>
          new ApiGatewayV2("MyApi").route("GET /", FUNCTION_ARN, {
            name: "Get User",
          }),
        () =>
          new ApiGatewayV2V5("MyApi").route("GET /", FUNCTION_ARN, {
            name: "Get User",
          }),
        1,
      );
    });

    it("links passed to every handler", async () => {
      const { Linkable } = await import("../../src/components/linkable");
      const link = () => [new Linkable("Thing", { properties: { a: 1 } })];
      await pulumi.expectTakeover(
        () =>
          new ApiGatewayV2("MyApi", { link: link() }).route(
            "GET /",
            "src/get.handler",
          ),
        () =>
          new ApiGatewayV2V5("MyApi", { link: link() }).route(
            "GET /",
            "src/get.handler",
          ),
        1,
      );
    });

    it("a domain name that another API created", async () => {
      await pulumi.expectTakeover(
        () =>
          new ApiGatewayV2("MyApi", {
            domain: { nameId: "api.example.com", path: "v2" },
          }),
        () =>
          new ApiGatewayV2V5("MyApi", {
            domain: { path: "v2" },
            existing: { domainName: "api.example.com" },
          }),
      );
    });
  });

  it("keeps each route's resources under the route", async () => {
    const api = new ApiGatewayV2V5("MyApi")
      .route("GET /", FUNCTION_ARN)
      .route("GET /users/{id}", "src/user.handler", { name: "GetUser" })
      .routeUrl("GET /search", "https://example.com");
    await pulumi.settle();

    expect(Object.keys(api.nodes.route)).toEqual([
      "GET /",
      "GetUser",
      "GET /search",
    ]);
    expect(api.nodes.route["GET /"].constructor.name).toBe("Route");
    expect(Object.keys(api.nodes.handler)).toEqual(["GET /", "GetUser"]);
    expect(Object.keys(api.nodes.permission)).toEqual(["GET /", "GetUser"]);
    const handler = await pulumi.resolve(api.nodes.handler.GetUser);
    expect(handler.constructor.name).toBe("Function");
  });

  it("names routes that differ only in punctuation apart", async () => {
    new ApiGatewayV2V5("MyApi")
      .route("GET /a-b", FUNCTION_ARN)
      .route("GET /ab", FUNCTION_ARN);
    await pulumi.settle();

    const routes = pulumi.resources
      .filter((r) => r.type === "aws:apigatewayv2/route:Route")
      .map((r) => r.name);
    expect(routes.length).toBe(2);
    expect(new Set(routes).size).toBe(2);
    for (const name of routes) expect(name).toMatch(/^MyApiRouteGETab[A-Z]/);
  });

  it("tells a transform which route it is given", async () => {
    new ApiGatewayV2V5("MyApi", {
      transform: {
        route: (args, _opts, _name, route) => {
          if (route === "POST /") args.operationName = "Create";
        },
      },
    })
      .route("GET /", FUNCTION_ARN)
      .route("POST /", FUNCTION_ARN);
    await pulumi.settle();

    const operations = pulumi.resources
      .filter((r) => r.type === "aws:apigatewayv2/route:Route")
      .map((r) => [r.inputs.routeKey, r.inputs.operationName]);
    expect(operations).toEqual([
      ["GET /", undefined],
      ["POST /", "Create"],
    ]);
  });

  it("rejects a route that was already added", () => {
    const api = new ApiGatewayV2V5("MyApi").route("GET /", FUNCTION_ARN);
    expect(() => api.route("get /", FUNCTION_ARN)).toThrow(
      /already has a route named "GET \/"/,
    );
    expect(() => api.route("GET", FUNCTION_ARN)).toThrow(/Invalid route GET/);
    expect(() => api.route("FETCH /", FUNCTION_ARN)).toThrow(/Invalid method/);
  });

  it("accepts a route name that every object has as a property", async () => {
    const api = new ApiGatewayV2V5("MyApi")
      .route("GET /a", FUNCTION_ARN, { name: "constructor" })
      .route("GET /b", FUNCTION_ARN, { name: "toString" });
    expect(() =>
      api.route("GET /c", FUNCTION_ARN, { name: "toString" }),
    ).toThrow(/already has a route named "toString"/);
    await pulumi.settle();

    expect(Object.keys(api.nodes.route)).toEqual(["constructor", "toString"]);
  });

  it("needs a plain value for the domain", async () => {
    const { output } = await import("@pulumi/pulumi");
    expect(
      () =>
        new ApiGatewayV2V5("MyApi", {
          domain: output("api.example.com") as any,
        }),
    ).toThrow(/"domain" of the "MyApi" API has to be a plain value/);
    await pulumi.settle();
  });

  it("says where a route's transform goes", () => {
    const api = new ApiGatewayV2V5("MyApi");
    expect(() =>
      api.route("GET /", FUNCTION_ARN, { transform: { route: {} } } as any),
    ).toThrow(/"transform" isn't an option here. Use the "transform" of "MyApi": its "handler", "integration" and "route" apply to every route/);
    expect(
      () =>
        new ApiGatewayV2V5("Other", {
          transform: { route: { handler: { memory: "1024 MB" } } } as any,
        }),
    ).toThrow(/use "transform.handler"/);
  });

  it("needs a VPC for a private route", () => {
    expect(() =>
      new ApiGatewayV2V5("MyApi").routePrivate("GET /", LOAD_BALANCER_ARN),
    ).toThrow(/Configure "vpc" for the "MyApi" API/);
  });

  it("needs one kind of authorizer", () => {
    const api = new ApiGatewayV2V5("MyApi");
    expect(() => api.addAuthorizer({ name: "none" })).toThrow(
      /one of "lambda" or "jwt"/,
    );
  });

  it("returns the authorizer, for use in route auth", async () => {
    const api = new ApiGatewayV2V5("MyApi");
    const authorizer = api.addAuthorizer({
      name: "tokens",
      jwt: { issuer: "https://issuer.com/", audiences: ["api"] },
    });
    await pulumi.settle();

    expect(await pulumi.resolve(authorizer.id)).toBe("MyApiAuthorizerTokens_id");
    expect(api.nodes.authorizer.tokens).toBe(authorizer);
  });

  it("uses the custom domain in its URL", async () => {
    const plain = new ApiGatewayV2V5("Plain");
    const custom = new ApiGatewayV2V5("Custom", {
      domain: { name: "api.example.com", dns: false, cert: CERT_ARN },
    });
    const mapped = new ApiGatewayV2V5("Mapped", {
      domain: { path: "v2" },
      existing: { domainName: "api.example.com" },
    });
    await pulumi.settle();

    expect(await pulumi.resolve([plain.url, custom.url, mapped.url])).toEqual([
      "https://abc123.execute-api.us-east-1.amazonaws.com",
      "https://api.example.com",
      "https://api.example.com/v2/",
    ]);
    expect(plain.nodes.domainName).toBeUndefined();
    expect(custom.nodes.certificate).toBeUndefined();
  });

  it("needs a certificate when DNS is off", () => {
    expect(
      () =>
        new ApiGatewayV2V5("MyApi", {
          domain: { name: "api.example.com", dns: false },
        }),
    ).toThrow(/"cert" is required when "dns" is disabled/);
  });

  it("links with its URL", async () => {
    const api = new ApiGatewayV2V5("MyApi");
    await pulumi.settle();

    expect(Object.keys((api as any).getSSTLink().properties)).toEqual(["url"]);
  });
});
