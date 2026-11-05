import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const POOL = "aws:cognito/identityPool:IdentityPool";
const ATTACHMENT =
  "aws:cognito/identityPoolRoleAttachment:IdentityPoolRoleAttachment";
const ROLE = "aws:iam/role:Role";
const POOL_ID = "us-east-1:02facf30-e2f3-49ec-9e79-c55187415cf8";

const pulumi = mockPulumi({
  // A role attachment that's looked up gives the roles attached to the pool
  state: (args) =>
    args.type === ATTACHMENT && !("roles" in args.inputs)
      ? {
          roles: {
            authenticated: "arn:aws:iam::123456789012:role/pool-auth",
            unauthenticated: "arn:aws:iam::123456789012:role/pool-unauth",
          },
        }
      : {},
});

type PoolClass =
  | typeof import("../../fixtures/v4/components/aws/cognito-identity-pool").CognitoIdentityPool
  | typeof import("../../../src/components/aws/cognito-identity-pool").CognitoIdentityPool;

describe("CognitoIdentityPool", () => {
  let Original: typeof import("../../fixtures/v4/components/aws/cognito-identity-pool").CognitoIdentityPool;
  let CognitoIdentityPool: typeof import("../../../src/components/aws/cognito-identity-pool").CognitoIdentityPool;
  let Function: typeof import("../../../src/components/aws/function").Function;

  beforeAll(async () => {
    Original = (
      await import("../../fixtures/v4/components/aws/cognito-identity-pool")
    ).CognitoIdentityPool;
    CognitoIdentityPool = (
      await import("../../../src/components/aws/cognito-identity-pool")
    ).CognitoIdentityPool;
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
  const registered = (type: string) =>
    pulumi.resources.filter((r) => r.type === type);

  // Each case deploys the 4.x CognitoIdentityPool, then the same thing as the
  // V5 one. Everything the 4.x one created has to be kept, with the same
  // inputs.
  describe("takes over a deployed CognitoIdentityPool", () => {
    pulumi.takeoverCases<PoolClass, PoolClass>({
      original: () => Original,
      v5: () => CognitoIdentityPool,
      cases: {
        "with nothing set": {
          create: (Pool, opts) => {
            new Pool("MyIdentityPool", {}, opts);
          },
          check: () =>
            expect(resource("MyIdentityPoolIdentityPool").type).toBe(POOL),
        },
        "with user pools and permissions": (Pool, opts) => {
          new Pool(
            "MyIdentityPool",
            {
              userPools: [
                { userPool: "us-east-1_QY6Ly46JH", client: "6va5jg3cgtrd" },
                { userPool: "us-east-1_other", client: "otherclient" },
              ],
              permissions: {
                authenticated: [
                  {
                    actions: ["s3:GetObject", "s3:PutObject"],
                    resources: ["arn:aws:s3:::my-bucket/*"],
                  },
                ],
                unauthenticated: [
                  {
                    actions: ["s3:GetObject"],
                    resources: ["arn:aws:s3:::my-bucket/*"],
                  },
                ],
              },
            },
            opts,
          );
        },
        "with settings given as outputs": (Pool, opts) => {
          new Pool(
            "MyIdentityPool",
            {
              userPools: output([
                { userPool: output("us-east-1_abc"), client: "client" },
              ]),
              permissions: output({
                authenticated: [
                  { actions: ["s3:GetObject"], resources: ["*"] },
                ],
              }),
            },
            opts,
          );
        },
        "with its pool and roles transformed": (Pool, opts) => {
          new Pool(
            "MyIdentityPool",
            {
              transform: {
                identityPool: (args: any) => {
                  args.allowUnauthenticatedIdentities = false;
                },
                authenticatedRole: { description: "Signed in" },
                unauthenticatedRole: (args: any) => {
                  args.description = "Signed out";
                },
              },
            },
            opts,
          );
        },
        // The 4.x `get` looks up the pool, the attachment and the roles at
        // the top of the app, and the V5 one inside the component. A lookup
        // owns nothing in AWS, so the old ones are forgotten and the same
        // resources are looked up again.
        "an identity pool referenced with get": {
          create: (Pool, opts) => Pool.get("MyIdentityPool", POOL_ID, opts),
          unclaimed: (way) => [
            `${POOL}::MyIdentityPoolIdentityPool`,
            `${ATTACHMENT}::MyIdentityPoolRoleAttachment`,
            `${ROLE}::MyIdentityPoolAuthRole`,
            `${ROLE}::MyIdentityPoolUnauthRole`,
            // It puts the component at the top of the app wherever it's
            // asked to be
            ...(way === "inside another component"
              ? ["sst:aws:CognitoIdentityPool::MyIdentityPool"]
              : []),
          ],
          check: () => {
            expect(registered(POOL).map((r) => [r.kind, r.options.id])).toEqual(
              [["read", POOL_ID]],
            );
            expect(
              registered(ROLE)
                .map((r) => r.options.id)
                .sort(),
            ).toEqual(["pool-auth", "pool-unauth"]);
          },
        },
      },
    });
  });

  it("creates the pool, its two roles, and their attachment", async () => {
    const pool = new CognitoIdentityPool("MyIdentityPool");
    await pulumi.settle();
    expect(resource("MyIdentityPoolAuthRole").type).toBe(ROLE);
    expect(resource("MyIdentityPoolUnauthRole").type).toBe(ROLE);
    expect(resource("MyIdentityPoolRoleAttachment").inputs.roles).toEqual({
      authenticated:
        "arn:aws:mock:us-east-1:123456789012:MyIdentityPoolAuthRole",
      unauthenticated:
        "arn:aws:mock:us-east-1:123456789012:MyIdentityPoolUnauthRole",
    });
    expect(pool.nodes.roleAttachment).toBeDefined();
  });

  it("uses an existing pool the way it is, with the roles given next to it", async () => {
    expect(
      () =>
        new CognitoIdentityPool("Refused", {
          userPools: [{ userPool: "us-east-1_abc", client: "abc" }],
          existing: { identityPool: POOL_ID },
        }),
    ).toThrow(
      /The "Refused" identity pool is given an existing "identityPool", which it uses the way it is. Remove "userPools" from its args/,
    );

    // A role given by its name is looked up by it, not by the attachment's
    const pool = new CognitoIdentityPool("MyIdentityPool", {
      existing: { identityPool: POOL_ID, authenticatedRole: "my-auth-role" },
    });
    await pulumi.settle();
    expect(
      registered(ROLE)
        .map((r) => r.options.id)
        .sort(),
    ).toEqual(["my-auth-role", "pool-unauth"]);
    expect(pool.nodes.authenticatedRole).toBeDefined();

    // What a $transform gives every identity pool isn't refused for one from
    // get
    const { $transform } = await import("../../../src/components/component");
    $transform(CognitoIdentityPool, (args, _opts, name) => {
      if (name === "TransformedPool") args!.permissions = { authenticated: [] };
    });
    CognitoIdentityPool.get("TransformedPool", POOL_ID);
    await pulumi.settle();
  });

  it("can be linked by a function", async () => {
    const pool = new CognitoIdentityPool("MyIdentityPool");
    new Function("Api", { handler: "src/api.handler", link: [pool] });
    await pulumi.settle();
    const policy = JSON.stringify(
      await pulumi.resolve(resource("ApiRole").inputs.inlinePolicies),
    );
    expect(policy).toContain("cognito-identity:*");
    expect(policy).toContain("MyIdentityPoolIdentityPool");
  });
});
