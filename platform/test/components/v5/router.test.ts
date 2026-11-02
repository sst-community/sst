import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Output, output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const DISTRIBUTION = "aws:cloudfront/distribution:Distribution";
const DYNAMIC = "pulumi-nodejs:dynamic:Resource";
const EDGE_ARN = "arn:aws:lambda:us-east-1:123456789012:function:signer:3";
const STORE_ARN =
  "arn:aws:cloudfront::123456789012:key-value-store/their-store";
const FUNCTION_URL =
  "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";

const pulumi = mockPulumi({
  state: (args) => {
    // A distribution that's looked up: a router deployed in another stage
    if (args.type === DISTRIBUTION && args.id)
      return {
        arn: `arn:aws:cloudfront::123456789012:distribution/${args.id}`,
        domainName: "d111111abcdef8.cloudfront.net",
        aliases: [],
        tagsAll: {
          "sst:ref:kv": "arn:aws:cloudfront::123456789012:key-value-store/a",
          "sst:ref:kv-namespace": "abcd",
          "sst:ref:version": "2",
          "sst:ref:protection": "oac",
        },
      };
    if (args.type === DISTRIBUTION)
      return {
        domainName: `${args.name.toLowerCase()}.cloudfront.net`,
        hostedZoneId: "Z2FDTNDATAQYW2",
        etag: "E1",
      };
    if (args.type === DYNAMIC && "etag" in args.inputs) return { isDone: true };
    if (args.type === "aws:lambda/function:Function")
      return { qualifiedArn: `${args.name}:1` };
    if (args.type === "aws:lambda/functionUrl:FunctionUrl")
      return { functionUrl: FUNCTION_URL };
    return {};
  },
});

describe("Router", () => {
  let OriginalRouter: typeof import("../../../src/components/aws/router").Router;
  let Router: typeof import("../../../src/components/aws/v5/router").Router;
  let OriginalBucket: typeof import("../../../src/components/aws/bucket").Bucket;
  let Bucket: typeof import("../../../src/components/aws/v5/bucket").Bucket;
  let OriginalFunction: typeof import("../../../src/components/aws/function").Function;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;

  beforeAll(async () => {
    OriginalRouter = (await import("../../../src/components/aws/router"))
      .Router;
    Router = (await import("../../../src/components/aws/v5/router")).Router;
    OriginalBucket = (await import("../../../src/components/aws/bucket"))
      .Bucket;
    Bucket = (await import("../../../src/components/aws/v5/bucket")).Bucket;
    OriginalFunction = (await import("../../../src/components/aws/function"))
      .Function;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
    await import("../../../src/components/aws/takeover/router");
    await import("../../../src/components/aws/takeover/function");
    await import("../../../src/components/aws/takeover/bucket");
    await import(
      "../../../src/components/aws/takeover/dns-validated-certificate"
    );
    await import("../../../src/components/aws/takeover/https-redirect");
  });

  beforeEach(() => {
    pulumi.reset();
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  const valueOf = <T>(value: Output<T>) =>
    new Promise<T>((resolve) => value.apply(resolve));

  // Each case deploys the 4.x Router, then the same thing as the V5 one, which
  // has to keep everything with the same inputs. The 4.x one kept each route
  // in a component of its own; those go.
  describe("takes over a deployed Router", () => {
    pulumi.takeoverCases({
      original: () => OriginalRouter as any,
      v5: () => Router as any,
      check: () => {
        expect(names()).toContain("MyRouterCdnDistribution");
        expect(pulumi.reportOf("MyRouter")).toHaveProperty("hint");
      },
      cases: {
        "no domain": {
          create: (Router, opts) => {
            new Router("MyRouter", {}, opts);
          },
          check: () => {
            expect(names()).toContain("MyRouterKvStore");
            expect(names()).toContain("MyRouterCloudfrontFunctionRequest");
            expect(names()).toContain("MyRouterServerCachePolicy");
          },
        },
        "a domain with aliases": (Router, opts) => {
          new Router(
            "MyRouter",
            {
              domain: { name: "example.com", aliases: ["*.example.com"] },
            },
            opts,
          );
        },
        "code at the edge, with a store of the user's": {
          create: (Router, opts) => {
            new Router(
              "MyRouter",
              {
                edge: {
                  viewerRequest: {
                    injection: `event.request.headers["x-foo"] = { value: "bar" };`,
                    kvStore: STORE_ARN,
                  },
                  viewerResponse: {
                    injection: `event.response.headers["x-bar"] = { value: "foo" };`,
                  },
                },
              },
              opts,
            );
          },
          check: () => {
            expect(names()).not.toContain("MyRouterKvStore");
            expect(names()).toContain("MyRouterCloudfrontFunctionResponse");
          },
        },
        "protection with OAC": (Router, opts) => {
          new Router("MyRouter", { protection: "oac" }, opts);
        },
        "protection with edge signing": {
          create: (Router, opts) => {
            new Router(
              "MyRouter",
              {
                protection: {
                  mode: "oac-with-edge-signing",
                  edgeFunction: { memory: "256 MB", timeout: "10 seconds" },
                },
              },
              opts,
            );
          },
          check: () => {
            expect(names()).toContain("MyRouterEdgeFunctionRole");
            expect(resource("MyRouterEdgeFunction").inputs.memorySize).toBe(
              256,
            );
          },
        },
        "protection with an edge function of the user's": {
          create: (Router, opts) => {
            new Router(
              "MyRouter",
              {
                protection: {
                  mode: "oac-with-edge-signing",
                  edgeFunction: { arn: EDGE_ARN },
                },
              },
              opts,
            );
          },
          check: () => expect(names()).not.toContain("MyRouterEdgeFunction"),
        },
        "a WAF": (Router, opts) => {
          new Router(
            "MyRouter",
            {
              waf: {
                rateLimitPerIp: 1000,
                managedRules: { sqlInjection: false },
              },
            },
            opts,
          );
        },
        "a WAF that logs what it blocks": {
          create: (Router, opts) => {
            new Router(
              "MyRouter",
              {
                waf: {
                  logging: {
                    include: "blocked",
                    retention: "1 week",
                    redact: { method: true, headers: ["X-Api-Key"] },
                  },
                },
              },
              opts,
            );
          },
          check: () => {
            expect(names()).toContain("MyRouterWafLogGroup");
            expect(names()).toContain("MyRouterWafLogging");
          },
        },
        "a WAF that logs everything": (Router, opts) => {
          new Router("MyRouter", { waf: { logging: true } }, opts);
        },
        "routes to URLs": {
          create: (Router, opts) => {
            // The 4.x `route()` returns nothing, so the calls aren't chained
            const router = new Router("MyRouter", { protection: "oac" }, opts);
            router.route("/", "https://example.com");
            router.route("api.example.com/v1", FUNCTION_URL, {
              protection: true,
              rewrite: { regex: "^/v1/(.*)$", to: "/$1" },
              readTimeout: "30 seconds",
              connectionAttempts: 1,
            });
            router.route("/plain", "http://example.com:8080");
          },
          unclaimed: [
            "sst:aws:RouterUrlRoute::MyRouterRoute/",
            "sst:aws:RouterUrlRoute::MyRouterRouteapi.example.com/v1",
            "sst:aws:RouterUrlRoute::MyRouterRoute/plain",
          ],
        },
        "routes with every arg, and patterns of each kind": {
          create: (Router, opts) => {
            // Signing asked for on a router that doesn't sign
            const router = new Router("MyRouter", {}, opts);
            router.route("api.example.com", FUNCTION_URL, {
              protection: true,
              connectionAttempts: 0,
              connectionTimeout: "3 seconds",
              readTimeout: "45 seconds",
              keepAliveTimeout: "10 seconds",
            });
            router.route("dev.example.com/api/v2", "https://example.com/v2");
          },
          unclaimed: [
            "sst:aws:RouterUrlRoute::MyRouterRouteapi.example.com",
            "sst:aws:RouterUrlRoute::MyRouterRoutedev.example.com/api/v2",
          ],
        },
        "routes given as outputs, on a router with an edge signer": {
          create: (Router, opts) => {
            const router = new Router(
              "MyRouter",
              {
                protection: {
                  mode: "oac-with-edge-signing",
                  edgeFunction: { arn: EDGE_ARN },
                },
              },
              opts,
            );
            router.route(
              "/api",
              output(FUNCTION_URL),
              output({
                protection: output(true),
                rewrite: { regex: output("^/api/(.*)$"), to: "/$1" },
              }),
            );
          },
          unclaimed: ["sst:aws:RouterUrlRoute::MyRouterRoute/api"],
        },
        // A move switches all of a component at once, so a stage doesn't
        // have both kinds of bucket; "a route to a bucket" has 4.x's
        "routes to V5 buckets, with and without args": {
          create: (Router, opts) => {
            const router = new Router("MyRouter", {}, opts);
            router.routeBucket(
              "/old",
              new Bucket("OldFiles", { access: "cloudfront" }),
            );
            router.routeBucket(
              "/new",
              new Bucket("NewFiles", { access: "cloudfront" }),
              { connectionAttempts: 2 },
            );
          },
          unclaimed: [
            "sst:aws:RouterBucketRoute::MyRouterRoute/old",
            "sst:aws:RouterBucketRoute::MyRouterRoute/new",
          ],
        },
        "an object transform that sets the distribution's tags": {
          create: (Router, opts) => {
            new Router(
              "MyRouter",
              { transform: { cdn: { tags: { team: "web" } } } as any },
              opts,
            );
          },
          // 4.x replaced the tags whole, so a router another stage
          // referenced with `get` couldn't be read. The V5 one merges them,
          // and adds back the ones `get` reads.
          changed: [["MyRouterCdnDistribution", ["tags"]]],
          check: () =>
            expect(resource("MyRouterCdnDistribution").inputs.tags).toEqual(
              expect.objectContaining({
                team: "web",
                "sst:ref:version": "2",
              }),
            ),
        },
        "a route to a bucket": {
          create: (Router, opts) => {
            const bucket = new OriginalBucket("MyBucket", {
              access: "cloudfront",
            });
            new Router("MyRouter", {}, opts).routeBucket("/files", bucket, {
              rewrite: { regex: "^/files/(.*)$", to: "/$1" },
              connectionTimeout: "3 seconds",
            });
          },
          unclaimed: ["sst:aws:RouterBucketRoute::MyRouterRoute/files"],
        },
        "transform functions": (Router, opts) => {
          new Router(
            "MyRouter",
            {
              transform: {
                cachePolicy: (args: any) => {
                  args.comment = "Mine";
                },
                cdn: (args: any) => {
                  args.wait = false;
                },
              },
            },
            opts,
          );
        },
        get: {
          create: (Router, opts) => {
            Router.get("MyRouter", "E2IDLMESRN6V62", opts).route(
              "/api",
              FUNCTION_URL,
            );
          },
          unclaimed: ["sst:aws:RouterUrlRoute::MyRouterRoute/api"],
          check: () => expect(names()).not.toContain("MyRouterKvStore"),
        },
      },
    });
  });

  it("keeps a route where the 4.x one had it, in the same place in the store", async () => {
    new Router("MyRouter", { protection: "oac" })
      .route("api.example.com/v1", FUNCTION_URL, {
        protection: true,
        readTimeout: "30 seconds",
      })
      .route("/plain", "http://example.com:8080");
    await pulumi.settle();

    const key = pulumi.resources.find(
      (r) =>
        r.type === "sst:aws:KvKeys" &&
        r.name.startsWith("MyRouterRouteKey") &&
        r.inputs.entries.metadata.includes("lambda-url"),
    )!;
    expect(JSON.parse(key.inputs.entries.metadata)).toEqual({
      host: "abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws",
      origin: {
        originAccessControlConfig: {
          enabled: true,
          signingBehavior: "always",
          signingProtocol: "sigv4",
          originType: "lambda",
        },
        timeouts: { readTimeout: 30 },
      },
    });
    const plain = pulumi.resources.find(
      (r) =>
        r.type === "sst:aws:KvKeys" &&
        r.name.startsWith("MyRouterRouteKey") &&
        r.inputs.entries.metadata.includes("8080"),
    )!;
    expect(JSON.parse(plain.inputs.entries.metadata)).toEqual({
      host: "example.com:8080",
      origin: { protocol: "http" },
    });
  });

  // A function served through the router by its own `url.router`
  const routed = (
    WithRouter: typeof OriginalRouter | typeof Router,
    WithFunction: typeof OriginalFunction | typeof Function,
  ) => {
    const router = new WithRouter("MyRouter", { protection: "oac" });
    new WithFunction("Api", {
      handler: "src/api.handler",
      url: { router: { instance: router as any, path: "/api" } },
    });
  };

  it("serves a 4.x Function as the 4.x Router did", async () => {
    const result = await pulumi.takesOver(
      () => routed(OriginalRouter, OriginalFunction),
      () => routed(Router, OriginalFunction),
    );
    expect(names()).toContain("ApiUrl");
    expect(result).toEqual({
      unclaimed: [],
      changed: [],
      unordered: [],
      revealed: [],
    });
  });

  it("serves a V5 Function as the 4.x Router served a 4.x one", async () => {
    const result = await pulumi.takesOver(
      () => routed(OriginalRouter, OriginalFunction),
      () => routed(Router, Function),
    );
    expect(names()).toContain("ApiUrl");
    expect(result).toEqual({
      unclaimed: [],
      changed: [],
      unordered: [],
      revealed: [],
    });
  });

  it("routes a V5 Function that links it with route()", async () => {
    const router = new Router("MyRouter", { protection: "oac" });
    const api = new Function("Api", {
      handler: "src/api.handler",
      url: true,
      link: [router],
    });
    router.route("/api", api.url, { protection: true });
    await pulumi.settle();

    expect(names()).toContain("ApiUrl");
    expect(
      pulumi.resources.filter((r) => r.name.startsWith("MyRouterRouteKey")),
    ).toHaveLength(1);
  });

  it("says what to write in place of inline routes and invalidation", () => {
    expect(
      () =>
        new Router("MyRouter", {
          routes: { "/*": "https://example.com" },
        } as any),
    ).toThrow(/"routes" isn't an option of the "MyRouter" Router\. Add each/);
    expect(() => new Router("MyRouter", { invalidation: true } as any)).toThrow(
      /"invalidation" isn't an option here\. sst\.aws\.Router never/,
    );
  });

  it("says what has to be a plain value", () => {
    expect(
      () => new Router("MyRouter", { protection: output("oac") as any }),
    ).toThrow(/"protection" of the "MyRouter" Router has to be a plain value/);
    expect(() => new Router("MyRouter", { waf: output(true) as any })).toThrow(
      /"waf" of the "MyRouter" Router has to be a plain value/,
    );
    expect(() =>
      new Router("MyRouter").route(output("/api") as any, "https://a.b"),
    ).toThrow(/pattern of a route of the "MyRouter" Router .* named after it/);
  });

  it("refuses a second route with the same pattern", () => {
    const router = new Router("MyRouter").route("/api", "https://a.example");
    expect(() => router.route("/api", "https://b.example")).toThrow(
      /"MyRouter" already has a route named "\/api"/,
    );
  });

  it("says plainly whether it signs, and reads it from a referenced router's tags", async () => {
    const none = new Router("Plain");
    const oac = new Router("Signing", { protection: "oac" });
    const referenced = Router.get("Shared", "E2IDLMESRN6V62");
    await pulumi.settle();

    expect(none._signs).toBe(false);
    expect(oac._signs).toBe(true);
    expect(await valueOf(referenced._signs as Output<boolean>)).toBe(true);
    expect(await valueOf(referenced._kvNamespace)).toBe("abcd");
    expect(await valueOf(oac.url)).toBe(
      "https://signingcdndistribution.cloudfront.net",
    );
  });
});
