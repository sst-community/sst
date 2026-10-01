import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";

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

describe("CognitoUserPoolV5", () => {
  let CognitoUserPool: typeof import("../../src/components/aws/cognito-user-pool").CognitoUserPool;
  let CognitoUserPoolV5: typeof import("../../src/components/aws/cognito-user-pool-v5").CognitoUserPoolV5;

  beforeAll(async () => {
    ({ CognitoUserPool } = await import(
      "../../src/components/aws/cognito-user-pool"
    ));
    ({ CognitoUserPoolV5 } = await import(
      "../../src/components/aws/cognito-user-pool-v5"
    ));
    await import("../../src/components/aws/takeover/cognito-user-pool");
    await import("../../src/components/aws/takeover/function");
    await import("../../src/components/aws/takeover/cognito-user-pool-client");
  });

  beforeEach(() => pulumi.reset());

  const registered = (type: string) =>
    pulumi.resources.filter((r) => r.type === type);

  // The same, for args both components take as they are. The user pool has
  // to be there, so the comparison isn't an empty one.
  async function expectSameArgs(args: any) {
    await pulumi.expectTakeover(
      () => new CognitoUserPool("MyUserPool", args),
      () => new CognitoUserPoolV5("MyUserPool", args),
    );
    expect(registered(POOL).map((r) => r.name)).toEqual(["MyUserPoolUserPool"]);
  }

  describe("takes over a deployed CognitoUserPool", () => {
    it("default user pool", async () => {
      await expectSameArgs(undefined);
      await expectSameArgs({});
    });

    it("usernames and aliases", async () => {
      await expectSameArgs({ usernames: ["email"] });
      await expectSameArgs({ usernames: ["phone", "email"] });
      await expectSameArgs({ aliases: ["preferred_username", "email"] });
      await expectSameArgs({ aliases: ["phone"] });
    });

    it("mfa, sms and software tokens", async () => {
      await expectSameArgs({
        mfa: "on",
        softwareToken: true,
        sms: {
          externalId: "1234567890",
          snsCallerArn: "arn:aws:iam::123456789012:role/CognitoSnsCaller",
          snsRegion: "us-east-1",
        },
        smsAuthenticationMessage: "Your authentication code is {####}",
      });
      await expectSameArgs({ mfa: "optional", softwareToken: false });
    });

    it("advanced security and the verification message", async () => {
      await expectSameArgs({ advancedSecurity: "enforced" });
      await expectSameArgs({
        advancedSecurity: "audit",
        verify: { emailSubject: "Verify your new Awesome account" },
      });
      await expectSameArgs({
        verify: {
          emailMessage: "Email code {####}",
          smsMessage: "SMS code {####}",
        },
      });
    });

    it("triggers given as ARNs", async () => {
      await expectSameArgs({
        triggers: {
          kmsKey: KMS_KEY_ARN,
          customEmailSender: FUNCTION_ARN,
          customSmsSender: `${FUNCTION_ARN}:live`,
          preSignUp: FUNCTION_ARN,
          postConfirmation: FUNCTION_ARN,
          preTokenGeneration: FUNCTION_ARN,
          preTokenGenerationVersion: "v2",
        },
      });
      // The user pool is told about each one, and may invoke each one
      expect(Object.keys(registered(POOL)[0].inputs.lambdaConfig)).toEqual([
        "customEmailSender",
        "customSmsSender",
        "kmsKeyId",
        "postConfirmation",
        "preSignUp",
        "preTokenGenerationConfig",
      ]);
      expect(registered(PERMISSION).map((r) => r.name).sort()).toEqual([
        "MyUserPoolPermissionCustomEmailSender",
        "MyUserPoolPermissionCustomSmsSender",
        "MyUserPoolPermissionPostConfirmation",
        "MyUserPoolPermissionPreSignUp",
        "MyUserPoolPermissionPreTokenGeneration",
      ]);

      await expectSameArgs({ triggers: { preTokenGeneration: FUNCTION_ARN } });
      await expectSameArgs({ triggers: {} });
    });

    it("triggers given as handlers", async () => {
      const args = {
        triggers: {
          preAuthentication: "src/preAuthentication.handler",
          postAuthentication: { handler: "src/postAuthentication.handler" },
        },
      };
      await expectSameArgs(args);
      // The functions are inside the user pool, and the user pool can
      // invoke them
      expect(
        registered("sst:aws:FunctionV5")
          .map((r) => [r.name, r.parent.split("::").at(-1)])
          .sort(),
      ).toEqual([
        ["MyUserPoolTriggerPostAuthentication", "MyUserPool"],
        ["MyUserPoolTriggerPreAuthentication", "MyUserPool"],
      ]);
      expect(registered("aws:lambda/permission:Permission").length).toBe(2);
    });

    it("a prefix domain", async () => {
      await expectSameArgs({ domain: { prefix: "my-app-dev" } });
      expect(
        registered("aws:cognito/userPoolDomain:UserPoolDomain")[0].inputs,
      ).toEqual({ domain: "my-app-dev", userPoolId: "MyUserPoolUserPool_id" });
    });

    it("a custom domain on Route 53", async () => {
      await expectSameArgs({ domain: "auth.example.com" });
      // The certificate, its record and the alias records are all there
      const types = pulumi.resources.map((r) => r.type);
      expect(types).toContain("sst:aws:Certificate");
      expect(types).toContain("aws:cognito/userPoolDomain:UserPoolDomain");
      expect(
        types.filter((type) => type === "aws:route53/record:Record").length,
      ).toBe(3);
      // The certificate is still made in us-east-1
      expect(
        registered("aws:acm/certificate:Certificate")[0].options.provider,
      ).toContain("AwsProvider.sst.us-east-1");
    });

    it("a custom domain with its own certificate", async () => {
      await expectSameArgs({
        domain: { name: "auth.example.com", dns: false, cert: CERT_ARN },
      });
      await expectSameArgs({
        domain: { name: "auth.example.com", cert: CERT_ARN },
      });
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
            new CognitoUserPool("MyUserPool", {
              domain: { name: "auth.example.com", dns: dns() },
            }),
          () =>
            new CognitoUserPoolV5("MyUserPool", {
              domain: { name: "auth.example.com", dns: dns() },
            }),
        );
      }
    });

    it("transforms", async () => {
      await expectSameArgs({
        domain: { prefix: "my-app-dev" },
        transform: {
          userPool: { deletionProtection: "ACTIVE" },
          domain: (args: any): undefined => {
            args.managedLoginVersion = 2;
          },
        },
      });
    });

    it("clients", async () => {
      await pulumi.expectTakeover(
        () => {
          const pool = new CognitoUserPool("MyUserPool");
          pool.addClient("Web");
          pool.addClient("Mobile", {
            providers: ["COGNITO", "Google"],
            callbackUrls: ["https://app.example.com/callback"],
            transform: { client: { generateSecret: true } },
          });
        },
        () => {
          const pool = new CognitoUserPoolV5("MyUserPool");
          pool.addClient("Web");
          pool.addClient("Mobile", {
            providers: ["COGNITO", "Google"],
            callbackUrls: ["https://app.example.com/callback"],
            transform: { client: { generateSecret: true } },
          });
        },
      );
      // A client stays a component of its own, named after the client
      expect(registered(CLIENT).map((r) => r.name)).toEqual([
        "WebClient",
        "MobileClient",
      ]);
      expect(registered(CLIENT)[1].inputs.generateSecret).toBe(true);
    });

    it("identity providers, and a client that uses one", async () => {
      const oidc = {
        type: "oidc",
        details: { client_id: "id", oidc_issuer: "https://github.com/" },
      } as const;
      await pulumi.expectTakeover(
        () => {
          const pool = new CognitoUserPool("MyUserPool");
          const provider = pool.addIdentityProvider("Google", google);
          pool.addIdentityProvider("GitHub", oidc);
          pool.addClient("Web", { providers: [provider.providerName] });
        },
        () => {
          const pool = new CognitoUserPoolV5("MyUserPool");
          const provider = pool.addIdentityProvider("Google", google);
          pool.addIdentityProvider("GitHub", oidc);
          pool.addClient("Web", { providers: [provider.providerName] });
        },
        2,
      );
      expect(registered(PROVIDER).length).toBe(2);
      expect(registered(CLIENT)[0].inputs.supportedIdentityProviders).toEqual([
        "Google",
      ]);
    });

    it("a provider's transform, set on the user pool", async () => {
      const identityProvider = { idpIdentifiers: ["google"] };
      await pulumi.expectTakeover(
        () => {
          const pool = new CognitoUserPool("MyUserPool");
          pool.addIdentityProvider("Google", {
            ...google,
            transform: { identityProvider },
          });
        },
        () => {
          const pool = new CognitoUserPoolV5("MyUserPool", {
            transform: { identityProvider },
          });
          pool.addIdentityProvider("Google", google);
        },
        1,
      );
    });

    // The user pool itself is NOT carried over, and this says so rather than
    // hiding it. `CognitoUserPool.get` looks the user pool up at the top of
    // the app, outside the component. `CognitoUserPoolV5.get` looks it up
    // inside the component, and a looked-up part can't be given the address
    // it had before. A lookup owns nothing in AWS: the old one is forgotten
    // and the same user pool is looked up again. The client is carried over.
    it("a user pool referenced with get, and what's added to it", async () => {
      const result = await pulumi.takesOver(
        () => {
          const pool = CognitoUserPool.get("MyUserPool", "us-east-1_abc");
          pool.addClient("Web");
        },
        () => {
          const pool = CognitoUserPoolV5.get("MyUserPool", "us-east-1_abc");
          pool.addClient("Web");
        },
      );
      expect(result).toEqual({
        unclaimed: [`${POOL}::MyUserPoolUserPool`],
        changed: [],
      });
      expect(registered(POOL).map((r) => [r.kind, r.options.id])).toEqual([
        ["read", "us-east-1_abc"],
      ]);
      expect(registered(CLIENT)[0].inputs.userPoolId).toBe("us-east-1_abc");
    });
  });

  it("keeps identity providers inside the user pool", async () => {
    const pool = new CognitoUserPoolV5("MyUserPool");
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
    const { Link } = await import("../../src/components/link");
    const pool = new CognitoUserPoolV5("MyUserPool");
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
    const pool = new CognitoUserPoolV5("MyUserPool");
    pool.addIdentityProvider("Google", google);
    expect(() => pool.addIdentityProvider("Google", google)).toThrow(
      /already has an identity provider named "Google"/,
    );
    await pulumi.settle();
  });

  it("says where an identity provider's transform goes", async () => {
    const pool = new CognitoUserPoolV5("MyUserPool");
    expect(() =>
      pool.addIdentityProvider("Google", { ...google, transform: {} } as any),
    ).toThrow(/its "identityProvider" applies to every identity provider/);
    await pulumi.settle();
  });

  it("keeps each trigger's function and permission under the trigger", async () => {
    const pool = new CognitoUserPoolV5("MyUserPool", {
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
    expect(fn.constructor.name).toBe("FunctionV5");
  });

  it("lets the user pool invoke a trigger given as an ARN", async () => {
    new CognitoUserPoolV5("MyUserPool", {
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
        new CognitoUserPoolV5("MyUserPool", {
          domain: output("auth.example.com") as any,
        }),
    ).toThrow(/"domain" of the "MyUserPool" user pool has to be a plain value/);
    expect(
      () =>
        new CognitoUserPoolV5("Other", {
          triggers: output({ preSignUp: FUNCTION_ARN }) as any,
        }),
    ).toThrow(/"triggers" of the "Other" user pool has to be a plain value/);
    await pulumi.settle();
  });

  it("rejects settings that don't go together", async () => {
    expect(
      () =>
        new CognitoUserPoolV5("MyUserPool", {
          aliases: ["email"],
          usernames: ["email"],
        }),
    ).toThrow(/cannot set both "aliases" and "usernames"/);
    expect(
      () =>
        new CognitoUserPoolV5("Senders", {
          triggers: { customEmailSender: FUNCTION_ARN },
        }),
    ).toThrow(/must provide a KMS key via "kmsKey"/);
    expect(
      () =>
        new CognitoUserPoolV5("Domain", {
          domain: { name: "auth.example.com", dns: false },
        }),
    ).toThrow(/"cert" is required when "dns" is disabled/);
    await pulumi.settle();
  });

  it("gives the URL of the hosted UI", async () => {
    const none = new CognitoUserPoolV5("None");
    const prefix = new CognitoUserPoolV5("Prefix", {
      domain: { prefix: "my-app-dev" },
    });
    const custom = new CognitoUserPoolV5("Custom", {
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
    const pool = CognitoUserPoolV5.get("MyUserPool", "us-east-1_abc");
    const withDomain = new CognitoUserPoolV5("Shared", {
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
        new CognitoUserPoolV5("Changed", {
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
    const { Link } = await import("../../src/components/link");
    const pool = new CognitoUserPoolV5("MyUserPool");
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
