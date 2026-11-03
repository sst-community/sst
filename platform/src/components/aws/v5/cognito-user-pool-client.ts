import { ComponentResourceOptions } from "@pulumi/pulumi";
import { cognito } from "@pulumi/aws";
import { type ComponentArgs, component } from "../../parts-component";
import { withDefault } from "../../args";
import type { Input } from "../../input";

const parts = {
  /**
   * The Cognito User Pool client.
   */
  client: cognito.UserPoolClient,
};

export interface CognitoUserPoolClientArgs extends ComponentArgs<typeof parts> {
  /**
   * The Cognito user pool ID.
   */
  userPool: Input<string>;
  /**
   * A list of identity providers that are supported for this client.
   * @default `["COGNITO"]`
   * @example
   *
   * :::tip
   * Reference federated identity providers using their `providerName` property.
   * :::
   *
   * If you are using a federated identity provider.
   *
   * ```js title="sst.config.ts"
   * const provider = userPool.addIdentityProvider("MyProvider", {
   *   type: "oidc",
   *   details: {
   *     authorize_scopes: "email profile",
   *     client_id: "your-client-id",
   *     client_secret: "your-client-secret"
   *   },
   * });
   * ```
   *
   * Make sure to pass in `provider.providerName` instead of hardcoding it to `"MyProvider"`.
   *
   * ```ts title="sst.config.ts" {2}
   * userPool.addClient("Web", {
   *   providers: [provider.providerName]
   * });
   * ```
   *
   * This ensures the client is created after the provider.
   */
  providers?: Input<Input<string>[]>;
  /**
   * List of allowed callback URLs for the identity providers.
   * @default `["https://example.com"]`
   */
  callbackUrls?: Input<Input<string>[]>;
}

/**
 * The `CognitoUserPoolClient` component is a client of an [Amazon Cognito user pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html).
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * It's what the `addClient` method of the `CognitoUserPool` component returns. A client is
 * a component of its own, under the name you add it with, so you can link it.
 *
 * @example
 *
 * #### Link the client to a resource
 *
 * ```ts title="sst.config.ts"
 * const client = userPool.addClient("Web");
 *
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [client]
 * });
 * ```
 *
 * The client's ID and secret are then available as `Resource.Web.id` and
 * `Resource.Web.secret`.
 */
export class CognitoUserPoolClient extends component(
  "sst:aws:CognitoUserPoolClient",
  parts,
) {
  constructor(
    name: string,
    args: CognitoUserPoolClientArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    this.part("client", {
      name,
      userPoolId: args.userPool,
      allowedOauthFlows: ["implicit", "code"],
      allowedOauthFlowsUserPoolClient: true,
      allowedOauthScopes: [
        "profile",
        "phone",
        "email",
        "openid",
        "aws.cognito.signin.user.admin",
      ],
      callbackUrls: withDefault(args.callbackUrls, ["https://example.com"]),
      supportedIdentityProviders: withDefault(args.providers, ["COGNITO"]),
    });
  }

  /**
   * The Cognito User Pool client ID.
   */
  public get id() {
    return this.nodes.client.id;
  }

  /**
   * The Cognito User Pool client secret.
   */
  public get secret() {
    return this.nodes.client.clientSecret;
  }

  /**
   * Linking a client gives the linked resource its ID and its secret.
   */
  public link() {
    return {
      properties: { id: this.id, secret: this.secret },
    };
  }
}
