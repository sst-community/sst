import { ComponentResourceOptions } from "@pulumi/pulumi";
import { cognito } from "@pulumi/aws";
import { V5Args, component } from "../../parts-component";
import { withDefault } from "../../args";
import type { Input } from "../../input";
import type {
  CognitoUserPoolClientArgs as OriginalCognitoUserPoolClientArgs,
} from "../cognito-user-pool";

const parts = {
  /**
   * The Cognito User Pool client.
   */
  client: cognito.UserPoolClient,
};

export interface CognitoUserPoolClientArgs
  extends V5Args<OriginalCognitoUserPoolClientArgs, typeof parts> {
  /**
   * The Cognito user pool ID.
   */
  userPool: Input<string>;
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
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [client]
 * });
 * ```
 *
 * The client's ID and secret are then available as `Resource.Web.id` and
 * `Resource.Web.secret`.
 */
export class CognitoUserPoolClient extends component(
  "sst:aws:CognitoUserPoolClientV5",
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
