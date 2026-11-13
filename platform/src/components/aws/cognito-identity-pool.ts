import { ComponentResourceOptions, interpolate, output } from "@pulumi/pulumi";
import { cognito, getRegionOutput, iam } from "@pulumi/aws";
import { type ComponentArgs, component, named } from "../parts-component";
import { usedAsItIs, getArgs } from "../args";
import type { Input } from "../input";
import { permission } from "./permission";
import { parseRoleArn } from "./helpers/arn";
import type { FunctionArgs } from "./function";

const parts = () => ({
  /**
   * The Amazon Cognito identity pool.
   */
  identityPool: cognito.IdentityPool,
  /**
   * The IAM role authenticated users get.
   */
  authenticatedRole: named(iam.Role, "AuthRole"),
  /**
   * The IAM role unauthenticated users get.
   */
  unauthenticatedRole: named(iam.Role, "UnauthRole"),
  /**
   * The attachment of the two roles to the identity pool.
   */
  roleAttachment: cognito.IdentityPoolRoleAttachment,
});

export interface CognitoIdentityPoolArgs extends ComponentArgs<typeof parts> {
  /**
   * Configure Cognito User Pools as identity providers to your identity pool.
   * @example
   * ```ts
   * {
   *   userPools: [
   *     {
   *       userPool: "us-east-1_QY6Ly46JH",
   *       client: "6va5jg3cgtrd170sgokikjm5m6"
   *     }
   *   ]
   * }
   * ```
   */
  userPools?: Input<
    Input<{
      /**
       * The Cognito user pool ID.
       */
      userPool: Input<string>;
      /**
       * The Cognito User Pool client ID.
       */
      client: Input<string>;
    }>[]
  >;
  /**
   * The permissions to attach to the authenticated and unauthenticated roles.
   * This allows the authenticated and unauthenticated users to access other AWS resources.
   *
   * @example
   * ```js
   * {
   *   permissions: {
   *     authenticated: [
   *       {
   *         actions: ["s3:GetObject", "s3:PutObject"],
   *         resources: ["arn:aws:s3:::my-bucket/*"]
   *       }
   *     ],
   *     unauthenticated: [
   *       {
   *         actions: ["s3:GetObject"],
   *         resources: ["arn:aws:s3:::my-bucket/*"]
   *       }
   *     ]
   *   }
   * }
   * ```
   */
  permissions?: Input<{
    /**
     * Attaches the given list of permissions to the authenticated users.
     */
    authenticated?: FunctionArgs["permissions"];
    /**
     * Attaches the given list of permissions to the unauthenticated users.
     */
    unauthenticated?: FunctionArgs["permissions"];
  }>;
}

/**
 * The `CognitoIdentityPool` component lets you add a [Amazon Cognito identity pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-identity.html) to your app.
 *
 * #### Create the identity pool
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.CognitoIdentityPool("MyIdentityPool", {
 *   userPools: [
 *     {
 *       userPool: "us-east-1_QY6Ly46JH",
 *       client: "6va5jg3cgtrd170sgokikjm5m6"
 *     }
 *   ]
 * });
 * ```
 *
 * #### Configure permissions for authenticated users
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.CognitoIdentityPool("MyIdentityPool", {
 *   userPools: [
 *     {
 *       userPool: "us-east-1_QY6Ly46JH",
 *       client: "6va5jg3cgtrd170sgokikjm5m6"
 *     }
 *   ],
 *   permissions: {
 *     authenticated: [
 *       {
 *         actions: ["s3:GetObject", "s3:PutObject"],
 *         resources: ["arn:aws:s3:::my-bucket/*"]
 *       }
 *     ]
 *   }
 * });
 * ```
 *
 * #### Switch from SST 4's `sst.aws.CognitoIdentityPool`
 *
 * Keep the name, and `sst migrate` moves it. The identity pool, its two roles and their attachment are kept. A few things are
 * written differently:
 *
 * - `nodes` has the roles' attachment too, and `transform` takes it.
 * - An identity pool from `get` reads the pool, the attachment and the roles inside the
 *   component, where SST 4's `CognitoIdentityPool.get` read them at the top of the app. A
 *   read creates nothing, so the switch only drops the old ones from the state. The
 *   options given to `get`, like a `parent`, are the component's now: SST 4's `CognitoIdentityPool.get`
 *   gave them to the pool it read and put the component at the top of the app.
 * - An identity pool given in `existing`, as `get` gives it, is used the way it is:
 *   `userPools` and `permissions` next to it are refused, where they were dropped.
 */
export class CognitoIdentityPool extends component(
  "sst:aws:CognitoIdentityPool",
  parts,
) {
  constructor(
    name: string,
    args: CognitoIdentityPoolArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    // An identity pool that's already deployed keeps the settings it has, and
    // its roles are the ones attached to it, unless they're given too
    const existing = this.existingPart("identityPool");
    if (existing) {
      usedAsItIs(
        args,
        ["userPools", "permissions"],
        "identityPool",
        `the "${name}" identity pool`,
      );
      const attachment =
        this.existingPart("roleAttachment") ??
        this.lookupPart("roleAttachment", existing.id);
      for (const [key, role] of [
        ["authenticatedRole", attachment.roles.authenticated],
        ["unauthenticatedRole", attachment.roles.unauthenticated],
      ] as const)
        if (!this.existingPart(key))
          this.lookupPart(
            key,
            role.apply((arn) => parseRoleArn(arn).roleName),
          );
      return;
    }

    const region = getRegionOutput({}, { parent: this }).region;
    const identityPool = this.part("identityPool", {
      identityPoolName: "",
      allowUnauthenticatedIdentities: true,
      cognitoIdentityProviders:
        args.userPools &&
        output(args.userPools).apply((userPools) =>
          userPools.map((v) => ({
            clientId: v.client,
            providerName: interpolate`cognito-idp.${region}.amazonaws.com/${v.userPool}`,
          })),
        ),
      supportedLoginProviders: {},
    });

    // Who may take a role: the pool's users, signed in or not
    const assumedBy = (amr: string) =>
      iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              effect: "Allow",
              principals: [
                {
                  type: "Federated",
                  identifiers: ["cognito-identity.amazonaws.com"],
                },
              ],
              actions: ["sts:AssumeRoleWithWebIdentity"],
              conditions: [
                {
                  test: "StringEquals",
                  variable: "cognito-identity.amazonaws.com:aud",
                  values: [identityPool.id],
                },
                {
                  test: "ForAnyValue:StringLike",
                  variable: "cognito-identity.amazonaws.com:amr",
                  values: [amr],
                },
              ],
            },
          ],
        },
        { parent: this },
      ).json;

    const authRole = this.part("authenticatedRole", {
      assumeRolePolicy: assumedBy("authenticated"),
      inlinePolicies: [
        {
          name: "inline",
          policy: output(args.permissions).apply(
            (permissions) =>
              iam.getPolicyDocumentOutput(
                {
                  statements: [
                    {
                      effect: "Allow",
                      actions: [
                        "mobileanalytics:PutEvents",
                        "cognito-sync:*",
                        "cognito-identity:*",
                      ],
                      resources: ["*"],
                    },
                    ...(permissions?.authenticated || []),
                  ],
                },
                { parent: this },
              ).json,
          ),
        },
      ],
    });

    const unauthRole = this.part("unauthenticatedRole", {
      assumeRolePolicy: assumedBy("unauthenticated"),
      inlinePolicies: [
        {
          name: "inline",
          policy: output(args.permissions).apply(
            (permissions) =>
              iam.getPolicyDocumentOutput(
                {
                  statements: [
                    {
                      effect: "Allow",
                      actions: ["mobileanalytics:PutEvents", "cognito-sync:*"],
                      resources: ["*"],
                    },
                    ...(permissions?.unauthenticated || []),
                  ],
                },
                { parent: this },
              ).json,
          ),
        },
      ],
    });

    this.part("roleAttachment", {
      identityPoolId: identityPool.id,
      roles: {
        authenticated: authRole.arn,
        unauthenticated: unauthRole.arn,
      },
    });
  }

  /**
   * The Cognito identity pool ID.
   */
  public get id() {
    return this.nodes.identityPool.id;
  }

  link() {
    return {
      properties: {
        id: this.id,
      },
      include: [
        permission({
          actions: ["cognito-identity:*"],
          resources: [this.nodes.identityPool.arn],
        }),
      ],
    };
  }

  /**
   * Reference an existing Identity Pool with the given ID. This is useful when you
   * create a Identity Pool in one stage and want to share it in another. It avoids having to
   * create a new Identity Pool in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share Identity Pools across stages.
   * :::
   *
   * @param name The name of the component.
   * @param identityPoolID The ID of the existing Identity Pool.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a Identity Pool in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new pool, you want to share the same pool from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const identityPool = $app.stage === "frank"
   *   ? sst.aws.CognitoIdentityPool.get("MyIdentityPool", "us-east-1:02facf30-e2f3-49ec-9e79-c55187415cf8")
   *   : new sst.aws.CognitoIdentityPool("MyIdentityPool");
   * ```
   *
   * Here `us-east-1:02facf30-e2f3-49ec-9e79-c55187415cf8` is the ID of the Identity Pool created in the `dev` stage.
   * You can find this by outputting the Identity Pool ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   identityPool: identityPool.id
   * };
   * ```
   */
  public static get(
    name: string,
    identityPoolID: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new CognitoIdentityPool(
      name,
      getArgs({ existing: { identityPool: identityPoolID } }),
      opts,
    );
  }
}
