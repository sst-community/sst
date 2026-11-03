import {
  ComponentResourceOptions,
  Output,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { cognito, getRegionOutput, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { ifSet, plain, withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { Function } from "./function";
import { type DomainArgs, domainOf } from "../helpers/domain";
import {
  type FunctionInput,
  type FunctionPart,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import { invokePermissionArgs } from "../helpers/function-permission";
import { useProvider } from "../helpers/provider";
import { permission } from "../permission";
import {
  CognitoUserPoolClient,
  type CognitoUserPoolClientArgs,
} from "./cognito-user-pool-client";

const parts = () => ({
  /**
   * The Amazon Cognito User Pool.
   */
  userPool: cognito.UserPool,
  /**
   * The function behind each trigger, by trigger: `preSignUp`,
   * `postConfirmation` and so on.
   */
  trigger: many(deferred(Function)),
  /**
   * The permission that lets the user pool invoke each trigger's function, by
   * trigger.
   */
  permission: many(lambda.Permission),
  /**
   * The certificate for the custom domain, created when `domain` is a custom
   * domain without a `cert`.
   */
  certificate: optional(DnsValidatedCertificate),
  /**
   * The domain of the hosted UI, when `domain` is set.
   */
  domain: optional(cognito.UserPoolDomain),
  /**
   * The identity providers added with `addIdentityProvider`, by provider name.
   */
  identityProvider: many(cognito.IdentityProvider),
});

export interface CognitoUserPoolTriggers {
  /**
   * The ARN of the AWS KMS key used for encryption.
   *
   * When `customEmailSender` or `customSmsSender` are configured, Cognito encrypts the
   * verification code and temporary passwords before sending them to your Lambda functions.
   */
  kmsKey?: Input<string>;
  /**
   * Triggered after the user successfully responds to the previous challenge, and a new
   * challenge needs to be created.
   */
  createAuthChallenge?: FunctionInput;
  /**
   * Triggered during events like user sign-up, password recovery, email/phone number
   * verification, and when an admin creates a user. Use this trigger to customize the
   * email provider.
   */
  customEmailSender?: FunctionInput;
  /**
   * Triggered during events like user sign-up, password recovery, email/phone number
   * verification, and when an admin creates a user. Use this trigger to customize the
   * message that is sent to your users.
   */
  customMessage?: FunctionInput;
  /**
   * Triggered when an SMS message needs to be sent, such as for MFA or verification codes.
   * Use this trigger to customize the SMS provider.
   */
  customSmsSender?: FunctionInput;
  /**
   * Triggered after each challenge response to determine the next action. Evaluates whether the
   * user has completed the authentication process or if additional challenges are needed.
   */
  defineAuthChallenge?: FunctionInput;
  /**
   * Triggered after a successful authentication event. Use this to perform custom actions,
   * such as logging or modifying user attributes, after the user is authenticated.
   */
  postAuthentication?: FunctionInput;
  /**
   * Triggered after a user is successfully confirmed; sign-up or email/phone number
   * verification. Use this to perform additional actions, like sending a welcome email or
   * initializing user data, after user confirmation.
   */
  postConfirmation?: FunctionInput;
  /**
   * Triggered before the authentication process begins. Use this to implement custom
   * validation or checks (like checking if the user is banned) before continuing
   * authentication.
   */
  preAuthentication?: FunctionInput;
  /**
   * Triggered before the user sign-up process completes. Use this to perform custom
   * validation, auto-confirm users, or auto-verify attributes based on custom logic.
   */
  preSignUp?: FunctionInput;
  /**
   * Triggered before tokens are generated in the authentication process. Use this to
   * customize or add claims to the tokens that will be generated and returned to the user.
   */
  preTokenGeneration?: FunctionInput;
  /**
   * The version of the preTokenGeneration trigger to use. Higher versions have access to
   * more information that support new features.
   * @default `"v1"`
   */
  preTokenGenerationVersion?: "v1" | "v2";
  /**
   * Triggered when a user attempts to sign in but does not exist in the current user pool.
   * Use this to import and validate users from an existing user directory into the
   * Cognito User Pool during sign-in.
   */
  userMigration?: FunctionInput;
  /**
   * Triggered after the user responds to a custom authentication challenge. Use this to
   * verify the user's response to the challenge and determine whether to continue
   * authenticating the user.
   */
  verifyAuthChallengeResponse?: FunctionInput;
}

export interface CognitoUserPoolPrefixDomainArgs {
  /**
   * Use an Amazon Cognito prefix domain. Creates a domain at
   * `{prefix}.auth.{region}.amazoncognito.com`.
   *
   * Cannot contain "aws", "amazon", or "cognito".
   */
  prefix: Input<string>;
}

export interface CognitoUserPoolDomainArgs extends DomainArgs {
  /**
   * The custom domain name. Must be a subdomain (e.g., `auth.example.com`). A plain value:
   * the DNS records are named after it.
   */
  name: string;
  /**
   * The ARN of an ACM (AWS Certificate Manager) certificate that proves ownership of the
   * domain. By default, a certificate is created and validated automatically.
   *
   * Cognito serves a custom domain through CloudFront, which takes its certificate from the
   * `us-east-1` region. The one that's created for you is created there, and one you pass
   * in has to be there too.
   */
  cert?: Input<string>;
}

export interface CognitoUserPoolArgs extends ComponentArgs<typeof parts> {
  /**
   * Configure the different ways a user can sign in besides using their username.
   *
   * :::note
   * You cannot change the aliases property once the User Pool has been created.
   * Learn more about [aliases](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases).
   * :::
   *
   * @default User can only sign in with their username.
   * @example
   *
   * ```ts
   * {
   *   aliases: ["email"]
   * }
   * ```
   */
  aliases?: Input<Input<"email" | "phone" | "preferred_username">[]>;
  /**
   * Allow users to be able to sign up and sign in with an email addresses or phone number
   * as their username.
   *
   * :::note
   * You cannot change the usernames property once the User Pool has been created.
   * Learn more about [aliases](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases).
   * :::
   *
   * @default User can only sign in with their username.
   * @example
   *
   * ```ts
   * {
   *   usernames: ["email"]
   * }
   * ```
   */
  usernames?: Input<Input<"email" | "phone">[]>;
  /**
   * Enable advanced security features.
   *
   * Learn more about [advanced security](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-advanced-security.html).
   *
   * @default Advanced security is disabled.
   * @example
   *
   * ```ts
   * {
   *   advancedSecurity: "enforced"
   * }
   * ```
   */
  advancedSecurity?: Input<"audit" | "enforced">;
  /**
   * Configure the multi-factor authentication (MFA) settings for the User Pool.
   *
   * If you enable MFA using `on` or `optional`, you need to configure either `sms` or
   * `softwareToken` as well.
   *
   * @default MFA is disabled.
   * @example
   *
   * ```ts
   * {
   *   mfa: "on"
   * }
   * ```
   */
  mfa?: Input<"on" | "optional">;
  /**
   * Configure the SMS settings for the User Pool.
   *
   * @default No SMS settings.
   * @example
   *
   * ```ts
   * {
   *   sms: {
   *     externalId: "1234567890",
   *     snsCallerArn: "arn:aws:iam::1234567890:role/CognitoSnsCaller",
   *     snsRegion: "us-east-1",
   *   }
   * }
   * ```
   */
  sms?: Input<{
    /**
     * The external ID used in IAM role trust relationships.
     *
     * Learn more about [external IDs](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html).
     */
    externalId: Input<string>;
    /**
     * The ARN of the IAM role that Amazon Cognito can assume to access the Amazon SNS
     *
     */
    snsCallerArn: Input<string>;
    /**
     * The AWS Region that Amazon Cognito uses to send SMS messages.
     */
    snsRegion?: Input<string>;
  }>;
  /**
   * The message template for SMS messages sent to users who are being authenticated.
   *
   * The template must include the `{####}` placeholder, which will be replaced with the
   * verification code.
   *
   * @default The default message template.
   * @example
   *
   * ```ts
   * {
   *   smsAuthenticationMessage: "Your authentication code is {####}"
   * }
   * ```
   */
  smsAuthenticationMessage?: Input<string>;
  /**
   * Configure the verification message sent to users who are being authenticated.
   */
  verify?: Input<{
    /**
     * Subject line for Email messages sent to users who are being authenticated.
     *
     * @default `"Verify your new account"`
     * @example
     *
     * ```ts
     * {
     *   verify: {
     *     emailSubject: "Verify your new Awesome account"
     *   }
     * }
     * ```
     */
    emailSubject?: Input<string>;
    /**
     * The template for email messages sent to users who are being authenticated.
     *
     * The template must include the `{####}` placeholder, which will be replaced with the
     * verification code.
     *
     * @default `"The verification code to your new account is {####}"`
     * @example
     *
     * ```ts
     * {
     *   verify: {
     *     emailMessage: "The verification code to your new Awesome account is {####}"
     *   }
     * }
     * ```
     */
    emailMessage?: Input<string>;
    /**
     * The template for SMS messages sent to users who are being authenticated.
     *
     * The template must include the `{####}` placeholder, which will be replaced with the
     * verification code.
     *
     * @default `"The verification code to your new account is {####}"`
     * @example
     *
     * ```ts
     * {
     *   verify: {
     *     smsMessage: "The verification code to your new Awesome account is {####}"
     *   }
     * }
     * ```
     */
    smsMessage?: Input<string>;
  }>;
  /**
   * Enable software token MFA for the User Pool.
   *
   * @default `false`
   * @example
   *
   * ```ts
   * {
   *   softwareToken: true
   * }
   * ```
   */
  softwareToken?: Input<boolean>;
  /**
   * Configure triggers for this User Pool. Each one takes the handler path or the function
   * args, which are plain values, or a function you already have, or its ARN. The
   * `triggers` are a plain value too: they decide which functions are created.
   *
   * The functions are in the user pool's `nodes.trigger`, by trigger, and
   * `transform.trigger` changes them.
   *
   * @default No triggers
   * @example
   *
   * ```js
   * {
   *   triggers: {
   *     preAuthentication: "src/preAuthentication.handler",
   *     postAuthentication: "src/postAuthentication.handler"
   *   }
   * }
   * ```
   */
  triggers?: Prettify<CognitoUserPoolTriggers>;
  /**
   * Configure a domain for the User Pool's hosted UI.
   *
   * You can use either a Cognito-provided prefix domain or your own custom domain. The
   * domain has to be a plain value, and so do a custom domain's `name` and `dns`: they
   * decide the certificate and the DNS records.
   *
   * @example
   *
   * Add a Cognito prefix domain.
   *
   * ```ts
   * {
   *   domain: {
   *     prefix: "my-app-dev"
   *   }
   * }
   * ```
   *
   * This creates a domain at `my-app-dev.auth.{region}.amazoncognito.com`.
   *
   * Add a custom domain. By default, creates an ACM certificate and configures
   * DNS records using Route 53.
   *
   * ```ts
   * {
   *   domain: "auth.example.com"
   * }
   * ```
   *
   * Use a domain hosted on Cloudflare.
   *
   * ```ts
   * {
   *   domain: {
   *     name: "auth.example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   */
  domain?:
    | string
    | CognitoUserPoolPrefixDomainArgs
    | Prettify<CognitoUserPoolDomainArgs>;
}

export interface CognitoUserPoolAddClientArgs
  extends Omit<CognitoUserPoolClientArgs, "userPool"> {}

export interface CognitoUserPoolIdentityProviderArgs {
  /**
   * The type of identity provider.
   */
  type: Input<"oidc" | "saml" | "google" | "facebook" | "apple" | "amazon">;
  /**
   * Configure the identity provider details, including the scopes, URLs, and identifiers.
   *
   * ```ts
   * {
   *   authorize_scopes: "email profile",
   *   client_id: "your-client-id",
   *   client_secret: "your-client-secret"
   * }
   * ```
   */
  details: Input<Record<string, Input<string>>>;
  /**
   * Define a mapping between identity provider attributes and user pool attributes.
   *
   * ```ts
   * {
   *   email: "email",
   *   username: "sub"
   * }
   * ```
   */
  attributes?: Input<Record<string, Input<string>>>;
}

/**
 * The `CognitoUserPool` component lets you add a [Amazon Cognito User Pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have. That includes its identity
 * providers and the functions behind its triggers.
 *
 * @example
 *
 * #### Create the user pool
 *
 * ```ts title="sst.config.ts"
 * const userPool = new sst.aws.v5.CognitoUserPool("MyUserPool");
 * ```
 *
 * #### Login using email
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CognitoUserPool("MyUserPool", {
 *   usernames: ["email"]
 * });
 * ```
 *
 * #### Add a hosted UI domain
 *
 * Use a Cognito prefix domain for the hosted UI.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CognitoUserPool("MyUserPool", {
 *   domain: {
 *     prefix: "my-app-dev"
 *   }
 * });
 * ```
 *
 * Or use your own custom domain.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CognitoUserPool("MyUserPool", {
 *   domain: "auth.example.com"
 * });
 * ```
 *
 * #### Configure triggers
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.CognitoUserPool("MyUserPool", {
 *   triggers: {
 *     preAuthentication: "src/preAuthentication.handler",
 *     postAuthentication: "src/postAuthentication.handler",
 *   },
 * });
 * ```
 *
 * #### Add Google identity provider
 *
 * ```ts title="sst.config.ts"
 * const GoogleClientId = new sst.Secret("GOOGLE_CLIENT_ID");
 * const GoogleClientSecret = new sst.Secret("GOOGLE_CLIENT_SECRET");
 *
 * const provider = userPool.addIdentityProvider("Google", {
 *   type: "google",
 *   details: {
 *     authorize_scopes: "email profile",
 *     client_id: GoogleClientId.value,
 *     client_secret: GoogleClientSecret.value,
 *   },
 *   attributes: {
 *     email: "email",
 *     name: "name",
 *     username: "sub",
 *   },
 * });
 * ```
 *
 * #### Add a client
 *
 * ```ts title="sst.config.ts"
 * const client = userPool.addClient("Web", {
 *   providers: [provider.providerName]
 * });
 * ```
 *
 * A client is a component of its own, so you can link it. Its ID and secret are then
 * available as `Resource.Web.id` and `Resource.Web.secret`.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [client]
 * });
 * ```
 *
 * #### Switch from `sst.aws.CognitoUserPool`
 *
 * Change `sst.aws.CognitoUserPool` to `sst.aws.v5.CognitoUserPool` and keep the name. The
 * user pool, its domain, its clients, its identity providers and its trigger functions are
 * kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const userPool = new sst.aws.CognitoUserPool("MyUserPool");
 * const userPool = new sst.aws.v5.CognitoUserPool("MyUserPool");
 * ```
 *
 * A few things work differently:
 *
 * - `addIdentityProvider` returns the Cognito identity provider. `provider.providerName`
 *   reads as before.
 * - An identity provider's own `transform` becomes the user pool's
 *   `transform.identityProvider`.
 * - `domain`, with a custom domain's `name` and `dns`, has to be a plain value, not an
 *   output. So do `triggers`, and each trigger's handler or function args: they decide
 *   what's created. A function you already have, or its ARN, can still be an output.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - `domain.dns` is an adapter SST 5's components use, like `sst.aws.dns()`,
 *   `sst.cloudflare.dns()` or `sst.vercel.dns()`. An object written by hand for SST 4's
 *   doesn't work.
 * - The DNS records that validate the certificate are named after the domain they
 *   validate, and a domain's hosted zone is found without a resource: SST 4's
 *   `HostedZoneLookup`, and Cloudflare's `ZoneLookup`, leave the state.
 * - An identity provider is created inside the user pool, with the provider the user pool
 *   has. `sst.aws.CognitoUserPool` created it beside the user pool, with only a `provider`
 *   passed to the user pool itself. So if your user pool takes its provider from a parent
 *   component or from `providers`, its identity providers are replaced on switch: remove
 *   them and deploy before you switch, then add them back.
 * - `get` gives its options to the component, so a `provider` you pass it reaches the
 *   clients and identity providers you add, and a `parent` or `providers` the identity
 *   providers. `sst.aws.CognitoUserPool.get` gave them to the user pool it looked up and
 *   to nothing else. So a client or an identity provider added to a user pool from `get`
 *   with a provider is replaced on switch, and a client gets a new ID.
 * - `nodes.userPool` is the user pool, not an output of it. `nodes` has every resource,
 *   the certificate, the trigger functions and the identity providers included.
 */
export class CognitoUserPool extends component(
  "sst:aws:CognitoUserPool",
  parts,
) {
  private hostedUiUrl?: Output<string>;

  constructor(
    name: string,
    args: CognitoUserPoolArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    // A user pool that's already deployed keeps the settings it has
    if (this.existingPart("userPool")) {
      const settings = SETTINGS.filter((key) => args[key] !== undefined);
      if (settings.length > 0)
        throw new VisibleError(
          `The "${name}" user pool is given an existing "userPool", so it doesn't create one and can't change its settings. Remove ${settings.map((key) => `"${key}"`).join(", ")}.`,
        );
    }
    if (args.aliases && args.usernames)
      throw new VisibleError(
        `You cannot set both "aliases" and "usernames" for the "${name}" user pool. Learn more about customizing sign-in attributes at https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases`,
      );

    const triggers = this.createTriggers(args.triggers);

    const userPool = this.part("userPool", {
      aliasAttributes:
        args.aliases &&
        output(args.aliases).apply((names) =>
          signInAttributes(names, "email", "phone", "preferred_username"),
        ),
      usernameAttributes:
        args.usernames &&
        output(args.usernames).apply((names) =>
          signInAttributes(names, "email", "phone"),
        ),
      accountRecoverySetting: {
        recoveryMechanisms: [
          { name: "verified_phone_number", priority: 1 },
          { name: "verified_email", priority: 2 },
        ],
      },
      adminCreateUserConfig: { allowAdminCreateUserOnly: false },
      usernameConfiguration: { caseSensitive: false },
      autoVerifiedAttributes: all([
        args.aliases ?? [],
        args.usernames ?? [],
      ]).apply(([byAlias, byUsername]) =>
        signInAttributes([...byAlias, ...byUsername], "email", "phone"),
      ),
      emailConfiguration: { emailSendingAccount: "COGNITO_DEFAULT" },
      verificationMessageTemplate: ifSet(args.verify, (verify) => ({
        defaultEmailOption: "CONFIRM_WITH_CODE",
        emailMessage: verify.emailMessage ?? VERIFICATION_MESSAGE,
        emailSubject: verify.emailSubject ?? "Verify your new account",
        smsMessage: verify.smsMessage ?? VERIFICATION_MESSAGE,
      })),
      userPoolAddOns: {
        advancedSecurityMode: withDefault<string, string>(
          args.advancedSecurity,
          "off",
          (mode) => mode.toUpperCase(),
        ),
      },
      mfaConfiguration: withDefault<string, string>(args.mfa, "off", (mfa) =>
        mfa.toUpperCase(),
      ),
      smsAuthenticationMessage: args.smsAuthenticationMessage,
      smsConfiguration: args.sms,
      softwareTokenMfaConfiguration: ifSet(
        output(args.softwareToken).apply((enabled) =>
          enabled ? { enabled: true } : undefined,
        ),
      ),
      lambdaConfig: triggers?.config,
    });

    for (const [trigger, fn] of Object.entries(triggers?.functions ?? {}))
      this.part(
        "permission",
        trigger,
        invokePermissionArgs(fn, "cognito-idp.amazonaws.com", userPool.arn),
      );

    if (args.domain)
      this.hostedUiUrl = this.createDomain(
        plain(args.domain, `The "domain" of the "${name}" user pool`),
        userPool,
      );
  }

  // The function behind each trigger, and what the user pool is told about
  // them.
  private createTriggers(triggers: CognitoUserPoolTriggers | undefined) {
    const name = this.componentName;
    plain(triggers, `The "triggers" of the "${name}" user pool`);
    if (!triggers) return undefined;
    if (
      (triggers.customEmailSender || triggers.customSmsSender) &&
      !triggers.kmsKey
    )
      throw new VisibleError(
        `You must provide a KMS key via "kmsKey" when configuring "customEmailSender" or "customSmsSender" for the "${name}" user pool.`,
      );

    const functions: Partial<Record<Trigger, FunctionPart>> = {};
    for (const trigger of TRIGGERS) {
      const definition = triggers[trigger];
      if (!definition) continue;
      functions[trigger] = functionPart(
        this,
        "trigger",
        trigger,
        plainFunction(
          definition,
          `The "${trigger}" trigger of the "${name}" user pool`,
        ),
        { description: `Subscribed to ${trigger} from ${name}` },
      );
    }
    const arn = (trigger: Trigger) => functions[trigger]?.targetArn;
    // Some triggers take the version of the event they're sent
    const versioned = (trigger: Trigger, lambdaVersion: string) => {
      const lambdaArn = arn(trigger);
      return lambdaArn && { lambdaArn, lambdaVersion };
    };

    const config: cognito.UserPoolArgs["lambdaConfig"] = {
      kmsKeyId: triggers.kmsKey,
      createAuthChallenge: arn("createAuthChallenge"),
      customEmailSender: versioned("customEmailSender", "V1_0"),
      customMessage: arn("customMessage"),
      customSmsSender: versioned("customSmsSender", "V1_0"),
      defineAuthChallenge: arn("defineAuthChallenge"),
      postAuthentication: arn("postAuthentication"),
      postConfirmation: arn("postConfirmation"),
      preAuthentication: arn("preAuthentication"),
      preSignUp: arn("preSignUp"),
      preTokenGenerationConfig: versioned(
        "preTokenGeneration",
        triggers.preTokenGenerationVersion === "v2" ? "V2_0" : "V1_0",
      ),
      userMigration: arn("userMigration"),
      verifyAuthChallengeResponse: arn("verifyAuthChallengeResponse"),
    };
    return { functions, config };
  }

  // The hosted UI's domain: a Cognito prefix domain, or a custom domain with
  // its certificate and the DNS records that point at it. Returns its URL.
  private createDomain(
    domain: NonNullable<CognitoUserPoolArgs["domain"]>,
    userPool: cognito.UserPool,
  ) {
    const name = this.componentName;
    const opts = { deleteBeforeReplace: true };

    if (typeof domain !== "string" && "prefix" in domain) {
      this.part(
        "domain",
        { userPoolId: userPool.id, domain: domain.prefix },
        opts,
      );
      const region = getRegionOutput(undefined, { parent: this }).region;
      return interpolate`https://${domain.prefix}.auth.${region}.amazoncognito.com`;
    }

    const custom = domainOf(domain, `the "${name}" user pool`);

    // Cognito serves a custom domain through CloudFront, which takes its
    // certificates from us-east-1.
    const certificateArn =
      custom.cert ??
      this.part(
        "certificate",
        { domainName: custom.name, dns: custom.dns! },
        { provider: useProvider("us-east-1") },
      ).arn;
    const userPoolDomain = this.part(
      "domain",
      { userPoolId: userPool.id, domain: custom.name, certificateArn },
      opts,
    );
    custom.dns?.alias(
      name,
      {
        name: custom.name,
        aliasName: userPoolDomain.cloudfrontDistribution,
        aliasZone: userPoolDomain.cloudfrontDistributionZoneId,
      },
      this.delegateOpts(),
    );
    return interpolate`https://${custom.name}`;
  }

  /**
   * The Cognito User Pool ID.
   */
  public get id() {
    return this.nodes.userPool.id;
  }

  /**
   * The Cognito User Pool ARN.
   */
  public get arn() {
    return this.nodes.userPool.arn;
  }

  /**
   * If a `domain` is configured, this is the full URL of the hosted UI.
   */
  public get domainUrl() {
    return this.hostedUiUrl;
  }

  /**
   * Add a client to the User Pool.
   *
   * @param name Name of the client.
   * @param args Configure the client.
   * @param opts Resource options.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const client = userPool.addClient("Web");
   * ```
   *
   * This returns the client as a component of its own, with its `id` and `secret`. Link it
   * to read them at runtime as `Resource.Web.id` and `Resource.Web.secret`.
   */
  public addClient(
    name: string,
    args: CognitoUserPoolAddClientArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    return new CognitoUserPoolClient(
      name,
      { userPool: this.id, ...args },
      { provider: this.componentOpts.provider, ...opts },
    );
  }

  /**
   * Add a federated identity provider to the User Pool.
   *
   * @param name Name of the identity provider.
   * @param args Configure the identity provider.
   *
   * @example
   *
   * For example, add a GitHub (OIDC) identity provider.
   *
   * ```ts title="sst.config.ts"
   * const GithubClientId = new sst.Secret("GITHUB_CLIENT_ID");
   * const GithubClientSecret = new sst.Secret("GITHUB_CLIENT_SECRET");
   *
   * const provider = userPool.addIdentityProvider("GitHub", {
   *   type: "oidc",
   *   details: {
   *      authorize_scopes: "read:user user:email",
   *      client_id: GithubClientId.value,
   *      client_secret: GithubClientSecret.value,
   *      oidc_issuer: "https://github.com/",
   *   },
   *   attributes: {
   *     email: "email",
   *     username: "sub",
   *   },
   * });
   * ```
   *
   * This returns the Cognito identity provider. Pass its `providerName` to the clients that
   * use it, so they're created after the provider.
   *
   * ```ts title="sst.config.ts"
   * userPool.addClient("Web", {
   *   providers: [provider.providerName]
   * });
   * ```
   */
  public addIdentityProvider(
    name: string,
    args: CognitoUserPoolIdentityProviderArgs,
  ) {
    this.assertNew("identity provider", "identityProvider", name, args);

    return this.part("identityProvider", name, {
      userPoolId: this.id,
      providerName: name,
      providerType: output(args.type).apply((type) => {
        if (!(type in PROVIDER_TYPES))
          throw new VisibleError(
            `Invalid provider type "${type}" for the "${name}" identity provider. Use one of: ${Object.keys(PROVIDER_TYPES).join(", ")}.`,
          );
        return PROVIDER_TYPES[type];
      }),
      providerDetails: args.details,
      attributeMapping: args.attributes,
    });
  }

  /**
   * Linking a user pool gives the linked resource its ID, and access to the
   * user pool.
   */
  public link() {
    return {
      properties: { id: this.id },
      include: [
        permission({ actions: ["cognito-idp:*"], resources: [this.arn] }),
      ],
    };
  }

  /**
   * Reference an existing User Pool with the given ID. This is useful when you
   * create a User Pool in one stage and want to share it in another. It avoids having to
   * create a new User Pool in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share User Pools across stages.
   * :::
   *
   * @param name The name of the component.
   * @param userPoolID The ID of the existing User Pool.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a User Pool in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new pool, you want to share the same pool from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const userPool = $app.stage === "frank"
   *   ? sst.aws.v5.CognitoUserPool.get("MyUserPool", "us-east-1_gcF5PjhQK")
   *   : new sst.aws.v5.CognitoUserPool("MyUserPool");
   * ```
   *
   * Here `us-east-1_gcF5PjhQK` is the ID of the User Pool created in the `dev` stage.
   * You can find this by outputting the User Pool ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   userPool: userPool.id
   * };
   * ```
   */
  public static get(
    name: string,
    userPoolID: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new CognitoUserPool(
      name,
      { existing: { userPool: userPoolID } },
      opts,
    );
  }
}

// The args that are settings of the user pool itself
const SETTINGS = [
  "aliases",
  "usernames",
  "advancedSecurity",
  "mfa",
  "sms",
  "smsAuthenticationMessage",
  "verify",
  "softwareToken",
  "triggers",
] as const;

const TRIGGERS = [
  "createAuthChallenge",
  "customEmailSender",
  "customMessage",
  "customSmsSender",
  "defineAuthChallenge",
  "postAuthentication",
  "postConfirmation",
  "preAuthentication",
  "preSignUp",
  "preTokenGeneration",
  "userMigration",
  "verifyAuthChallengeResponse",
] as const;

type Trigger = (typeof TRIGGERS)[number];

const VERIFICATION_MESSAGE =
  "The verification code to your new account is {####}";

// What Cognito calls each kind of identity provider
const PROVIDER_TYPES = {
  saml: "SAML",
  oidc: "OIDC",
  facebook: "Facebook",
  google: "Google",
  amazon: "LoginWithAmazon",
  apple: "SignInWithApple",
};

// What Cognito calls the attributes a user can sign in with
const SIGN_IN_ATTRIBUTES = {
  email: "email",
  phone: "phone_number",
  preferred_username: "preferred_username",
};

// The ones of `names` that are among `allowed`, as Cognito calls them and in
// the order `allowed` has them.
function signInAttributes(
  names: string[],
  ...allowed: (keyof typeof SIGN_IN_ATTRIBUTES)[]
) {
  return allowed
    .filter((name) => names.includes(name))
    .map((name) => SIGN_IN_ATTRIBUTES[name]);
}
