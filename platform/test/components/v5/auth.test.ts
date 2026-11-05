import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const DISTRIBUTION = "aws:cloudfront/distribution:Distribution";
const FUNCTION_URL =
  "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === DISTRIBUTION)
      return {
        domainName: `${args.name.toLowerCase()}.cloudfront.net`,
        hostedZoneId: "Z2FDTNDATAQYW2",
        etag: "E1",
      };
    if (args.type === "pulumi-nodejs:dynamic:Resource" && "etag" in args.inputs)
      return { isDone: true };
    if (args.type === "aws:lambda/functionUrl:FunctionUrl")
      return { functionUrl: FUNCTION_URL };
    return {};
  },
});

type AuthClass =
  | typeof import("../../fixtures/v4/components/aws/auth").Auth
  | typeof import("../../../src/components/aws/auth").Auth;

// What 4.x kept in the state and the V5 one doesn't: the record of its
// version, which has nothing in the cloud behind it
const VERSION = "sst:sst:Version::MyAuthVersion";

describe("Auth", () => {
  let Original: typeof import("../../fixtures/v4/components/aws/auth").Auth;
  let Auth: typeof import("../../../src/components/aws/auth").Auth;
  let Function: typeof import("../../../src/components/aws/function").Function;

  beforeAll(async () => {
    Original = (await import("../../fixtures/v4/components/aws/auth")).Auth;
    Auth = (await import("../../../src/components/aws/auth")).Auth;
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

  // Each case deploys the 4.x Auth, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept, with the same inputs.
  describe("takes over a deployed Auth", () => {
    pulumi.takeoverCases<AuthClass, AuthClass>({
      original: () => Original,
      v5: () => Auth,
      cases: {
        "an issuer from a handler": {
          create: (Auth, opts) => {
            new Auth("MyAuth", { issuer: "src/auth.handler" }, opts);
          },
          unclaimed: [VERSION],
          check: () =>
            expect(resource("MyAuthIssuer").type).toBe("sst:aws:Function"),
        },
        "an issuer from its args, with a URL of its own": {
          create: (Auth, opts) => {
            new Auth(
              "MyAuth",
              {
                issuer: {
                  handler: "src/auth.handler",
                  timeout: "30 seconds",
                  environment: { STAGE: "test" },
                  permissions: [
                    { actions: ["ses:SendEmail"], resources: ["*"] },
                  ],
                  url: { authorization: "none" },
                },
              },
              opts,
            );
          },
          unclaimed: [VERSION],
        },
        // 4.x took the issuer's args as an output. The V5 one takes them as a
        // plain value, as the V5 `Function` takes its handler.
        "an issuer given as an output": {
          original: (opts) =>
            new Original(
              "MyAuth",
              { issuer: output({ handler: "src/auth.handler" }) },
              opts,
            ),
          v5: (opts) =>
            new Auth(
              "MyAuth",
              { issuer: { handler: "src/auth.handler" } },
              opts,
            ),
          unclaimed: [VERSION],
        },
        "the deprecated authorizer, written as issuer": {
          original: (opts) =>
            new Original("MyAuth", { authorizer: "src/auth.handler" }, opts),
          v5: (opts) =>
            new Auth("MyAuth", { issuer: "src/auth.handler" }, opts),
          unclaimed: [VERSION],
        },
        "with a custom domain": {
          create: (Auth, opts) => {
            new Auth(
              "MyAuth",
              { issuer: "src/auth.handler", domain: "auth.example.com" },
              opts,
            );
          },
          // 4.x kept the router's route in a component of its own, with
          // nothing in the cloud behind it. The V5 router takes its line in
          // the router's list over, as the Router's own tests say.
          unclaimed: [VERSION, "sst:aws:RouterUrlRoute::MyAuthRouterRoute/"],
          check: () => expect(names()).toContain("MyAuthRouter"),
        },
      },
    });
  });

  it("serves the issuer at its URL, with the table linked and named in OPENAUTH_STORAGE", async () => {
    const auth = new Auth("MyAuth", { issuer: "src/auth.handler" });
    await pulumi.settle();
    expect(await pulumi.resolve(auth.url)).toBe(FUNCTION_URL.slice(0, -1));
    expect(resource("MyAuthStorage").type).toBe("sst:aws:Dynamo");
    const env = JSON.stringify(
      await pulumi.resolve(resource("MyAuthIssuerFunction").inputs.environment),
    );
    expect(env).toContain("OPENAUTH_STORAGE");
    expect(resource("MyAuthIssuerUrl").inputs.cors).toBeUndefined();
    expect(pulumi.reportOf("MyAuth")?.hint).toBe(FUNCTION_URL.slice(0, -1));
  });

  it("serves the issuer at its domain through a router, which reports no hint of its own", async () => {
    const auth = new Auth("MyAuth", {
      issuer: "src/auth.handler",
      domain: "auth.example.com",
    });
    await pulumi.settle();
    expect(await pulumi.resolve(auth.url)).toBe("https://auth.example.com");
    expect(auth.nodes.router).toBeDefined();
    expect(pulumi.reportOf("MyAuthRouter")?.hint).toBeUndefined();
  });

  it("turns down what the 4.x Auth took and the V5 one doesn't", () => {
    expect(
      () =>
        // @ts-expect-error
        new Auth("MyAuth", { authorizer: "src/auth.handler" }),
    ).toThrow(
      /"authorizer" isn't an option for the "MyAuth" auth server. Use "issuer"/,
    );
    expect(
      () =>
        new Auth("MyAuth", {
          issuer: "src/auth.handler",
          // @ts-expect-error
          forceUpgrade: "v2",
        }),
    ).toThrow(/"forceUpgrade" isn't an option for the "MyAuth" auth server/);
    expect(
      () =>
        new Auth("MyAuth", {
          issuer: "arn:aws:lambda:us-east-1:123456789012:function:auth",
        }),
    ).toThrow(/is the ARN of a function/);
    expect(
      () =>
        new Auth("MyAuth", {
          issuer: "src/auth.handler",
          // @ts-expect-error
          domain: output("auth.example.com"),
        }),
    ).toThrow(/"domain"/);
  });

  it("gives the issuer a URL even when its args turn it off, and takes transforms for its parts", async () => {
    new Auth("MyAuth", {
      issuer: { handler: "src/auth.handler", url: false },
      domain: "auth.example.com",
      transform: {
        issuer: { memory: "256 MB" },
        router: (args: any) => {
          args.waf = true;
        },
      },
    });
    await pulumi.settle();
    expect(names()).toContain("MyAuthIssuerUrl");
    expect(resource("MyAuthIssuerFunction").inputs.memorySize).toBe(256);
    expect(names().some((n) => n.startsWith("MyAuthRouterWaf"))).toBe(true);
  });

  it("refuses an existing issuer, which it couldn't give a URL, and an existing router", () => {
    expect(
      () =>
        new Auth("MyAuth", {
          issuer: "src/auth.handler",
          existing: { issuer: "arn:aws:lambda:us-east-1:1:function:x" as any },
        }),
    ).toThrow(
      /"existing.issuer" isn't an option for the "MyAuth" auth server. Pass the handler or the function's args in "issuer"/,
    );
    for (const domain of [undefined, "auth.example.com"])
      expect(
        () =>
          new Auth("MyAuth", {
            issuer: "src/auth.handler",
            domain,
            existing: { router: "E2IDLMESRN6V62" },
          }),
      ).toThrow(
        /"existing.router" isn't an option for the "MyAuth" auth server. Its router serves the issuer at its "domain"/,
      );
  });

  it("refuses an issuer given as an output", async () => {
    expect(
      () =>
        new Auth("MyAuth", {
          issuer: output("src/auth.handler") as any,
        }),
    ).toThrow(/"issuer"/);
  });

  it("can be linked by a function, which gets OPENAUTH_ISSUER", async () => {
    const auth = new Auth("MyAuth", { issuer: "src/auth.handler" });
    new Function("Api", { handler: "src/api.handler", link: [auth] });
    await pulumi.settle();
    const env = JSON.stringify(
      await pulumi.resolve(resource("ApiFunction").inputs.environment),
    );
    expect(env).toContain("OPENAUTH_ISSUER");
  });
});
