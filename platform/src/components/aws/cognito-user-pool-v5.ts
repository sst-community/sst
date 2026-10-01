import {
  ComponentResourceOptions,
  Output,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { cognito, getRegionOutput, lambda } from "@pulumi/aws";
import {
  V5Args,
  component,
  deferred,
  many,
  optional,
} from "../parts-component";
import { ifSet, plain, withDefault } from "../args";
import type { Plain } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { FunctionV5 } from "./function-v5";
import { CustomDomainArgs, customDomain } from "./helpers/custom-domain";
import { FunctionPart, functionPart } from "./helpers/function-part";
import { invokePermissionArgs } from "./helpers/function-permission";
import { useProvider } from "./helpers/provider";
import { permission } from "./permission";
import type {
  CognitoIdentityProviderArgs,
  CognitoUserPoolArgs,
} from "./cognito-user-pool";
import {
  CognitoUserPoolClientV5,
  CognitoUserPoolClientV5Args,
} from "./cognito-user-pool-client-v5";

const parts = () => ({
  /**
   * The Amazon Cognito User Pool.
   */
  userPool: cognito.UserPool,
  /**
   * The function behind each trigger, by trigger: `preSignUp`,
   * `postConfirmation` and so on.
   */
  trigger: many(deferred(FunctionV5)),
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

type Triggers = NonNullable<Plain<CognitoUserPoolArgs["triggers"]>>;

export interface CognitoUserPoolV5PrefixDomainArgs {
  /**
   * Use an Amazon Cognito prefix domain. Creates a domain at
   * `{prefix}.auth.{region}.amazoncognito.com`.
   *
   * Cannot contain "aws", "amazon", or "cognito".
   */
  prefix: Input<string>;
}

export interface CognitoUserPoolV5DomainArgs extends CustomDomainArgs {
  /**
   * The custom domain name. Must be a subdomain (e.g., `auth.example.com`).
   */
  name: Input<string>;
  /**
   * ARN of an existing ACM certificate in `us-east-1`. By default, a certificate
   * is created and validated automatically.
   */
  cert?: Input<string>;
}

export interface CognitoUserPoolV5Args
  extends V5Args<Omit<CognitoUserPoolArgs, "domain" | "triggers">, typeof parts> {
  /**
   * Configure triggers for this User Pool. Each one takes the handler path,
   * the function args, or a function ARN.
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
  triggers?: Plain<CognitoUserPoolArgs["triggers"]>;
  /**
   * Configure a domain for the User Pool's hosted UI.
   *
   * You can use either a Cognito-provided prefix domain or your own custom domain.
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
    | CognitoUserPoolV5PrefixDomainArgs
    | CognitoUserPoolV5DomainArgs;
}

export interface CognitoUserPoolV5ClientArgs
  extends Omit<CognitoUserPoolClientV5Args, "userPool"> {}

export interface CognitoUserPoolV5IdentityProviderArgs
  extends Omit<CognitoIdentityProviderArgs, "transform"> {}

/**
 * The `CognitoUserPoolV5` component lets you add a [Amazon Cognito User Pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html) to your app.
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
 * const userPool = new sst.aws.CognitoUserPoolV5("MyUserPool");
 * ```
 *
 * #### Login using email
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.CognitoUserPoolV5("MyUserPool", {
 *   usernames: ["email"]
 * });
 * ```
 *
 * #### Add a hosted UI domain
 *
 * Use a Cognito prefix domain for the hosted UI.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.CognitoUserPoolV5("MyUserPool", {
 *   domain: {
 *     prefix: "my-app-dev"
 *   }
 * });
 * ```
 *
 * Or use your own custom domain.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.CognitoUserPoolV5("MyUserPool", {
 *   domain: "auth.example.com"
 * });
 * ```
 *
 * #### Configure triggers
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.CognitoUserPoolV5("MyUserPool", {
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
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [client]
 * });
 * ```
 *
 * #### Switch from `CognitoUserPool`
 *
 * Change `CognitoUserPool` to `CognitoUserPoolV5` and keep the name. The user pool, its
 * domain, its clients, its identity providers and its trigger functions are kept. Three
 * things are written differently:
 *
 * - `addIdentityProvider` returns the Cognito identity provider. `provider.providerName`
 *   reads as before.
 * - An identity provider's own `transform` becomes the user pool's
 *   `transform.identityProvider`.
 * - `domain`, `domain.dns` and `triggers` have to be plain values, not outputs.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const userPool = new sst.aws.CognitoUserPool("MyUserPool");
 * const userPool = new sst.aws.CognitoUserPoolV5("MyUserPool");
 * ```
 */
export class CognitoUserPoolV5 extends component(
  "sst:aws:CognitoUserPoolV5",
  parts,
) {
  private hostedUiUrl?: Output<string>;

  constructor(
    name: string,
    args: CognitoUserPoolV5Args = {},
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
  private createTriggers(triggers: Triggers | undefined) {
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
      functions[trigger] = functionPart(this, "trigger", trigger, definition, {
        description: `Subscribed to ${trigger} from ${name}`,
      });
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
    domain: NonNullable<CognitoUserPoolV5Args["domain"]>,
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

    const custom = customDomain(domain, `the "${name}" user pool`);

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
    custom.dns?.createAlias(
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
    args: CognitoUserPoolV5ClientArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    return new CognitoUserPoolClientV5(
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
    args: CognitoUserPoolV5IdentityProviderArgs,
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
   *   ? sst.aws.CognitoUserPoolV5.get("MyUserPool", "us-east-1_gcF5PjhQK")
   *   : new sst.aws.CognitoUserPoolV5("MyUserPool");
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
    return new CognitoUserPoolV5(
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
