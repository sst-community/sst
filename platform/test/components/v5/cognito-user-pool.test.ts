import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const pulumi = mockPulumi({
  // What the 4.x component wraps things in. They have nothing in AWS behind
  // them, and they go when the V5 component takes over.
  wrappers: /^sst:aws:CognitoIdentityProvider::/,
  state: (args) => {
    switch (args.type) {
      case "aws:cognito/userPoolDomain:UserPoolDomain":
        return {
          cloudfrontDistribution: "d111111abcdef8.cloudfront.net",
          cloudfrontDistributionZoneId: "Z2FDTNDATAQYW2",
        };
      case "aws:cognito/userPoolClient:UserPoolClient":
        return { clientSecret: "shh" };
      case "aws:acm/certificate:Certificate":
        return {
          domainValidationOptions: [
            {
              resourceRecordType: "CNAME",
              resourceRecordName: "_abc.auth.example.com.",
              resourceRecordValue: "_def.acm-validations.aws.",
            },
          ],
        };
      default:
        return {};
    }
  },
  call: (args) =>
    args.token === "aws:index/getRegion:getRegion"
      ? { name: "us-east-1", region: "us-east-1" }
      : undefined,
});

const FUNCTION_ARN = "arn:aws:lambda:us-east-1:123456789012:function:my-fn";
const KMS_KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/abc";
const CERT_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/abc";
const POOL = "aws:cognito/userPool:UserPool";
const CLIENT = "aws:cognito/userPoolClient:UserPoolClient";
const PROVIDER = "aws:cognito/identityProvider:IdentityProvider";
const PERMISSION = "aws:lambda/permission:Permission";

const google = {
  type: "google",
  details: {
    authorize_scopes: "email profile",
    client_id: "id",
    client_secret: "secret",
  },
  attributes: { email: "email", username: "sub" },
} as const;

type PoolClass =
  | typeof import("../../../src/components/aws/cognito-user-pool").CognitoUserPool
  | typeof import("../../../src/components/aws/v5/cognito-user-pool").CognitoUserPool;

describe("CognitoUserPool", () => {
  let OriginalCognitoUserPool: typeof import("../../../src/components/aws/cognito-user-pool").CognitoUserPool;
  let CognitoUserPool: typeof import("../../../src/components/aws/v5/cognito-user-pool").CognitoUserPool;

  let cloudflare: typeof import("../../../src/components/cloudflare/dns");
  let vercel: typeof import("../../../src/components/vercel/dns");

  beforeAll(async () => {
    cloudflare = await import("../../../src/components/cloudflare/dns");
    vercel = await import("../../../src/components/vercel/dns");
    ({ CognitoUserPool: OriginalCognitoUserPool } = await import(
      "../../../src/components/aws/cognito-user-pool"
    ));
    ({ CognitoUserPool } = await import(
      "../../../src/components/aws/v5/cognito-user-pool"
    ));
    await import("../../../src/components/aws/takeover/cognito-user-pool");
    await import("../../../src/components/aws/takeover/function");
    await import("../../../src/components/aws/takeover/cognito-user-pool-client");
  });

  beforeEach(() => pulumi.reset());

  const registered = (type: string) =>
    pulumi.resources.filter((r) => r.type === type);

  describe("takes over a deployed CognitoUserPool", () => {
    // Args both components take as they are
    const sameArgs: Record<string, any> = {
      "default user pool": {},
      "email as the username": { usernames: ["email"] },
      "phone and email as the username": { usernames: ["phone", "email"] },
      "aliases": { aliases: ["preferred_username", "email"] },
      "phone as an alias": { aliases: ["phone"] },
      "mfa, sms and software tokens": {
        mfa: "on",
        softwareToken: true,
        sms: {
          externalId: "1234567890",
          snsCallerArn: "arn:aws:iam::123456789012:role/CognitoSnsCaller",
          snsRegion: "us-east-1",
        },
        smsAuthenticationMessage: "Your authentication code is {####}",
      },
      "optional mfa without software tokens": {
        mfa: "optional",
        softwareToken: false,
      },
      "advanced security": { advancedSecurity: "enforced" },
      "advanced security and the verification subject": {
        advancedSecurity: "audit",
        verify: { emailSubject: "Verify your new Awesome account" },
      },
      "verification messages": {
        verify: {
          emailMessage: "Email code {####}",
          smsMessage: "SMS code {####}",
        },
      },
      "one trigger given as an ARN": {
        triggers: { preTokenGeneration: FUNCTION_ARN },
      },
      "no triggers": { triggers: {} },
      "a custom domain with its own certificate and no DNS": {
        domain: { name: "auth.example.com", dns: false, cert: CERT_ARN },
      },
      "a custom domain with its own certificate": {
        domain: { name: "auth.example.com", cert: CERT_ARN },
      },
      transforms: {
        domain: { prefix: "my-app-dev" },
        transform: {
          userPool: { deletionProtection: "ACTIVE" },
          domain: (args: any): undefined => {
            args.managedLoginVersion = 2;
          },
        },
      },
    };
    const pool =
      (args: any) => (Pool: PoolClass, opts?: ComponentResourceOptions) =>
        new Pool("MyUserPool", args, opts);
    const oidc = {
      type: "oidc",
      details: { client_id: "id", oidc_issuer: "https://github.com/" },
    } as const;

    pulumi.takeoverCases({
      original: () => OriginalCognitoUserPool,
      v5: () => CognitoUserPool,
      // The user pool has to be there, so the comparison isn't an empty one
      check: () =>
        expect(registered(POOL).map((r) => r.name)).toEqual([
          "MyUserPoolUserPool",
        ]),
      cases: {
        ...Object.fromEntries(
          Object.entries(sameArgs).map(([name, args]) => [name, pool(args)]),
        ),
        "no args": pool(undefined),
        "triggers given as ARNs": {
          create: pool({
            triggers: {
              kmsKey: KMS_KEY_ARN,
              customEmailSender: FUNCTION_ARN,
              customSmsSender: `${FUNCTION_ARN}:live`,
              preSignUp: FUNCTION_ARN,
              postConfirmation: FUNCTION_ARN,
              preTokenGeneration: FUNCTION_ARN,
              preTokenGenerationVersion: "v2",
            },
          }),
          // The user pool is told about each one, and may invoke each one
          check: () => {
            expect(
              Object.keys(registered(POOL)[0].inputs.lambdaConfig),
            ).toEqual([
              "customEmailSender",
              "customSmsSender",
              "kmsKeyId",
              "postConfirmation",
              "preSignUp",
              "preTokenGenerationConfig",
            ]);
            expect(
              registered(PERMISSION)
                .map((r) => r.name)
                .sort(),
            ).toEqual([
              "MyUserPoolPermissionCustomEmailSender",
              "MyUserPoolPermissionCustomSmsSender",
              "MyUserPoolPermissionPostConfirmation",
              "MyUserPoolPermissionPreSignUp",
              "MyUserPoolPermissionPreTokenGeneration",
            ]);
          },
        },
        "triggers given as handlers": {
          create: pool({
            triggers: {
              preAuthentication: "src/preAuthentication.handler",
              postAuthentication: { handler: "src/postAuthentication.handler" },
            },
          }),
          // The functions are inside the user pool, and the user pool can
          // invoke them
          check: () => {
            expect(
              registered("sst:aws:FunctionV5")
                .map((r) => [r.name, r.parent.split("::").at(-1)])
                .sort(),
            ).toEqual([
              ["MyUserPoolTriggerPostAuthentication", "MyUserPool"],
              ["MyUserPoolTriggerPreAuthentication", "MyUserPool"],
            ]);
            expect(registered(PERMISSION).length).toBe(2);
          },
        },
        "a prefix domain": {
          create: pool({ domain: { prefix: "my-app-dev" } }),
          check: () =>
            expect(
              registered("aws:cognito/userPoolDomain:UserPoolDomain")[0].inputs,
            ).toEqual({
              domain: "my-app-dev",
              userPoolId: "MyUserPoolUserPool_id",
            }),
        },
        "a custom domain on Route 53": {
          create: pool({ domain: "auth.example.com" }),
          check: () => {
            // The certificate, its record and the alias records are all there
            const types = pulumi.resources.map((r) => r.type);
            expect(types).toContain("sst:aws:Certificate");
            expect(types).toContain(
              "aws:cognito/userPoolDomain:UserPoolDomain",
            );
            expect(
              types.filter((type) => type === "aws:route53/record:Record")
                .length,
            ).toBe(3);
            // The certificate is still made in us-east-1
            expect(
              registered("aws:acm/certificate:Certificate")[0].options.provider,
            ).toContain("AwsProvider.sst.us-east-1");
          },
        },
        "a custom domain on Cloudflare": (Pool, opts) =>
          new Pool(
            "MyUserPool",
            {
              domain: {
                name: "auth.example.com",
                dns: cloudflare.dns({ zone: "zone-1" }),
              },
            },
            opts,
          ),
        "a custom domain on Vercel": (Pool, opts) =>
          new Pool(
            "MyUserPool",
            {
              domain: {
                name: "auth.example.com",
                dns: vercel.dns({ domain: "example.com" }),
              },
            },
            opts,
          ),
        clients: {
          create: (Pool, opts) => {
            const pool = new Pool("MyUserPool", {}, opts);
            pool.addClient("Web");
            pool.addClient("Mobile", {
              providers: ["COGNITO", "Google"],
              callbackUrls: ["https://app.example.com/callback"],
              transform: { client: { generateSecret: true } },
            });
          },
          // A client stays a component of its own, named after the client
          check: () => {
            expect(registered(CLIENT).map((r) => r.name)).toEqual([
              "WebClient",
              "MobileClient",
            ]);
            expect(registered(CLIENT)[1].inputs.generateSecret).toBe(true);
          },
        },
        "identity providers, and a client that uses one": {
          create: (Pool, opts) => {
            const pool = new Pool("MyUserPool", {}, opts);
            const provider = pool.addIdentityProvider("Google", google);
            pool.addIdentityProvider("GitHub", oidc);
            pool.addClient("Web", { providers: [provider.providerName] });
          },
          wrappers: 2,
          check: () => {
            expect(registered(PROVIDER).length).toBe(2);
            expect(
              registered(CLIENT)[0].inputs.supportedIdentityProviders,
            ).toEqual(["Google"]);
          },
        },
        "a provider's transform, set on the user pool": {
          original: (opts) =>
            new OriginalCognitoUserPool("MyUserPool", {}, opts).addIdentityProvider(
              "Google",
              {
                ...google,
                transform: { identityProvider: { idpIdentifiers: ["google"] } },
              },
            ),
          v5: (opts) =>
            new CognitoUserPool(
              "MyUserPool",
              {
                transform: { identityProvider: { idpIdentifiers: ["google"] } },
              },
              opts,
            ).addIdentityProvider("Google", google),
          wrappers: 1,
        },
        // The user pool itself is NOT carried over, and this says so rather
        // than hiding it. The 4.x `CognitoUserPool.get` looks the user pool up
        // outside the component. V5's `get` looks it up inside the component,
        // and a looked-up part can't be given the address it had before. A
        // lookup owns nothing in AWS: the old one is forgotten and the same
        // user pool is looked up again. The client is carried over.
        "a user pool referenced with get, and what's added to it": {
          create: (Pool, opts) =>
            Pool.get("MyUserPool", "us-east-1_abc", opts).addClient("Web"),
          // The 4.x `CognitoUserPool.get` gives its options to the user pool it
          // looks up and not to the component, which is at the top of the app
          // wherever it's asked to be, and has nothing in AWS behind it.
          unclaimed: (way) => [
            `${POOL}::MyUserPoolUserPool`,
            ...(way === "inside another component"
              ? ["sst:aws:CognitoUserPool::MyUserPool"]
              : []),
          ],
          // For the same reason it creates the client with the app's
          // provider. V5 creates it with the one the user pool
          // is looked up with, which replaces it.
          changed: (way) =>
            way === "with another provider"
              ? [["WebClient", ["options.provider"]]]
              : [],
          check: () => {
            expect(registered(POOL).map((r) => [r.kind, r.options.id])).toEqual(
              [["read", "us-east-1_abc"]],
            );
            expect(registered(CLIENT)[0].inputs.userPoolId).toBe(
              "us-east-1_abc",
            );
          },
        },
      },
    });
  });

  it("keeps identity providers inside the user pool", async () => {
    const pool = new CognitoUserPool("MyUserPool");
    const provider = pool.addIdentityProvider("Google", google);
    await pulumi.settle();

    expect(pool.nodes.identityProvider.Google).toBe(provider);
    expect(provider.constructor.name).toBe("IdentityProvider");
    expect(await pulumi.resolve(provider.providerName)).toBe("Google");
    expect(registered(PROVIDER)[0].parent.split("::").at(-1)).toBe("MyUserPool");
    expect(registered(PROVIDER)[0].inputs).toMatchObject({
      providerName: "Google",
      providerType: "Google",
      userPoolId: "MyUserPoolUserPool_id",
    });
  });

  it("returns a client that can be linked under its own name", async () => {
    const { Link } = await import("../../../src/components/link");
    const pool = new CognitoUserPool("MyUserPool");
    const client = pool.addClient("Web");
    await pulumi.settle();

    expect(await pulumi.resolve([client.id, client.secret])).toEqual([
      "WebClient_id",
      "shh",
    ]);
    expect(client.nodes.client.constructor.name).toBe("UserPoolClient");
    const props = await pulumi.resolve(Link.getProperties([client]));
    expect(props.Web).toMatchObject({ id: "WebClient_id", secret: "shh" });
  });

  it("rejects an identity provider that was already added", async () => {
    const pool = new CognitoUserPool("MyUserPool");
    pool.addIdentityProvider("Google", google);
    expect(() => pool.addIdentityProvider("Google", google)).toThrow(
      /already has an identity provider named "Google"/,
    );
    await pulumi.settle();
  });

  it("says where an identity provider's transform goes", async () => {
    const pool = new CognitoUserPool("MyUserPool");
    expect(() =>
      pool.addIdentityProvider("Google", { ...google, transform: {} } as any),
    ).toThrow(/its "identityProvider" applies to every identity provider/);
    await pulumi.settle();
  });

  it("keeps each trigger's function and permission under the trigger", async () => {
    const pool = new CognitoUserPool("MyUserPool", {
      triggers: {
        preSignUp: "src/preSignUp.handler",
        postConfirmation: FUNCTION_ARN,
      },
    });
    await pulumi.settle();

    expect(Object.keys(pool.nodes.trigger).sort()).toEqual([
      "postConfirmation",
      "preSignUp",
    ]);
    expect(Object.keys(pool.nodes.permission).sort()).toEqual([
      "postConfirmation",
      "preSignUp",
    ]);
    const fn = await pulumi.resolve(pool.nodes.trigger.preSignUp);
    expect((fn.constructor as any).__pulumiType).toBe("sst:aws:FunctionV5");
  });

  it("lets the user pool invoke a trigger given as an ARN", async () => {
    new CognitoUserPool("MyUserPool", {
      triggers: { postConfirmation: `${FUNCTION_ARN}:live` },
    });
    await pulumi.settle();

    expect(registered(PERMISSION).map((r) => [r.name, r.inputs])).toEqual([
      [
        "MyUserPoolPermissionPostConfirmation",
        {
          action: "lambda:InvokeFunction",
          function: FUNCTION_ARN,
          qualifier: "live",
          principal: "cognito-idp.amazonaws.com",
          sourceArn: "arn:aws:mock:us-east-1:123456789012:MyUserPoolUserPool",
        },
      ],
    ]);
    expect(registered(POOL)[0].inputs.lambdaConfig).toEqual({
      postConfirmation: `${FUNCTION_ARN}:live`,
    });
  });

  it("needs plain values for the domain and the triggers", async () => {
    const { output } = await import("@pulumi/pulumi");
    expect(
      () =>
        new CognitoUserPool("MyUserPool", {
          domain: output("auth.example.com") as any,
        }),
    ).toThrow(/"domain" of the "MyUserPool" user pool has to be a plain value/);
    expect(
      () =>
        new CognitoUserPool("Other", {
          triggers: output({ preSignUp: FUNCTION_ARN }) as any,
        }),
    ).toThrow(/"triggers" of the "Other" user pool has to be a plain value/);
    await pulumi.settle();
  });

  it("rejects settings that don't go together", async () => {
    expect(
      () =>
        new CognitoUserPool("MyUserPool", {
          aliases: ["email"],
          usernames: ["email"],
        }),
    ).toThrow(/cannot set both "aliases" and "usernames"/);
    expect(
      () =>
        new CognitoUserPool("Senders", {
          triggers: { customEmailSender: FUNCTION_ARN },
        }),
    ).toThrow(/must provide a KMS key via "kmsKey"/);
    expect(
      () =>
        new CognitoUserPool("Domain", {
          domain: { name: "auth.example.com", dns: false },
        }),
    ).toThrow(/"cert" is required when "dns" is disabled/);
    await pulumi.settle();
  });

  it("gives the URL of the hosted UI", async () => {
    const none = new CognitoUserPool("None");
    const prefix = new CognitoUserPool("Prefix", {
      domain: { prefix: "my-app-dev" },
    });
    const custom = new CognitoUserPool("Custom", {
      domain: { name: "auth.example.com", dns: false, cert: CERT_ARN },
    });
    await pulumi.settle();

    expect(none.domainUrl).toBeUndefined();
    expect(none.nodes.domain).toBeUndefined();
    expect(await pulumi.resolve([prefix.domainUrl, custom.domainUrl])).toEqual([
      "https://my-app-dev.auth.us-east-1.amazoncognito.com",
      "https://auth.example.com",
    ]);
    expect(custom.nodes.domain!.constructor.name).toBe("UserPoolDomain");
    expect(custom.nodes.certificate).toBeUndefined();
  });

  it("uses a user pool that's already deployed", async () => {
    const pool = CognitoUserPool.get("MyUserPool", "us-east-1_abc");
    const withDomain = new CognitoUserPool("Shared", {
      existing: { userPool: pool.nodes.userPool },
      domain: { prefix: "shared" },
    });
    await pulumi.settle();

    expect(await pulumi.resolve(pool.id)).toBe("us-east-1_abc");
    expect(withDomain.nodes.userPool).toBe(pool.nodes.userPool);
    expect(registered(POOL).map((r) => r.kind)).toEqual(["read"]);
    expect(
      registered("aws:cognito/userPoolDomain:UserPoolDomain")[0].inputs,
    ).toEqual({ domain: "shared", userPoolId: "us-east-1_abc" });

    // Its settings are its own
    expect(
      () =>
        new CognitoUserPool("Changed", {
          existing: { userPool: "us-east-1_abc" },
          mfa: "on",
          triggers: { preSignUp: FUNCTION_ARN },
        }),
    ).toThrow(
      /given an existing "userPool", so it doesn't create one and can't change its settings. Remove "mfa", "triggers"/,
    );
    await pulumi.settle();
  });

  it("links with its ID and access to the user pool", async () => {
    const { Link } = await import("../../../src/components/link");
    const pool = new CognitoUserPool("MyUserPool");
    await pulumi.settle();

    expect(Link.isLinkable(pool)).toBe(true);
    const link = (pool as any).getSSTLink();
    expect(await pulumi.resolve(link.properties)).toEqual({
      id: "MyUserPoolUserPool_id",
    });
    expect(await pulumi.resolve(link.include)).toMatchObject([
      {
        actions: ["cognito-idp:*"],
        resources: ["arn:aws:mock:us-east-1:123456789012:MyUserPoolUserPool"],
      },
    ]);
  });
});
